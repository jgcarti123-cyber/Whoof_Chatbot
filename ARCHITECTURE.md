# Whoof Vet AI — Architecture & Flow

A complete walkthrough of how Whoof works end-to-end, written so you can understand the
flow and confidently make future changes. Every section points at the real files and
functions.

> **TL;DR of the stack:** Node.js + Express 5 (no framework magic), EJS server-rendered
> views, vanilla JS frontend, PostgreSQL 17 + `pgvector` for hybrid RAG. LLM calls go
> through one swappable provider layer (Groq **or** Anthropic). Embeddings run locally
> (no API) by default. There is no React, no build step, no ORM.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [Tech stack & where everything lives](#2-tech-stack--where-everything-lives)
3. [Backend structure — how Node/Express is wired](#3-backend-structure--how-nodeexpress-is-wired)
4. [The LLM provider abstraction](#4-the-llm-provider-abstraction)
5. [Hybrid RAG — ingestion](#5-hybrid-rag--ingestion)
6. [Hybrid RAG — retrieval](#6-hybrid-rag--retrieval)
7. [The chat request lifecycle (the heart of the app)](#7-the-chat-request-lifecycle)
8. [Triage — asking the owner clarifying questions](#8-triage--asking-the-owner-clarifying-questions)
9. [Structured output & the `/visualise` command](#9-structured-output--the-visualise-command)
10. [The three kinds of memory](#10-the-three-kinds-of-memory)
11. [Decisions — durable saved facts](#11-decisions--durable-saved-facts)
12. [The system prompt](#12-the-system-prompt)
13. [Data model (Postgres schema)](#13-data-model-postgres-schema)
14. [Auth & sessions](#14-auth--sessions)
15. [Config / environment variables](#15-config--environment-variables)
16. [Frontend](#16-frontend)
17. ["Where do I change X?" — a practical guide](#17-where-do-i-change-x)

---

## 1. The big picture

Whoof is a veterinary chat assistant for dog owners. The owner logs in, fills a pet
profile, and asks questions. Every answer is shaped by:

- **The dog's profile** (breed, age, diet, history) — injected directly into the prompt.
- **A curated knowledge base** of vet guideline PDFs — retrieved per question via hybrid
  search (RAG).
- **Memory** of past conversations and saved decisions — injected as plain fact.

A single answer can therefore combine retrieved guideline material, breed facts, the dog's
profile, and remembered decisions — all assembled into one system prompt that a language
model turns into a reply.

```
                       ┌─────────────────────────────────────────────┐
   Owner's question →  │  POST /api/chat/message  (routes/chat.js)   │
                       └─────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼───────────────────────────────────────┐
        ▼                     ▼                     ▼                   ▼
  Emergency check       Triage (haiku)        RAG retrieval       Memory load
  (keyword scan)        pet-related?          rewrite→embed→      decisions +
        │               needs questions?      hybrid search       rolling summary
        │                     │               (pgvector+FTS)            │
        └─────────────────────┴───────────────────┬─────────────────────┘
                                                   ▼
                                       buildSystemPrompt()  (lib/llm.js)
                                                   ▼
                            generateAnswer()  /  generateRoutedAnswer()
                              (plain text)        (structured card, /visualise only)
                                                   ▼
                              persist turn → conversation_memory
                                                   ▼
                                        JSON response → frontend
```

---

## 2. Tech stack & where everything lives

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js ≥18 | `server.js` is the entry point |
| HTTP | Express 5 | `app.use('/', require('./routes/...'))` |
| Views | EJS | server-rendered `views/*.ejs` |
| Frontend | Vanilla JS + CSS | `public/chat-client.js`, `public/style.css` |
| DB | PostgreSQL 17 + `pgvector` | accessed via `pg` Pool, no ORM |
| Migrations | `node-pg-migrate` | `migrations/17000000000XX_*.js` |
| Sessions | `express-session` + `connect-pg-simple` | stored in a Postgres `session` table |
| LLM | Groq **or** Anthropic | switched by `LLM_PROVIDER` |
| Embeddings | local Transformers.js **or** Voyage | switched by `EMBEDDING_PROVIDER` |
| PDF parsing | Python (PyMuPDF + pdfplumber) | `scripts/parse_pdf.py`, called by the ingest script |

**Directory map**

```
server.js              App bootstrap: middleware, session, route mounting, /health
db.js                  Single pg Pool; exports { pool, query }
middleware/
  requireAuth.js       Gate: redirects to /login if no session.ownerId
routes/
  auth.js              /login, /logout, /dev-login
  profile.js           Onboarding + pet profile read/write
  chat.js              THE core: POST /api/chat/message + chat pages   (599 lines)
lib/
  llmProvider.js       Provider switch (Groq/Anthropic). 4 primitives.
  llm.js               System-prompt builder + answer generation + routing
  rag.js               Retrieval: rewrite → embed → hybrid search → rerank
  embeddings.js        Local/Voyage embeddings (used by BOTH ingest & retrieval)
  triage.js            Pre-answer classifier (pet-related? needs questions?)
  structured.js        StructuredAnswer JSON Schema + validator (the card contract)
  decisions.js         Detect/save/load "locked decisions"
  memory.js            One rolling summary per pet across past chats
scripts/
  ingest-all-pdfs.sh   Batch-ingest every PDF in kb-source/
  ingest-kb-pdf.js     One PDF → parse → vision → embed → kb_chunks
  parse_pdf.py         PDF → structured JSON (chunks + extracted figures)
views/                 login.ejs, onboarding.ejs, chat.ejs
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
`req.session.ownerId`.

**Database access** is deliberately thin ([db.js](db.js)): one shared `pg.Pool` reading
`DATABASE_URL`, exposing `query(text, params)`. Every module does raw parameterised SQL —
there is no ORM, so to understand a query you just read the SQL.

There are **three route files**:

- `routes/auth.js` — login (email + bcrypt-hashed access code), logout, and a dev-only
  `/dev-login` shortcut.
- `routes/profile.js` — onboarding form + pet profile CRUD.
- `routes/chat.js` — the chat pages **and** the one endpoint that does all the work:
  `POST /api/chat/message`. Everything interesting flows through here.

---

## 4. The LLM provider abstraction

**Every** LLM call in the app goes through [lib/llmProvider.js](lib/llmProvider.js). This is
the single switch point: set `LLM_PROVIDER=groq` for Groq's open models, or leave it
`anthropic` for Claude. The rest of the code never talks to a provider SDK directly.

> **Important:** embeddings and reranking are **not** here — those always go to Voyage or
> the local model (Groq has no embeddings API). So the app can run on Groq for text while
> embeddings run locally. That split is by design.

There are **three model tiers** (each overridable by env):

| Tier | Groq default | Anthropic default | Used for |
|---|---|---|---|
| main | `llama-3.3-70b-versatile` | `claude-sonnet-4-6` | the actual vet answer |
| fast | `llama-3.1-8b-instant` | `claude-haiku-4-5` | triage, query rewrite, titles, summaries, decision detection |
| vision | `llama-4-scout-17b` | `claude-haiku` | figure descriptions during ingestion |

The provider exposes **four primitives** — learn these and you understand every model call:

1. `generate({ system, user, maxTokens, fast })` → plain text. (chat answers, query rewrite, titles, summaries)
2. `generateStructured({ system, user, tool, fast })` → forces **one** tool and returns its parsed args. (triage classifier, decision detector)
3. `generateRouted({ system, user, tools, force })` → offers several tools and lets the model pick one (or forces one with `force`). (text-vs-card routing)
4. `describeImage({ imagePath, prompt })` → vision caption. (ingestion)

Each primitive maps the same call onto the Anthropic Messages API **or** the Groq
OpenAI-compatible `chat/completions` API. `isConfigured()` reports whether the active
provider has a key — used everywhere for **fail-open** behaviour (if there's no key or the
call errors, the app degrades gracefully instead of crashing).

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
  │  and extracts figure images to disk.
  ▼
Vision pass  (for chunk_type === 'figure')
  │  each figure image → provider.describeImage() → a clinical caption,
  │  appended to the chunk's text as "Visual description: …".
  │  Low-confidence ones (logos/diagrams) are flagged for review.
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

## 6. Hybrid RAG — retrieval

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

---

## 7. The chat request lifecycle

This is the whole app in one function: `POST /api/chat/message` in
[routes/chat.js](routes/chat.js). Here is the exact order of operations.

```
1.  Parse input
      rawMessage = body.message
      parseFormatCommand(rawMessage) → { modality, cleaned }
      message        = cleaned text (command stripped, used for LLM/retrieval)
      forceStructured = body.force_structured OR a /visualise command was present
      clarifications  = body.clarifications (owner's triage answers, 2nd round only)

2.  Load pet  (JOIN owners)        → 400 if the owner has no pet profile

3.  Pending decision offer?  (only if no clarifications)
      If the bot just offered to save a decision in this chat:
        owner said "yes"  → saveDecision() + confirm   (return)
        owner said "no"   → clear the offer + acknowledge (return)
        anything else     → offer lapses, continue normally

4.  enriched = message + clarifying answers   (used for emergency scan + retrieval)

5.  Emergency check     checkEmergency(enriched)  → escalated (keyword match)
      Emergencies SHORT-CIRCUIT triage and always answer immediately in plain text.

6.  Triage   (first submit only, not for emergencies)   → triageQuestion(message, pet)
      not pet-related     → polite decline, no expensive answer call   (return)
      needs_clarification → return clarifying questions, don't answer yet (return)
      otherwise           → fall through to the answer path

7.  Answer path
      a. lookupBreed(pet.breed)               (direct SQL)
      b. resolveSession()                     (this turn's chat; creates one if new)
      c. recentHistory = last 5 turns of THIS chat
      d. [decisions, rollingSummary]          (cross-chat memory, in parallel)
      e. retrieveChunks(enriched, 5)          (the RAG step from §6)
      f. buildSystemPrompt(pet, chunks, history, breed, {clarifications, decisions, summary, ownerName})
      g. ANSWER:
            forceStructured && !escalated
              ? generateRoutedAnswer(..., { force:'structured' })   → a CARD
              : generateAnswer(...)                                  → plain TEXT
         (Cards are OPT-IN — only the /visualise command makes one. See §9.)
      h. Sources & confidence attach ONLY to KB-grounded clinical answers
         (not recall answers, not when retrieval was too weak).
      i. detectDecision()  → maybe park a save-offer on the session (see §11)
      j. persistTurn()     → write the turn to conversation_memory
                              (stores the RAW message so "/visualise" shows on reload)
      k. respond with JSON; fire-and-forget rollUpInactiveChats() (memory, §10)
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
**not** for emergencies. Wired at `routes/chat.js` step 6.

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
  → generateRoutedAnswer(systemPrompt, message, { force: 'structured' })
  the raw "/visualise …" text is STORED as the owner_question (so it persists on reload)

lib/llm.js → generateRoutedAnswer()
  offers TEXT_TOOL + STRUCTURED_TOOL; force compels send_structured_reply
  validates the result; on any problem degrades to fallbackText, then to a plain answer
```

**Telemetry:** every turn records `response_modality` ('text'|'structured'),
`structured_trigger` (now always 'command' when a card appears), and `structured_kind` on
`conversation_memory`.

**To add another command** (e.g. `/steps`, `/table`): add one entry to the `FORMAT_COMMANDS`
array — it exists in **both** `routes/chat.js` (authority) and `public/chat-client.js`
(optimistic UI + hint). The answer flow doesn't change.

**To re-enable model-chosen cards:** in `routes/chat.js` step 7g, change the branch back to
call `generateRoutedAnswer(..., forceStructured ? {force:'structured'} : {})` so the model
can pick `send_structured_reply` on its own again.

---

## 10. The three kinds of memory

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
3.  The owner's NEXT message:
      isAffirmation() ("yes", "do it", 👍)  → saveDecision() writes it
      isDecline()     ("no", "later")        → clear the offer
      anything else                          → offer lapses, message answered normally
```

`saveDecision()` supersedes any previous **active** decision of the same type (keeps old ones
as `status='superseded'` for audit), so only the newest is asserted. `loadActiveDecisions()`
pulls active ones into every prompt.

A structured card can also carry a `save_decision` action button, so the card owns its own
save UI — that's why the legacy popup is skipped when the answer is structured
(`routes/chat.js` step 7i checks `!structuredAnswer`).

---

## 12. The system prompt

`buildSystemPrompt()` in [lib/llm.js](lib/llm.js) assembles everything into one prompt. It's
worth reading once — it's where the assistant's personality and rules live. Sections, in
order:

1. **Identity & rules** — "You are Whoof AI…", stay-in-lane (dogs only), don't cite sources
   inline, recall-vs-clinical distinction, and the **emergency rule** (lead with
   "⚠️ URGENT" for poisoning, breathing trouble, collapse, seizures, etc.).
2. **Patient profile** — `buildPetSummary()` turns the `pet_profile` row into prose (age,
   breed, weight, diet, allergies, vaccinations, meds, surgeries, temperament…).
3. **Owner name** — so it can address them personally.
4. **Breed context** — from `breed_reference` (predispositions, life expectancy, temperament).
5. **Saved decisions** — asserted facts, marked authoritative.
6. **Rolling summary** — "what you remember about Monkey from past conversations".
7. **Earlier in this chat** — the last 5 turns verbatim.
8. **Clarification answers** — the owner's triage answers, if this is the 2nd round.
9. **Relevant reference material** — the retrieved KB chunks, numbered with their
   section/page (but the model is told **not** to cite them inline — sources are shown
   separately in the UI).

When you want to change tone, guardrails, or what context the model sees, this function is
the place.

---

## 13. Data model (Postgres schema)

Defined across `migrations/17000000000XX_*.js` (run with `npm run migrate:up`). The main
tables:

| Table | Purpose | Key columns |
|---|---|---|
| `owners` | the logged-in user | `email`, `access_code_hash`, `owner_name` |
| `pet_profile` | the dog | `owner_id`, `name`, `breed`, `date_of_birth`, diet/vax/surgery JSON, temperament… |
| `breed_reference` | breed facts (seeded) | `breed_name`, `common_conditions`, `weight_range_kg`, `temperament_notes` |
| `kb_chunks` | RAG knowledge base | `embedding vector(768)`, `fts_vector`, `content`, `source_title`, `section`, `page_number`, `chunk_type` |
| `conversation_session` | one chat thread | `pet_id`, `title`, `pending_decision` (jsonb), `pinned`, `last_active_at` |
| `conversation_memory` | one Q&A turn | `owner_question`, `answer_summary`, `sources_cited`, `confidence_level`, `escalated`, `structured_answer` (jsonb), `response_modality`, `structured_trigger`, `structured_kind`, `summarized` |
| `pet_memory` | rolling summary | `pet_id` (unique), `digest`, `updated_at` |
| `pet_decisions` | locked facts | `pet_id`, `decision_type`, `title`, `content` (jsonb), `status` (active/superseded) |
| `session` | express-session store | auto-created by connect-pg-simple |

`kb_chunks.embedding` is `vector(768)` to match the local model. The hybrid search needs
`fts_vector` (a generated `tsvector`) — that's migration 009. If you switch embedding models
you must change this dimension and re-ingest.

The structured-answer columns on `conversation_memory` come from migration
`016_structured-answers`. The three memory/decision tables come from migrations 012–015.

---

## 14. Auth & sessions

Simple invite-based auth ([routes/auth.js](routes/auth.js)):

- An owner row has an `access_code_hash` (bcrypt). Login = email + access code →
  `bcrypt.compare` → set `req.session.ownerId`.
- No passwords, no signup — owners are seeded/invited. Access codes are handed out manually
  ("contact the Whoof team").
- `/dev-login` logs straight in as the demo owner — **disabled when `NODE_ENV=production`**.
- Sessions live in Postgres, so they survive restarts.

`req.session.ownerId` is the only identity used app-wide; `requireAuth` enforces it.

> ⚠️ **Testing caution:** onboarding is an upsert keyed on `owner_id`. Never POST to
> `/onboarding` or `/api/chat` under a real tester/demo account during automated testing —
> it overwrites their live data. Use a throwaway owner with a unique email and delete it
> after.

---

## 15. Config / environment variables

All in `.env` (gitignored). The ones that matter:

| Var | Default | Effect |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection (required) |
| `SESSION_SECRET` | dev fallback | session cookie signing |
| `PORT` | 3000 | HTTP port |
| `LLM_PROVIDER` | `anthropic` | `groq` or `anthropic` — switches **all** text/vision calls |
| `GROQ_API_KEY` | — | required if provider=groq |
| `GROQ_MODEL` / `GROQ_FAST_MODEL` / `GROQ_VISION_MODEL` | llama-3.3-70b / llama-3.1-8b / llama-4-scout | per-tier overrides |
| `ANTHROPIC_API_KEY` | — | required if provider=anthropic |
| `ANTHROPIC_MODEL` / `ANTHROPIC_FAST_MODEL` | sonnet-4-6 / haiku-4-5 | per-tier overrides |
| `EMBEDDING_PROVIDER` | `local` | `local` (Transformers.js, no API) or `voyage` |
| `EMBEDDING_MODEL` | `Xenova/bge-base-en-v1.5` | local model (768-dim) |
| `VOYAGE_API_KEY` | — | needed for Voyage embeddings AND reranking |
| `ENABLE_RERANK` | unset | `true` turns on Voyage cross-encoder reranking (per-message cost) |
| `NODE_ENV` | — | `production` disables `/dev-login` |

The provider split means a common setup is: **Groq for the LLM** (fast, cheap, the
`llama` models — note the low rate limits) **+ local embeddings** (free, no rate limit).

---

## 16. Frontend

No framework — server-rendered EJS pages plus one vanilla JS controller.

- `views/chat.ejs` renders the page and any **persisted** turns. A stored structured card is
  re-rendered from a `data-structured` attribute on reload.
- `public/chat-client.js` runs the live chat: capture input, parse slash commands
  (`parseFormatCommand`, mirroring the server), optimistic user bubble (`appendUserMessage`),
  POST to `/api/chat/message` (`postMessage`), render the reply. A structured reply is drawn
  by `renderStructuredAnswer()` (one generic renderer for the StructuredAnswer schema). It
  also handles the triage chip UI, the decision-offer popup, sources/confidence display, and
  the `/visualise` typeahead + bare-command nudge.
- `public/style.css` holds all styling (design tokens as CSS variables, Cabinet Grotesk
  font, dark/light theme).

> **Reload rules:** route/lib edits need a server restart (or run `npm run dev` =
> `node --watch`); client JS/CSS edits just need a browser hard-refresh (Cmd+Shift+R).

---

## 17. "Where do I change X?"

| I want to… | Edit |
|---|---|
| Change when the bot asks clarifying questions | `buildTriageSystem()` + `needs_clarification` description in `lib/triage.js` |
| Add a new slash command | `FORMAT_COMMANDS` in **both** `routes/chat.js` and `public/chat-client.js` |
| Change the assistant's tone / rules / emergency list | `buildSystemPrompt()` in `lib/llm.js` |
| Add fields to the card layout | `STRUCTURED_ANSWER_SCHEMA` + `validateStructuredAnswer()` in `lib/structured.js`, and `renderStructuredAnswer()` in `public/chat-client.js` |
| Re-enable model-chosen cards | the answer branch in `routes/chat.js` step 7g |
| Swap LLM provider or model | `.env` (`LLM_PROVIDER`, `*_MODEL`) — no code change |
| Change the embedding model | `EMBEDDING_MODEL` in `.env` **+ a migration to change `vector(N)` + re-ingest everything** |
| Tune retrieval (k, RRF, reranking) | `lib/rag.js` (`hybridSearch`, `retrieveChunks`, `ENABLE_RERANK`) |
| Add knowledge | drop PDF in `kb-source/` → `bash scripts/ingest-all-pdfs.sh` |
| Change what's remembered across chats | `lib/memory.js` (rolling summary) |
| Change save-decision behaviour | `lib/decisions.js` |
| Change the DB schema | add a `migrations/…js` file, then `npm run migrate:up` |

---

### A note on resilience

Almost every external call **fails open**: no LLM key → triage/rewrite/summary skip and the
answer still goes out; retrieval errors → answer without KB; reranking errors → use hybrid
order; a malformed card → degrade to its `fallbackText` → degrade to plain text. This is why
the app keeps working even when a provider is rate-limited (you'll see warnings in the logs,
not crashes).
