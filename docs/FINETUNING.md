# Fine-tuning the intent classifier

This guide walks through swapping Spendex's purchase-intent classifier from
Claude Haiku 4.5 (the production default) to a locally-hosted, fine-tuned
Llama 3.2 3B served via Ollama. You'll end up with:

- A LoRA-fine-tuned model that runs on your own hardware (Mac M-series by
  default; NVIDIA-GPU Linux supported via axolotl).
- An `ollama create`d tag (e.g. `spendex-classifier:v1`) that the MCP server
  can talk to with a one-line env var change.
- An evaluation report comparing accuracy of Haiku vs. base Llama vs. tuned
  Llama on a held-out 10% slice of your training data.

## Why fine-tune

| Reason | Why it matters |
|---|---|
| Privacy | The merchant name, description, and amount of every charge classified is sent to Anthropic. Local inference keeps that on your machine. |
| Cost | Haiku charges per token. After the model is fine-tuned and running locally, the marginal cost of a classification is electricity. At ~$0.002 per Haiku call and 10k classifications/day, you save ~$600/month per environment. |
| Latency | A 3B model on Apple Silicon answers in ~150-300ms vs. ~600-1200ms for a Haiku round-trip. Classification is on the hot path for `pay_for_service`; halving it shaves time off every charge. |
| Offline | The MCP server keeps working when the user's network drops. The static fallback still kicks in if the local model is unreachable. |

What you trade off: the small student model is, generally, slightly less
accurate than Haiku — especially on long-tail categories where you have few
training examples. The eval report below measures that gap precisely.

## Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4). 16 GB unified memory minimum,
  32 GB+ recommended. (For Linux/NVIDIA, see "Linux GPU path" below.)
- [Ollama](https://ollama.com/) >= 0.3 installed and running
  (`ollama serve` or the menu-bar app).
- Python 3.10+ with a venv:
  ```bash
  python3 -m venv .venv
  source .venv/bin/activate
  pip install --upgrade mlx-lm
  ```
- llama.cpp checked out somewhere for GGUF conversion:
  ```bash
  git clone https://github.com/ggerganov/llama.cpp
  pip install -r llama.cpp/requirements.txt
  ```
- An `ANTHROPIC_API_KEY` (only needed to generate the synthetic training
  set — once you have the dataset you can fine-tune offline).
- A populated Supabase `intent_classifications` table is optional but
  recommended — it gives you real-world data to mix with the synthetic set.

## Pipeline overview

```
  +-----------------+    +------------------+    +-----------------+
  | 01-export       |    | 02-synthesize    |    | 03-prepare      |
  | real-classif.   | +  | synth-classif.   | -> | train/valid/    |
  | .jsonl          |    | .jsonl           |    | test.jsonl      |
  +-----------------+    +------------------+    +--------+--------+
                                                          |
                                                          v
                                                 +-----------------+
                                                 | 04-finetune.sh  |
                                                 | mlx-lm LoRA     |
                                                 +--------+--------+
                                                          |
                                                          v
                                                 +-----------------+
                                                 | 05-evaluate.ts  |
                                                 | accuracy report |
                                                 +--------+--------+
                                                          |
                                                          v
                                                 +-----------------+
                                                 | 06-deploy.sh    |
                                                 | -> ollama create|
                                                 +-----------------+
```

Each step has a default that lets you skip configuring it, and a small set
of env vars when you want to tweak. The scripts are idempotent — re-running
the same step overwrites the previous output.

## Step 1 — Export real classifications

Pull every non-`unknown` row from `intent_classifications` over the last
30 days and write it as JSONL.

```bash
npm run finetune:export
# or:
DAYS=90 tsx scripts/finetune/01-export-dataset.ts
```

Expected output:

```
[export-dataset] querying intent_classifications since 2026-04-13T...
[export-dataset] wrote 8419 rows -> .../data/real-classifications.jsonl
[export-dataset] category distribution:
  dev_tools       3214 (38.2%)
  shopping        1872 (22.2%)
  subscription    1108 (13.2%)
  ...
```

Class imbalance is visible immediately. If `gambling` and `gift_cards` look
under-represented, that's fine — the next step rebalances by generating
synthetic examples in every category.

## Step 2 — Synthesise distillation examples

Have Haiku invent 5,000 plausible purchase intents (rotating through all 10
categories) and classify each one with the production classification
prompt. This is the distillation step: the small student learns to imitate
the big teacher on a clean, evenly-distributed dataset.

```bash
npm run finetune:synth
# or with a smaller count for testing:
COUNT=200 CONCURRENCY=5 tsx scripts/finetune/02-synthesize-examples.ts
```

Expected output (truncated):

```
[synth] generating 5000 examples (concurrency=10) -> .../data/synthetic-classifications.jsonl
[synth] est. cost: ~$0.20
[synth] 5000/5000 (100.0%) - written=4983 failed=17 - 412s
[synth] done. wrote=4983 failed=17 duration=412s
```

Failures are normal (rare Haiku API errors, occasional malformed tool calls)
— they're dropped silently. Aim for a >95% success rate; investigate if it
drops below.

## Step 3 — Prepare the mlx-lm chat dataset

Merge real + synthetic, shuffle with a fixed seed, split 80/10/10, and
write as the chat-style JSONL that mlx-lm understands.

```bash
npm run finetune:prepare
# or:
SEED=42 tsx scripts/finetune/03-prepare-mlx-data.ts
```

Expected output:

```
[prepare] loaded real=8419 synth=4983
[prepare] wrote 10721/1340/1341 (train/valid/test) into .../data
```

The seed determines the shuffle and therefore the train/valid/test split.
Keep it constant if you want comparable eval numbers across runs.

## Step 4 — Fine-tune

```bash
bash scripts/finetune/04-finetune.sh
# Or with custom hyperparams:
ITERS=2000 BATCH_SIZE=8 bash scripts/finetune/04-finetune.sh
```

What to watch:

- **Train loss should fall steadily** from ~2.5 toward ~0.4-0.6 over 1000
  iterations on the 5k synthetic + real set.
- **Valid loss should track train loss within ~0.1**. If valid loss starts
  rising while train loss keeps falling, you're overfitting; cut `--iters`
  or add more data.
- A 1000-iteration run on an M2 Max with 32 GB memory takes ~25 minutes.
  Each LoRA checkpoint is ~50-100 MB; they accumulate under `./adapters/`.

## Step 5 — Evaluate vs. Haiku

Before deploying, run all three backends (Haiku, untuned Llama 3.2 3B,
tuned Llama 3.2 3B) on the held-out test set and write a markdown report.

```bash
# First make sure both Ollama tags exist:
ollama pull llama3.2:3b

# Run eval (assumes the tuned model has been deployed by step 6; if not, the
# tuned column will show all errors and you can re-run after step 6):
npm run finetune:eval
```

Expected output:

```
[eval] loaded 1341 test rows from .../data/test.jsonl
[eval] row 1341/1341
[eval] wrote .../data/eval-report.md
[eval] summary:
  haiku-4.5 (baseline)                  cat=94.2% urg=88.1% risk+/-10=82.3% errors=0
  ollama-base (llama3.2:3b)             cat=71.8% urg=72.4% risk+/-10=58.2% errors=14
  ollama-tuned (spendex-classifier:v1)  cat=91.6% urg=85.7% risk+/-10=79.4% errors=2
```

Numbers above are illustrative — your dataset will yield slightly
different absolute values, but the **shape** should hold: tuned recovers
most of the Haiku gap.

Open `data/eval-report.md` for per-category accuracy and confusion
matrices. If a category drops dramatically (e.g. tuned model collapses
`gambling` to `unknown`), add more examples of that category to the
synthetic set and re-run from step 2.

## Step 6 — Deploy to Ollama

Fuse the LoRA adapter into the base model, convert to GGUF (Q4_K_M
quantisation), write a Modelfile, and register the tag.

```bash
bash scripts/finetune/06-deploy-to-ollama.sh
```

What it does, end-to-end:

1. `python -m mlx_lm.fuse` merges `./adapters/` into the base weights and
   writes `./fused-model/`.
2. `llama.cpp/convert_hf_to_gguf.py` converts HF format to GGUF at
   `./fused-model.gguf`.
3. Writes a `Modelfile` with the production system prompt baked in.
4. `ollama create spendex-classifier:v1 -f Modelfile`.
5. Smoke-tests with one classification call.

Output ends with:

```
[deploy] done. Configure the MCP server with:
          CLASSIFIER_BACKEND=ollama
          OLLAMA_MODEL=spendex-classifier:v1
```

## Step 7 — Swap backends in production

In your `.env` (or your secrets manager):

```bash
CLASSIFIER_BACKEND=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=spendex-classifier:v1
```

That's it. Restart the MCP server; `getClassifierBackend()` will pick up
the new value and route all classifications through Ollama.

Roll back at any time with:

```bash
CLASSIFIER_BACKEND=anthropic
```

The contract is unchanged — same `IntentClassification` shape, same
`source: "llm" | "cache" | "fallback" | "dev_mode"` field, same 5s
timeout, same static fallback on failure. The smart-rules engine doesn't
know which backend produced the result.

## Cost analysis

Assumptions: 10,000 classifications/day; cache hit rate 60%; Haiku
$0.0008/$0.0040 per 1k input/output tokens; classifications average
~250/100 tokens.

| Backend | Per-call cost | Daily ops cost | Yearly |
|---|---:|---:|---:|
| Haiku 4.5 | ~$0.0006 | ~$2.40 (4000 misses) | ~$876 |
| Ollama (tuned, local Mac mini) | $0.0000 marginal; ~$10/month electricity | ~$0.33 | ~$120 |
| Ollama (tuned, on a $200/month VPS with GPU) | $0.0000 marginal; $200/month infra | ~$6.66 | $2400 |

The break-even is around 8k classifications/day on a Mac mini, much
higher on cloud GPU.

## Linux GPU path

The fine-tuning script supports axolotl as a drop-in alternative:

```bash
pip install axolotl[deepspeed]
BACKEND=axolotl bash scripts/finetune/04-finetune.sh
```

The other scripts (export, synthesize, prepare, evaluate, deploy) are
backend-agnostic — they all consume/produce JSONL and only the actual
training step differs.

## Troubleshooting

**`ollama: command not found`** — install Ollama from
https://ollama.com/download or via Homebrew (`brew install ollama`).

**`mlx_lm` import errors** — make sure you're inside the venv and that
`pip install --upgrade mlx-lm` completed without errors. On Intel Macs,
mlx is not supported; use the axolotl path instead.

**`convert_hf_to_gguf.py: No such file or directory`** — clone llama.cpp
and set the `LLAMA_CPP` env var to its path before running step 6.

**Eval shows tuned model is worse than base** — your training set is too
small or too narrow. Bump `COUNT` in step 2 to 10000 and retrain.

**Cache hits are still served from old classifications** — the cache is
keyed on (service + description + amount bucket); switching the backend
does not invalidate it. Truncate `intent_classifications` to clear, or
wait 7 days for the TTL.

## Where things live

| File | Purpose |
|---|---|
| `src/lib/intent-classifier.ts` | Orchestrator (cache, fallback, backend factory) |
| `src/lib/intent-classifier-ollama.ts` | Ollama backend implementation |
| `scripts/finetune/01-export-dataset.ts` | Pull real classifications from Supabase |
| `scripts/finetune/02-synthesize-examples.ts` | Distill Haiku into synthetic data |
| `scripts/finetune/03-prepare-mlx-data.ts` | Merge, shuffle, split, reformat |
| `scripts/finetune/04-finetune.sh` | LoRA fine-tune (mlx-lm or axolotl) |
| `scripts/finetune/05-evaluate.ts` | Accuracy comparison report |
| `scripts/finetune/06-deploy-to-ollama.sh` | Fuse + convert + register |
| `data/` | All intermediate + output artefacts (gitignored) |
