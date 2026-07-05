# CLAUDE.md — Prim Pets

Instructions for Claude Code working in this repo. Read this before making any change.
Full architecture detail lives in `ARCHITECTURE.md` (24 sections) — read the relevant
section there before touching a system you don't already understand; don't re-derive it
from scratch.

> **Naming note:** the product rebranded from "Whoof" to "Prim Pets" partway through
> development. Several internal identifiers still literally say "whoof" and were
> deliberately left alone: the npm package name (`whoof-vet-ai-db`), the seeded demo
> account's email domain (`demo.owner@whoof.example`), and the exported spreadsheet
> filenames (`whoof-responses.xlsx`, `whoof-commit-log.xlsx`). Grep for both names if
> you're not finding something.

## 0. Operating rules (read first)

These govern *how* you work here, independent of any specific task:

1. **Minimal diffs only.** Change only the lines needed to satisfy the request. Don't
   refactor, rename, reformat, or "clean up" adjacent code that wasn't asked for. Prefer
   editing a function over rewriting a file.
2. **No unnecessary code or agents.** Don't write exploratory scripts, don't spin up
   subagents/Task-tool calls, and don't generate alternate versions "just in case." If the
   fix is a 3-line change, make a 3-line change.
3. **No dev server / preview unless asked.** Don't run `npm run dev`, `npm start`, open a
   browser, or otherwise preview the running app on your own initiative. Only do this when
   explicitly told to preview or test something live.
4. **Never touch real accounts.** Never `POST` to `/onboarding` or `/api/chat/message`
   under a real tester/demo owner account while testing — onboarding is an upsert keyed on
   `owner_id` and will overwrite live data. Use a throwaway owner with a unique email, and
   delete it after. (This is an existing project rule, not a new one — see §19 of
   `ARCHITECTURE.md`.)
5. **Don't run migrations or ingestion against the real DB** unless asked to. `npm run
   migrate:up` and `scripts/ingest-all-pdfs.sh` both mutate persistent state.
6. **Preserve the architecture.** The patterns below are deliberate, several were arrived
   at after real bugs (see the commit log excerpts in §5). Don't restructure the LLM
   provider abstraction, the RAG pipeline, the memory system, the opt-in structured
   answers, or the Find/booking/vet-panel subsystems unless the user explicitly asks for
   that change.
7. **When unsure, ask or make the smallest reversible change.** Don't guess at product
   intent for anything touching the system prompt, triage rules, or auth.
8. **Before trusting a local test result, check which database you actually just hit.**
   This bit us for real: a local terminal had `DATABASE_URL` exported to Render (left over
   from an ingest/seed run) while the browser pointed at `localhost:3000` — so "local"
   testing was silently reading/writing the **Render** database the whole time, and a
   passing check in one shell didn't mean the running server agreed. If a local script's
   result and what the running app shows disagree, verify with `ps eww <pid> | grep
   DATABASE_URL` on the actual server process before assuming a code bug (see
   `ARCHITECTURE.md` §23).

## 1. What this app is

Prim Pets is a veterinary chat assistant for dog owners (India-focused). Owner logs in (or
requests access via self-serve signup — `ARCHITECTURE.md` §19), fills a pet profile, and
asks questions. Every answer is shaped by: the dog's profile, a curated vet-guideline
knowledge base (retrieved via hybrid RAG, with a live web-search fallback), and memory of
past conversations/decisions — assembled into one system prompt per message.

Beyond that core Q&A loop, Prim Pets also acts as a small concierge: it finds real nearby
vets/parks/cafés, drafts WhatsApp vet-booking messages, tracks saved vets and generates
pre-visit briefings, and logs tester feedback to an admin dashboard + a live Excel export.
See §2 for how these fit together.

Stack: Node.js + Express 5, EJS server-rendered views, vanilla JS frontend, PostgreSQL 17
+ pgvector. No React, no build step, no ORM. LLM calls go through one swappable provider
layer (Groq or Anthropic, `LLM_PROVIDER` env var). Embeddings run locally by default in dev
(Transformers.js, no build step required) — the **deployed** instance on Render runs Voyage
AI embeddings instead, because the free web service's 512MB RAM cap can't hold the local
model in-process (see `ARCHITECTURE.md` §18/§23). Hosted on Render (free tier); see §10
below and `DEPLOY.md`.

## 2. System structure at a glance

Read `ARCHITECTURE.md` for the full detail behind each of these — this is just the map so
you know which subsystem a task belongs to before you go looking:

| Subsystem | What it does | Core files | `ARCHITECTURE.md` |
|---|---|---|---|
| **Chat request lifecycle** | The one endpoint (`POST /api/chat/message`) that pending-decision, booking, and place checks, emergency check, triage, RAG, and answer generation all flow through, in that order | `routes/chat.js` | §7 |
| **LLM provider abstraction** | Single switch point for Groq/Anthropic; 4 primitives every model call goes through | `lib/llmProvider.js` | §4 |
| **Hybrid RAG (ingestion + retrieval)** | PDF → chunks → embeddings → `kb_chunks`; per-message vector+FTS fusion (RRF), optional rerank, web-search fallback when the KB is weak | `lib/rag.js`, `lib/embeddings.js`, `lib/webSearch.js`, `scripts/ingest-*` | §5, §6 |
| **Triage** | Fast classifier: pet-related? needs clarifying questions before answering? | `lib/triage.js` | §8 |
| **Structured output (`/visualise`)** | Opt-in card layout; text is the default for everything else | `lib/structured.js`, `lib/llm.js` | §9 |
| **Memory** | Within-chat history (last 5), one rolling cross-chat summary per pet, locked decisions, and reply-to-a-specific-answer targeting | `lib/memory.js`, `lib/decisions.js`, `routes/chat.js` | §10, §11 |
| **System prompt** | Assembles everything above into one prompt; the one place tone/rules/formatting live | `lib/llm.js` (`buildSystemPrompt`) | §12 |
| **Find nearby places** | Vets/parks/cafés via Google Places, with a community-recommendation layer; chat-typed place questions route into the same pipeline | `lib/vetFinder.js`, `lib/communityPicks.js`, `lib/placeIntent.js` | §13 |
| **Vet booking drafts** | Detects a booking request, drafts a WhatsApp message, resolves the clinic's phone | `lib/bookingIntent.js`, `lib/booking.js` | §14 |
| **My Vet panel** | Saved vets, visit tracking, pre-visit clinical briefing + owner checklist | `lib/vetSummary.js`, `routes/chat.js` | §15 |
| **Feedback & admin** | Tester ratings on each turn; password-gated dashboard with a Users panel (every owner + access code + delete action) and a turn viewer | `routes/admin.js`, `views/admin*.ejs` | §16 |
| **Excel export & Groq quota badge** | Ops-only tooling scoped to one tracked test account | `lib/exportExcel.js`, `lib/tokenUsage.js` | §17 |
| **Self-serve signup** | Request-access form on the login page; creates the owner + a generated access code the admin relays | `routes/auth.js`, `views/login.ejs` | §19 |
| **Rate limiting** | In-memory sliding-window limiter on login/signup/admin-login/delete-user | `middleware/rateLimit.js` | §24 |

## 3. Directory map

```
server.js              App bootstrap: middleware, session, route mounting, /health
db.js                  Single pg Pool; exports { pool, query }
middleware/
  requireAuth.js       Gate: redirects to /login if no session.ownerId
  rateLimit.js         In-memory sliding-window limiter (login/signup/admin, §24)
routes/
  auth.js              /login, /signup, /logout, /dev-login (opt-in via ENABLE_DEV_LOGIN, off by default)
  profile.js           Onboarding + pet profile read/write
  chat.js              THE core: POST /api/chat/message + chat pages + Find/booking/vet-panel/feedback endpoints (~1,350 lines)
  admin.js             Password-gated /admin dashboard: Users panel + turn viewer (separate auth from owner sessions)
lib/
  llmProvider.js       Provider switch (Groq/Anthropic) — the ONLY place that calls a model SDK
  llm.js               System-prompt builder + answer generation + text/card routing
  rag.js               Retrieval: rewrite → embed → hybrid search (RRF) → optional rerank
  embeddings.js        Local/Voyage embeddings — used by BOTH ingest and retrieval
  triage.js            Pre-answer classifier (pet-related? needs clarifying questions?)
  structured.js        StructuredAnswer JSON Schema + validator (the /visualise card contract)
  decisions.js         Detect/save/load "locked decisions" (durable saved facts)
  memory.js            One rolling summary per pet, across past chats
  placeIntent.js       Detects chat-typed place questions → routes into Find pipeline
  bookingIntent.js     Detects vet-booking requests → WhatsApp booking draft flow
  booking.js           Drafts the WhatsApp booking message text
  communityPicks.js    Community-recommended vets/parks/cafes layer (Tavily + Google Places)
  webSearch.js         Tavily fallback for external-info questions the KB can't answer, and the community-picks search source
  vetFinder.js         Google Places nearby search + text search (vets/parks/cafes)
  vetSummary.js        Pre-vet-visit clinical briefing + owner checklist generation
  tokenUsage.js        Tracks Groq daily token usage against published free-tier caps
  exportExcel.js       Writes whoof-responses.xlsx for the tracked tester account
scripts/               ingest-all-pdfs.sh, ingest-kb-pdf.js, parse_pdf.py, seed-owners.js,
                       backfill-access-codes.js (generates a code for owners created
                       before that column existed — running it replaces their working
                       code, see ARCHITECTURE.md §19),
                       generate-commit-log.js (regenerates whoof-commit-log.xlsx via a
                       post-commit git hook — don't hand-edit that file)
views/                 login.ejs, onboarding.ejs, chat.ejs, admin.ejs, admin-login.ejs
public/                chat-client.js (~1,830 lines), style.css + chat-light.css (light-theme
                       overrides for the chat page), Cabinet Grotesk font
kb-source/             Source guideline PDFs
migrations/            Ordered DB schema migrations (node-pg-migrate), 25 so far
render.yaml            Render Blueprint: web service + managed Postgres (§10, ARCHITECTURE.md §23)
DEPLOY.md               Render deployment walkthrough
SECURITY.md             Summary of the security-hardening pass (§11, ARCHITECTURE.md §24)
```

Full request lifecycle, RAG internals, memory model, and data schema: see
`ARCHITECTURE.md` sections 5–18. Don't paraphrase or re-derive these from source when the
doc already explains them — read the relevant section instead.

## 4. Locked product behavior — do not weaken without being asked

The chatbot's answers must stay **readable and structured**. This has been tuned through
real user testing (see commit log) and regressing it is the single easiest way to make the
product worse:

- **3+ enumerable things (symptoms, options, steps, reasons) → a bulleted or numbered
  list.** This is a hard, mechanical trigger in the system prompt (`lib/llm.js`), not a
  soft aesthetic preference — earlier soft wording didn't stick.
- **Length must match the question.** 1–3 sentences for yes/no, reassurance, casual
  messages. Full detail reserved for genuine clinical questions, plans, recipes, how/why
  explanations. Don't re-summarize prior context in every reply.
- **Never open with the owner's name; use it at most once per conversation, default to
  never.**
- **Don't reflexively end answers with "consult a vet."** The app already shows a
  permanent disclaimer under the chat box. Only recommend an in-person visit when it
  genuinely warrants one (real emergency, needs hands-on diagnosis, worsening despite home
  care, prescription-only treatment).
- **Emergency answers lead with "⚠️ URGENT"** and skip triage entirely (poisoning,
  breathing trouble, collapse, seizures, etc.).
- All of the above lives in `buildSystemPrompt()` in `lib/llm.js` — that's the one place
  to change tone/rules/formatting, not scattered post-processing.

## 5. Locked architecture decisions — do not regress

Pulled from the project's commit history so intent doesn't get lost in a future refactor:

- **Structured "cards" (the visual stat/section/callout layout) are opt-in only, via the
  `/visualise` slash command.** The model previously chose card-vs-text itself and
  defaulted to cards almost always — this was deliberately reverted. Default output is
  always plain text. Don't re-enable model-chosen cards unless explicitly asked (the
  re-enable path is documented in `ARCHITECTURE.md` §9/§22 if it's ever wanted).
- **Chat-typed questions about nearby places ("cafes which are pet friendly") must route
  into the same Find/Places pipeline as the Find button** (`lib/placeIntent.js` →
  `routes/chat.js`), not be answered from the model's own knowledge. The model must never
  invent specific place names or pet-friendliness claims.
- **Find results (vets, parks, and cafés alike) must show 5–7 options, always as cards —
  see §6 for the exact spec.** Never a bare text list, never fewer than 5 when that many
  real places exist nearby, never more than 7 without an explicit "show more" tap.
- **The vet-visit briefing (`lib/vetSummary.js`) must only summarize the owner's own
  reported words**, never the assistant's prior explanatory answers — asking about a
  symptom is not a report of having it. If you touch this file, keep that boundary.
- **Ingestion and retrieval must use the same embedding model** (`lib/embeddings.js` is
  the single shared entrypoint for both). Changing the embedding model requires a
  migration to change `vector(N)` on `kb_chunks` **and** a full re-ingest — never change
  one without the other.
- **Locked decisions are authoritative over the rolling summary** when both are present in
  a prompt — decisions win, no hedging. Don't blend these two memory mechanisms.
- **Everything fails open.** No LLM key, a retrieval error, a reranking error, a malformed
  structured card, a booking/place-intent detector with no LLM key — all of these must
  degrade gracefully to a plainer path, never crash the request. Preserve this pattern in
  any new integration.
- **`/dev-login` stays off by default regardless of environment**, gated behind
  `ENABLE_DEV_LOGIN=true` (not just `NODE_ENV`), and `SESSION_SECRET` / `ADMIN_SECRET` must
  fail fast (not fall back to a default) in production. Don't relax this for convenience.
- The Excel export (`whoof-responses.xlsx`) and the Groq quota badge are gated to specific
  test accounts by design (see `.env`/`routes` for the account check) — don't widen that
  gate without being asked.
- **The admin dashboard's Users panel is deliberately dynamic** (queries every real owner),
  not a hardcoded allowlist like it used to be. Don't reintroduce a hardcoded tester list
  there — the Excel export and quota badge gates (above) are separate, intentionally-narrow
  exceptions and should stay that way.
- **`owners.access_code` stores the plaintext access code, admin-only visible, alongside
  the bcrypt hash.** This is an accepted, deliberate tradeoff (the admin needs to *read* the
  code to relay it; bcrypt is one-way) — not an oversight to "fix" by removing the plaintext
  column. Don't widen where that column is exposed beyond the admin dashboard.
- **The embedding model dimension is a schema-level fact, not just an env setting.**
  `kb_chunks.embedding` is currently `vector(1024)` (migration 023, Voyage) — this applies
  to *every* environment that runs the full migration chain, including local dev, regardless
  of that environment's own `EMBEDDING_PROVIDER` setting. See `ARCHITECTURE.md` §18/§20 before
  assuming you can just flip `EMBEDDING_PROVIDER=local` locally without also checking (or
  rolling back) the migration state.
- **Rate limiting, timing-safe comparisons, and the enumeration-safe login error message are
  intentional security controls**, not incidental code — see `ARCHITECTURE.md` §24 /
  `SECURITY.md` for what each one prevents. Don't remove or loosen them for convenience
  (e.g. don't swap `crypto.timingSafeEqual` back to `===`, don't skip the rate limiter on a
  new auth-adjacent route).

## 6. Find results — card count & format spec

When the owner taps **Find** (Vets / Parks / Cafés) or asks in chat and gets routed into
the same pipeline (`lib/placeIntent.js` → `GET /api/vets/nearby`), the result set must:

- **Show at least 5 and at most 7 places** per category, whenever that many real,
  verified places exist within range. This applies uniformly to **vets, parks, and
  cafés** — not just the community-only categories. If fewer than 5 real places can be
  found nearby, show what's genuinely there (never pad with invented ones); don't show
  more than 7 without the owner explicitly asking for more (a "Show N more places" action,
  already the pattern for parks/cafés via `RECOMMEND_DEFAULT` in `routes/chat.js` — extend
  the same cap/reveal-more behavior to vets if it isn't already there when you touch this).
- **Always render as cards, never as a plain text list.** Each card shows, in this order:
  1. **Venue name** (bold).
  2. An **"Open now"** badge (green pill) when `open` is known to be true — omitted
     entirely when open/closed status is unknown, never shown as false/negative.
  3. **Full address** (muted text, matches what Google Places returns).
  4. **Distance** from the owner ("2.0 km away"), with a location-pin icon.
  5. **Star rating + review count** ("★★★★★ 4.7 (53)"), when available.
  6. A light **recommendation badge** — the community "why pet owners like it" reason when
     one exists, or a general "positive reviews from pet owners" note otherwise. Never
     invent a reason that isn't backed by the community-picks data or the review count.
  7. A **"Directions ↗"** link that opens real Google Maps directions/place info.
- This is the same card shape `lib/communityPicks.js` / `routes/chat.js` already build
  (`v.name`, `v.address`, `v.distanceLabel`, `v.rating`/`v.reviews`, `v.open`,
  `v.community.reason`, `v.mapsUrl`) and `renderStructuredAnswer()` in
  `public/chat-client.js` already renders (`structured_kind: 'places'`, §9/§13 of
  `ARCHITECTURE.md`) — this section exists so the 5–7 count and the card format are
  treated as a firm product requirement, not an incidental side effect of whatever Google
  Places happened to return.

## 7. Where do I change X?

(Condensed from `ARCHITECTURE.md` §22 — check there for the full table.)

| Task | Edit |
|---|---|
| When the bot asks clarifying questions | `lib/triage.js` |
| Assistant tone / formatting / emergency rules | `buildSystemPrompt()` in `lib/llm.js` |
| Add a slash command | `FORMAT_COMMANDS` in **both** `routes/chat.js` and `public/chat-client.js` |
| Card layout fields | `lib/structured.js` + `renderStructuredAnswer()` in `public/chat-client.js` |
| Swap LLM provider/model | `.env` only — no code change |
| Change embedding model | `.env` + a migration for `vector(N)` + full re-ingest |
| Tune retrieval (k, RRF, reranking) | `lib/rag.js` |
| Tune the web-search fallback trigger | `kbWeak`/`wantsExternal` logic in `routes/chat.js` |
| Add knowledge | drop PDF in `kb-source/` → `bash scripts/ingest-all-pdfs.sh` |
| Cross-chat memory | `lib/memory.js` |
| Decision save behavior | `lib/decisions.js` |
| Find result count / card format (§6) | `lib/vetFinder.js` (Places request size), `routes/chat.js` (`RECOMMEND_DEFAULT`, card assembly), `lib/communityPicks.js` |
| Booking-message wording | `lib/booking.js` |
| Vet-visit briefing accuracy rules | `lib/vetSummary.js` |
| DB schema change | new file in `migrations/`, then `npm run migrate:up` |
| Add a new admin dashboard action | `routes/admin.js` (route, gated by `requireAdmin`) + `views/admin.ejs` — see the delete-user action for the pattern |
| Deploy a change | push to `main` — Render redeploys and re-runs `migrate:up` automatically (§10) |

## 8. Commands

```
npm run dev          # node --watch server.js — only run when asked to preview
npm run migrate:up   # apply pending migrations — only run when asked
npm run seed         # seed script
bash scripts/ingest-all-pdfs.sh          # (re)ingest kb-source/ PDFs — only when asked
node scripts/seed-owners.js              # create/update hardcoded test owners + codes
node scripts/backfill-access-codes.js    # generate a code for owners missing one —
                                          #   replaces their working login code, only
                                          #   run when asked
```

Any of the DB-touching commands above can be pointed at Render instead of local Postgres
by exporting `DATABASE_URL` to Render's external connection string first — useful for
seeding/ingesting the deployed database, but see operating rule 8 above about knowing which
database you're actually talking to.

Route/lib edits need a server restart (or `npm run dev`); client JS/CSS edits just need a
browser hard-refresh — but again, don't start or refresh anything unless asked to preview.

## 9. Reference docs in this repo

- `ARCHITECTURE.md` — full system walkthrough (24 sections), read before deep changes.
- `DEPLOY.md` — step-by-step Render deployment walkthrough; `ARCHITECTURE.md` §23 has the
  architectural summary of *why* it's set up that way.
- `SECURITY.md` — the security-hardening pass, one entry per fix with severity/verification
  detail; `ARCHITECTURE.md` §24 has the condensed version.
- `whoof-commit-log.xlsx` — auto-generated history of every commit with full rationale;
  useful when you need to understand *why* something is the way it is before changing it.
  Don't hand-edit it — it's regenerated by a git post-commit hook
  (`scripts/generate-commit-log.js`).
- `Whoof_Vet_AI_Architecture_Guide.docx`, `Whoof_Vet_AI_Build_Plan.docx` — supplementary
  planning docs. **Not updated as part of this pass** — they predate the rebrand/deployment/
  security work and are likely stale; flag this if anyone relies on them.

## 10. Deployment (Render) — quick reference

Full detail: `DEPLOY.md` (walkthrough) and `ARCHITECTURE.md` §23 (architectural summary).
The short version:

- `render.yaml` is a Blueprint — provisions a free web service + free managed Postgres
  together. Its build command (`npm install && npm run migrate:up`) means **every deploy
  also applies any pending migrations** — pushing to `main` and migrating the deployed DB
  are the same event, not two things to remember separately.
- The deployed instance runs `EMBEDDING_PROVIDER=voyage`, not the local model — the free
  tier's 512MB RAM cap can't hold the local model in-process alongside Node/Express/the
  Postgres pool (this actually happened: an OOM kill mid-request, surfacing to users as a
  generic "Network error"). Don't switch it back to `local` without addressing the memory
  constraint some other way.
- Managed Postgres needs TLS; `db.js` decides whether to enable it from the connection
  target's **hostname** (`localhost`/`127.0.0.1` → off, anything else → on), not from
  `NODE_ENV` — this matters for one-off scripts run locally against Render's external URL.
- `kb-source/*.pdf` is gitignored, so a fresh database's KB starts empty until someone runs
  the ingest script against it with a matching `EMBEDDING_PROVIDER`.
- See operating rule 8 above: it's easy to have a terminal's `DATABASE_URL` pointed at
  Render while the browser is looking at `localhost` — verify before trusting a "local"
  test result.

## 11. Security hardening — what's already been done

Full detail: `SECURITY.md` (per-fix writeup) and `ARCHITECTURE.md` §24 (condensed). A
full-codebase review already fixed: stored XSS via `<script>`-tag breakout in inline JSON
(`app.locals.safeJson()` in `server.js`), a fail-open markdown sanitizer (now fails closed),
missing SRI pinning on CDN scripts, no rate limiting anywhere (`middleware/rateLimit.js`,
now on `/login`, `/signup`, `/admin/login`, `/admin/users/:id/delete`), an account-
enumeration + timing leak on `/login`, a timing-unsafe admin-secret comparison, and missing
baseline security headers. Treat all of these as locked-in (§5) — don't relax them for
convenience, and don't add a new auth-adjacent route without considering whether it needs
the same rate limiting / timing-safe / enumeration-safe treatment.
