# Prompt for Claude Code: PDF Knowledge Base Ingestion Pipeline

Copy everything below the line into Claude Code in the same project as the Whoof vet-AI test webpage.

---

I'm replacing the placeholder KB ingestion approach with the real thing. I have actual source documents now — starting with a 126-page WSAVA Global Dental Guidelines PDF (peer-reviewed, image-heavy, deeply structured), and I'll be adding more guideline PDFs over time (vaccination, nutrition, pain management, etc.). The simple "read plain text files from kb-source/" script isn't enough for this — these are real clinical documents with section hierarchy, summary boxes, tables, and dozens of clinical photos/radiographs that carry real diagnostic context in their captions.

Build a proper ingestion pipeline for this. Here's what I need, and why:

## 1. Structure-aware PDF parsing — not flat text extraction

The source PDFs have a consistent shape: numbered Sections, each with topic headings and sub-headings (e.g. "Section 1: Oral Anatomy and Common Pathology" → "Periodontal Diseases" → "Clinical Features"), "Key Points" bullet boxes closing out most subsections, tables, an extensive reference list, and clinical photos/radiographs with detailed captions (e.g. "Figure 9. Bleeding on probing is grade II gingivitis... When gently probed, note the significant haemorrhage").

Dumping this through a naive page-by-page text extractor will scramble headings into body text and lose the structure that makes retrieval accurate. Use a parsing approach that preserves heading hierarchy — your call on tooling (e.g. Python's `unstructured` library detecting headings by font size/weight/color, or a PDF library that exposes text blocks with font metadata so you can reconstruct heading levels yourself, or another approach you think is more reliable). If the best tool for this is Python rather than Node, that's fine — shell out to a Python helper script from the Node ingestion script rather than forcing a worse Node-only library. Tell me what you picked and why.

Whatever you use, each parsed unit needs to retain: which Section / subsection / sub-subsection it belongs to, its page number, and whether it's body text, a "Key Points" box, a table, or a figure caption.

## 2. Chunking rules

- Chunk primarily at the sub-subsection level (e.g. "Clinical Features" as one chunk) — these run roughly 300–600 words in the source document and are already coherent topic units. Split further only if a sub-subsection is unusually long, with ~100-token overlap between splits so a fact isn't orphaned across a cut.
- Pull "Key Points" boxes out as their own chunks (`chunk_type = 'key_points'`). They're the document's own distilled summary and tend to be the highest-signal retrieval target for a simple owner question — don't bury them inside a larger chunk.
- Tables become their own chunks (`chunk_type = 'table'`), preserved as structured markdown (rows/columns intact), not flattened into a paragraph.
- Before embedding, prepend the heading path as literal text, e.g. `"Section 1 > Periodontal Diseases > Clinical Features: "` followed by the chunk content. This measurably helps retrieval because the embedding picks up topical context, not just the raw sentence.
- Strip inline citations like `(Smith 2019)` from the text that gets embedded — they add no semantic value and dilute the vector. Keep the original citations in a separate `citations` text field on the row for provenance/audit, don't just discard them.

## 3. Figures and photos — caption + vision description, not raw image embedding

The photo captions in these documents are often genuinely informative on their own (the gingivitis example above is a real one from the dental guidelines). For each figure:

- Extract the figure's printed caption and the sentence in the body text that references it (e.g. "...(Figure 9)"), and combine them into one chunk tagged `chunk_type = 'figure'`, linked to its parent section.
- Extract the actual image from the PDF page (e.g. via `pdfimages`/`pdftoppm` or page rendering + crop) and pass it to Claude with a vision-capable call, asking for a one-paragraph clinical description of what's depicted. Merge that description into the figure's chunk text alongside the original caption. This is captioning, not multimodal embedding — keeps the retrieval pipeline simple text-only for now.
- This vision call happens once per figure, at ingestion time, not per chat message — so it's a one-time cost per PDF, not a recurring one. Log how many figures you processed and flag any the vision call couldn't confidently describe (e.g. low-resolution diagrams) so I can review them manually.
- Do NOT build image embedding / visual similarity search (e.g. so an owner could upload a photo of their dog's gums and get matched against reference images) — that's a real feature but a separate, bigger one with its own product and liability considerations. Flag it as a phase-2 idea in your summary, don't build it now.

## 4. Schema changes

Extend the existing `kb_chunks` table (flag this as a new migration, same pattern as before — don't silently skip telling me):

- `source_title` text — e.g. "WSAVA Global Dental Guidelines (2020)"
- `section` text, `subsection` text, `sub_subsection` text — nullable, populated where the source has that structure
- `page_number` int
- `chunk_type` text CHECK (`body`, `key_points`, `table`, `figure`)
- `citations` text — original inline citations, stripped from the embedded content
- `confidence_tier` text CHECK (`high`, `medium`, `low`) — default `high` for peer-reviewed/official guideline sources like WSAVA; I'll mark lower tiers manually for anything less authoritative I add later

Keep supporting the existing plain-text/markdown `kb-source/` ingestion path for hand-written short chunks too (some content I'll still just write myself) — this is additive, not a replacement. Those rows can leave the new structural fields null.

Also add a new `breed_reference` table — breed facts shouldn't go through the same RAG pool as guideline text, since breed is already a known field on `pet_profile` and deserves a direct lookup, not a vector-similarity guess:

- `breed_name` text (unique)
- `weight_range_kg` text
- `common_conditions` text[]
- `life_expectancy_years` text
- `temperament_notes` text
- `source` text

Seed it with a small starter set: a handful of common breeds likely to match my actual test owners' dogs, plus a required fallback row for `"Mixed breed / unknown"` (and ideally one for "Indian street dog / indie" given where I'm testing this) so the lookup never comes back empty. I'll expand this list myself later — just get the lookup mechanism working with a few real rows.

## 5. Retrieval upgrade

Update the chat endpoint's retrieval step:

- **Hybrid search**: combine pgvector similarity with Postgres full-text search (`tsvector`) on the chunk text in one query, merging the two rankings (e.g. reciprocal rank fusion). Pure embedding similarity alone misses exact-term matches (specific tooth numbers, drug names, breed names) that keyword search catches directly.
- **Query rewriting**: before embedding the owner's question for retrieval, do a quick LLM pass that restates it in clinical terms (e.g. "his breath stinks and he won't eat" → "halitosis and anorexia in a dog") — owners and guideline documents don't use the same vocabulary, and this closes that gap.
- **Reranking** (Voyage has a rerank endpoint, same provider we're already using): retrieve a wider candidate set (~20-30 chunks) via hybrid search, then rerank down to the top 4-6 before they go to the LLM. This is the change most likely to noticeably improve answer accuracy, but it's a recurring per-message API cost, not a one-time ingestion cost — put it behind an env var (`ENABLE_RERANK=true/false`) so I can A/B it before committing to the extra cost.
- **Breed lookup**: when a chat request comes in, look up the pet's recorded breed against `breed_reference` (exact match, falling back to a simple fuzzy/contains match for typos, falling back to the "Mixed breed / unknown" row) and inject the result directly into the system context — don't route this through vector search at all.

## 6. Ingestion script

Build `scripts/ingest-kb-pdf.js` (or `.py` if that's more practical given your tooling choice above — your call, just be consistent with whatever you used for parsing): takes a PDF path, runs parse → chunk → figure-caption → embed → insert. Make it idempotent — hash the source file and skip re-ingesting unchanged PDFs on repeat runs. Have it print a per-document report when done: chunk counts by type, figure count, any figures flagged for manual review.

Run it against the WSAVA Dental Guidelines PDF I'm providing as the first real test case.

## Acceptance check

1. Running the ingestion script against the dental guidelines PDF completes without errors and reports a chunk count in a sane range for a 126-page document (low hundreds, not a dozen, not tens of thousands).
2. At least one `key_points` chunk and one `figure` chunk exist in `kb_chunks` and read sensibly when I spot-check them directly in the DB.
3. The hybrid search query runs without error and returns dental-relevant results for a test query like "my dog's breath smells really bad."
4. `breed_reference` is seeded and a chat request for a pet with a recorded breed correctly pulls that breed's row into context (and falls back cleanly for an unrecognized breed).
5. Re-running the ingestion script on the same PDF doesn't duplicate chunks.

## Keep in mind

- This PDF has a real text layer (not a scanned image needing OCR) — don't build OCR handling for this one, but flag in your summary if you hit a future PDF that's scan-only, since that would need a different approach.
- Don't build the image-embedding/visual-diagnosis feature — captioning only, as above.
- Don't touch the existing `vector(1536)`→Voyage dimension setup from the last migration — keep using the same embedding model/dimension that's already working.

Implement this, then tell me: what parsing tool you went with and why, the ingestion report from running it on the dental guidelines PDF, and whether reranking is on or off by default.
