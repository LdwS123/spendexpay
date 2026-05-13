#!/usr/bin/env bash
#
# 04-finetune.sh — LoRA fine-tune Llama 3.2 3B on the prepared dataset.
#
# Two paths:
#
#   1) Mac (Apple Silicon, default)   — uses mlx-lm (https://github.com/ml-explore/mlx-lm).
#      Runs on the unified Metal memory; no CUDA needed.
#   2) Linux with NVIDIA GPU           — set BACKEND=axolotl to run via axolotl.
#      Requires axolotl + CUDA + appropriate Python wheels.
#
# Prerequisites:
#
#   Mac:
#     python3 -m venv .venv && source .venv/bin/activate
#     pip install --upgrade mlx-lm
#     # Verify: python -m mlx_lm.lora --help
#
#   Linux:
#     pip install axolotl[deepspeed]
#     # Verify: axolotl --version
#
# Inputs:
#   ./data/train.jsonl, ./data/valid.jsonl   produced by 03-prepare-mlx-data.ts
#
# Outputs:
#   ./adapters/                              LoRA weights (small, ~50–100 MB)
#   ./adapters/adapter_config.json           hyperparameters (auto-emitted by mlx-lm)
#
# Tuning notes:
#   - The defaults below are good for 5k–20k examples on an M-series Mac with
#     32 GB unified memory. Bump --iters if your loss is still falling at the end.
#   - Watch the valid-loss curve. If it stops falling for 100 iters, stop —
#     anything more is overfit on a 5k-example set.
#

set -euo pipefail

BACKEND="${BACKEND:-mlx}"
DATA_DIR="${DATA_DIR:-./data}"
ADAPTER_DIR="${ADAPTER_DIR:-./adapters}"
MODEL="${MODEL:-mlx-community/Llama-3.2-3B-Instruct-4bit}"
ITERS="${ITERS:-1000}"
BATCH_SIZE="${BATCH_SIZE:-4}"
LORA_LAYERS="${LORA_LAYERS:-16}"
SAVE_EVERY="${SAVE_EVERY:-100}"

echo "[finetune] backend=$BACKEND model=$MODEL iters=$ITERS"

mkdir -p "$ADAPTER_DIR"

if [ "$BACKEND" = "mlx" ]; then
  # mlx-lm LoRA fine-tune. Flags:
  #   --model          Base model on Hugging Face. The "Instruct-4bit" variant
  #                    is pre-quantised so it fits in <8GB unified memory.
  #   --train          Required flag to actually run training (otherwise it
  #                    just builds the adapter scaffolding).
  #   --data           Directory containing train.jsonl + valid.jsonl. mlx-lm
  #                    auto-detects the schema from the file extension.
  #   --iters          Number of optimisation steps. 1000 is enough for ~5k
  #                    examples; scale linearly with dataset size.
  #   --batch-size     4 fits in 32 GB unified memory on a Llama-3.2-3B-Q4.
  #                    Bump to 8 on 64 GB+ machines.
  #   --lora-layers    Top N transformer layers to adapt. 16 is a strong
  #                    default — adapts the head and last few attention blocks.
  #   --save-every     Checkpoint cadence. 100 iters means ~10 saves over a
  #                    1000-step run; you can resume from any of them.
  #   --adapter-path   Where to write the LoRA weights.
  python -m mlx_lm.lora \
    --model "$MODEL" \
    --train \
    --data "$DATA_DIR" \
    --iters "$ITERS" \
    --batch-size "$BATCH_SIZE" \
    --num-layers "$LORA_LAYERS" \
    --save-every "$SAVE_EVERY" \
    --adapter-path "$ADAPTER_DIR"

  echo "[finetune] done. LoRA adapter at $ADAPTER_DIR"
  echo "[finetune] next: bash scripts/finetune/06-deploy-to-ollama.sh"

elif [ "$BACKEND" = "axolotl" ]; then
  # Axolotl path for Linux GPU machines. Axolotl wants a YAML config; we
  # generate one inline so the script stays self-contained.
  CONFIG_FILE="$(mktemp).yml"
  cat > "$CONFIG_FILE" <<EOF
base_model: meta-llama/Llama-3.2-3B-Instruct
model_type: LlamaForCausalLM
tokenizer_type: AutoTokenizer
load_in_4bit: true
strict: false

datasets:
  - path: $DATA_DIR/train.jsonl
    type: chat_template
    chat_template: llama3
    field_messages: messages

dataset_prepared_path:
val_set_size: 0.0
output_dir: $ADAPTER_DIR

adapter: lora
lora_r: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target_modules:
  - q_proj
  - v_proj
  - k_proj
  - o_proj

sequence_len: 1024
sample_packing: false
pad_to_sequence_len: false

gradient_accumulation_steps: 4
micro_batch_size: $BATCH_SIZE
num_epochs: 3
optimizer: adamw_bnb_8bit
lr_scheduler: cosine
learning_rate: 0.0002

bf16: auto
gradient_checkpointing: true
flash_attention: true
EOF
  echo "[finetune] axolotl config → $CONFIG_FILE"
  axolotl train "$CONFIG_FILE"
  echo "[finetune] done. axolotl wrote weights under $ADAPTER_DIR"
  echo "[finetune] next: convert to GGUF and bash scripts/finetune/06-deploy-to-ollama.sh"

else
  echo "Unknown BACKEND='$BACKEND'. Use 'mlx' (default, Mac) or 'axolotl' (Linux GPU)."
  exit 1
fi
