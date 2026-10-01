# Demo Laptop Runbook (RTX 3050, 4 GB VRAM)

The build machine has no GPU. This is the procedure for running ExecuGate.ai with
**real local inference** on a 4 GB card, in the configuration the hackathon demo
should use.

Total setup: roughly 30 minutes, mostly downloading weights.

---

## 0. Why this is fiddly

A 4 GB card cannot hold whisper, a 3B LLM, and an embedding model at the same time.

```
whisper small (int8_float16)   ~1.1 GB
Qwen2.5-3B Q4_K_M + KV cache   ~2.6 GB
multilingual-e5-small          ~0.6 GB
                              --------
combined                       ~4.2 GB   >  4 GB budget
```

So `ModelArbiter` loads **one role at a time**: ASR, then LLM, then embeddings,
releasing the previous model before the next one is used. This is enforced in code
(`packages/orchestration/src/arbiter.ts`) and covered by `tests/unit/arbiter.test.ts`,
not left to manual discipline.

Set the real budget so the arbiter knows what it is working with:

```bash
VRAM_BUDGET_MB=3800
```

## 1. Tooling

```bash
# CUDA-capable PyTorch — check the wheel index for your driver.
pip install "torch" --index-url https://download.pytorch.org/whl/cu121
pip install "faster-whisper[cu12]"
pip install sentence-transformers

# llama.cpp (Windows: download a CUDA build release from github.com/ggerganov/llama.cpp)
llama-server --version
```

## 2. Models

```bash
mkdir -p models && cd models

# LLM: ~2.0 GB — Indonesian-capable, fits 4 GB, supports guided JSON decoding
huggingface-cli download Qwen/Qwen2.5-3B-Instruct-GGUF qwen2.5-3b-instruct-q4_k_m.gguf --local-dir .

# Embeddings: ~470 MB — multilingual, needed for Indonesian retrieval
huggingface-cli download intfloat/multilingual-e5-small --local-dir ./e5
```

## 3. Start the three servers

Run each in its own terminal. They are separate processes on purpose: the arbiter
releases the model between phases, and separate processes make that real rather than
notional.

**Terminal 1 — LLM**

```bash
llama-server -m models/qwen2.5-3b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 \
  --ctx-size 8192 \
  --alias qwen-local \
  --jinja
```

`--alias` is what `LLM_MODEL` must be set to. `--ctx-size 8192` is the largest context
that fits; going higher will OOM once the KV cache is allocated.

**Terminal 2 — ASR**

```bash
python -m faster_whisper.server \
  --model small --device cuda --compute_type int8_float16 \
  --host 127.0.0.1 --port 9000
```

If WER comes back above 10%, try `--model medium` with
`--compute_type int8_float16` (~1.5 GB). It still fits when it is the only resident
role.

**Terminal 3 — Embeddings**

```bash
python -m sentence_transformers.server \
  --model models/e5 --host 127.0.0.1 --port 8081
```

## 4. Configure

```bash
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_MODEL=qwen-local
LLM_API_KEY=dummy            # llama-server ignores it, but the client requires a header
LLM_TEMPERATURE=0

EMBED_PROVIDER=openai
EMBED_BASE_URL=http://127.0.0.1:8081/v1
EMBED_MODEL=sentence-transformers/multilingual-e5-small
EMBED_DIMS=384

ASR_PROVIDER=whisper-http
ASR_BASE_URL=http://127.0.0.1:9000
ASR_MODEL=small

VRAM_BUDGET_MB=3800
```

## 5. Verify before you demo

```bash
npm run check:gpu          # probes every endpoint, prints the remedy for each failure
npm run bench:gpu          # additionally times a real completion and a real embedding
npm run setup              # re-seed so embeddings use the real model
npm run eval:tickets       # ticket accuracy against the real model
```

`check:gpu` exits non-zero if a provider the demo needs is unreachable, so
"the laptop is ready" is a measurement, not an assumption.

## 6. Measure ASR properly (PRD FR-01.2)

The WER harness is honest about missing data: it reports skipped cases rather than
claiming a pass. Record the eight clips in `fixtures/eval/asr-cases.json`:

```bash
mkdir -p fixtures/eval/audio
# Read each `reference` aloud, save as fixtures/eval/audio/<audio filename>
# a01-golden.mp3, a02-switch.mp3, a03-ops.mp3, a04-report.mp3,
# a05-question.mp3, a06-long.mp3, a07-english.mp3, a08-filler.mp3
```

```bash
npm run eval:asr
```

Target: mean WER below 10%. If it is not:

| Symptom | Fix |
|---|---|
| Mean WER 12–20% | Switch ASR to `--model medium` |
| English segments mangled | Confirm `--language` is not pinned to `id` |
| Only `long` cases fail | That clip exceeds the 300 s voice-note limit |
| Errors on numbers ("512 KB") | Expected on `small`; the canonical value is still in project memory, so the answer path stays correct |

## 7. Run the demo

```bash
npm run dev
```

Both the Telegram bot and the dashboard read the same configuration. Voice notes go
through whisper; text instructions go straight to the LLM.

## 8. If the card still runs out of memory

In order, cheapest fix first:

1. Drop ASR to `--model base` (~150 MB).
2. Lower `--ctx-size` to 4096.
3. Run ASR on CPU int8 (`--device cpu --compute_type int8`) — slower, but frees
   ~1.1 GB for the LLM.
4. Fall back to cloud providers for the LLM only, keeping whisper local. The adapters
   are independent; nothing in the app assumes they are co-located.

## 9. Honest reporting of the latency budget

The PRD's 3-second reasoning target is **not** reachable with a 3B model on this GPU:
a 300-token structured response at ~30–50 tok/s takes 6–10 seconds.

What the app does about it, and what to say if asked:

- **Streaming**: time-to-first-token is ~300 ms, so the commander sees the approval
  card forming immediately. `eval:latency` reports TTFT and total separately.
- **Guided decoding**: the JSON schema is compiled into a grammar, so output is short
  and structurally valid.
- **Cloud mode** does meet the literal 3 s target, if you would rather trade latency
  for self-containment on the day.

This is deviation DEV-2 in `docs/BUILD_PLAN.md` §17. Report it as a known constraint
with a mitigation rather than quoting a number the hardware cannot produce.