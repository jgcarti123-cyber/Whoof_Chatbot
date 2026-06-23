# Prompt for Claude Code — Whoof Vet AI: Owner Test Webpage

Copy everything below the line into Claude Code. Run this after the database/migrations prompt (owners, pet_profile, health_history, conversation_memory, kb_chunks) has already been applied — this prompt extends that service, it doesn't recreate it.

---

I'm building Whoof, a GPS dog-collar startup. The subscription driver is a "vet in your pocket" AI chatbot — a 30-years-experience vet persona that answers an owner's pet-health questions using a curated knowledge base plus each dog's stored profile and history.

Before this goes anywhere near the Flutter app or real hardware, I want to test it with 3-4 real dog owners on a plain web page. No collar, no app — just: they log in, tell us about their dog, and chat with the vet AI so I can judge answer accuracy and tone before investing in the app integration.

## What I want

A small web app (separate frontend, same backend/database as the schema prompt) with three pieces: per-owner login, a profile/onboarding form, and a chat interface backed by retrieval-augmented generation over a vet knowledge base.

### 1. Auth — per-owner login

Only 3-4 known testers, so keep it lightweight: each owner logs in with their email + a one-time access code I share with them directly (e.g. over WhatsApp), checked against their `owners` row, then a session cookie keeps them logged in. If you have a better simple approach for a tiny known group, use it — just tell me why. After login, an owner should only ever see their own dog's data.

### 2. Onboarding / profile form

A form that captures the `pet_profile` fields from the existing schema (breed, age/DOB, weight, sex, neutered, diet, meals/day, allergies, vaccination history, past health conditions, region, temperament, etc.) — reuse the existing table, don't invent new ones. Owner should be able to come back and edit it later. This form *is* the "ask the owner questions and build a memory" step from the original plan, so the questions should read naturally, not like a database form (e.g. "How many meals does [dog name] eat a day?" not "meals_per_day:").

### 3. Knowledge base — seed it minimally for now

Add a small ingestion script (e.g. `scripts/ingest-kb.js`) that reads plain text/markdown files from a local `kb-source/` folder, splits them into reasonably sized chunks, embeds them, and inserts into `kb_chunks` (source, topic, content, embedding, citation_url, license_note). I'll drop in the real curated vet content (WSAVA guidelines, Merck Vet Manual excerpts, etc.) afterward — for now, seed 5-10 placeholder chunks on common topics (vaccination schedules, vomiting/diarrhea, limping, heat exhaustion, common food toxins like chocolate/xylitol) so the retrieval path is testable end-to-end today.

### 4. Chat — RAG + vet persona + basic safety net

A chat endpoint that, per owner message:
1. Pulls the dog's profile + recent relevant `health_history`/`conversation_memory` for context.
2. Retrieves the top-k similar `kb_chunks` via the `ivfflat` index.
3. Calls the LLM with a system prompt built from a vet persona along these lines (adapt as needed, keep the substance):

> You are a calm, experienced veterinarian with 30 years of small-animal practice, speaking directly to a dog's owner. You know this specific dog's profile and history — use it. Ground your answers in the provided reference material and cite it naturally (don't just dump a source list). If the reference material doesn't cover the question, say so plainly rather than guessing. You are not a replacement for an in-person vet: for anything that could be an emergency (e.g. suspected poisoning, difficulty breathing, collapse, bloated/hard abdomen, seizures, can't stand, pale/blue gums), say clearly and immediately that the owner should see a vet or emergency clinic now, before anything else. Otherwise, be warm, specific, and practical — not generic internet advice.

4. Saves the exchange to `conversation_memory` (`owner_question`, `answer_summary`, `sources_cited`, `symptom_tags`, `confidence_level`), and sets `escalated = true` with an `escalation_reason` when the message matches an emergency-symptom keyword list (ship a starter list, e.g. the ones in the persona prompt above) — this is a simple keyword safety net for the test, not the full deterministic escalation engine from the roadmap. That's a separate later prompt.

### 5. LLM + embedding provider — your call

I haven't picked these yet. Pick a sensible pairing and tell me why — e.g. Claude (Anthropic) for the chat model paired with Voyage AI or OpenAI for embeddings (Anthropic doesn't offer its own embeddings API), or OpenAI end-to-end for simplicity. Whatever you pick, the `kb_chunks.embedding` column is currently `vector(1536)` as a placeholder — if your chosen embedding model outputs a different dimension, add a migration to fix the column rather than forcing the model to match a number I made up. Put API keys in `.env.example`, not hardcoded.

## Tech setup

- Extend the existing Express service from the schema prompt — same Postgres database, don't spin up a second one.
- Frontend: your call on framework (server-rendered pages + plain JS is probably fastest for 3-4 users; a small React app is fine too if you'd rather) — optimize for "I can test this this week," not production polish.
- No need for an admin UI yet — I'll review `conversation_memory` rows directly in Postgres to judge accuracy.

## Acceptance check

- I (as admin, however you set this up — seed script is fine) can create 3-4 owner + pet_profile records.
- Each owner logs in and sees only their own dog, can fill in/edit the onboarding form.
- Asking a normal pet-health question returns an answer grounded in retrieved `kb_chunks`, with `conversation_memory` recording the exchange.
- Asking an emergency-style question (e.g. "my dog ate a chunk of chocolate cake") gets a clear "see a vet now" answer and `escalated = true`.
- Show me one full round trip end-to-end: the question, the retrieved chunks, the model's answer, and the resulting `conversation_memory` row.

## Keep in mind

- This is a test surface for accuracy/tone, not the production UI — the Flutter app integration is a separate, later prompt, and so is the full deterministic escalation engine from the roadmap.
- Reuse the schema/migrations already in place. If wiring this up reveals a real gap (e.g. you need an `owner_access_code` column on `owners` for the login), add it and tell me — don't silently bolt on columns I haven't seen.
- Keep the 3-4 test owners' data isolated from each other; no shared visibility.

Please implement this, run it locally, log in as one seeded test owner, ask it both a normal question and an emergency-style one, and show me the full round trip for each before I put it in front of the real owners.
