#!/usr/bin/env python3
"""
parse_pdf.py — Structure-aware PDF parser for WSAVA and similar clinical guideline PDFs.

Tooling choice: PyMuPDF (fitz) for text/image extraction with font metadata,
pdfplumber for table detection. PyMuPDF gives per-span font-size + flags which is
the most reliable way to reconstruct heading hierarchy without an external ML model.
pdfplumber's line-detection is materially better than fitz for tables in journal-style
PDFs. Both are fast and have no network calls.

Usage:
    python3 scripts/parse_pdf.py <pdf_path> --output <out.json> [--image-dir <dir>]

Output: JSON file containing { source_title, page_count, chunks: [...], image_dir }
        Each chunk: { chunk_type, section, subsection, sub_subsection, page_number,
                      content, citations, figure_id, image_path, heading_path }

Requirements:  pip install PyMuPDF pdfplumber
"""

import sys
import os
import json
import re
import argparse
import hashlib
from pathlib import Path
from collections import Counter

try:
    import fitz  # PyMuPDF
except ImportError:
    print("ERROR: PyMuPDF not installed. Run: pip3 install PyMuPDF pdfplumber", file=sys.stderr)
    sys.exit(1)

try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    print("WARNING: pdfplumber not installed — table extraction disabled.", file=sys.stderr)
    HAS_PDFPLUMBER = False

# ── Constants ──────────────────────────────────────────────────────────────────

CITATION_PARENS  = re.compile(r'\([A-Z][A-Za-z\-]+ et al\.?,? \d{4}[a-z]?(?:[,;] [A-Z][A-Za-z\-]+ et al\.?,? \d{4}[a-z]?)*\)')
CITATION_AUTHOR  = re.compile(r'\b[A-Z][a-z]+ (?:et al\.?,? )?\(\d{4}\)')
CITATION_NUMBERED= re.compile(r'\[\d+(?:[,–\-]\d+)*\]')
FIGURE_CAPTION   = re.compile(r'^(Fig(?:ure)?\.?\s*\d+[a-zA-Z]?(?:\.\d+)?)[.\s:\-–]', re.IGNORECASE)
TABLE_CAPTION    = re.compile(r'^Table\s+\d+[.\s:\-–]', re.IGNORECASE)
KEY_POINTS_HDR   = re.compile(r'^key\s+point', re.IGNORECASE)
SECTION_NUM      = re.compile(r'^\d+(\.\d+){0,2}\s+\S')  # e.g. "1 Intro" or "1.2.3 Sub"
# Text to skip (running headers/footers typical in journal articles)
SKIP_PATTERNS    = [
    re.compile(r'^\d+\s*$'),                        # bare page numbers
    re.compile(r'^journal of small animal practice', re.IGNORECASE),
    re.compile(r'^wiley\s', re.IGNORECASE),
    re.compile(r'^©\s*\d{4}', re.IGNORECASE),
    re.compile(r'^doi:', re.IGNORECASE),
    re.compile(r'^received:|^accepted:|^correspondence:', re.IGNORECASE),
    re.compile(r'^https?://', re.IGNORECASE),       # bare URLs (journal website headers)
    re.compile(r'^www\.\S+$', re.IGNORECASE),       # bare domain names
    re.compile(r'^\d{8,},\s*\d{4},\s*\d+,\s*Downloaded from', re.IGNORECASE),  # Wiley download notice
    re.compile(r'onlinelibrary\.wiley\.com', re.IGNORECASE),                    # Wiley URL in notice
    re.compile(r'^\s*Global Dental Guidelines\s*$', re.IGNORECASE),            # repeated page header
    re.compile(r'^\s*WSAVA\s+Global\s+', re.IGNORECASE),                       # repeated page header
    re.compile(r'^This is an open access article', re.IGNORECASE),             # open-access notice
]

# Fraction of page height: blocks whose top is in the top N% or bottom N%
# are treated as header/footer and skipped. Tuned for A4 two-column journal PDFs.
HEADER_FOOTER_MARGIN = 0.08   # 8% of page height
OVERLAP_CHARS = 400   # ~100 tokens of overlap between splits
MAX_CHUNK_CHARS = 3000


# ── Helpers ────────────────────────────────────────────────────────────────────

def strip_citations(text):
    """Remove inline citations; return (clean_text, extracted_citations)."""
    cites = []
    for pat in (CITATION_PARENS, CITATION_AUTHOR, CITATION_NUMBERED):
        for m in pat.finditer(text):
            cites.append(m.group(0))
    clean = CITATION_PARENS.sub('', text)
    clean = CITATION_AUTHOR.sub('', clean)
    clean = CITATION_NUMBERED.sub('', clean)
    clean = re.sub(r'  +', ' ', clean).strip()
    return clean, '; '.join(dict.fromkeys(cites))  # deduplicated


def should_skip(text):
    t = text.strip()
    if len(t) < 3:
        return True
    for pat in SKIP_PATTERNS:
        if pat.match(t):
            return True
    return False


def split_long_chunk(text, max_chars=MAX_CHUNK_CHARS, overlap=OVERLAP_CHARS):
    """Split text at sentence boundaries with overlap."""
    if len(text) <= max_chars:
        return [text]
    # Split at sentence ends
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks, cur = [], ''
    for sent in sentences:
        if len(cur) + len(sent) > max_chars and cur:
            chunks.append(cur.strip())
            # carry last `overlap` chars into next chunk
            cur = cur[-overlap:] + ' ' + sent if len(cur) > overlap else sent
        else:
            cur = (cur + ' ' + sent).strip() if cur else sent
    if cur.strip():
        chunks.append(cur.strip())
    return chunks


def make_heading_path(*parts):
    return ' > '.join(p for p in parts if p)


# ── Font-size based heading detection ─────────────────────────────────────────

def analyse_font_sizes(doc):
    """
    Returns (body_size, heading_thresholds) where heading_thresholds is a
    sorted list of (min_size, level) pairs — level 1 = section, 2 = subsection, 3 = sub.
    """
    size_counts = Counter()
    for page in doc:
        for block in page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    s = round(span["size"], 1)
                    size_counts[s] += len(span["text"])

    if not size_counts:
        return 10.0, []

    body_size = size_counts.most_common(1)[0][0]
    # Any size > body + 1pt is a candidate heading
    heading_sizes = sorted([s for s in size_counts if s > body_size + 0.9], reverse=True)

    thresholds = []
    for level, sz in enumerate(heading_sizes[:3], start=1):
        thresholds.append((sz, level))

    return body_size, thresholds


def classify_span(span, body_size, thresholds):
    """Return 'h1'|'h2'|'h3'|'body'|'caption'."""
    size  = round(span["size"], 1)
    flags = span.get("flags", 0)
    is_bold = bool(flags & 16)

    for min_sz, level in thresholds:
        if size >= min_sz - 0.2:
            return f'h{level}'

    # Bold text slightly larger than body → treat as h3
    if is_bold and size >= body_size + 0.5:
        return 'h3'

    # Small italic → likely caption or footnote
    if size < body_size - 0.8:
        return 'caption'

    return 'body'


# ── Table extraction via pdfplumber ───────────────────────────────────────────

def extract_tables_from_pdf(pdf_path):
    """Returns {page_num: [markdown_table_str]} (1-indexed pages)."""
    if not HAS_PDFPLUMBER:
        return {}
    tables_by_page = {}
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages, start=1):
                raw_tables = page.extract_tables()
                if not raw_tables:
                    continue
                md_tables = []
                for tbl in raw_tables:
                    if not tbl or not tbl[0]:
                        continue
                    rows = []
                    header = [str(c or '').strip() for c in tbl[0]]
                    rows.append('| ' + ' | '.join(header) + ' |')
                    rows.append('|' + '---|' * len(header))
                    for row in tbl[1:]:
                        cells = [str(c or '').strip().replace('\n', ' ') for c in row]
                        rows.append('| ' + ' | '.join(cells) + ' |')
                    md_tables.append('\n'.join(rows))
                if md_tables:
                    tables_by_page[i] = md_tables
    except Exception as e:
        print(f"WARNING: pdfplumber table extraction failed: {e}", file=sys.stderr)
    return tables_by_page


# ── Image extraction ───────────────────────────────────────────────────────────

def extract_images_from_page(doc, page_num_0, image_dir, source_stem):
    """Extract images from page (0-indexed) to image_dir. Returns list of paths."""
    paths = []
    page = doc[page_num_0]
    img_list = page.get_images(full=True)
    for img_index, img_info in enumerate(img_list):
        xref = img_info[0]
        try:
            img_data = doc.extract_image(xref)
            ext  = img_data.get("ext", "png")
            raw  = img_data.get("image", b"")
            if len(raw) < 2000:   # skip tiny icons/logos
                continue
            w = img_data.get("width",  0)
            h = img_data.get("height", 0)
            if w < 80 or h < 80:  # skip tiny decorative images
                continue
            fname = f"{source_stem}_p{page_num_0+1}_img{img_index}.{ext}"
            fpath = os.path.join(image_dir, fname)
            with open(fpath, "wb") as f:
                f.write(raw)
            paths.append(fpath)
        except Exception as e:
            print(f"WARNING: could not extract image xref={xref} page={page_num_0+1}: {e}", file=sys.stderr)
    return paths


# ── Main parse routine ─────────────────────────────────────────────────────────

def clean_title_from_filename(pdf_path):
    """Turn a filename stem into a readable title."""
    stem = Path(pdf_path).stem
    stem = re.sub(r'[_\-]+', ' ', stem)          # underscores/dashes → spaces
    stem = re.sub(r'\s+', ' ', stem).strip()
    return stem

# Junk metadata titles produced by authoring tools — not usable as citations.
JUNK_TITLE = re.compile(
    r'^(microsoft word|untitled|document\d*|.*\.(qxp|doc|docx|indd|pdf|pages|tex)\b)',
    re.IGNORECASE,
)

def derive_source_title(doc, pdf_path, override=None):
    if override:
        return override.strip()
    meta = doc.metadata or {}
    meta_title = (meta.get("title") or '').strip()
    if meta_title and not JUNK_TITLE.match(meta_title) and len(meta_title) > 4:
        return meta_title
    return clean_title_from_filename(pdf_path)

def parse_pdf(pdf_path, image_dir, title_override=None):
    doc = fitz.open(pdf_path)
    source_stem = Path(pdf_path).stem[:40].replace(' ', '_')

    # Derive source title — explicit override > clean metadata title > filename
    source_title = derive_source_title(doc, pdf_path, title_override)

    body_size, thresholds = analyse_font_sizes(doc)
    tables_by_page = extract_tables_from_pdf(pdf_path)

    # Collect all images by page (0-indexed)
    images_by_page = {}
    os.makedirs(image_dir, exist_ok=True)
    for pno in range(len(doc)):
        imgs = extract_images_from_page(doc, pno, image_dir, source_stem)
        if imgs:
            images_by_page[pno] = imgs

    chunks = []

    # State
    section         = None
    subsection      = None
    sub_subsection  = None
    current_text    = []
    current_cites   = []
    current_page    = 1
    in_key_points   = False
    in_references   = False

    def flush_body():
        nonlocal current_text, current_cites, in_key_points
        text = ' '.join(current_text).strip()
        cites = '; '.join(dict.fromkeys(c for c in current_cites if c))
        current_text  = []
        current_cites = []
        if not text or len(text) < 40:
            return
        if should_skip(text):
            return

        ctype = 'key_points' if in_key_points else 'body'
        in_key_points = False

        heading_path = make_heading_path(section, subsection, sub_subsection)
        for split in split_long_chunk(text):
            chunks.append({
                "chunk_type":     ctype,
                "section":        section,
                "subsection":     subsection,
                "sub_subsection": sub_subsection,
                "page_number":    current_page,
                "content":        split,
                "citations":      cites,
                "figure_id":      None,
                "image_path":     None,
                "heading_path":   heading_path,
            })

    # Insert table chunks that appeared on this page
    def flush_tables_for_page(page_1indexed):
        for md_table in tables_by_page.get(page_1indexed, []):
            heading_path = make_heading_path(section, subsection, sub_subsection)
            chunks.append({
                "chunk_type":     "table",
                "section":        section,
                "subsection":     subsection,
                "sub_subsection": sub_subsection,
                "page_number":    page_1indexed,
                "content":        md_table,
                "citations":      "",
                "figure_id":      None,
                "image_path":     None,
                "heading_path":   heading_path,
            })

    seen_tables = set()

    for page in doc:
        pno = page.number   # 0-indexed
        page_1 = pno + 1

        # Tables (add once per page)
        if page_1 not in seen_tables:
            flush_tables_for_page(page_1)
            seen_tables.add(page_1)

        page_images = images_by_page.get(pno, [])
        page_image_idx = 0

        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
        page_rect = page.rect
        page_h = page_rect.height if page_rect.height else 842
        page_w = page_rect.width  if page_rect.width  else 595
        margin_top    = page_h * HEADER_FOOTER_MARGIN
        margin_bottom = page_h * (1 - HEADER_FOOTER_MARGIN)

        # Sort blocks by vertical band then horizontal position (two-column reading order)
        blocks_sorted = sorted(blocks, key=lambda b: (round(b["bbox"][1] / 20) * 20, b["bbox"][0]))

        for block in blocks_sorted:
            if block.get("type") != 0:
                continue

            # Skip blocks that sit in the top or bottom margin (running headers/footers)
            bx0, by0, bx1, by1 = block["bbox"]
            if by1 < margin_top or by0 > margin_bottom:
                continue

            block_text_parts = []
            block_class  = 'body'
            block_is_bold_only = True

            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    t = span["text"].strip()
                    if not t:
                        continue
                    cls = classify_span(span, body_size, thresholds)
                    if cls == 'body' and not (span.get("flags", 0) & 16):
                        block_is_bold_only = False
                    if cls in ('h1', 'h2', 'h3'):
                        block_class = cls
                    block_text_parts.append(t)

            raw = ' '.join(block_text_parts).strip()
            if not raw or len(raw) < 3:
                continue
            if should_skip(raw):
                continue

            # Stop accumulating content once we hit the References section
            if re.match(r'^references?\s*$', raw, re.IGNORECASE):
                flush_body()
                in_references = True
                continue
            if in_references:
                continue

            # ── Detect figure captions ────────────────────────────────────────
            fig_match = FIGURE_CAPTION.match(raw)
            if fig_match:
                flush_body()
                figure_id = fig_match.group(1).strip()
                clean_cap, cap_cites = strip_citations(raw)
                # Associate with next available image on this page
                img_path = None
                if page_image_idx < len(page_images):
                    img_path = page_images[page_image_idx]
                    page_image_idx += 1
                heading_path = make_heading_path(section, subsection, sub_subsection)
                chunks.append({
                    "chunk_type":     "figure",
                    "section":        section,
                    "subsection":     subsection,
                    "sub_subsection": sub_subsection,
                    "page_number":    page_1,
                    "content":        clean_cap,
                    "citations":      cap_cites,
                    "figure_id":      figure_id,
                    "image_path":     img_path,
                    "heading_path":   heading_path,
                })
                current_page = page_1
                continue

            # ── Table caption (pdfplumber already extracted the table itself) ─
            if TABLE_CAPTION.match(raw):
                continue

            # ── Key Points marker ─────────────────────────────────────────────
            if KEY_POINTS_HDR.match(raw):
                flush_body()
                in_key_points = True
                current_page = page_1
                continue

            # ── Heading ───────────────────────────────────────────────────────
            if block_class in ('h1', 'h2', 'h3'):
                flush_body()
                current_page = page_1
                if block_class == 'h1' or (SECTION_NUM.match(raw) and raw.count('.') == 0):
                    section        = raw
                    subsection     = None
                    sub_subsection = None
                elif block_class == 'h2' or (SECTION_NUM.match(raw) and raw.count('.') == 1):
                    subsection     = raw
                    sub_subsection = None
                else:
                    sub_subsection = raw
                in_key_points = False
                continue

            # ── Body text ─────────────────────────────────────────────────────
            clean, cites = strip_citations(raw)
            if clean:
                current_text.append(clean)
                if cites:
                    current_cites.append(cites)
                current_page = page_1

    flush_body()

    # Images with no caption (remaining unassigned images get a placeholder figure chunk)
    for pno, img_list in images_by_page.items():
        for img_path in img_list:
            # Check if already assigned to a figure chunk
            assigned = any(c.get("image_path") == img_path for c in chunks)
            if not assigned:
                chunks.append({
                    "chunk_type":     "figure",
                    "section":        None,
                    "subsection":     None,
                    "sub_subsection": None,
                    "page_number":    pno + 1,
                    "content":        f"[Image from page {pno+1} — no caption found]",
                    "citations":      "",
                    "figure_id":      f"img_p{pno+1}",
                    "image_path":     img_path,
                    "heading_path":   "",
                })

    page_count = len(doc)
    doc.close()
    return {
        "source_title": source_title,
        "pdf_path":     str(pdf_path),
        "page_count":   page_count,
        "chunks":       chunks,
        "image_dir":    image_dir,
    }


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Structure-aware PDF parser for clinical guideline PDFs")
    ap.add_argument("pdf_path", help="Path to the PDF file")
    ap.add_argument("--output", required=True, help="Output JSON file path")
    ap.add_argument("--image-dir", default="/tmp/whoof_pdf_images", help="Directory to save extracted images")
    ap.add_argument("--title", default=None, help="Override the source_title (used in citations) instead of deriving from metadata/filename")
    args = ap.parse_args()

    pdf_path = os.path.abspath(args.pdf_path)
    if not os.path.exists(pdf_path):
        print(f"ERROR: PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    stem = hashlib.md5(pdf_path.encode()).hexdigest()[:8]
    image_dir = os.path.join(args.image_dir, stem)
    os.makedirs(image_dir, exist_ok=True)

    print(f"Parsing: {os.path.basename(pdf_path)}", file=sys.stderr)
    result = parse_pdf(pdf_path, image_dir, title_override=args.title)

    # Summary stats to stderr
    by_type = {}
    for c in result["chunks"]:
        t = c["chunk_type"]
        by_type[t] = by_type.get(t, 0) + 1
    print(f"  Pages:    {result['page_count']}", file=sys.stderr)
    print(f"  Chunks:   {len(result['chunks'])} total", file=sys.stderr)
    for t, n in sorted(by_type.items()):
        print(f"    {t:12s}: {n}", file=sys.stderr)
    figs_with_images = sum(1 for c in result["chunks"] if c.get("image_path"))
    print(f"  Images extracted: {figs_with_images}", file=sys.stderr)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"Output written to: {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
