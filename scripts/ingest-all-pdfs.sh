#!/usr/bin/env bash
#
# ingest-all-pdfs.sh — ingest every PDF in kb-source/ through the pipeline.
#
# Idempotent: ingest-kb-pdf.js hashes each file and skips unchanged ones, so
# re-running only processes new or modified PDFs.
#
# Usage:
#   bash scripts/ingest-all-pdfs.sh                 # full ingest (embeddings + figure vision)
#   bash scripts/ingest-all-pdfs.sh --no-vision     # skip Claude vision (faster, cheaper)
#   bash scripts/ingest-all-pdfs.sh --dry-run       # parse + report only, no DB writes
#   bash scripts/ingest-all-pdfs.sh --force         # re-ingest even if unchanged
#
# Requires VOYAGE_API_KEY (embeddings) and, unless --no-vision, ANTHROPIC_API_KEY
# (figure descriptions) in .env.

set -u
cd "$(dirname "$0")/.." || exit 1

EXTRA_ARGS=("$@")

# Clean citation titles for files whose auto-derived title is poor.
# Anything not listed here uses the parser's derived title.
title_for() {
  case "$1" in
    "cancergoldens.pdf")                      echo "Cancer in Golden Retrievers" ;;
    "Golden-Retriever-ready.pdf")             echo "Golden Retriever — Breed Overview" ;;
    "Final-GRCA-Study-Guide-2017-rev.pdf")    echo "GRCA Golden Retriever Study Guide (2017)" ;;
    "The_Golden_Retriever_Lifetime_Study_establishing_a.pdf") echo "The Golden Retriever Lifetime Study" ;;
    "PGR_submission_Kinsman_Rachel_1456578_FINAL.pdf")        echo "Kinsman — Canine Research Thesis" ;;
    "WSAVA-Hereditary-Disease-Committee-Position-Paper-HDC-Edited.pdf") echo "WSAVA Hereditary Disease Committee Position Paper" ;;
    "WSAVA-Nutrition-Assessment-Guidelines-2011-JSAP.pdf")    echo "WSAVA Nutrition Assessment Guidelines (2011)" ;;
    "J of Small Animal Practice - 2020 - Niemiec - World Small Animal Veterinary Association Global Dental Guidelines.pdf") echo "WSAVA Global Dental Guidelines (2020)" ;;
    "J of Small Animal Practice - 2022 - Monteiro - 2022 WSAVA guidelines for the recognition  assessment and treatment of pain.pdf") echo "WSAVA Pain Management Guidelines (2022)" ;;
    "Veterinary Internal Medicine - 2010 -  - Endoscopic  Biopsy  and Histopathologic Guidelines for the Evaluation of.pdf") echo "Endoscopic Biopsy & Histopathologic GI Guidelines (2010)" ;;
    "WSAVA-Vaccination-guidelines-2024.pdf")  echo "WSAVA Vaccination Guidelines (2024)" ;;
    *) echo "" ;;
  esac
}

total=0; ok=0; failed=0
for pdf in kb-source/*.pdf; do
  [ -e "$pdf" ] || continue
  total=$((total+1))
  base="$(basename "$pdf")"
  title="$(title_for "$base")"

  echo ""
  echo "########################################################################"
  echo "# $base"
  echo "########################################################################"

  if [ -n "$title" ]; then
    node scripts/ingest-kb-pdf.js "$pdf" --title "$title" "${EXTRA_ARGS[@]}"
  else
    node scripts/ingest-kb-pdf.js "$pdf" "${EXTRA_ARGS[@]}"
  fi

  if [ $? -eq 0 ]; then ok=$((ok+1)); else failed=$((failed+1)); fi
done

echo ""
echo "════════════════════════════════════════"
echo " Batch ingest finished: $ok ok, $failed failed, $total total"
echo "════════════════════════════════════════"
