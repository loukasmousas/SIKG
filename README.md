# (SIKG) Semantic Image Knowledge Graph

Offline-capable image understanding with deterministic manifests, spatial relationships, and a browser viewer backed by SPARQL and optional voice control.

## Highlights

- End-to-end pipelines for single images and large tiled inputs using TFJS COCO-SSD object detection, DeepLab ADE20K segmentation, and MediaPipe face detection with on-demand blurring.
- Structured metadata captured in both JSON and RDF (via N3) with a SPARQL-enabled interactive viewer and REST/Socket.IO endpoints.
- Voice query path that runs fully locally (Whisper transcription → GPT4All GGUF LLM → SPARQL intent) with configurable temperature, token budget, and timeout.
- Binary `.pht` pixel stores with SHA-256 integrity tracking and deterministic JSON manifests produced by shared serializers.
- Evaluation scripts for merge quality, spatial relations, graph integrity, privacy blur, reproducibility, and more (reports under `output/eval/`).

## Requirements

- macOS, Linux, or WSL with Bash, curl, and build tools
- Node.js 20.x (installed automatically by the script unless `--skip-node` is used)
- ffmpeg on the PATH (the install script installs it inside dev containers; set `FFMPEG_PATH` otherwise)

## Installation

```bash
bash install.sh --llm-model mistral --whisper-model small.en
```

The installer will:

1. Install Node.js 20 via nvm (unless `--skip-node`).
2. Fetch npm dependencies.
3. Download the requested Whisper and GPT4All GGUF models and verify their SHA256 hashes.
4. Generate a `.env` file with the selected defaults (LLM model, Whisper model, performance profile, optional JSON slimming).
5. Optionally scaffold a VS Code dev container when `--devcontainer` is supplied.

Run `bash install.sh --help` to view all flags (`--perf-profile`, `--slim-json`, `--models-dir`, `--timeout-ms`, `--quiet`, etc.).

## Usage

### Launch the interactive viewer

```bash
npm run viewer
# or
node src/viewer/InteractiveViewerServer.js
```

Then open http://localhost:3000 to browse manifests, edit regions, inspect relationships, run SPARQL queries, and experiment with the voice interface.

### Generate manifests

```bash
# Full-frame pipeline
node src/single/Main.js input-images/sample.jpg --profile balanced --privacy on

# Tiled pipeline for very large images
node src/tiled/TiledMLMain.js input-images/huge.tif --profile fast --privacy off

# Batch pipeline that picks single vs tiled automatically
node ingest.js --profile balanced --privacy on
```

Outputs land in `output/` as `<image>.json` + `<image>.pht` with optional `<image>.raw-model.json` dumps.

### Run evaluations

```bash
# After manifests exist
npm run eval:all
```

Individual evaluators are available under `npm run eval:<name>` (see `package.json`). Reports and logs are written to `output/eval/`.

### Tests and linting

```bash
npm run lint
npm run test:slim           # representative unit tests
npm run test:ci             # broader suite used in CI
```

## Configuration

A `.env` file is generated during installation. Key entries:

- `PERF_PROFILE` (`fast|balanced|quality`) – default inference preset for pipelines.
- `FACE_PRIVACY` (`0|1`) – opt-in on the command line with `--privacy on|off`.
- `PHT_SLIM_JSON` (`0|1`) – controls geometry slimming inside serialized metadata.
- `LLM_*` knobs (`LLM_MODEL`, `LLM_TEMP`, `LLM_NPREDICT`, `LLM_TIMEOUT_MS`) – tune local GPT4All inference speed vs quality.
- `MODELS_DIR`, `WHISPER_MODEL`, `FFMPEG_PATH` – alternate model locations or custom ffmpeg executable.

Environment variables can be overridden per command (e.g., `DEBUG=1 PHT_FAST_TILING=0 node ingest.js ...`).

## Repository Layout

- `src/common/` – shared infrastructure (PixelMatrix, Serializer, MetadataIndex, spatial linking, logging).
- `src/single/` – single-image pipeline and ML wrapper.
- `src/tiled/` – tiled pipeline with adaptive stride logic and serializer.
- `src/viewer/` – Express/Socket.IO server for the interactive web UI.
- `src/global/` – federated registry used when multiple manifests are loaded together.
- `src/voice/` – Whisper + GPT4All voice-to-SPARQL services.
- `tests/` – CLI tests, evaluators, and benchmarks.
- `models/` – GGUF and Whisper models downloaded by `install.sh`.
- `output/` – Generated manifests, tiles, and evaluation reports (not version controlled).

## Voice & SPARQL Flow

1. Browser captures audio and posts WebM chunks to the viewer server.
2. The server converts audio to WAV via `fluent-ffmpeg`, transcribes it with `nodejs-whisper`, and feeds the text to GPT4All.
3. GPT4All returns a normalized intent that is compiled into SPARQL and executed over the in-memory N3 store.
4. Results and the raw LLM response are streamed back to the client alongside metadata about the generated LIMIT, predicates, and filters.

Adjust generation behaviour with `LLM_TEMP`, `LLM_NPREDICT`, and `LLM_TIMEOUT_MS`, or point `LLM_MODEL`/`MODELS_DIR` to a different GGUF file.

## Troubleshooting

- **`ffmpeg` not found** – install it system-wide or set `FFMPEG_PATH` to the binary before starting the viewer.
- **Model downloads are slow** – use `--skip-mistral`, `--skip-orca`, or provide a pre-downloaded `.gguf` with `--llm-model <file>`.
- **High memory use on tiled runs** – lower `--tileSize`, disable DeepLab via `--profile fast`, or set `maxTiles` when constructing `TiledMLProcessor`.
- **Voice intent empty** – ensure `.env` points to a valid GGUF file and raise `LLM_TIMEOUT_MS` for slower CPUs.

## License

Apache-2.0. See `LICENSE` for details.
