# Deploying to Render (free tier)

`render.yaml` in the repo root is a Render Blueprint — it provisions the web
service and a free managed Postgres together. Steps:

## 1. Push `render.yaml` to `main`

Already done if you're reading this after a commit that includes it.

## 2. Create the Blueprint in Render

1. https://dashboard.render.com/ → **New +** → **Blueprint**.
2. Connect the `Whoof_Chatbot` GitHub repo, branch `main`.
3. Render reads `render.yaml` and shows two resources: `prim-pets-db` (Postgres)
   and `prim-pets` (web service). Click **Apply**.
4. First build runs `npm install && npm run migrate:up` — this also runs the
   `enable-extensions` migration, which needs pgvector on the Postgres image.
   Render's managed Postgres supports it; if the migration errors on
   `CREATE EXTENSION vector`, your plan/region doesn't have it enabled and you
   should ask Render support to add it (it's a one-line config on their end).

## 3. Set the secrets Render can't generate for you

The blueprint marks these `sync: false`, so set them once in the dashboard
under the `prim-pets` service → **Environment**:

- `ADMIN_SECRET` — password for `/admin` (tester feedback dashboard).
- `GROQ_API_KEY` (if `LLM_PROVIDER=groq`, the default) — free key at
  https://console.groq.com/keys.
- `VOYAGE_API_KEY` — **required.** Embeddings run on Voyage AI, not the local
  in-process model — Render's free web service caps at 512MB RAM, and loading
  the local ONNX model there gets the process OOM-killed mid-request (see the
  note in `render.yaml`). Free tier: 3 RPM / 10K TPM, no card needed —
  https://dash.voyageai.com/.
- `GOOGLE_PLACES_API_KEY` — for Find nearby (vets/parks/cafés).
- `TAVILY_API_KEY` — optional, web-search fallback. Free tier, no card.

`SESSION_SECRET` and `DATABASE_URL` are auto-generated/auto-wired by the
blueprint — don't set those manually.

## 4. Ingest the knowledge base into the new database

`kb-source/*.pdf` is intentionally gitignored (large binaries), so the fresh
Render Postgres starts with an **empty `kb_chunks` table** — chat still works,
it just falls back to the web-search path instead of the curated KB. To seed
it, run the ingest script locally, pointed at the Render database, once:

```bash
# Get the External Database URL from the Render dashboard
# (prim-pets-db → Info → "External Database URL" — the internal one only
# works from inside Render's network, not your laptop).
export DATABASE_URL="postgres://...render-external-url.../prim_pets_db"
# Must match the deployed EMBEDDING_PROVIDER (voyage) — ingestion and retrieval
# have to share one embedding space, or similarity search returns garbage.
export EMBEDDING_PROVIDER=voyage
export VOYAGE_API_KEY="<same key you set in the Render dashboard>"
bash scripts/ingest-all-pdfs.sh
```

If you ever re-ingest locally for dev work, unset `EMBEDDING_PROVIDER` (or set
it back to `local`) — local dev keeps using the free in-process model by
default, since a laptop has plenty of RAM to spare. Re-run the Render-pointed
ingest above any time you add a PDF to `kb-source/`.

## 5. First load will be slow — that's expected

The free tier spins the service down after 15 minutes idle; the first request
after that has to cold-boot the whole process. Subsequent requests within the
same "awake" window are fast.

## 6. Verify

- `https://<your-service>.onrender.com/health` → `{"status":"ok", ...}`.
- `/login` → create a throwaway account, complete onboarding, confirm chat
  answers and Find nearby both work.
- `/admin` → gated behind `ADMIN_SECRET`, confirm it loads.

## Known free-tier limits

- **Service sleeps after 15 min idle.** Fine for a tester link, not for a
  public always-on launch — upgrade to a paid instance type when you're ready
  for that (`render.yaml` → change `plan: free` to a paid plan under the
  `prim-pets` service).
- **Free Postgres expires after 90 days.** Render emails a warning in advance;
  either upgrade the database plan or provision a fresh free one and re-run
  step 4 (the KB is the only thing worth re-seeding — everything else is
  owner-generated data you'd expect to reset with a fresh deploy anyway).
