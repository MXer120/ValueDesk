#!/usr/bin/env bash
# The Fed live widget's speech model (apps/web/src/components/fedlive/stt.worker.ts),
# fetched at build time so the site serves it from its own origin: no third party
# in the visitor's browser, nothing to add to the CSP. Moonshine tiny, 8-bit, at a
# pinned revision of onnx-community/moonshine-tiny-ONNX (~30 MB).
#
#   bash deploy/vercel/fetch-model.sh <dir> [<cache>]   writes <dir>/models/onnx-community/moonshine-tiny-ONNX/
#
# build.sh runs it into apps/web/dist; for `npm run dev`, run it once into apps/web/public
# (apps/web/public/models is ignored by git).
#
# EVERY FILE IS CHECKED against its sha256 at the pinned revision (deploy/vercel/model.sha256;
# the two .onnx files are Hugging Face's own LFS ids, the rest checked against its git blob ids,
# 2026-11-18): a file that does not match is fetched again, and one that still does not match
# fails the build - the site never serves weights nobody checked.
#
# <cache>: a directory kept between builds. Vercel re-populates it on the next build of the
# project (package.mjs config.json `cache`: .cache/valuedesk-model), so the ~32 MB come from
# Hugging Face once per revision instead of on every build. A file is taken from the cache
# only when its checksum matches; what is fetched goes into the cache first, then into <dir>.
set -euo pipefail
dest="${1:?usage: fetch-model.sh <dir> [<cache dir>]}"
cache="${2:-}"
repo=onnx-community/moonshine-tiny-ONNX
rev=a6da1241cd305dcd64eab1edbd615f2bb9aabb95
sums="${VS_MODEL_SUMS:-$(dirname "${BASH_SOURCE[0]}")/model.sha256}"
base="${VS_MODEL_BASE_URL:-https://huggingface.co/$repo/resolve/$rev}"
out="$dest/models/$repo"
[ -s "$sums" ] || { echo "error: no checksum list at $sums" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# Where a file is fetched to and checked: the cache (one folder per revision) when there is one.
store="$out"
[ -n "$cache" ] && store="$cache/$repo@$rev"
mkdir -p "$out/onnx" "$store/onnx"
fetched=0
reused=0
while read -r want f; do
  f="${f%$'\r'}"
  [ -n "$f" ] || continue
  mkdir -p "$(dirname "$store/$f")" "$(dirname "$out/$f")"
  if [ -s "$store/$f" ] && [ "$(sha "$store/$f")" = "$want" ]; then
    reused=$((reused + 1))
  else
    curl -fsSL --retry 3 -o "$store/$f.part" "$base/$f"
    got="$(sha "$store/$f.part")"
    if [ "$got" != "$want" ]; then
      rm -f "$store/$f.part"
      echo "error: $f does not match its checksum at $rev (got $got, want $want) - not served" >&2
      exit 1
    fi
    mv -f "$store/$f.part" "$store/$f"
    fetched=$((fetched + 1))
  fi
  [ "$store" = "$out" ] || cp -f "$store/$f" "$out/$f"
done < "$sums"
echo "speech model: $reused file(s) from ${cache:-$out} as they were, $fetched fetched from Hugging Face" >&2
# MIT asks for its notice with every copy, and the site serves the weights: the licence goes
# next to them (served as /models/onnx-community/moonshine-tiny-ONNX/LICENSE.txt, named on /licenses; .txt because the Vercel packaging refuses a file without an extension).
# The English Tiny model is MIT (github.com/moonshine-ai/moonshine LICENSE, section 1; read 2026-10-28).
cat > "$out/LICENSE.txt" <<'EOF'
Moonshine tiny (English speech recognition), ONNX export onnx-community/moonshine-tiny-ONNX
(https://huggingface.co/onnx-community/moonshine-tiny-ONNX), base model UsefulSensors/moonshine-tiny
(https://huggingface.co/UsefulSensors/moonshine-tiny), from https://github.com/moonshine-ai/moonshine.
Served unmodified by ValueDesk for the Fed live widget's in-browser transcription.

MIT License

Copyright (c) 2025 Useful Sensors, Inc. (dba Moonshine AI)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
echo "speech model in $out ($(du -sh "$out" | cut -f1))" >&2
