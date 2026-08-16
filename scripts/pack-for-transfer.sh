#!/usr/bin/env bash
# Packs the current project into a .tar.gz for moving to another machine.
# Never touches anything on this machine — excluded paths just aren't added
# to the archive; nothing on disk here is deleted or modified.
#
# Usage:
#   scripts/pack-for-transfer.sh [--strip-personal] [output_dir]
#
#   --strip-personal   Also excludes data/resumes, data/cover-letters,
#                       data/answer-examples, data/candidate-notes (your
#                       profile content). Off by default — a normal transfer
#                       keeps them so the new machine has continuity.
#   output_dir          Where to write the archive. Defaults to the parent
#                       directory of the project (never inside it, so the
#                       archive being written can't accidentally include
#                       itself).
#
# Always excluded, regardless of flags:
#   node_modules/, dist/, .vitest-data/  — regenerate via `npm run setup`/
#                                           `npm run build`.
#   data/db/*.sqlite3*                   — regenerates on first run.
#   data/runs/                           — this machine's run history/artifacts.
#   data/workspaces/                     — per-workbench data (other people's
#                                           resumes/examples/run history, not
#                                           yours), same tier as data/runs above.
#   .env                                 — never bundled into any archive by
#                                           this project, on principle (real
#                                           API keys live there). Copy it by
#                                           hand if you want continuity.

set -euo pipefail

strip_personal=false
output_dir=""

for arg in "$@"; do
  case "$arg" in
    --strip-personal) strip_personal=true ;;
    *) output_dir="$arg" ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
project_name="$(basename "$project_dir")"

if [[ -z "$output_dir" ]]; then
  output_dir="$(cd "$project_dir/.." && pwd)"
else
  mkdir -p "$output_dir"
  output_dir="$(cd "$output_dir" && pwd)"
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
archive_path="$output_dir/${project_name}-transfer-${timestamp}.tar.gz"

excludes=(
  --exclude="./node_modules"
  --exclude="./dist"
  --exclude="./.vitest-data"
  --exclude="./data/db/*.sqlite3*"
  --exclude="./data/runs"
  --exclude="./data/workspaces"
  --exclude="./.env"
)

if $strip_personal; then
  excludes+=(
    --exclude="./data/resumes/*.pdf"
    --exclude="./data/resumes/.cache"
    --exclude="./data/cover-letters/*.md"
    --exclude="./data/cover-letters/*.txt"
    --exclude="./data/answer-examples/*.md"
    --exclude="./data/answer-examples/*.txt"
    --exclude="./data/candidate-notes/*.md"
    --exclude="./data/candidate-notes/*.txt"
  )
fi

echo "Packing $project_dir"
echo "  -> $archive_path"
$strip_personal && echo "  (personal profile files excluded)" || echo "  (personal profile files included)"

tar -czf "$archive_path" -C "$project_dir" "${excludes[@]}" .

echo "Done."
echo "Note: .env was never included — copy it by hand if you want the new machine to have your real API keys."
