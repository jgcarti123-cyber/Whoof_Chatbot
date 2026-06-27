# Prompt for Claude Code — Whoof Vet AI: Tester Feedback & Rating System

Copy everything below the line into Claude Code. Run this against the existing app — chat, auth, and the `conversation_memory` table are already built and working; this prompt only adds a feedback layer on top, it doesn't touch the chat logic itself.

---

I'm about to put Whoof's vet AI chatbot in front of some friends and family for real testing. Before that starts, I want a lightweight way for testers to rate each answer and leave a quick reason, so I can come back later and find exactly where the bot is failing — without building anything that looks or feels like RLHF training infrastructure. This is a feedback log for manual review, not a training pipeline.

## What I want

### 1. A new table: `response_feedback`

One row per rated turn, upsertable (a tester can revise their rating). It links to the conversation turn, not the other way around — `conversation_memory` shouldn't know feedback exists.

- `memory_id` uuid, **PRIMARY KEY**, FK → `conversation_memory.id`, ON DELETE CASCADE — one feedback row per turn, and using it as the PK makes submitting a rating a natural upsert (`ON CONFLICT (memory_id) DO UPDATE`).
- `owner_id` uuid NOT NULL, FK → `owners.id`, ON DELETE CASCADE — set from `req.session.ownerId` server-side, never from the request body. Denormalized on purpose even though it's reachable via `conversation_memory → pet_profile.owner_id`, since "everything tester X said" is a query I'll run often.
- `rating` smallint NOT NULL, CHECK between 1 and 10.
- `tags` text[] — multi-select, from a **fixed vocabulary**, validated server-side too (don't trust whatever the client sends): `wrong_info`, `missed_pet_context`, `too_long`, `too_vague`, `misunderstood_question`, `tone_off`, `exactly_right`.
- `comment` text, nullable — free text, optional.
- `created_at` timestamptz, default `now()`.
- `updated_at` timestamptz, default `now()` — bump it on every revision. Reuse the existing `set_updated_at()` trigger function from the `pet_profile` migration rather than redefining it.

Add a partial index: `CREATE INDEX ON response_feedback (created_at DESC) WHERE rating <= 4;` — that's the query I'll actually run over and over ("show me what's failing"), worth indexing for specifically.

Use `node-pg-migrate`, same as every other migration in `migrations/` — follow the existing numbering (the last one is `1700000000016_structured-answers.js`, so this should be `1700000000017_response-feedback.js` or whatever the next free number actually is).

### 2. An endpoint to submit/revise feedback

Something like `POST /api/chat/feedback` (your call whether it lives in `routes/chat.js` alongside the other session-scoped actions, or a new `routes/feedback.js` — just tell me which and why). Body: `{ memory_id, rating, tags, comment }`.

Server-side, before writing anything:
- `req.session.ownerId` must already be authenticated (same middleware as the rest of `routes/chat.js`).
- The `memory_id` must resolve to a `conversation_memory` row whose `pet_id` belongs to *this* owner's pet — reject otherwise. One tester must never be able to rate, or even discover, another tester's turn.
- `rating` must be an integer 1–10; reject anything else.
- `tags` must be a subset of the fixed vocabulary above; drop anything that isn't, don't error the whole request over one unrecognized tag.

Upsert into `response_feedback` on `memory_id`. This endpoint should never be able to break or block the actual chat flow — if it errors, the chat keeps working; this is purely additive, in keeping with the fail-open approach already used elsewhere in this codebase.

### 3. The rating widget in the chat UI

In `public/chat-client.js`, attach a small widget under each AI bubble, the same way the decision-offer-card / structured-answer action row already attach things under a bubble — match that visual pattern, don't invent a new one.

- Every response from `/api/chat/message` (and the other `res.json` calls in `chat.js`) already returns `memory_id` — use it directly, no extra fetch needed.
- Skip the widget entirely on turns that don't have a `memory_id` yet (e.g. the `needs_clarification` turn isn't persisted to `conversation_memory` until the owner answers it).
- Collapsed by default: ten small number buttons, 1–10. Tapping one fires the feedback POST immediately (optimistic, fire-and-forget, same pattern as the existing pin/delete fetches) — that alone is a useful signal even if the tester stops there.
- After picking a number, expand in place to show the tag chips (multi-select) and an optional comment box, both wired to the same upsert endpoint on submit.
- After submitting, settle into a quiet "Thanks — got it ✓" state rather than disappearing. Tapping a different number later should just re-open it and revise.
- Style it with `public/style.css`, matching the existing visual language (spacing, colors, font) rather than a new look.

## Acceptance check

- Migration applies cleanly; `response_feedback` exists with the constraints above.
- Asking the chatbot a question, then rating the answer 3/10 with the "Wrong info" tag and a comment, produces exactly one row in `response_feedback` linked to the right `conversation_memory.id` and the right `owner_id`.
- Re-rating the same answer updates that same row (no duplicate), and `updated_at` changes.
- Logged in as a different test owner, confirm there's no way to see or submit feedback against the first owner's `memory_id` — try it directly against the endpoint, not just through the UI.
- The `needs_clarification` turn renders with no rating widget.
- Show me one full round trip: the question, the answer, the rating + tags + comment submitted, and the resulting `response_feedback` row.

## Keep in mind

- This is a feedback log for me to read, not a training pipeline — don't add anything that looks like reward-model scaffolding or batch export jobs. If I want that later, it's a separate prompt.
- No admin/review UI needed yet — I'll query `response_feedback` joined to `conversation_memory` directly in Postgres (filtering `rating <= 4`, newest first) to find what's failing.
- Don't touch the actual chat/triage/RAG logic in `chat.js` — this is purely additive on top of the existing flow.
- If you spot a real gap — e.g. a `model_provider` column on `conversation_memory` would make this more useful later, since I can switch between Groq and Anthropic via env var — flag it and tell me your reasoning rather than silently adding it.

Please implement this, run the migration, and show me the full round trip from the acceptance check before I put this in front of testers.
