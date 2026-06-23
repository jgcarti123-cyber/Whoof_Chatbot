# Prompt for Claude Code — Whoof Vet AI: Database Schema & Migrations

Copy everything below the line into Claude Code.

---

I'm building Whoof, a GPS dog-collar startup. V0 is a collar with Safe/Walk/Find modes, geofencing, and a Paw Passport. The subscription driver is a "vet in your pocket" AI chatbot that answers an owner's pet-health questions using a curated knowledge base plus each dog's stored profile and history, instead of a generic LLM with no memory.

I've finalized the data design for this (data schema, knowledge sourcing, persona, and rollout roadmap). This prompt is the first concrete build task from that plan: stand up the actual database as code. Nothing else yet — no LLM orchestration, no knowledge-base ingestion, no chatbot logic. Just the data layer.

**Scope note:** no collar yet. Before this goes into the app, I'm testing the chatbot's accuracy on a small web page with 3-4 real dog owners, with no physical collar in their hands during that test. Leave collar/telemetry data out of the schema entirely for now — it comes back in a later prompt once we're integrating with the real app and hardware.

## What I want

A new backend service — Node.js + Express — with a Postgres database (pgvector extension enabled) and migrations for the tables below. This is a brand-new service; there's no existing backend in this project yet (the Flutter app is separate and currently has no server to talk to).

## Schema

**owners** (minimal — just enough for pet_profile to have something to reference)
- `id` uuid PK, default `gen_random_uuid()`
- `email` text NOT NULL, unique
- `created_at` timestamptz, default `now()`

**pet_profile**
- `id` uuid PK, default `gen_random_uuid()`
- `owner_id` uuid NOT NULL, FK → owners.id, ON DELETE CASCADE
- `name` text NOT NULL
- `breed` text NOT NULL
- `is_mixed_breed` boolean, default false
- `date_of_birth` date (nullable — many owners won't know it)
- `age_estimated_years` numeric(4,1) (nullable — used when DOB is unknown)
- `sex` text, CHECK in ('male','female')
- `neutered` boolean
- `weight_kg` numeric(5,2)
- `body_condition` text, CHECK in ('underweight','ideal','overweight')
- `diet_type` text
- `meals_per_day` smallint
- `food_allergies` text[]
- `treat_frequency` text
- `vaccination_history` jsonb (array of `{vaccine, date}`)
- `known_medications` jsonb
- `known_drug_reactions` text
- `last_vet_visit_date` date
- `last_vet_visit_reason` text
- `living_situation` text, CHECK in ('indoor','outdoor','mixed')
- `region` text NOT NULL (city/state in India — drives climate-risk context later)
- `baseline_activity_level` text
- `other_animals_in_household` boolean
- `household_has_children` boolean
- `temperament_flags` text[]
- `known_phobias` text
- `created_at` timestamptz, default `now()`
- `updated_at` timestamptz, default `now()`

**health_history**
- `id` uuid PK, default `gen_random_uuid()`
- `pet_id` uuid NOT NULL, FK → pet_profile.id, ON DELETE CASCADE
- `date_recorded` date NOT NULL
- `condition` text NOT NULL
- `severity` text, CHECK in ('mild','moderate','severe')
- `notes` text
- `created_at` timestamptz, default `now()`

**conversation_memory**
- `id` uuid PK, default `gen_random_uuid()`
- `pet_id` uuid NOT NULL, FK → pet_profile.id, ON DELETE CASCADE
- `created_at` timestamptz, default `now()`
- `owner_question` text NOT NULL
- `symptom_tags` text[]
- `answer_summary` text
- `sources_cited` jsonb
- `escalated` boolean, default false
- `escalation_reason` text
- `confidence_level` text, CHECK in ('low','medium','high')
- `owner_reported_outcome` text

**kb_chunks** (the vet knowledge base — not linked to any pet; retrieved fresh per question)
- `id` uuid PK, default `gen_random_uuid()`
- `source` text NOT NULL (e.g. "WSAVA Global Guidelines", "Dr. X, BVSc")
- `topic` text
- `content` text NOT NULL
- `embedding` vector(1536) — placeholder dimension; we haven't picked an embedding model yet, flag this clearly rather than treating it as final
- `citation_url` text
- `license_note` text
- `created_at` timestamptz, default `now()`

## Indexes

- B-tree index on every `pet_id` foreign key column (health_history, conversation_memory).
- GIN index on `pet_profile.temperament_flags` and `pet_profile.food_allergies` (array columns).
- An `ivfflat` index on `kb_chunks.embedding` for similarity search (note in a comment that it needs `ANALYZE` after the table has real data, since ivfflat is trained on existing rows).

## Tech setup

- Use `node-pg-migrate` (or Knex migrations if you have a strong reason to prefer it — your call, just tell me which and why) for the migration files, one per table plus one that runs `CREATE EXTENSION IF NOT EXISTS vector;` first.
- A `docker-compose.yml` using the `pgvector/pgvector` image so Postgres + pgvector run locally with no manual install.
- A `.env.example` with a `DATABASE_URL` placeholder.
- A small `db.js` (or similar) wrapping a `pg` `Pool`, plus a `GET /health` route that runs a trivial query to confirm the API can reach the database.
- A `seed.js` (optional but nice) that inserts one example owner + pet_profile row, so I can sanity-check the schema by querying it.

## Acceptance check

- `docker compose up -d` brings up Postgres with pgvector enabled.
- Running the migrations creates all five tables with the constraints above and no errors.
- `GET /health` returns 200 and confirms a real DB round-trip, not just "server is up."

## Keep in mind

- This is V0 scope. Don't build the LLM orchestrator, the knowledge-base ingestion pipeline, or the red-flag escalation logic — those are separate, later prompts.
- Field names should stay easy to extend — `health_history` and `conversation_memory` will grow as the chatbot itself gets built.
- If you think a field is missing or a type/constraint choice is wrong for how Postgres will actually be queried later (e.g. the `vaccination_history` jsonb vs. a normalized child table), flag it and tell me your reasoning rather than silently picking one.

Please implement this, run the migrations locally to confirm they apply cleanly, and show me the resulting schema (`\d` output for each table, or however you'd verify it) before we move on to anything beyond the data layer.
