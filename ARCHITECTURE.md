# Whoof Vet AI — Architecture & Flow

A complete walkthrough of how Whoof works end-to-end, written so you can understand the
flow and confidently make future changes. Every section points at the real files and
functions.

> **TL;DR of the stack:** Node.js + Express 5 (no framework magic), EJS server-rendered
> views, vanilla JS frontend, PostgreSQL 17 + `pgvector` for hybrid RAG. LLM calls go
> through one swappable provider layer (Groq **or** Anthropic). Embeddings run locally
> (no API) by default. There is no React, no build step, no ORM. Beyond the core Q&A loop,
> the app also finds real nearby places (vets/parks/cafés), drafts WhatsApp vet-booking
> messages, generates pre-vet-visit briefings, and logs tester feedback to an admin
> dashboard + a live Excel export.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [Tech stack & where everything lives](#2-tech-stack--where-everything-lives)
3. [Backend structure — how Node/Express is wired](#3-backend-structure--how-nodeexpress-is-wired)
4. [The LLM provider abstraction](#4-the-llm-provider-abstraction)
5. [Hybrid RAG — ingestion](#5-hybrid-rag--ingestion)
6. [Hybrid RAG — retrieval, and the web-search fallback](#6-hybrid-rag--retrieval-and-the-web-search-fallback)
7. [The chat request lifecycle (the heart of the app)](#7-the-chat-request-lifecycle)
8. [Triage — asking the owner clarifying questions](#8-triage--asking-the-owner-clarifying-questions)
9. [Structured output & the `/visualise` command](#9-structured-output--the-visualise-command)
10. [The three kinds of memory (+ replying to a specific answer)](#10-the-three-kinds-of-memory--replying-to-a-specific-answer)
11. [Decisions — durable saved facts](#11-decisions--durable-saved-facts)
12. [The system prompt](#12-the-system-prompt)
13. [Finding nearby places — Find button, chat routing, and community picks](#13-finding-nearby-places--find-button-chat-routing-and-community-picks)
14. [Vet booking drafts over WhatsApp](#14-vet-booking-drafts-over-whatsapp)
15. [My Vet panel — saved vets & pre-visit summaries](#15-my-vet-panel--saved-vets--pre-visit-summaries)
16. [Response feedback & the admin dashboard](#16-response-feedback--the-admin-dashboard)
17. [Excel export & the Groq daily-quota badge](#17-excel-export--the-groq-daily-quota-badge)
18. [Data model (Postgres schema)](#18-data-model-postgres-schema)
19. [Auth & sessions](#19-auth--sessions)
20. [Config / environment variables](#20-config--environment-variables)
21. [Frontend](#21-frontend)
22. ["Where do I change X?" — a practical guide](#22-where-do-i-change-x)

---

## 1. The big picture

Whoof is a veterinary chat assistant for dog owners. The owner logs in, fills a pet
profile, and asks questions. Every answer is shaped by:

- **The dog's profile** (breed, age, diet, history) — injected directly into the prompt.
- **A curated knowledge base** of vet guideline PDFs — retrieved per question via hybrid
  search (RAG), with a live web-search fallback when the KB doesn't cover the topic.
- **Memory** of past conversations and saved decisions — injected as plain fact.

Around that core loop, the app also acts as a small concierge: it finds real nearby vets,
parks, and pet-friendly cafés (§13); drafts a WhatsApp message to book a vet appointment
(§14); tracks the owner's saved vets and generates a pre-visit briefing before a check-up
(§15); and logs tester feedback to an internal admin dashboard and a live Excel export for
manual review (§16, §17).

A single answer can therefore combine retrieved guideline material, breed facts, the dog's
profile, and remembered decisions — all assembled into one system prompt that a language
model turns into a reply.

```
                       ┌─────────────────────────────────────────────┐
   Owner's question →  │  POST /api/chat/message  (routes/chat.js)   │
                       └─────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼──────────────────────────┬────────────────────┐
        ▼                     ▼                           ▼                    ▼
  Pending-decision      Booking / place            Emergency check      Triage (fast
  yes/no? (§11)         intent detected?            (keyword scan)      model): pet-
        │               → short-circuit to                │            related? needs
        │                 §13/§14, skip the                │            questions?
        │                 rest of this turn                │                  │
        └─────────────────────┴─────────────┬──────────────┴──────────────────┘
                                             ▼
                       RAG retrieval (§6) → web-search fallback if the KB is weak
                                             │
                              Memory load: decisions + rolling summary (§10, §11)
                                             ▼
                                  buildSystemPrompt()  (lib/llm.js, §12)
                                             ▼
                       generateAnswer()  /  toStructuredCard()  (§9)
                        (plain text)        (structured card, /visualise only)
                                             ▼
                     persist turn → conversation_memory (incl. reply_to_memory_id)
                                             ▼
       JSON response → frontend, then fire-and-forget: roll up memory (§10),
                        update the tracked tester's Excel export (§17)
```

---

## 2. Tech stack & where everything lives

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js ≥18 | `server.js` is the entry point |
| HTTP | Express 5 | `app.use('/', require('./routes/...'))` |
| Views | EJS | server-rendered `views/*.ejs` |
| Frontend | Vanilla JS + CSS | `public/chat-client.js` (~1,800 lines), `public/style.css` |
| DB | PostgreSQL 17 + `pgvector` | accessed via `pg` Pool, no ORM |
| Migrations | `node-pg-migrate` | `migrations/17000000000XX_*.js`, 22 so far |
| Sessions | `express-session` + `connect-pg-simple` | stored in a Postgres `session` table |
| LLM | Groq **or** Anthropic | switched by `LLM_PROVIDER` |
| Embeddings | local Transformers.js **or** Voyage | switched by `EMBEDDING_PROVIDER` |
| PDF parsing | Python (PyMuPDF + pdfplumber) | `scripts/parse_pdf.py`, called by the ingest script |
| Places / maps | Google Places API (New) | `lib/vetFinder.js` — nearby search + text search |
| Web search | Tavily | `lib/webSearch.js` — KB fallback + community-picks source |
| Messaging | WhatsApp via `wa.me` deep links | no API/integration — the owner taps send |
| Spreadsheet export | `xlsx` (SheetJS) | `lib/exportExcel.js` writes `whoof-responses.xlsx` (gitignored) |

**Directory map**

```
server.js              App bootstrap: middleware, session, route mounting, /health
db.js                  Single pg Pool; exports { pool, query }
middleware/
  requireAuth.js       Gate: redirects to /login if no session.ownerId
routes/
  auth.js              /login, /logout, /dev-login (opt-in via ENABLE_DEV_LOGIN)
  profile.js           Onboarding + pet profile read/write
  chat.js              THE core: POST /api/chat/message + chat pages   (~1,350 lines)
  admin.js             /admin dashboard (password-gated) for reviewing tester turns
lib/
  llmProvider.js       Provider switch (Groq/Anthropic). 4 primitives; feeds tokenUsage.
  llm.js               System-prompt builder + answer generation + routing
  rag.js               Retrieval: rewrite → embed → hybrid search → rerank
  embeddings.js        Local/Voyage embeddings (used by BOTH ingest & retrieval)
  triage.js            Pre-answer classifier (pet-related? needs questions?)
  structured.js        StructuredAnswer JSON Schema + validator (the card contract)
  decisions.js         Detect/save/load "locked decisions"
  memory.js            One rolling summary per pet across past chats
  placeIntent.js       Detects a chat-typed "find nearby places" question (§13)
  bookingIntent.js     Detects a chat-typed "book a vet appointment" request (§14)
  booking.js           Drafts the WhatsApp booking message text (§14)
  vetFinder.js         Google Places (New): nearby search + text search (§13)
  communityPicks.js    Layers "what pet owners recommend" onto Places results (§13)
  webSearch.js         Tavily web search — KB fallback (§6) + community-picks source (§13)
  vetSummary.js        Pre-vet-visit clinical briefing + owner checklist (§15)
  tokenUsage.js        Tracks Groq daily token usage against published free-tier caps (§17)
  exportExcel.js        Writes whoof-responses.xlsx for the tracked tester account (§17)
scripts/
  ingest-all-pdfs.sh   Batch-ingest every PDF in kb-source/
  ingest-kb-pdf.js     One PDF → parse → embed → kb_chunks
  parse_pdf.py         PDF → structured JSON (chunks + extracted figures)
  generate-commit-log.js  Regenerates whoof-commit-log.xlsx from `git log` (post-commit hook)
  install-git-hooks.sh   Installs that post-commit hook
views/                 login.ejs, onboarding.ejs, chat.ejs, admin.ejs, admin-login.ejs
public/                chat-client.js, style.css, brand assets
kb-source/             The source guideline PDFs (not committed-tracked content)
migrations/            Ordered DB schema migrations
```

---

## 3. Backend structure — how Node/Express is wired

`server.js` does five things, in order ([server.js](server.js)):

1. **Loads env** via `dotenv` (`.env`, gitignored — holds all keys).
2. **View engine**: EJS, views in `/views`.
3. **Middleware**: `express.json()`, `express.urlencoded()`, `express.static('public')`.
4. **Sessions**: `express-session` backed by Postgres (`connect-pg-simple` auto-creates a
   `session` table). Cookie lasts 30 days, `httpOnly`, `sameSite: strict`.
5. **Mounts routes** and adds `GET /` (redirect to `/chat` or `/onboarding` depending on
   whether the owner has a pet) and `GET /health` (DB ping).

Every protected route uses `middleware/requireAuth` — if `req.session.ownerId` is missing
it redirects to `/login`. The owner's identity for the whole app is just
`req.session.ownerId`. The admin dashboard (§16) uses a **separate** `req.session.adminAuth`
flag, not tied to any owner account.

**Database access** is deliberately thin ([db.js](db.js)): one shared `pg.Pool` reading
`DATABASE_URL`, exposing `query(text, params)`. Every module does raw parameterised SQL —
there is no ORM, so to understand a query you just read the SQL.

There are **four route files** now:

- `routes/auth.js` — login (email + bcrypt-hashed access code), logout, and a dev-only
  `/dev-login` shortcut (opt-in, see §19).
- `routes/profile.js` — onboarding form + pet profile CRUD.
- `routes/chat.js` — the chat pages, the core `POST /api/chat/message` endpoint, and the
  bolt-on features that grew alongside it: nearby-places search, booking drafts, the "My
  Vet" panel endpoints, response feedback, and session pin/delete. Almost everything
  interesting flows through this one file.
- `routes/admin.js` — the password-gated `/admin` dashboard for reviewing a tracked
  tester's turns, ratings, and feedback (§16).

---

## 4. The LLM provider abstraction

**Every** LLM call in the app goes through [lib/llmProvider.js](lib/llmProvider.js). This is
the single switch point: set `LLM_PROVIDER=groq` for Groq's open models, or leave it
`anthropic` for Claude. The rest of the code never talks to a provider SDK directly.

> **Important:** embeddings and reranking are **not** here — those always go to Voyage or
> the local model (Groq has no embeddings API). So the app can run on Groq for text while
> embeddings run locally. That split is by design.

There are **two model tiers** (each overridable by env):

| Tier | Groq default | Anthropic default | Used for |
|---|---|---|---|
| main | `llama-3.3-70b-versatile` | `claude-sonnet-4-6` | the actual vet answer |
| fast | `llama-3.1-8b-instant` | `claude-haiku-4-5` | triage, query rewrite, titles, summaries, place/booking-intent detection, vet-visit briefings |

Ingestion has no vision-model step — figure chunks use whatever caption text
`parse_pdf.py` extracts from the PDF layout (or a placeholder if none was found). A
vision-caption primitive existed here previously but was removed: it didn't improve
answer accuracy enough for this KB to justify the added Groq API cost and rate-limit
exposure (see the ingest script's history if you need to reintroduce it).

The provider exposes **three primitives** — learn these and you understand every model call:

1. `generate({ system, user, maxTokens, fast })` → plain text. (chat answers, query rewrite, titles, summaries, booking-message drafts)
2. `generateStructured({ system, user, tool, fast })` → forces **one** tool and returns its parsed args. (triage classifier, decision detector, place/booking-intent detectors, community-mentions extractor, vet-visit summariser)
3. `generateRouted({ system, user, tools, force })` → offers several tools and lets the model pick one (or forces one with `force`). (text-vs-card routing)

Each primitive maps the same call onto the Anthropic Messages API **or** the Groq
OpenAI-compatible `chat/completions` API. `isConfigured()` reports whether the active
provider has a key — used everywhere for **fail-open** behaviour (if there's no key or the
call errors, the app degrades gracefully instead of crashing).

**Groq usage tracking:** every successful Groq response carries `usage.total_tokens`. The
Groq call path fire-and-forgets this into `lib/tokenUsage.js` (`recordUsage()`), which sums
it per model per UTC day in the `token_usage_daily` table — see §17 for why (Groq exposes
no queryable daily-remaining endpoint) and how it surfaces as the quota badge.

---

## 5. Hybrid RAG — ingestion

"RAG" = Retrieval-Augmented Generation: we don't fine-tune a model on vet data, we
**retrieve** relevant guideline passages at question time and put them in the prompt.

Ingestion turns PDFs in `kb-source/` into rows in the `kb_chunks` table. Driver:
[scripts/ingest-kb-pdf.js](scripts/ingest-kb-pdf.js), batch wrapper
[scripts/ingest-all-pdfs.sh](scripts/ingest-all-pdfs.sh).

**Pipeline per PDF:**

```
PDF file
  │  1. SHA-256 hash → compare to scripts/.pdf-hashes.json
  │     unchanged? skip (idempotent). --force to override.
  ▼
parse_pdf.py  (Python: PyMuPDF + pdfplumber)
  │  splits the document into CHUNKS with structural metadata:
  │  section / subsection / page_number / chunk_type (body | figure | table)
  │  and extracts figure images to disk. Figure chunks keep whatever caption text
  │  was found in the PDF layout (or a placeholder) — no vision-model step.
  ▼
Embedding  (lib/embeddings.js → embedDocuments)
  │  every chunk's "heading_path: content" string → a 768-dim vector.
  │  Batched (16 at a time). Default model is LOCAL (no API).
  ▼
DB write  (one transaction)
     DELETE existing rows for this source_title  → INSERT all chunks
     → ANALYZE kb_chunks (refresh the ivfflat index) → save hash
```

**Why "delete then insert"?** Re-ingesting a source replaces it cleanly — no duplicates.
The unit of replacement is `source_title` (so the `--title` flag matters; the batch script
keeps a `title_for()` map of clean citation titles per filename).

**Each chunk row** carries: `source_title`, `source`, `topic`, `section`, `subsection`,
`sub_subsection`, `page_number`, `chunk_type`, `content`, `citations`, `embedding` (vector),
`confidence_tier`, `license_note`. This structural metadata is what lets the UI show
"Sources (5)" with section + page later.

**To add knowledge:** drop a PDF in `kb-source/`, optionally add a clean title in
`title_for()` in the batch script, then `bash scripts/ingest-all-pdfs.sh`. It only
processes new/changed files.

> **Phase-2 note (not built):** image-based diagnosis (owner uploads a photo, match against
> reference images) would need multimodal embeddings + a separate image-vector column +
> liability review. The ingest script prints this reminder at the end.

---

## 6. Hybrid RAG — retrieval, and the web-search fallback

Retrieval happens **per chat message** in [lib/rag.js](lib/rag.js), entrypoint
`retrieveChunks(questionText, topK=5)`. "Hybrid" = it combines **two** different search
methods and fuses their rankings.

```
owner question
  │  1. rewriteQueryClinical()  (fast model)
  │     "his breath stinks and he won't eat" → "halitosis and anorexia in dogs"
  │     (makes the query match clinical guideline language; fails open to original)
  ▼
  │  2. embedQuery()  (lib/embeddings.js)  → 768-dim vector
  ▼
  3. hybridSearch()  — Reciprocal Rank Fusion (RRF) of two legs, in ONE SQL query:
       ┌─────────────────────────────┐     ┌──────────────────────────────────┐
       │ Vector leg                  │     │ Full-text leg                    │
       │ embedding <=> query_vector  │     │ fts_vector @@ plainto_tsquery    │
       │ (pgvector cosine distance)  │     │ (Postgres FTS, ts_rank_cd)       │
       └──────────────┬──────────────┘     └─────────────────┬────────────────┘
                      │  each returns a ranked list           │
                      └───────────────┬───────────────────────┘
                                      ▼
              RRF score = 1/(60+rank_vec) + 1/(60+rank_fts)
              (k=60 is the standard constant; FULL OUTER JOIN so a chunk
               found by either leg counts) → ORDER BY rrf_score → top-k
  ▼
  4. rerankWithVoyage()  — OPTIONAL, only if ENABLE_RERANK=true
     (a cross-encoder re-scores the candidates; costs an API call per message)
```

**Why hybrid?** Vector search catches *semantic* matches ("anorexia" ≈ "won't eat"); FTS
catches *exact term* matches (drug names, "parvovirus") that embeddings sometimes blur. RRF
gives you the strengths of both without tuning a weight.

**Graceful degradation** (all automatic):
- No embeddings/Voyage → vector leg still works locally (default is the local model).
- No LLM key → query rewrite skipped, raw question used.
- `fts_vector` column missing (migration 009 not run) → falls back to vector-only search.
- `ENABLE_RERANK` unset → reranking skipped (it's a per-message cost).

**Critical invariant** ([lib/embeddings.js](lib/embeddings.js)): ingestion and retrieval
**must** use the same embedding model, or query and document vectors live in different
spaces and retrieval silently breaks. Both go through `embeddings.js`, which is why it
exists. The local model (`Xenova/bge-base-en-v1.5`, 768-dim) needs an instruction prefix on
the **query only** — handled in `embedQuery()`. If you change the model, change the vector
dimension in a migration and re-ingest everything.

**Breed lookup is separate** — `lookupBreed()` is a direct SQL lookup against
`breed_reference` (exact → fuzzy substring → "Mixed breed" fallback), **not** vector search.
Breed facts are injected straight into the prompt.

### 6a. Web-search fallback ([lib/webSearch.js](lib/webSearch.js))

When the KB retrieval is weak, `routes/chat.js` calls Tavily for a few live web results
instead of leaving the model to answer from stale/no reference material. This is scoped
tightly so it can't turn into a general search engine:

- **Trigger** — `kbWeak = chunks.length === 0 || topCosine < threshold`. The threshold is
  usually `0.6`, but a regex (`wantsExternal`) detects intent that clearly needs *external*
  or *fresh* facts (a phone number, address, "latest/newest", a price, a year) and raises
  the bar to `0.72` for those — the static KB shouldn't be trusted over the web for
  something like a clinic's phone number just because it scores moderately.
  `topCosine` is the top chunk's **raw cosine similarity**, not the RRF score — RRF only
  reflects rank position (always ~0.016 at rank 1) and can't distinguish a good KB match
  from a bad one, which cosine can.
- **Never fires** for emergencies, recall questions ("what did we decide?"), a `/visualise`
  recast of a previous answer, or when Tavily isn't configured (`isConfigured()`).
- **Fail-soft** — any Tavily error returns `[]`; the answer proceeds on the model's own
  knowledge, just without the web-grounded badge.
- Results are injected into the prompt as a `## Recent information from the web:` section
  (see §12) and cited in the response as `sources_cited` with a real `url` (so the UI can
  render clickable links) and `confidence_level: 'medium'`.
- `lib/webSearch.js` also exports a general-purpose `search()` (no veterinary query bias),
  used by `lib/communityPicks.js` (§13) to search for place recommendations rather than
  clinical content.

---

## 7. The chat request lifecycle

This is the whole app in one function: `POST /api/chat/message` in
[routes/chat.js](routes/chat.js). Here is the exact order of operations.

```
1.  Parse input
      rawMessage = body.message
      parseFormatCommand(rawMessage) → { modality, cleaned }
      message         = cleaned text (command stripped, used for LLM/retrieval)
      forceStructured = body.force_structured OR a /visualise command was present
      replyToMemoryId = body.reply_to_memory_id (a UUID the owner tapped "Reply" on, §10)
      clarifications  = body.clarifications (owner's triage answers, 2nd round only)

2.  Load pet  (JOIN owners)        → 400 if the owner has no pet profile

3.  Pending decision offer?  (only if no clarifications, see §11)
      If the bot just offered to save a decision in this chat:
        owner said "yes"  → saveDecision() + confirm   (return)
        owner said "no"   → clear the offer + acknowledge (return)
        anything else     → offer lapses, continue normally

4.  Vet-booking request?  (only if no clarifications — cheap regex gate first, §14)
      looksLikeBooking(message) → confirm + resolve clinic → draft WhatsApp link (return)
      not actually a booking → falls through to the normal answer path

5.  "Find nearby places" request typed in chat?  (only if no clarifications, §13)
      looksLikePlaceQuery(message) → confirm intent → hand the client a place_prompt
      signal so it runs the SAME Find pipeline as the Find button (return)
      not actually a place search → falls through to the normal answer path

6.  enriched = message + clarifying answers   (used for emergency scan + retrieval)

7.  Emergency check     checkEmergency(enriched)  → escalated (keyword match)
      Emergencies SHORT-CIRCUIT triage and always answer immediately in plain text.

8.  Triage   (first submit only, not for emergencies)   → triageQuestion(message, pet)
      not pet-related     → polite decline, no expensive answer call   (return)
      needs_clarification → return clarifying questions, don't answer yet (return)
      otherwise           → fall through to the answer path

9.  Answer path
      a. lookupBreed(pet.breed)               (direct SQL)
      b. loadReplyTarget(pet.id, replyToMemoryId)   (§10 — the specific turn being replied to)
      c. resolveSession()                     (this turn's chat; creates one if new)
      d. recentHistory = last 5 turns of THIS chat
      e. [decisions, rollingSummary]          (cross-chat memory, in parallel, §10/§11)
      f. retrieveChunks(enriched, 5)          (the RAG step from §6)
      g. web-search fallback if the KB is weak and it's not an emergency/recall/recast (§6a)
      h. buildSystemPrompt(pet, chunks, history, breed,
           {clarifications, decisions, summary, ownerName, webResults, replyTo})   (§12)
      i. ANSWER:
            forceStructured && !escalated
              ? generateAnswer() then toStructuredCard() on the fast model   → a CARD
              : generateAnswer()                                             → plain TEXT
         (Cards are OPT-IN — only the /visualise command makes one. See §9.)
      j. Sources & confidence attach to KB-grounded OR web-grounded clinical answers
         (not recall answers, not decision offers, not structured cards' own actions).
      k. detectDecision()  → maybe park a save-offer on the session (see §11)
      l. persistTurn()     → write the turn to conversation_memory, including
                              reply_to_memory_id (stores the RAW message so "/visualise"
                              shows on reload)
      m. respond with JSON; fire-and-forget rollUpInactiveChats() (§10) and
         maybeUpdateExcel() (§17, no-op unless this is the tracked tester account)
```

Helpers worth knowing, all local to `routes/chat.js`:
- `parseFormatCommand()` — strips a leading `/visualise` (or `/visualize`) and reports the
  forced modality. **This is the server-side authority** for slash commands — it works even
  for direct API calls, not just the UI.
- `isRecallQuestion()` — regex detecting "what did we decide / you said / last time…".
  Recall answers come from memory, so they get **no** sources and **no** confidence tag.
- `resolveSession()` / `fetchSession()` — a "session" is one chat thread
  (`conversation_session`); a "turn" is one Q&A (`conversation_memory`).
- `persistTurn()` — the single writer to `conversation_memory`.
- `loadReplyTarget()` — resolves an owner-supplied `reply_to_memory_id` against THIS pet's
  turns only; a bad/foreign/missing id just means no reply context (fail-soft), never a
  hard error (§10).
- `handleBookingRequest()` / `handlePlaceRequest()` — own the early-exit branches for §13/§14.

---

## 8. Triage — asking the owner clarifying questions

Before spending a main-model call on an answer, a **fast** classifier decides two things
([lib/triage.js](lib/triage.js), tool `triage_pet_question`):

1. **`pet_related`** — is this about a dog/animal at all? If not, the bot politely declines
   (gates out "capital of India" type questions).
2. **`needs_clarification`** — should we ask a few quick multiple-choice questions before
   answering? If yes, it returns 2–4 `clarifying_questions`, each with tappable `options`
   and `allow_text: true` (the owner can always type their own answer).

**When does it fire?** Only on the **first** submit of a message (no clarifications yet) and
**not** for emergencies, and not if the message was already claimed by the pending-decision,
booking, or place-search checks that run before it (§7 steps 3–5). Wired at `routes/chat.js`
step 8.

**What triggers `needs_clarification`?** This is purely the classifier's judgment, steered by
the tool description and `buildTriageSystem()`. The current rule (deliberately strict):

> Ask clarifying questions **only** when the owner is reporting an **active, currently-observed
> physical health symptom** where "see a vet now vs. monitor at home" genuinely depends on the
> missing detail (vomiting, limping, not eating, a new lump…).
>
> **Never** ask for: informational questions ("how do I know if…", "what are the signs of…"),
> behaviour/training/anxiety questions, or diet/grooming/vaccination/general-care questions.
> When in doubt → don't ask, just answer.

This narrowness is intentional — earlier the classifier over-asked (e.g. it asked four
questions for "how do I know if my dog has separation anxiety?", which is informational).

**Two-round flow:**

```
Round 1:  owner asks → triage says needs_clarification
          → server returns { needs_clarification, original_message, clarifying_questions }
          → frontend renders chips + "type your own" + a "Get Whoof AI's answer" button
Round 2:  owner answers → frontend re-POSTs with clarifications: [{question, answer}, …]
          → triage is SKIPPED (clarifications present) → answer path runs, with the
            answers folded into the prompt (clarificationSection in buildSystemPrompt)
```

**Fail-open:** if the classifier has no key or errors, it returns
`{ pet_related: true, needs_clarification: false }` so the normal answer path still runs.

**To tune triage behaviour:** edit the `needs_clarification` description and
`buildTriageSystem()` in `lib/triage.js`. No code change is needed to change *when* it asks —
it's all in those two prompt strings.

---

## 9. Structured output & the `/visualise` command

By default every answer is **plain text**. A **structured card** (a header + stat tiles +
sections + callouts + tags + action buttons) is produced **only** when the owner uses the
`/visualise` slash command.

> This is a recent, deliberate decision. The model used to autonomously choose card-vs-text,
> but it made cards for almost everything. Now cards are **opt-in via `/visualise` only**.

**The card contract** lives in [lib/structured.js](lib/structured.js):
- `STRUCTURED_ANSWER_SCHEMA` — a JSON Schema used **verbatim** as the tool's `input_schema`.
  One generic shape (`subject`, `header`, `stats[]`, `sections[]`, `callouts[]`, `tags[]`,
  `actions[]`, `fallbackText`). `sections[].layout` is `timeline` or `list` today.
- `validateStructuredAnswer()` — defensive server-side cleaning. It **drops** malformed
  sub-parts rather than failing the whole turn, and only reports `invalid` if a load-bearing
  field is missing (`header.title` or `fallbackText`), so the caller can fall back to text.

**`fallbackText` is mandatory and important:** it's a complete plain-text version of the same
answer. The rest of the app (memory, search, decision detection, accessibility) uses
`fallbackText` as *the* canonical answer text, so a card never breaks downstream logic.

**How a `/visualise` request flows:**

```
Client (public/chat-client.js)
  user types "/visualise <question>" and presses enter
  parseFormatCommand() detects the command, sets forceStructured = true
  the FULL "/visualise …" text is shown in the chat bubble (so the owner sees the command
    was applied) and sent to the server; force_structured:true is also sent
  bare "/visualise" with nothing after it → held in the box with a nudge, not sent
  a typeahead menu appears when you type "/" (discoverability)

Server (routes/chat.js)
  parseFormatCommand() strips "/visualise" → message (clean) used for the model/retrieval
  forceStructured = true
  → answer as TEXT on the big model, then lay it out as a card on the FAST model
    (lib/llm.js: toStructuredCard()) — this avoids the heavy forced-structured call that
    429s on Groq's per-minute token limit and silently degrades to plain text
  the raw "/visualise …" text is STORED as the owner_question (so it persists on reload)

lib/llm.js → toStructuredCard()
  tries a flat line format on the fast model first (JSON-escaped tool calls get mangled by
    llama-3.1-8b), then a deterministic text→card builder — NEVER returns null, so a
    /visualise request always yields a real, populated card
```

**A `structured_kind` beyond cards:** the `structured_answer` / `response_modality` /
`structured_kind` columns on `conversation_memory` aren't only used by `/visualise`. The
nearby-places result (§13) is also persisted as a structured turn with
`structured_kind: 'places'` so a reload hydrates back into live place cards — but
`response_modality`'s DB check constraint only allows `'text'` or `'structured'`, so
`'places'` lives in `structured_kind`, not as a modality of its own.

**Telemetry:** every turn records `response_modality` ('text'|'structured'),
`structured_trigger` (now always 'command' when a `/visualise` card appears), and
`structured_kind` on `conversation_memory`.

**To add another command** (e.g. `/steps`, `/table`): add one entry to the `FORMAT_COMMANDS`
array — it exists in **both** `routes/chat.js` (authority) and `public/chat-client.js`
(optimistic UI + hint). The answer flow doesn't change.

**To re-enable model-chosen cards:** in `routes/chat.js` step 9i, change the branch back to
offer both `send_text_reply`/`send_structured_reply` via `generateRoutedAnswer` and let the
model pick, instead of always forcing text-then-recast. See `lib/llm.js`'s
`generateRoutedAnswer()` (still present, used for the routing primitive) for the tool
definitions.

---

## 10. The three kinds of memory (+ replying to a specific answer)

A frequent point of confusion: Whoof has **three distinct memory mechanisms**, and only one
of them is retrieval. Keeping them separate is a core design idea.

| Memory | Scope | How it's used | File |
|---|---|---|---|
| **Within-chat history** | last 5 turns of the *current* chat | verbatim in the prompt | `routes/chat.js` (SQL) → `historySection` in `lib/llm.js` |
| **Rolling summary** | all *past* chats, one fixed slot per pet | one ~300-token summary, injected as fact | `lib/memory.js` |
| **Locked decisions** | confirmed durable facts | injected as authoritative fact | `lib/decisions.js` |

**Why no "search my past conversations"?** On purpose. Conversation transcripts are **never**
embedded or vector-searched. Instead:

- The **rolling summary** ([lib/memory.js](lib/memory.js)) keeps exactly **one** compressed
  summary per pet (`pet_memory.digest`, capped ~300 tokens / 1400 chars). When chats other
  than the active one have un-folded turns, `rollUpInactiveChats()` runs **one** pass:
  `prior summary + those turns → a new summary that REPLACES the old one`. Folded turns are
  marked `summarized = true` so they're never reprocessed.

  The payoff: **memory-loading cost stays flat** no matter how many past chats exist — a pet
  with 50 chats costs the same as one with 2, because we always compress into the same slot
  instead of accumulating more to search. It's triggered fire-and-forget after each answer.

- **Locked decisions** are asserted facts (see §11), not summaries.

Raw transcripts stay in `conversation_memory` for audit, but they don't cross sessions except
through the summary.

**"Reply to this answer" is a fourth mechanism, but it's targeting, not memory.** Tapping
"Reply" on any past AI answer (live or reloaded from history) sets `reply_to_memory_id` on
the next request. `conversation_memory.reply_to_memory_id` is a self-referencing FK
(`ON DELETE SET NULL`, migration 021). The server resolves it via `loadReplyTarget()` —
scoped to the current pet, so an id can't leak another owner's turn — and injects the quoted
Q&A into the prompt as its own section (`replySection` in `buildSystemPrompt()`, §12), telling
the model the new message is a direct follow-up to that *specific* turn regardless of what's
been discussed since. This exists because the model otherwise only sees the last 5 turns of
within-chat history — a follow-up about something said further back had no reliable anchor.
It doesn't change what's stored in the rolling summary or decisions; it only changes what's
prepended to a single turn's prompt.

---

## 11. Decisions — durable saved facts

A "decision" is a settled record about the dog (a finalized diet plan, a confirmed allergy or
diagnosis, an agreed treatment routine). They're the **opposite of retrieval**: injected into
every prompt as plain asserted fact — no vector search, no sources, no confidence, no hedging.
The prompt explicitly tells the model these are **authoritative** and win over any conflicting
memory. Code: [lib/decisions.js](lib/decisions.js).

**Offer → confirm flow:**

```
1.  After a substantive answer, detectDecision() (fast model, assess_saveable_decision tool)
    judges whether this exchange FINALIZED something worth saving, and drafts a warm
    one-line offer ("…want me to save this as Monkey's official plan? Just say yes.").
2.  The proposal parks on conversation_session.pending_decision (it is NOT saved yet).
    The UI shows it as a popup card.
3.  The owner's NEXT message, OR a tap on the popup's own buttons:
      isAffirmation() ("yes", "do it", 👍)  → saveDecision() writes it
      isDecline()     ("no", "later")        → clear the offer
      anything else                          → offer lapses, message answered normally
```

Besides the implicit yes/no-in-chat flow, three explicit endpoints exist so the popup card's
own buttons don't need the owner to type anything:
- `POST /api/chat/session/:id/decision/confirm` — saves the pending offer as-is.
- `POST /api/chat/session/:id/decision/dismiss` — clears the pending offer.
- `POST /api/chat/session/:id/decision/save` — saves an **explicit** `{ title, decision_type,
  summary }` payload, used by the `save_decision` action button a structured `/visualise`
  card can carry (`decision_type` is validated against a fixed enum). This is separate from
  the legacy pending-offer popup — a structured reply owns its own save UI, so
  `routes/chat.js` skips parking a pending offer when the answer is a card
  (`!structuredAnswer` check).

`saveDecision()` supersedes any previous **active** decision of the same type (keeps old ones
as `status='superseded'` for audit), so only the newest is asserted. `loadActiveDecisions()`
pulls active ones into every prompt.

---

## 12. The system prompt

`buildSystemPrompt()` in [lib/llm.js](lib/llm.js) assembles everything into one prompt. It's
worth reading once — it's where the assistant's personality and rules live. Sections, in
order:

1. **Identity & rules** — "You are Whoof AI…", stay-in-lane (dogs only), an ingestion-safety
   carve-out (a dog getting into a human substance is always a toxicity question, never
   brushed off), don't cite sources inline, recall-vs-clinical distinction, and the
   **emergency rule** (lead with "⚠️ URGENT" for poisoning, breathing trouble, collapse,
   seizures, etc.), length calibration (short for casual/yes-no, detail only for genuine
   clinical questions), and the hard "3+ things → bullets" formatting rule.
2. **Patient profile** — `buildPetSummary()` turns the `pet_profile` row into prose (age,
   breed, weight, diet, allergies, vaccinations, meds, surgeries, temperament…).
3. **Owner name** — a hard rule against opening with it (see the locked product behaviour
   note in the repo's `CLAUDE.md`): default to never using it, at most once per conversation.
4. **Breed context** — from `breed_reference` (predispositions, life expectancy, temperament).
5. **Saved decisions** — asserted facts, marked authoritative (§11).
6. **Rolling summary** — "what you remember about Monkey from past conversations" (§10).
7. **Earlier in this chat** — the last 5 turns verbatim (§10).
8. **Reply-to-answer context** — if the owner tapped "Reply" on a specific earlier turn, that
   exact Q&A is quoted here and the model is told the new message follows up on it directly,
   independent of anything discussed since (§10).
9. **Clarification answers** — the owner's triage answers, if this is the 2nd round (§8).
10. **Relevant reference material** — the retrieved KB chunks, numbered with their
    section/page (but the model is told **not** to cite them inline — sources are shown
    separately in the UI).
11. **Recent information from the web** — only present when the KB had no good match (§6a);
    same "don't quote URLs inline" rule, since the pages are shown to the owner separately.

When you want to change tone, guardrails, or what context the model sees, this function is
the place.

---

## 13. Finding nearby places — Find button, chat routing, and community picks

The location button opens a 3-way category picker — **Vets**, **Parks**, **Cafés** — and
calls `GET /api/vets/nearby?lat=&lng=&radius=&category=`, backed by
[lib/vetFinder.js](lib/vetFinder.js) (Google Places API "New", `searchNearby` /
`searchText`, POST + `X-Goog-*` header auth) and layered with community sentiment via
[lib/communityPicks.js](lib/communityPicks.js).

**Chat-typed questions must use the same pipeline.** Testing showed the worst-rated turns of
a session were all the same request typed in chat instead of tapped via Find — e.g. "what
about cafés which are pet friendly" — which got an improvised, sometimes-wrong list from the
model's own knowledge (it even denied knowing about a real, verified place once). So:

- [lib/placeIntent.js](lib/placeIntent.js): `looksLikePlaceQuery()` is a cheap regex gate
  (place noun + a "near/find" signal, or an explicit "pet-friendly …") that runs on every
  message; `detectPlaceRequest()` only runs behind that gate — a fast-model confirm that
  rejects false hits ("we walk in the park daily" is not a place search) and picks a
  category.
- When it fires, `routes/chat.js`'s `handlePlaceRequest()` returns `{ place_prompt: true,
  category }` instead of an answer — the client then runs the identical location-prompt →
  `/api/vets/nearby` flow the Find button uses, so results are always real, verified places.
- **The model itself is told it has no access to maps or real businesses** and must never
  invent place names or pet-friendliness claims (see §12, identity & rules) — this guardrail
  and the routing above are what actually stop the fabrication, together.

**Community picks** ([lib/communityPicks.js](lib/communityPicks.js)) layer "what local pet
owners actually recommend" onto the real Google results, since Places gives a star rating but
not community trust:

```
Google Places nearby results (real, verified places)
        │
        ▼
Tavily search for the area (Reddit, blogs, local pet forums) — general search(),
  not the vet-scoped searchWeb() — biased toward "best <category> in <area> ... recommended
  by dog/pet owners"
        │
        ▼
Fast model extracts named venues + a one-line "why" (list_recommended_places tool);
  never invents a venue or reason — skips anything not clearly named
        │
        ▼
Fuzzy-match extracted names onto the nearby Google places (shared-brand-word matching)
        │
        ├─ VETS: matched places float to the top with a "🐾 Community pick" badge +
        │        reason; unmatched community names become clickable "also loved by
        │        locals" Maps-search links (extras). Vets stay proximity-sorted otherwise.
        │
        └─ PARKS/CAFÉS: COMMUNITY-ONLY — no raw nearby dump. Every recommended name is
                 resolved to a real place (reusing a nearby-list match, or a fresh Places
                 text search) so it has an address + coordinates, then sorted by live
                 distance from the searcher and capped at 7 by default (RECOMMEND_DEFAULT);
                 the rest are returned as `more_places`, revealed only via an explicit
                 "Show N more places" tap. If the community pass genuinely finds nothing for
                 that area, it falls back to the plain nearby list rather than a dead end —
                 the copy is honest that these are a fallback, not vetted picks.
```

Fail-soft + cached: the whole community layer times out at 12s and any error just returns the
plain Google places unchanged. Results are cached **per (category, area) for 7 days**
in-memory (`Map`, cleared on restart) — a locality label like "Wakad, Pimpri-Chinchwad" is
derived from the Places addresses themselves (`deriveLocality()`), so the same area isn't
re-searched on every request.

**Persistence:** a nearby-places result is saved as a chat turn (`structured_kind: 'places'`,
see §9) so the search shows up in the sidebar and survives a reload as live cards, not
degraded markdown.

---

## 14. Vet booking drafts over WhatsApp

Whoof never contacts a clinic itself — it only **drafts** a short appointment-request message
and hands the owner a one-tap `wa.me` deep link to review and send. This works for any
clinic regardless of their tech setup, with no booking integration required.

**Detecting the request** ([lib/bookingIntent.js](lib/bookingIntent.js)), same cheap-first
shape as place detection (§13):
- `looksLikeBooking()` — a fast regex gate ("book", "appointment", "schedule a visit"…),
  loose on purpose since the LLM stage rejects false hits.
- `detectBookingRequest()` — only runs behind the gate: confirms real booking intent and
  extracts the clinic name, resolving vague references ("this place", "the first one")
  against the recent chat and the owner's saved vets. No-LLM fallback does a regex grab
  ("book... at <name>").

**Drafting the message** ([lib/booking.js](lib/booking.js)): `draftBookingMessage()` writes a
short, polite, plain-text message via the fast model — names the dog with breed/age, mentions
a health reason **only** if the recent conversation clearly shows one (never invents a
symptom), asks for available slots, and never commits to a specific date/time or leaves a
bracketed placeholder. Falls back to a plain template if the LLM is unavailable or the output
looks broken (too short, or still has a `[placeholder]`).

**Resolving a phone number** — a saved vet (`pet_profile.vets`, §15) is checked first via
loose clinic-name matching (`clinicMatches()` — brand-word matching that ignores generic
words like "clinic"/"pet"/"hospital" so "Maxpetz Pet Clinic" matches "Maxpetz Jubilee
Hills"); if there's no saved match, `lib/vetFinder.js`'s `searchPlaceByText()` looks it up via
Google Places. No phone found → the owner still gets the drafted text plus a Google Maps
link, with a nudge to add the clinic's number under **My Vet**.

**Two entry points, same draft logic:**
- **In-chat**, end-to-end: `handleBookingRequest()` in `routes/chat.js` (§7 step 4) — confirms
  intent, resolves the clinic, drafts the message, and replies with the `wa.me` link (or asks
  which clinic, surfacing saved vets, if none was named).
- **Explicit endpoint**: `POST /api/vets/booking-draft` (used by the "Draft booking" button on
  a vet-finder result card) — same drafting logic, takes `clinic_name`/`clinic_phone`/
  `session_id` directly.

---

## 15. My Vet panel — saved vets & pre-visit summaries

A collapsible sidebar panel lets an owner save one or more regular vets and prepare for an
upcoming visit.

**Saved vets** — `pet_profile.vets` (jsonb array, migration 019; each entry
`{ id, name, clinic, phone, primary }`, exactly one flagged `primary`). This **supersedes**
the original single `vet_name`/`vet_clinic`/`vet_phone` columns from migration 018 — those
older columns are backfilled into the new array and left in place (harmless) rather than
dropped, so nothing broke mid-deploy. `PUT /api/vet/list` (`routes/chat.js`) validates and
saves the whole list (`normalizeVets()` caps at 10, sanitises each field, guarantees exactly
one primary).

**Visit tracking:**
- `POST /api/vet/mark-visit` — records a completed visit (`pet_profile.last_vet_visit_date`,
  defaults to today). If a scheduled `next_vet_visit_date` is now on/before this date, it's
  auto-cleared so a stale "upcoming appointment" doesn't linger.
- `POST /api/vet/schedule-visit` — sets or clears a future appointment date
  (`next_vet_visit_date`, migration 020), validated to be today or later.

**Pre-visit summaries** ([lib/vetSummary.js](lib/vetSummary.js), `POST /api/vet/summary`):
two artifacts generated together from one structured LLM call —
- **briefing** — 50–70 words of plain clinical prose for the vet, sent as a WhatsApp message
  to the primary saved vet's number (prefixed "Pre-visit summary for &lt;dog&gt;").
- **checklist** — 3–7 short bullet phrases the *owner* scans and raises in person.

Time range is either `since_visit` (turns strictly after `last_vet_visit_date`, falling back
to `history` if no visit has ever been logged) or `history` (last 6 months, capped at 100
turns).

**The critical accuracy boundary — this was a real bug, not a hypothetical:** the summariser
must only reflect the **owner's own reported words**, never the assistant's prior
explanatory answers. Testing found the briefing mining the AI's own general explanations
("ticks can cause X, Y, Z") and asserting them as things the dog was actually experiencing,
with no such report ever made. The fix, preserved deliberately:
- Only the owner's messages are fed to the summariser at all (`turnLine()`) — the assistant's
  replies are never included as input.
- Non-clinical noise (nearby-place searches, off-topic turns, `[system turns]`) is filtered
  out first (`isNoiseTurn()`), and the prompt states explicitly: **asking about a topic is
  never a report of having it** — "what are the symptoms of X?" must never become "the dog
  has X" in the output. Purely informational topics are reframed as the owner's *questions to
  raise*, never as conditions.
- The **no-LLM fallback** (`fallbackSummaries()`) is even stricter, since there's no model to
  reason about nuance: it uses ONLY turns with a hard clinical signal (an emergency escalation
  or an extracted symptom tag), never the raw recent-questions list, and says "no specific
  concerns — routine check-up" when nothing clinical was logged.
- Runs on the **fast** model deliberately — it's a separate Groq rate-limit bucket from the
  main answer model, so it actually completes during heavy testing instead of 429-ing and
  falling back.

---

## 16. Response feedback & the admin dashboard

A lightweight feedback **log for manual review** — not a training pipeline, and it can never
block or affect a live conversation.

**Submitting feedback** — `POST /api/chat/feedback` (`routes/chat.js`), body
`{ memory_id, rating, tags?, comment? }`:
- `rating` must be an integer 1–10 (`response_feedback.rating`, DB `CHECK` constrained).
- `tags` are filtered against a fixed vocabulary (`wrong_info`, `missed_pet_context`,
  `too_long`, `too_vague`, `misunderstood_question`, `tone_off`, `exactly_right`) — unknown
  tags are silently dropped, not rejected.
- **Ownership gate**: the turn must belong to the requesting owner's own pet (`conversation_
  memory` → `pet_profile.owner_id` JOIN) before any write — a tester can't rate, or even
  probe the existence of, another tester's turn.
- One row per turn: `response_feedback.memory_id` is both the primary key and an FK to
  `conversation_memory` (`ON DELETE CASCADE`), so resubmitting a rating is a natural
  `ON CONFLICT (memory_id) DO UPDATE` upsert.
- Feedback is hydrated back onto reloaded turns via a JOIN in the chat history query, and
  rendered as a settled "Thanks" state with an edit link on the AI bubble.

**The admin dashboard** ([routes/admin.js](routes/admin.js), `views/admin.ejs` /
`admin-login.ejs`): a simple password-gated view (`ADMIN_SECRET`, checked against
`req.session.adminAuth` — see §19) for browsing one tester's full turn history at a time,
with escalation flags, confidence levels, and any submitted rating/tags/comment, plus summary
stats (average rating, count of low ratings ≤4). The tester list is currently a small
hardcoded allowlist in the route (`rushiljohn10@gmail.com`, `tester123@gmail.com`) — widen
that intentionally, not by accident.

---

## 17. Excel export & the Groq daily-quota badge

Two small internal-ops features, both scoped to a **single tracked tester account**
(`rushiljohn10@gmail.com`) so they never appear for a real end customer.

**Live Excel export** ([lib/exportExcel.js](lib/exportExcel.js)) — writes
`whoof-responses.xlsx` (project root, gitignored) with one row per turn: date/time, owner,
email, pet, session title, question, answer, confidence, escalated, rating, tags, comment.
`writeExcel()` does a **full rewrite** of the sheet each time (simplicity over incremental
updates), called once at server startup and then fire-and-forget after every turn belonging
to the tracked email (`maybeUpdate(ownerId)` — a cheap email check keeps this a no-op for
everyone else). `EXCLUDED_EMAILS` lets specific testers (currently `tester123@gmail.com`) be
kept out of the sheet entirely, even if the query would otherwise include them.

**Groq daily-quota badge** ([lib/tokenUsage.js](lib/tokenUsage.js)) — Groq's API only exposes
a **per-minute** rate-limit bucket on successful responses; the **daily** cap that actually
causes visible outages only ever appears in the free text of a 429 error, with no endpoint to
query it proactively. So the app sums `usage.total_tokens` from every real Groq response
itself (hooked into `lib/llmProvider.js`'s Groq call path, see §4) and persists a running
per-model daily total in `token_usage_daily` (UTC calendar day; survives restarts, unlike an
in-memory counter). `GET /api/chat/quota` exposes this — but only when `LLM_PROVIDER=groq`
**and** the requesting owner's email matches the same tracked test account, since this is
really an ops signal about the whole app's *shared, per-organization* Groq limit, not
something meaningful to a real customer ("your personal tokens" isn't a real concept here).
The frontend renders it as a small badge, turning red (`quota-badge--low`) at ≤15% of the
main model's daily cap remaining.

---

## 18. Data model (Postgres schema)

Defined across `migrations/17000000000XX_*.js` (run with `npm run migrate:up`). The main
tables:

| Table | Purpose | Key columns |
|---|---|---|
| `owners` | the logged-in user | `email`, `access_code_hash`, `owner_name` |
| `pet_profile` | the dog | `owner_id`, `name`, `breed`, `date_of_birth`, diet/vax/surgery JSON, temperament, `vets` (jsonb array, §15), `last_vet_visit_date`, `next_vet_visit_date`… |
| `breed_reference` | breed facts (seeded) | `breed_name`, `common_conditions`, `weight_range_kg`, `temperament_notes` |
| `kb_chunks` | RAG knowledge base | `embedding vector(768)`, `fts_vector`, `content`, `source_title`, `section`, `page_number`, `chunk_type` |
| `conversation_session` | one chat thread | `pet_id`, `title`, `pending_decision` (jsonb), `pinned`, `last_active_at` |
| `conversation_memory` | one Q&A turn | `owner_question`, `answer_summary`, `sources_cited`, `confidence_level`, `escalated`, `structured_answer` (jsonb), `response_modality`, `structured_trigger`, `structured_kind`, `summarized`, `reply_to_memory_id` (§10) |
| `pet_memory` | rolling summary | `pet_id` (unique), `digest`, `updated_at` |
| `pet_decisions` | locked facts | `pet_id`, `decision_type`, `title`, `content` (jsonb), `status` (active/superseded) |
| `response_feedback` | tester ratings (§16) | `memory_id` (PK, FK→conversation_memory), `owner_id`, `rating` (1–10, CHECK), `tags[]`, `comment` |
| `token_usage_daily` | Groq quota tracking (§17) | `usage_date`, `model`, `tokens_used` — PK `(usage_date, model)` |
| `session` | express-session store | auto-created by connect-pg-simple |

`kb_chunks.embedding` is `vector(768)` to match the local model. The hybrid search needs
`fts_vector` (a generated `tsvector`) — that's migration 009. If you switch embedding models
you must change this dimension and re-ingest.

The structured-answer columns on `conversation_memory` come from migration
`016_structured-answers`; `reply_to_memory_id` from migration `021` (self-referencing FK,
`ON DELETE SET NULL`). The three memory/decision tables come from migrations 012–015.
`pet_profile.vets` supersedes the single-vet columns added in migration `018` (see §15,
migration `019`); `next_vet_visit_date` is migration `020`. `response_feedback` is migration
`017`; `token_usage_daily` is migration `022`.

---

## 19. Auth & sessions

Simple invite-based auth ([routes/auth.js](routes/auth.js)):

- An owner row has an `access_code_hash` (bcrypt). Login = email + access code →
  `bcrypt.compare` → set `req.session.ownerId`.
- No passwords, no signup — owners are seeded/invited. Access codes are handed out manually
  ("contact the Whoof team").
- The login page has a client-side **"Remember me"** checkbox that stashes the email + access
  code in `localStorage` (`whoof_remember`) purely for autofill convenience on that browser —
  this is a UX nicety, not a security mechanism; the server-side session is unaffected either
  way.
- `/dev-login` logs straight in as the seeded demo owner — **off by default regardless of
  environment**, gated behind `ENABLE_DEV_LOGIN=true` (not just `NODE_ENV`), so it can't be
  reached on a public tunnel as a passwordless bypass even outside production. Opt in only in
  a trusted local `.env`.
- Sessions live in Postgres, so they survive restarts.

`req.session.ownerId` is the only owner identity used app-wide; `requireAuth` enforces it.

**A separate admin auth** ([routes/admin.js](routes/admin.js), §16) protects `/admin`: a
single shared password (`ADMIN_SECRET`) checked on `POST /admin/login`, setting
`req.session.adminAuth = true`. Not tied to any owner account, and not gated by `requireAuth`
— it has its own `requireAdmin` middleware. In production, `ADMIN_SECRET` must be set or the
app fails to start (the dev fallback value is public knowledge in the source).

> ⚠️ **Testing caution:** onboarding is an upsert keyed on `owner_id`. Never POST to
> `/onboarding` or `/api/chat` under a real tester/demo account during automated testing —
> it overwrites their live data. Use a throwaway owner with a unique email and delete it
> after.

---

## 20. Config / environment variables

All in `.env` (gitignored). The ones that matter:

| Var | Default | Effect |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection (required) |
| `SESSION_SECRET` | dev fallback | session cookie signing — **required** when `NODE_ENV=production` |
| `PORT` | 3000 | HTTP port |
| `NODE_ENV` | — | `production` turns on secure cookies + trust-proxy, and makes a missing `SESSION_SECRET`/`ADMIN_SECRET` a hard startup error |
| `ADMIN_SECRET` | dev fallback (`whoof-admin`) | `/admin` dashboard password — **required** when `NODE_ENV=production` |
| `ENABLE_DEV_LOGIN` | unset (off) | set `true` only in a trusted local `.env` to enable the passwordless `/dev-login` shortcut |
| `LLM_PROVIDER` | `anthropic` | `groq` or `anthropic` — switches **all** text calls |
| `GROQ_API_KEY` | — | required if provider=groq |
| `GROQ_MODEL` / `GROQ_FAST_MODEL` | llama-3.3-70b / llama-3.1-8b | per-tier overrides |
| `ANTHROPIC_API_KEY` | — | required if provider=anthropic |
| `EMBEDDING_PROVIDER` | `local` | `local` (Transformers.js, no API) or `voyage` |
| `EMBEDDING_MODEL` | `Xenova/bge-base-en-v1.5` | local model (768-dim) |
| `VOYAGE_API_KEY` | — | needed for Voyage embeddings AND reranking |
| `ENABLE_RERANK` | unset (`false`) | `true` turns on Voyage cross-encoder reranking (per-message cost) |
| `GOOGLE_PLACES_API_KEY` | — | required for the nearby vets/parks/cafés Find feature (§13) and clinic phone lookups (§14) |
| `TAVILY_API_KEY` | — | required for the web-search KB fallback (§6a) and the community-picks layer (§13); both are simply skipped (fail-soft) if unset |

The provider split means a common setup is: **Groq for the LLM** (fast, cheap, the
`llama` models — note the low rate limits, hence the quota badge in §17)
**+ local embeddings** (free, no rate limit).

---

## 21. Frontend

No framework — server-rendered EJS pages plus one vanilla JS controller
(`public/chat-client.js`, ~1,800 lines).

- `views/chat.ejs` renders the page and any **persisted** turns. A stored structured card
  (including a `structured_kind: 'places'` turn, §13) is re-rendered from a `data-structured`
  attribute on reload.
- `public/chat-client.js` runs the live chat: capture input, parse slash commands
  (`parseFormatCommand`, mirroring the server), optimistic user bubble (`appendUserMessage`),
  POST to `/api/chat/message` (`postMessage`), render the reply. Beyond the core loop it also
  drives:
  - the triage chip UI and the decision-offer popup (with direct confirm/dismiss buttons,
    §11);
  - `renderStructuredAnswer()` — one generic renderer for the StructuredAnswer schema, reused
    for `/visualise` cards and nearby-places result cards;
  - the **"Reply"** button that appears on hover (desktop) or is always visible (touch) on
    any past AI answer, showing a quoted preview above the composer until sent or cancelled
    (§10);
  - the **feedback widget** (rating scale + tag chips + comment, settling into a "Thanks"
    state) on each AI answer (§16);
  - the **My Vet** sidebar panel — saved vets, mark/schedule a visit, and the "Prep for vet
    visit" summary flow with a time-range toggle (§15);
  - the **location button**'s 3-card category picker (Vets/Parks/Cafés) and the "Draft
    booking" button on a vet result card (§13/§14);
  - the **Groq quota badge**, shown only when `GET /api/chat/quota` reports `visible: true`
    (§17);
  - dark/light theme toggle (`localStorage` + `prefers-color-scheme` fallback, anti-flicker
    inline script in every view).
- `views/login.ejs` adds a client-side "Remember me" checkbox (§19) that persists
  email + access code in `localStorage` for autofill — not a server-side mechanism.
- `views/admin.ejs` / `admin-login.ejs` render the internal dashboard (§16) — plain
  server-rendered tables, no client JS of note.
- `public/style.css` holds all styling (design tokens as CSS variables, Cabinet Grotesk
  font, dark/light theme).

> **Reload rules:** route/lib edits need a server restart (or run `npm run dev` =
> `node --watch`); client JS/CSS edits just need a browser hard-refresh (Cmd+Shift+R).

---

## 22. "Where do I change X?"

| I want to… | Edit |
|---|---|
| Change when the bot asks clarifying questions | `buildTriageSystem()` + `needs_clarification` description in `lib/triage.js` |
| Add a new slash command | `FORMAT_COMMANDS` in **both** `routes/chat.js` and `public/chat-client.js` |
| Change the assistant's tone / rules / emergency list | `buildSystemPrompt()` in `lib/llm.js` |
| Add fields to the card layout | `STRUCTURED_ANSWER_SCHEMA` + `validateStructuredAnswer()` in `lib/structured.js`, and `renderStructuredAnswer()` in `public/chat-client.js` |
| Re-enable model-chosen cards | the answer branch in `routes/chat.js` step 9i (§9) |
| Swap LLM provider or model | `.env` (`LLM_PROVIDER`, `*_MODEL`) — no code change |
| Change the embedding model | `EMBEDDING_MODEL` in `.env` **+ a migration to change `vector(N)` + re-ingest everything** |
| Tune retrieval (k, RRF, reranking) | `lib/rag.js` (`hybridSearch`, `retrieveChunks`, `ENABLE_RERANK`) |
| Tune when the web-search fallback fires | the `kbWeak` / `wantsExternal` logic in `routes/chat.js` (§6a) |
| Add knowledge | drop PDF in `kb-source/` → `bash scripts/ingest-all-pdfs.sh` |
| Change what's remembered across chats | `lib/memory.js` (rolling summary) |
| Change save-decision behaviour | `lib/decisions.js` + the `/decision/*` routes in `routes/chat.js` |
| Change when chat-typed place questions get routed to Find | `lib/placeIntent.js` |
| Change how community picks are sourced/ranked | `lib/communityPicks.js` |
| Change when a message is treated as a booking request | `lib/bookingIntent.js` |
| Change the booking-message wording | `lib/booking.js` |
| Change the vet-visit briefing/checklist content or accuracy rules | `lib/vetSummary.js` |
| Add/remove a feedback tag | `FEEDBACK_TAGS` in `routes/chat.js` (server) — mirror in the frontend widget |
| Change who can see the admin dashboard / tracked-tester features | the tester allowlists in `routes/admin.js`, `lib/exportExcel.js`, and `routes/chat.js`'s `QUOTA_VISIBLE_EMAIL` |
| Change the DB schema | add a `migrations/…js` file, then `npm run migrate:up` |

---

### A note on resilience

Almost every external call **fails open**: no LLM key → triage/rewrite/summary skip and the
answer still goes out; retrieval errors → answer without KB; web search unconfigured or
erroring → skipped, no web-grounded badge; reranking errors → use hybrid order; a malformed
card → degrade to its `fallbackText` → degrade to plain text; a booking/place-intent detector
with no LLM key → falls back to a plain regex guess rather than blocking the message; the
community-picks layer times out or errors → plain Google places, unchanged. This is why the
app keeps working even when a provider is rate-limited (you'll see warnings in the logs, not
crashes).
