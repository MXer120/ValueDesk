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
echo "speech model in $out ($(du -sh "$out" | cut -f1))" >&2
