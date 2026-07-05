<p align="center">
  <img src="public/Prim_Pets.png" width="90" alt="Prim Pets logo" />
</p>

<h1 align="center">Prim Pets</h1>
<p align="center">A veterinary chat assistant for dog owners — grounded in real clinical guidelines, not guesswork.</p>

---

## What it does

Prim Pets answers questions about *your specific dog* — using their own profile (breed,
age, diet, allergies, medical history) plus a curated library of veterinary guidelines,
not just whatever a language model happens to already "know." Beyond Q&A, it also:

- 🔍 **Finds real, verified nearby vets, parks, and pet-friendly cafés** — never invented places
- 📅 **Drafts a WhatsApp message to book a vet appointment**
- 🩺 **Remembers your dog's history across conversations** and writes a pre-visit briefing before a checkup
- 📊 **Turns any answer into a visual card** on request (`/visualise`)

## How it stays accurate

- **Retrieval-Augmented Generation (RAG)** — clinical answers are grounded in 25 curated
  documents (WSAVA vaccination, pain management, and nutrition guidelines, breed studies),
  retrieved via hybrid vector + full-text search — not the model's raw training data.
- **Web search fallback, with guardrails** — kicks in only when the knowledge base doesn't
  cover a question, with safeguards so it can't confuse your pet with an unrelated
  same-named person, place, or topic.
- **Three-tier memory** — recent chat history, a compressed rolling summary per pet, and
  explicit "locked decisions" for settled facts (a confirmed diet plan, an agreed
  treatment) — so the assistant stays consistent without re-searching every past
  conversation.

For the full story — the real accuracy failures found through testing and how each was
fixed — see [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md).

## Tech stack

Node.js + Express · PostgreSQL + `pgvector` · EJS + vanilla JS (no frontend framework, no
build step) · Groq / Anthropic (swappable LLM provider) · Voyage AI / local embeddings
(swappable) · Google Places + Tavily for real-world grounding.

## Running it locally

```bash
docker compose up -d                     # local Postgres + pgvector
npm install
cp .env.example .env                     # fill in your own API keys
npm run migrate:up                       # sets up the database schema
node scripts/seed-breed-reference.js     # seeds breed reference data
bash scripts/ingest-all-pdfs.sh          # ingests kb-source/*.pdf into the knowledge base
npm run dev
```

## Documentation

| Doc | What's in it |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Quick orientation — what does what, where to change things |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system walkthrough, section by section |
| [DEPLOY.md](DEPLOY.md) | Deploying to Render |
| [SECURITY.md](SECURITY.md) | The security-hardening pass |
| [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) | How this was built, and every real bug fixed along the way |
