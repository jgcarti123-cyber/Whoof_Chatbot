# Prim Pets — Project Summary (for resume/portfolio use)

Raw reference material on what was built, why, and how it evolved from a prototype into a
deployed, security-hardened product. Structured to mirror the project's own system map —
each heading below is one branch of that map, with the real implementation detail and
production lessons behind it. Written to be mined for resume bullets, not pasted verbatim —
pull the angle (RAG, debugging, security, product iteration) that matches the role you're
targeting.

Solo-built, 41 commits, iterated across multiple real user-testing rounds, deployed to
production on Render.

---

## 1. Core Tech Stack

- **Runtime: Node.js & Express 5.** No framework beyond Express itself — no Next.js, no
  Nest, no build step. `server.js` is a single, readable bootstrap: middleware, session
  store, route mounting, a `/health` endpoint.
- **Database: PostgreSQL 17 & `pgvector`.** One database does double duty as the relational
  store (owners, pets, conversations, feedback) *and* the vector store for retrieval — no
  separate vector DB service to run or pay for. Schema evolved through 26 ordered
  migrations (`node-pg-migrate`), including two full embedding-dimension migrations.
- **Frontend: Vanilla JS & EJS.** Server-rendered views, one hand-written JS controller
  (~1,950 lines) for the live chat UI — no React, no client-side framework, no bundler.
  Deliberate: a small team/solo project doesn't need the operational overhead of a modern
  frontend build pipeline to ship a good chat experience.
- **LLM: Groq & Anthropic Abstraction.** Every model call in the app funnels through one
  provider-switch module (`lib/llmProvider.js`) exposing three primitives — plain-text
  generation, forced single-tool generation, and multi-tool routing — so the rest of the
  codebase never talks to a vendor SDK directly. Swapping the whole app between Groq's fast
  open models and Anthropic's Claude is a single environment variable, no code change.
- **Embeddings: Local Transformers.js (dev) / Voyage AI (production).** Development runs an
  open-source embedding model fully in-process, no API key or rate limit. Production runs
  a hosted embeddings API instead — not for accuracy, but because of a real infrastructure
  constraint documented in full under **Ops & Feedback** below.

---

## 2. Chat Request Lifecycle

The single endpoint every owner message flows through, in a fixed order: pending-decision
check → booking/place-intent short-circuit → emergency check → triage → retrieval → answer
generation.

- **Triage Classifier.** A fast, cheap model call gates every message before any real work
  happens: is this actually pet-related, and does it have enough information to answer well
  (e.g. "what should I feed her" needs the dog's age/weight/allergies first, so triage asks
  for them instead of guessing). This keeps the assistant from either refusing valid
  questions or answering underspecified ones badly.
- **Emergency Detection.** A keyword scan (suspected poisoning, breathing trouble, collapse,
  seizures, and similar) runs ahead of triage and retrieval entirely — a genuine emergency
  skips the normal pipeline and gets an immediate, clearly-flagged urgent response rather
  than waiting behind a classifier call.
- **Structured Output (`/visualise`).** An opt-in "card" layout (stats, step sequences,
  callouts) the owner can force with a slash command, separate from the default plain-text
  answer. **A real production bug here**: the forced-structured tool call ran on the large
  answer model and was silently hitting that model's per-minute token cap under normal
  load — the resulting 429 degraded to plain text with zero visible indication anything had
  gone wrong. Fixed by decoupling the two steps: the large model still writes the answer as
  plain text, then a second, fast-model call only re-lays it out as a card in a flatter
  format that model doesn't mangle — with a deterministic fallback so a card always renders
  even if that second call fails.
- **System Prompt Construction.** One function (`buildSystemPrompt()`) assembles the dog's
  profile, retrieved reference material, memory, and every tone/formatting rule into a
  single prompt — the one place any of that logic lives, not scattered post-processing.
  Several of its rules exist because a soft version of them **did not survive contact with
  the model in practice** and had to be rewritten as hard, mechanical triggers instead of
  gentle preferences: opening every reply with the owner's name (flipped to "never open
  with it, use it at most once"), answers running long for casual one-line messages
  (flipped to an explicit length cap by question type), enumerable lists getting crammed
  into dense prose (flipped to "3+ things named → stop, format as a list, no exceptions"),
  and a reflexive "consult a vet" sign-off on nearly every answer (flipped to "answer
  directly by default, only refer out for a genuine emergency or hands-on diagnosis").

---

## 3. Hybrid RAG System

The core engineering problem: making an LLM give clinically grounded, non-hallucinated
advice about a specific dog.

- **PDF Ingestion Pipeline.** A Python parser (PyMuPDF + pdfplumber) turns each source PDF
  into typed chunks (body / figure / table) with section, subsection, and page-number
  metadata preserved, so a retrieved passage can cite exactly where it came from and stays
  coherent rather than splitting a table mid-row. The knowledge base itself is 25 documents,
  hand-selected for authority over volume — official WSAVA guidelines on vaccination, pain
  management, nutrition assessment, and hereditary disease, plus peer-reviewed breed and
  behavioral studies — on the bet that a small authoritative corpus beats a large unvetted
  one for a narrow clinical domain. A vision-model captioning step for figures was built and
  then deliberately removed after weighing its actual accuracy contribution against its real
  cost and rate-limit exposure during ingestion.
- **Vector & FTS Hybrid Search.** Every query fuses two independent signals — dense vector
  similarity and Postgres full-text search — via Reciprocal Rank Fusion, so a query that's
  lexically close to the source text (an exact drug or symptom name) isn't missed just
  because its embedding drifted, and vice versa. **A real bug found here**: the check used
  to decide "is the knowledge base actually confident, or should this fall back to the web"
  was built on the RRF rank score — which sits at roughly the same ~0.016 value at rank 1
  regardless of whether the match is good or bad, because it reflects rank position, not
  similarity. The web fallback was effectively dead code that could never fire correctly.
  Fixed by adding real cosine similarity to the retrieval query and pairing it with an
  intent classifier, so questions that clearly want current external facts get a higher
  trust bar before the KB is preferred over a live search.
- **Web-Search Fallback (Tavily).** Fires only when retrieval is weak, gated behind the
  same pet-relevance check as everything else, and never for emergencies. **A real accuracy
  failure found in testing**: a user's dog named "Messi" asked about his ideal daily routine
  returned web results about the footballer Lionel Messi's training schedule instead — the
  fallback had sent the pet's literal name to the search API with only a generic topical
  prefix, not enough to stop an ambiguous proper noun from dominating the search. Fixed with
  three independent layers: the pet's name is replaced with a generic "the [breed] dog"
  phrase in the outbound search string only (never in the prompt or the visible answer, and
  general enough to guard against *any* name collision, not just this one); any returned
  result that doesn't mention a dog/pet/veterinary term is dropped before it can become a
  cited source; and the system prompt itself now explicitly tells the model to verify a web
  snippet is genuinely relevant before using it, naming this exact failure mode.
- **Breed Reference Integration.** A seeded lookup table of India-relevant breeds (weight
  ranges, common health predispositions, temperament notes) feeds directly into the prompt
  for breed-specific context, and separately powers a type-to-filter breed dropdown on the
  pet-profile form. **A real production gap found post-deploy**: this table is populated by
  a standalone seeding script, not an automatic migration — so it silently shipped *empty*
  on the production database (the migration created the table structure, but nothing had
  ever run the one-time seed against that specific database), and the breed dropdown quietly
  had zero options until traced back to that exact gap and fixed.

---

## 4. Memory & Facts

Deliberately avoids the naive approach of embedding every past message and vector-searching
transcripts — three separate, purpose-built mechanisms instead, so they can't blur together:

- **Within-chat History (Last 5).** The last 5 turns of the *current* conversation,
  included verbatim in the prompt — cheap, exact, sufficient for a normal back-and-forth.
- **Rolling Pet Summary.** Every *other* past chat is folded into a single compressed
  digest per pet (capped ~300 tokens), not searched. A background pass takes whatever turns
  haven't been folded yet, combines them with the *existing* summary, and produces one new
  summary that **replaces** the old one — it never accumulates. The deliberate payoff: a pet
  with 50 past chats costs exactly the same to load as one with 2, because memory is always
  one fixed-size slot.
- **Locked Decisions (Authoritative).** When a conversation settles something concrete (a
  finalized diet plan, a confirmed allergy, an agreed treatment routine), the assistant
  proactively offers to save it; once confirmed, that fact is injected into every future
  prompt as a plain, authoritative statement, explicitly told to win over the rolling
  summary if the two ever conflict — no hedging, no re-deriving it from memory each time.
- **Specific Answer Targeting.** Since the model only automatically sees the last 5 turns, a
  follow-up about something discussed much earlier had no reliable anchor. Tapping "Reply"
  on any past answer resolves and re-injects that *exact* turn into the prompt for the next
  message only — scoped server-side to the requesting owner's own pet, so a client-supplied
  id can never be used to pull another user's conversation data.

---

## 5. Concierge Features

Beyond Q&A, the app acts as a small concierge — but every claim it makes about the real
world is deliberately grounded, never improvised.

### Nearby Places
- **Google Places API** — real, verified nearby vets/parks/cafés with rating, distance, and
  open/closed status, never invented.
- **Community Picks Layer** — layers "what local pet owners actually recommend" on top of
  raw Places results (Places gives a star rating, not community trust): a separate web
  search biased toward the specific area and category, a model extraction step that pulls
  only clearly-named venues and a one-line reason (never inventing one), fuzzy-matched back
  onto the real Places results so a genuine community favorite floats to the top with a
  badge instead of being buried in generic rating order.
- **Chat Routing.** **A real accuracy failure found in testing**: the single worst-rated
  cluster of turns in one testing session was all the same request — a place question typed
  in plain chat instead of tapped via the Find button — answered from the model's own
  unverified knowledge, including once outright denying a real place the app's own Find
  pipeline had already verified existed. Fixed with an intent detector that routes a
  chat-typed place question into the *exact same* verified pipeline the Find button uses,
  so a typed question and a button tap now always produce identical, trustworthy results —
  paired with a hard prompt rule banning the model from inventing place names on its own.

### Vet Services
- **WhatsApp Booking Drafts** — resolves a clinic's phone number and drafts a short,
  polite appointment message, handed to the owner as a one-tap `wa.me` link to review and
  send themselves; the app never contacts a clinic directly, so it works with zero
  integration for any clinic.
- **My Vet Saved List** — tracked vets with visit history and dates, so an owner isn't
  re-entering the same clinic's details every visit.
- **Pre-visit Briefings.** A short clinical summary generated before a checkup, built from
  the owner's own reported history. **Two real accuracy failures found in testing, both
  fixed**: first, the summarizer was mining the *assistant's own explanatory answers* and
  asserting their content as things the dog was actually experiencing — asking "what are the
  symptoms of ticks?" turned into a briefing claiming the dog was actively showing those
  symptoms, with no such report ever made. Fixed by feeding the summarizer only the owner's
  own words, with an explicit rule that asking about a topic is never the same as reporting
  it, then verified against the exact failing transcript plus a control case to confirm real
  symptoms still surface correctly. Second, under provider rate-limiting the summarizer
  fell back to a naive dump of recent turns and started parroting unrelated searches ("find
  a vet nearby," café questions) as if they were medical content — fixed by filtering those
  out before summarizing and restricting the no-LLM fallback path to only escalated or
  symptom-tagged turns.

---

## 6. Ops & Feedback

- **Admin Dashboard.** Password-gated, separate from owner auth entirely. Evolved from a
  hardcoded two-tester allowlist into a fully dynamic Users panel — every real account,
  its access code, onboarding status, and a delete action (which cascades cleanly through
  every dependent table via foreign keys) — so reviewing testers no longer means editing
  source code to add one.
- **Response Feedback Log.** A lightweight 1–10 rating plus tag chips and an optional
  comment on every turn, gated so an owner can only rate their own pet's conversation —
  this is what surfaced several of the real bugs described above in the first place (the
  worst-rated turns of a session were the reliable signal that pointed straight at the
  chat-routing and briefing-fabrication issues).
- **Excel Export Utility.** A live spreadsheet export scoped to one internal tracked test
  account, rewritten in full after every relevant turn — a deliberately narrow, ops-only
  tool, not a general reporting feature.
- **Groq Quota Tracking.** Groq's API only ever exposes a *per-minute* rate-limit bucket on
  a successful response — the *daily* cap that actually causes real outages only appears in
  the free text of a 429 error, with no endpoint to query it proactively. So the app sums
  token usage from every real response itself and persists a running daily total per model,
  surfaced as a small badge only to the account that needs to watch it.

**Cross-cutting production hardening** (not its own branch, but real work behind "production
quality"): a full security-hardening pass (a stored-XSS vector via `</script>` tag breakout
in inline JSON, a markdown sanitizer that failed *open* instead of *closed*, missing
Subresource Integrity on CDN scripts, no rate limiting anywhere, an account-enumeration +
timing leak on login, a timing-unsafe admin-secret comparison); a diagnosed and fixed
out-of-memory production crash (the free-tier host's 512MB RAM cap couldn't hold the local
embedding model in-process alongside the app itself, surfacing to users as a generic
"Network error" until root-caused via the host's own process event log — fixed by moving
production embeddings to a hosted API, which required a coordinated schema migration and a
full knowledge-base re-ingest); and a real infrastructure trap where a terminal's database
connection was still pointed at production from an earlier task, making "local" testing
silently read and write production data — caught by inspecting the actual running server
process's environment rather than trusting either shell in isolation, and turned into a
standing project rule afterward.

---

## 7. Future Evolution (Multi-Agent Swarm)

**Proposed next architectural direction — not yet built.** The current system is a single
well-orchestrated pipeline (triage → retrieval → one system prompt → one answer). The
next phase under consideration reframes it as a small swarm of specialized agents behind a
router, rather than one monolithic prompt handling every concern:

- **Supervisor Agent Router** — a dispatch layer that routes a request to the right
  specialized agent below instead of one prompt trying to handle every case.
- **Clinic Handshake & Copilot** — a vet-facing counterpart that could integrate with an
  actual clinic's own systems, beyond today's one-way WhatsApp booking draft.
- **Insurance Claims Agent** — automating the filing and tracking of a pet-insurance claim
  rather than only advising the owner about one.
- **Proactive Health Manager** — an agent that surfaces care reminders and patterns on its
  own initiative, instead of only ever responding to an owner-initiated question.
- **Hyper-Contextual Retail Agent** — a commerce-aware agent that could recommend (and
  potentially help purchase) food, medication, or supplies contextually, grounded the same
  way the current Find/booking features are — real, verified options only, never invented.

---

## Skills this project demonstrates

RAG system design (hybrid retrieval, RRF fusion, query rewriting, embedding model
migration); designing bounded-cost, multi-tier conversational memory instead of naive
transcript retrieval; prompt engineering under real model constraints (iterating rules
until they actually stick on a specific model, not just in theory); root-cause debugging of
production incidents (OOM crashes, silent JS errors, rate-limit cascades, infrastructure
misconfiguration, a missing-seed-data gap); relational schema design and migration
discipline (Postgres + `pgvector`); application security (XSS, timing attacks, account
enumeration, rate limiting); third-party API integration with resilience (Google Places,
Tavily, WhatsApp, two different LLM providers, two different embedding providers); and
end-to-end product iteration driven by real user feedback rather than assumption.
