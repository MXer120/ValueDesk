#!/usr/bin/env bash
# The Fed live widget's speech model (apps/web/src/components/fedlive/stt.worker.ts),
# fetched at build time so the site serves it from its own origin: no third party
# in the visitor's browser, nothing to add to the CSP. Moonshine tiny, 8-bit, at a
# pinned revision of onnx-community/moonshine-tiny-ONNX (~30 MB).
#
#   bash deploy/vercel/fetch-model.sh <dir>   writes <dir>/models/onnx-community/moonshine-tiny-ONNX/
#
# build.sh runs it into apps/web/dist; for `npm run dev`, run it once into apps/web/public
# (apps/web/public/models is ignored by git).
set -euo pipefail
dest="${1:?usage: fetch-model.sh <dir>}"
repo=onnx-community/moonshine-tiny-ONNX
rev=a6da1241cd305dcd64eab1edbd615f2bb9aabb95
out="$dest/models/$repo"
mkdir -p "$out/onnx"
for f in config.json generation_config.json preprocessor_config.json special_tokens_map.json tokenizer.json tokenizer_config.json \
         onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  [ -s "$out/$f" ] && continue
  curl -fsSL --retry 3 -o "$out/$f" "https://huggingface.co/$repo/resolve/$rev/$f"
done
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
