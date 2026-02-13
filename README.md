# Luca Express Talk 🎙️

Human-like voice-to-voice conversational AI powered by [NVIDIA PersonaPlex](https://github.com/NVIDIA/personaplex).

A full-stack application with a **React/TypeScript frontend** and the **PersonaPlex 7B speech-to-speech model** backend, enabling real-time voice conversations with customizable personas and voices.

## Features

- **Real-time Voice Conversations** — Natural, low-latency speech-to-speech interactions
- **Multiple Voice Options** — 18 voice presets (natural/variety × male/female)
- **Custom Personas** — Define Luca's personality with text prompts
- **Full Duplex** — Supports interruptions, overlaps, and natural turn-taking
- **Guardian System** — Process lifecycle management, zombie reaping, CUDA monitoring
- **Backend Monitor** — Real-time server diagnostics panel in the UI

## Architecture

```
┌─────────────────────┐       WebSocket        ┌──────────────────────┐
│   luca-talks/       │  ◄──── /api/chat ────►  │   PersonaPlex 7B     │
│   React + Vite      │       (Opus/PCM)        │   moshi.server       │
│   :5173             │                         │   :8998               │
└─────────────────────┘                         └──────────────────────┘
        │                                                │
   Vite proxy ──────────────────────────────────────────►│
   /api/chat → http://127.0.0.1:8998                     │
```

## Prerequisites

- **Windows 10/11** or **Linux** with NVIDIA GPU (16GB+ VRAM recommended, or use `--cpu-offload`)
- **Node.js 20+** (LTS)
- **Python 3.11** with CUDA-enabled PyTorch
- **CUDA 12.1+** compatible drivers
- **Hugging Face Account** — [Get a token](https://huggingface.co/settings/tokens) (for model download)

## Project Structure

```
VoiceLuca/
├── luca-talks/                    # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── VoiceChat.tsx      # Main conversation UI
│   │   │   ├── AudioVisualizer.tsx # Visual audio feedback
│   │   │   ├── VoiceSelector.tsx  # Voice preset dropdown
│   │   │   ├── BackendMonitor.tsx # Server diagnostics panel
│   │   │   ├── GuardianPanel.tsx  # Process guardian UI
│   │   │   ├── LauncherPage.tsx   # Startup/launcher screen
│   │   │   └── MaintenancePage.tsx
│   │   ├── hooks/
│   │   │   └── useAudioStream.ts  # WebSocket + Web Audio API
│   │   ├── guardian/              # Backend lifecycle management
│   │   │   ├── processTracker.ts  # PID tracking & health
│   │   │   ├── zombieReaper.ts    # Orphan process cleanup
│   │   │   ├── inferenceFence.ts  # GPU inference gating
│   │   │   ├── cudaMonitor.ts     # VRAM monitoring
│   │   │   └── vitePlugin.ts      # Vite integration
│   │   └── App.tsx
│   ├── scripts/
│   │   ├── start.ps1              # One-command startup
│   │   └── health-check.ps1       # System diagnostics
│   ├── vite.config.ts             # Proxy, backend lifecycle, diag endpoints
│   └── package.json
├── personaplex/                   # NVIDIA PersonaPlex source (upstream)
│   ├── moshi/                     # Model server code
│   └── Dockerfile
├── personaplex-7b-v1/             # Model weights (not tracked in git)
│   ├── model.safetensors          # ~15.6GB
│   ├── config.json
│   └── tokenizer_spm_32k_3.model
├── test_ws3.py                    # End-to-end WebSocket test
├── benchmark.py                   # Performance benchmarks
└── test_sdp.py                    # SDP attention tests
```

## Quick Start

### 1. Clone & Install

```powershell
git clone https://github.com/gusitde/luca-express-talks.git
cd luca-express-talks
```

### 2. Set Up Python Environment

```powershell
python -m venv personaplex-env
.\personaplex-env\Scripts\Activate.ps1
pip install -e personaplex/moshi
```

### 3. Download Model Weights

```powershell
$env:HF_TOKEN = "your_huggingface_token"
# Download from https://huggingface.co/nvidia/personaplex-7b-v1
```

### 4. Start the Backend

```powershell
$env:NO_TORCH_COMPILE = "1"
$env:NO_CUDA_GRAPH = "1"
& personaplex-env\Scripts\python.exe -m moshi.server --cpu-offload --static none `
    --moshi-weight personaplex-7b-v1\model.safetensors `
    --tokenizer personaplex-7b-v1\tokenizer_spm_32k_3.model
```

Wait for the model to load (~2-3 minutes). You'll see:
```
======== Running on http://0.0.0.0:8998 ========
```

### 5. Start the Frontend

```powershell
cd luca-talks
npm install
npm run dev -- --host
```

Open http://localhost:5173 in your browser.

## Usage

1. Click **Start Talking** to begin a conversation
2. Speak naturally — Luca will respond in real-time
3. Use **Settings** to change voice or persona
4. Click **Stop** to end the conversation

## Voice Options

| Voice | Style |
|-------|-------|
| NATF0–NATF3 | Natural Female (4 voices) |
| NATM0–NATM3 | Natural Male (4 voices) |
| VARF0–VARF4 | Variety Female (5 voices) |
| VARM0–VARM4 | Variety Male (5 voices) |

## Backend Details

### PersonaPlex 7B

The backend uses [NVIDIA PersonaPlex](https://github.com/NVIDIA/personaplex), a real-time full-duplex speech-to-speech model based on the [Moshi](https://arxiv.org/abs/2410.00037) architecture. Key specs:

- **Model**: PersonaPlex 7B parameters
- **Audio**: 24kHz sample rate, Opus or PCM float32 streaming
- **Latency**: Real-time on 16GB+ VRAM GPUs; ~3 min warmup with `--cpu-offload`
- **Protocol**: WebSocket binary frames with kind byte (`0x00`=handshake, `0x01`=opus, `0x02`=text, `0x03`=pcm_f32)

### Server Modifications

The server (`moshi/server.py`) has been patched for Windows compatibility and stability:

- **ThreadPoolExecutor** for GPU inference — prevents event loop blocking during system prompt processing
- **`/healthz` endpoint** — returns server status and lock state
- **Heartbeat disabled** — prevents connection drops during long system prompt warmups
- **`.detach().numpy()`** fix — resolves autograd tensor error on Windows
- **Lock timeout** — 20s acquisition timeout for new connections
- **Client disconnect detection** during system prompt processing

### Configuration

| Flag | Description |
|------|-------------|
| `--cpu-offload` | Offload model layers to CPU (for <16GB VRAM) |
| `--static none` | Disable built-in static file serving |
| `--moshi-weight` | Path to model weights file |
| `--tokenizer` | Path to tokenizer model |

## Troubleshooting

### Server won't start

- **"CUDA out of memory"** — Close GPU-heavy apps, try `--cpu-offload`
- **"Torch not compiled with CUDA"** — `pip install torch --index-url https://download.pytorch.org/whl/cu121`

### No audio response

- Check microphone permissions in browser
- System prompts take ~3-6 min on first connection with `--cpu-offload`; wait for handshake
- Run `python test_ws3.py` to test the audio pipeline directly

### Connection timeout

- Verify backend: `curl http://localhost:8998/healthz`
- Check if lock is held (another session connected): look for `lock_locked: true`

## Tech Stack

- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS
- **Backend**: NVIDIA PersonaPlex 7B (Moshi architecture)
- **Audio**: Web Audio API + WebSocket streaming (Opus/PCM)
- **GPU**: CUDA 12.1 + PyTorch 2.4
- **Infra**: Guardian system for process lifecycle management

## License

Frontend code is MIT. PersonaPlex model is subject to [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/).

## Acknowledgments

- [NVIDIA PersonaPlex](https://github.com/NVIDIA/personaplex)
- [Kyutai Moshi](https://github.com/kyutai-labs/moshi)
