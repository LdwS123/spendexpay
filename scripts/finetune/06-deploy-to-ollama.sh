#!/usr/bin/env bash
#
# 06-deploy-to-ollama.sh — bake the mlx-lm LoRA adapter into a deployable
# Ollama model.
#
# Steps:
#   1) Fuse the LoRA adapter into the base model with mlx_lm.fuse — produces
#      a full HF-format model directory.
#   2) Convert that to GGUF via llama.cpp's convert_hf_to_gguf.py.
#   3) Write a Modelfile and register with `ollama create`.
#   4) Smoke-test the new model with one classification.
#
# Prerequisites:
#   pip install mlx-lm                                  # already needed for 04-finetune
#   git clone https://github.com/ggerganov/llama.cpp   # needs convert_hf_to_gguf.py
#   pip install -r llama.cpp/requirements.txt
#   ollama --version                                    # >= 0.3 for ADAPTER support
#
# Why fuse-then-convert and not "ollama supports LoRA adapters directly":
#   Ollama's ADAPTER directive expects a GGUF-format LoRA, not an mlx-format
#   one. The simplest path is to merge the adapter into the base weights and
#   ship the fused model as a single quantised GGUF. Saves a step at runtime
#   too — no adapter to load each time the model is served.

set -euo pipefail

BASE_MODEL="${BASE_MODEL:-mlx-community/Llama-3.2-3B-Instruct-4bit}"
ADAPTER_DIR="${ADAPTER_DIR:-./adapters}"
FUSED_DIR="${FUSED_DIR:-./fused-model}"
GGUF_PATH="${GGUF_PATH:-./fused-model.gguf}"
LLAMA_CPP="${LLAMA_CPP:-./llama.cpp}"
OLLAMA_TAG="${OLLAMA_TAG:-spendex-classifier:v1}"

echo "[deploy] base=$BASE_MODEL adapter=$ADAPTER_DIR -> $OLLAMA_TAG"

# 1) Fuse: turns adapter + base into a single set of weights.
echo "[deploy] step 1/4 - fusing adapter into base model"
python -m mlx_lm.fuse \
  --model "$BASE_MODEL" \
  --adapter-path "$ADAPTER_DIR" \
  --save-path "$FUSED_DIR"

# 2) Convert to GGUF. We default to Q4_K_M quantisation - the sweet spot for
#    Llama-3.2 3B: <2 GB on disk, runs in <4 GB RAM, accuracy loss <1%.
echo "[deploy] step 2/4 - converting to GGUF (Q4_K_M)"
if [ ! -d "$LLAMA_CPP" ]; then
  echo "[deploy] error: llama.cpp not found at $LLAMA_CPP"
  echo "        clone with: git clone https://github.com/ggerganov/llama.cpp"
  exit 1
fi
python "$LLAMA_CPP/convert_hf_to_gguf.py" "$FUSED_DIR" --outfile "$GGUF_PATH" --outtype q4_k_m

# 3) Write a Modelfile and register with Ollama.
#    - FROM: bundles the fused GGUF directly (no upstream pull needed).
#    - SYSTEM: same system prompt the production server uses so the tuned
#      model sees the same context distribution at inference time.
#    - PARAMETER temperature 0.1: classification is a labelling task, low
#      temperature gives stable answers.
echo "[deploy] step 3/4 - registering with Ollama as $OLLAMA_TAG"
MODELFILE="$(mktemp)"
cat > "$MODELFILE" <<EOF
FROM $GGUF_PATH

SYSTEM """You are a purchase-intent classifier for an AI agent wallet (Spendex). Given a merchant + description + amount, output a structured classification the rules engine uses to decide whether to authorize the charge. Categories: dev_tools, shopping, subscription, food, travel, gambling, crypto, gift_cards, cash_advance, unknown. Urgency: low|medium|high. risk_score: 0-100. Respond with a single JSON object."""

PARAMETER temperature 0.1
PARAMETER num_predict 400
EOF
ollama create "$OLLAMA_TAG" -f "$MODELFILE"

# 4) Smoke test.
echo "[deploy] step 4/4 - smoke test"
ollama run "$OLLAMA_TAG" "service: amazon
amount_usd: 1200
description: buy a MacBook Pro

Respond with a single JSON object with fields category, subcategory, urgency, risk_score, reasoning."

echo ""
echo "[deploy] done. Configure the MCP server with:"
echo "          CLASSIFIER_BACKEND=ollama"
echo "          OLLAMA_MODEL=$OLLAMA_TAG"
