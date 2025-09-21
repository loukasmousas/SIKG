#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------
# Default settings (override via flags)
# -------------------------------------------------------------
MODELS_DIR="./models"
INSTALL_NODE=1
WHISPER_MODEL="small.en" # nodejs-whisper model (tiny.en|base.en|small.en|...)
TIMEOUT_MS=60000
GENERATE_DEVCONTAINER=0
DEVCONTAINER_OVERWRITE=0
PERF_PROFILE="balanced"   # fast|balanced|quality (written to .env as PERF_PROFILE)
SLIM_JSON=0                # 1 to default enable slimming in generated .env
DOWNLOAD_MISTRAL=1
DOWNLOAD_ORCA=1
QUIET=0
GPT4ALL_MISTRAL_URL="https://gpt4all.io/models/gguf/mistral-7b-instruct-v0.1.Q4_0.gguf"
GPT4ALL_ORCA_URL="https://gpt4all.io/models/gguf/orca-mini-3b-gguf2-q4_0.gguf"
MISTRAL_FILE="mistral-7b-instruct-v0.1.Q4_0.gguf"        # Canonical filename
# SHA256 of the known-good mistral model you have locally. Update ONLY if you intentionally change model file.
MISTRAL_SHA256="c0fff3ee02f4b8f7296fbb560155b68a13644b12b9e1e761744c05fb637ade7c"
ORCA_FILE="orca-mini-3b-gguf2-q4_0.gguf"
ORCA_SHA256="4c876b7b0994294c677a6a1b375a0c618270f456585b42e443665ca4b89f917a"
LLM_MODEL="mistral"   # logical name: mistral|orca|<custom .gguf filename>

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --models-dir PATH        Directory for GGUF models (default: ./models)
  --llm-model NAME         Default LLM model (mistral|orca|<custom .gguf>) (default: mistral)
  --whisper-model NAME     nodejs-whisper model (tiny.en|base.en|small.en|...) (default: small.en)
  --timeout-ms N           LLM timeout (default: 60000)
  --skip-node              Do NOT install Node via nvm (assumes already present)
  --devcontainer           Generate a .devcontainer/devcontainer.json (Ubuntu 22.04) and exit
  --devcontainer-overwrite  Generate a .devcontainer/devcontainer.json (Ubuntu 22.04), overwriting any existing file
  --perf-profile MODE      Default performance profile (fast|balanced|quality) (default: balanced)
  --slim-json              Write PHT_SLIM_JSON=1 into .env (default off)
  --skip-mistral           Do not download mistral model
  --skip-orca              Do not download orca model
  --quiet                  Reduced output (essential steps only)
  --help                   Show this help

Examples:
  bash install.sh --whisper-model small.en
  bash install.sh --timeout-ms 90000 --llm-model orca
EOF
}

# -------------------------------------------------------------
# Parse arguments
# -------------------------------------------------------------
log(){ if [[ ${QUIET:-0} -eq 0 ]]; then echo "$*"; fi }
warn(){ echo "[WARN] $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
  --models-dir) MODELS_DIR="$2"; shift 2;;
  --llm-model) LLM_MODEL="$2"; shift 2;;
  --whisper-model) WHISPER_MODEL="$2"; shift 2;;
  --timeout-ms) TIMEOUT_MS="$2"; shift 2;;
  --perf-profile) PERF_PROFILE="$2"; shift 2;;
  --slim-json) SLIM_JSON=1; shift;;
  --skip-node) INSTALL_NODE=0; shift;;
  --skip-mistral) DOWNLOAD_MISTRAL=0; shift;;
  --skip-orca) DOWNLOAD_ORCA=0; shift;;
  --quiet) QUIET=1; shift;;
  --devcontainer) GENERATE_DEVCONTAINER=1; shift;;
  --devcontainer-overwrite) GENERATE_DEVCONTAINER=1; DEVCONTAINER_OVERWRITE=1; shift;;
    *) echo "Unknown arg: $1"; usage; exit 1;;
  esac
done

# Validate performance profile
case "$PERF_PROFILE" in
  fast|balanced|quality) : ;; # ok
  *) warn "Invalid --perf-profile '$PERF_PROFILE' (expected fast|balanced|quality) – defaulting to 'balanced'"; PERF_PROFILE="balanced" ;;
esac

log(){ if [[ $QUIET -eq 0 ]]; then echo "$*"; fi }
warn(){ echo "[WARN] $*" >&2; }
log "-------------------------------"
log "Generate devcontainer: $GENERATE_DEVCONTAINER"
log "Download Mistral : $([[ $DOWNLOAD_MISTRAL -eq 1 ]] && echo yes || echo no)"
log "Download Orca    : $([[ $DOWNLOAD_ORCA -eq 1 ]] && echo yes || echo no)"
log "Whisper model    : $WHISPER_MODEL (nodejs-whisper)"
log "Timeout (ms)     : $TIMEOUT_MS"
log "Perf profile     : $PERF_PROFILE"
log "Slim JSON       : $SLIM_JSON"
log "Install Node     : $INSTALL_NODE"
log "Selected LLM     : $LLM_MODEL"
log "Quiet mode       : $QUIET"
log "(nodejs-whisper CLI will auto-build; cmake included)"
log ""

# Map logical model name to actual filename
case "$LLM_MODEL" in
  mistral) LLM_MODEL="$MISTRAL_FILE" ;;
  orca)    LLM_MODEL="$ORCA_FILE" ;;
  *.gguf)  ;; # custom filename provided
  *) echo "[WARN] Unknown --llm-model value '$LLM_MODEL' (expect mistral|orca|*.gguf). Using as-is." ;;
esac

# -------------------------------------------------------------
# System dependencies
# -------------------------------------------------------------
if [[ $GENERATE_DEVCONTAINER -eq 1 ]]; then
  echo "[DevContainer] Preparing devcontainer manifest ..."
  mkdir -p .devcontainer

  if [[ -f .devcontainer/devcontainer.json ]] && [[ ${DEVCONTAINER_OVERWRITE:-0} -ne 1 ]]; then
    echo "[DevContainer] Existing .devcontainer/devcontainer.json found."
    echo "[DevContainer] Not overwriting to preserve comments/formatting."
    echo "[DevContainer] Writing enriched proposal to .devcontainer/devcontainer.generated.json"
    cat > .devcontainer/devcontainer.generated.json <<'DCEOF'
// NOTE: Generated by install.sh. Merge manually to retain comments in your existing file.
{
  "name": "pht-crypto-project",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "20" }
  },
  "postCreateCommand": "bash install.sh --timeout-ms 90000 --llm-model mistral --whisper-model small.en --skip-node && node src/voice/transcribe.js tests/hello.wav || true",
  "customizations": {
    "vscode": {
      "settings": {
        "files.eol": "\n",
        "terminal.integrated.defaultProfile.linux": "bash"
      },
      "extensions": ["dbaeumer.vscode-eslint"]
    }
  },
  "remoteEnv": {
    "LLM_TIMEOUT_MS": "90000",
    "LLM_MODEL": "mistral-7b-instruct-v0.1.Q4_0.gguf",
    "MODELS_DIR": "models",
    "WHISPER_MODEL": "small.en"
  },
  "forwardPorts": [3000, 3001],
  "mounts": [
    "source=gpt4all-cache,target=/root/.cache/gpt4all,type=volume",
    "source=npm-cache,target=/root/.npm,type=volume"
  ],
  "runArgs": ["--init"]
}
DCEOF
    echo "[DevContainer] Review and merge .devcontainer/devcontainer.generated.json into your devcontainer.json."
    exit 0
  else
    if [[ ${DEVCONTAINER_OVERWRITE:-0} -eq 1 ]]; then
      echo "[DevContainer] Overwriting .devcontainer/devcontainer.json (auto-overwrite enabled)."
    else
      echo "[DevContainer] Writing .devcontainer/devcontainer.json ..."
    fi
    cat > .devcontainer/devcontainer.json <<'DCEOF'
// NOTE: Generated by install.sh
{
  "name": "pht-crypto-project",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "20" }
  },
  "postCreateCommand": "bash install.sh --timeout-ms 90000 --llm-model mistral --whisper-model small.en --skip-node && node src/voice/transcribe.js tests/hello.wav || true",
  "customizations": {
    "vscode": {
      "settings": {
        "files.eol": "\n",
        "terminal.integrated.defaultProfile.linux": "bash"
      },
      "extensions": ["dbaeumer.vscode-eslint"]
    }
  },
  "remoteEnv": {
    "LLM_TIMEOUT_MS": "90000",
    "LLM_MODEL": "mistral-7b-instruct-v0.1.Q4_0.gguf",
    "MODELS_DIR": "models",
    "WHISPER_MODEL": "small.en"
  },
  "forwardPorts": [3000, 3001],
  "mounts": [
    "source=gpt4all-cache,target=/root/.cache/gpt4all,type=volume",
    "source=npm-cache,target=/root/.npm,type=volume"
  ],
  "runArgs": ["--init"]
}
DCEOF
    echo "[DevContainer] Devcontainer manifest ready."
    exit 0
  fi
fi

log "[1/5] Installing system packages (sudo may prompt)..."
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  build-essential cmake git curl ca-certificates \
  ffmpeg

# -------------------------------------------------------------
# Node.js via nvm
# -------------------------------------------------------------
if [[ $INSTALL_NODE -eq 1 ]]; then
  if ! command -v node >/dev/null 2>&1; then
  log "[2/5] Installing nvm + Node 20..."
    export NVM_DIR="$HOME/.nvm"
    if [[ ! -d "$NVM_DIR" ]]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    fi
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
  else
  log "[2/5] Node already present: $(node -v)"
  fi
else
  log "[2/5] Skipping Node install."
fi

# -------------------------------------------------------------
# nodejs-whisper model fetch / build
# -------------------------------------------------------------
log "[3b/5] Ensuring nodejs-whisper model ($WHISPER_MODEL) ..."
if command -v npx >/dev/null 2>&1; then
  # Attempt a silent model download (download-only mode). If flag unsupported, ignore errors.
  if npx -y nodejs-whisper --model "$WHISPER_MODEL" --download-only >/dev/null 2>&1; then
  log "Whisper model present."
  else
  log "(Info) download-only flag not supported; falling back to simulated build trigger."
    # Feed model name + 'n' (no CUDA) to avoid hang; discard output.
    printf "%s\nn\n" "$WHISPER_MODEL" | npx -y nodejs-whisper --help >/dev/null 2>&1 || true
  fi
  # If binary still missing let first real transcription build it.
else
  log "npx not found; skipping whisper pre-build (will build on first use)." 
fi

# Ensure npm available
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Aborting."
  exit 1
fi

# -------------------------------------------------------------
# Project npm dependencies
# -------------------------------------------------------------
log "[3/5] Installing npm dependencies..."
# Model packages may declare conflicting peer deps across TFJS majors.
# We first try a strict install; on ERESOLVE we retry with --legacy-peer-deps to allow coexistence.
if [[ -f package-lock.json ]]; then
  if ! npm ci; then
    echo "npm ci failed (lock mismatch or peer dep conflict). Falling back to npm install..." >&2
    if ! npm install; then
      echo "npm install failed (likely peer dependency conflict). Retrying with --legacy-peer-deps..." >&2
      npm install --legacy-peer-deps
    fi
  fi
else
  if ! npm install; then
    echo "npm install failed (likely peer dependency conflict). Retrying with --legacy-peer-deps..." >&2
    npm install --legacy-peer-deps
  fi
fi

# -------------------------------------------------------------
# Models directory + downloads
# -------------------------------------------------------------
log "[4/5] Preparing models directory..."
mkdir -p "$MODELS_DIR"

download_model () {
  local url="$1"
  local dest_dir="$2"
  local fname
  fname="$(basename "$url")"
  local out="$dest_dir/$fname"
  if [[ -f "$out" ]]; then
    echo "  - $fname already exists (skip)"
  else
    echo "  - Downloading $fname ..."
    curl -L --fail --progress-bar "$url" -o "$out.part"
    mv "$out.part" "$out"
    echo "  - Saved to $out"
  fi
}
if [[ $DOWNLOAD_MISTRAL -eq 1 ]]; then download_model "$GPT4ALL_MISTRAL_URL" "$MODELS_DIR"; else log "  - Skipping mistral download"; fi
if [[ $DOWNLOAD_ORCA -eq 1 ]]; then download_model "$GPT4ALL_ORCA_URL" "$MODELS_DIR"; else log "  - Skipping orca download"; fi

# Verify Mistral
if [[ $DOWNLOAD_MISTRAL -eq 1 && -f "$MODELS_DIR/$MISTRAL_FILE" ]]; then
  echo "  - Verifying SHA256 for $MISTRAL_FILE ..."
  have_hash=$(sha256sum "$MODELS_DIR/$MISTRAL_FILE" | awk '{print $1}')
  if [[ "$have_hash" != "$MISTRAL_SHA256" ]]; then
    echo "ERROR: Hash mismatch for $MISTRAL_FILE" >&2
    echo "  Expected: $MISTRAL_SHA256" >&2
    echo "  Actual  : $have_hash" >&2
    echo "  The file will be removed to avoid using a corrupt/unexpected model." >&2
    rm -f "$MODELS_DIR/$MISTRAL_FILE"
    exit 1
  else
    echo "  - Hash OK"
  fi
  underscore_alias="${MISTRAL_FILE/v0.1/v0_1}"
  if [[ "$underscore_alias" != "$MISTRAL_FILE" ]]; then
    if [[ ! -e "$MODELS_DIR/$underscore_alias" ]]; then
      ln -s "$MISTRAL_FILE" "$MODELS_DIR/$underscore_alias"
      echo "  - Created symlink alias $underscore_alias -> $MISTRAL_FILE"
    else
      echo "  - Alias $underscore_alias already exists (skip)"
    fi
  fi
elif [[ $DOWNLOAD_MISTRAL -eq 1 ]]; then
  warn "Expected model file $MISTRAL_FILE not found after download step."
fi

# Verify Orca
if [[ $DOWNLOAD_ORCA -eq 1 && -f "$MODELS_DIR/$ORCA_FILE" ]]; then
  echo "  - Verifying SHA256 for $ORCA_FILE ..."
  have_hash=$(sha256sum "$MODELS_DIR/$ORCA_FILE" | awk '{print $1}')
  if [[ "$have_hash" != "$ORCA_SHA256" ]]; then
    echo "ERROR: Hash mismatch for $ORCA_FILE" >&2
    echo "  Expected: $ORCA_SHA256" >&2
    echo "  Actual  : $have_hash" >&2
    echo "  The file will be removed to avoid using a corrupt/unexpected model." >&2
    rm -f "$MODELS_DIR/$ORCA_FILE"
    exit 1
  else
    echo "  - Hash OK"
  fi
elif [[ $DOWNLOAD_ORCA -eq 1 ]]; then
  warn "Expected model file $ORCA_FILE not found after download step."
fi
 # (both models already downloaded above)

# -------------------------------------------------------------
# .env file
# -------------------------------------------------------------
log "[5/5] Writing .env ..."
# Backup existing .env if present
if [[ -f .env ]]; then
  cp .env ".env.backup.$(date +%s)" && echo "  - Existing .env backed up.";
fi
cat > .env <<EOF
# Auto-generated by install.sh
LLM_TIMEOUT_MS=$TIMEOUT_MS
MODELS_DIR=$MODELS_DIR
WHISPER_MODEL=$WHISPER_MODEL
LLM_MODEL=$LLM_MODEL
# Generation tuning (lower n-predict for faster CPU; lower temp for stability)
LLM_NPREDICT=64
LLM_TEMP=0.10 # 0.15 for Mistral and 0.1 for Orca
# Slim duplicate geometry from metadataIndex.index (0 = off, 1 = on)
PHT_SLIM_JSON=$SLIM_JSON
# Default performance profile for pipelines (fast|balanced|quality)
PERF_PROFILE=$PERF_PROFILE
# Verbose logging (1/true/yes/on/debug to enable; errors always shown)
DEBUG=0
# Optional: server port (defaults to 3000 if unset)
# PORT=3000
# Optional: system ffmpeg override (full path). By default PATH is used.
# FFMPEG_PATH=/usr/bin/ffmpeg
# Optional: default SPARQL LIMIT to append when missing (SELECT without GROUP/COUNT)
# SPARQL_DEFAULT_LIMIT=200
# Optional: explicit model file override under project root (e.g., models/custom.gguf)
# LLM_MODEL_FILE=
# To enable later: set to 1 or true (export PHT_SLIM_JSON=1) before running ingest/Main/TiledMLMain/server.
EOF

# -------------------------------------------------------------
# Sanity checks
# -------------------------------------------------------------
log "[Post] Running quick sanity checks..."

# Check ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not on PATH"
  exit 1
fi

# Check Node & ability to require gpt4all
node - <<'NODEEOF'
try {
  require('gpt4all');
  console.log("Node sanity: gpt4all module loaded.");
} catch(e) {
  console.error("Node sanity failed:", e);
  process.exit(1);
}
NODEEOF

if [[ $QUIET -eq 0 ]]; then
  echo
  echo "Installation complete."
  echo "Next steps:"
  echo "  0) node ingest.js # (if not done already)"
  echo "  1) npm start (or: node src/viewer/InteractiveViewerServer.js)"
  echo "  2) (Optional) Run tests:   npm run test:ci   # fast core" 
  echo "                         or npm run test:all  # full suite"
  echo "  3) (Optional) Run: node src/voice/transcribe.js tests/hello.wav  # builds whisper CLI & outputs readiness JSON"
  echo "  4) Confirm models present in ./models (if not skipped)"
  echo "  5) Privacy blur is integrated; no extra downloads required. Use the UI toggle or add ?blur=1 to /getTile."
  echo
  echo "If you added models here, ensure your VoiceService.js uses:"
  echo "  loadModel('<file>', { model_path: '<dir>', allow_download:false, ... })"
  echo "Switch active LLM: edit .env LLM_MODEL (mistral|orca|custom.gguf) then restart server."
  echo "Enable JSON slimming now: set PHT_SLIM_JSON=1 in .env or export at runtime."
  echo "Adjust performance profile: edit PERF_PROFILE in .env (fast|balanced|quality)."
  echo
  echo "To verify speech stack now:"
  echo "  node src/voice/transcribe.js tests/hello.wav  # should print JSON with status=ready"
fi