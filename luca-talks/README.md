# Luca Talks 🎙️

Human-like voice-to-voice conversational AI powered by NVIDIA PersonaPlex.

## Features

- **Real-time Voice Conversations** - Natural, low-latency speech-to-speech interactions
- **Multiple Voice Options** - Choose from 18 different voice presets
- **Custom Personas** - Define Luca's personality with text prompts
- **Full Duplex** - Supports interruptions, overlaps, and natural turn-taking

## Prerequisites

- **Windows 10/11** with NVIDIA GPU (16GB+ VRAM recommended)
- **Node.js 20+** (LTS)
- **Python 3.11** (for PersonaPlex)
- **Hugging Face Account** - [Get a token](https://huggingface.co/settings/tokens)
- **CUDA 12.1+** compatible drivers

## Quick Start

### 1. Set Environment Variable

```powershell
$env:HF_TOKEN = "your_huggingface_token"
```

### 2. Start PersonaPlex Server

```powershell
cd D:\VoiceLuca
$env:NO_TORCH_COMPILE = "1"
D:\VoiceLuca\personaplex-env\Scripts\python.exe -m moshi.server --ssl (Join-Path $env:TEMP "ssl_luca")
```

Wait for the model to load (~2-5 minutes). You'll see:
```
Access the Web UI directly at https://192.168.x.x:8998
======== Running on https://0.0.0.0:8998 ========
```

### 3. Start React Client (optional)

```powershell
cd D:\VoiceLuca\luca-talks
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

**Or** just use the built-in UI at https://localhost:8998

## Usage

1. Click **Start Talking** to begin a conversation
2. Speak naturally - Luca will respond in real-time
3. Use **Settings** to change voice or persona
4. Click **Stop** to end the conversation

## Voice Options

| Voice | Style |
|-------|-------|
| NATF0-3 | Natural Female (4 voices) |
| NATM0-3 | Natural Male (4 voices) |
| VARF0-4 | Variety Female (5 voices) |
| VARM0-4 | Variety Male (5 voices) |

## Configuration

Copy `.env.example` to `.env` and configure:

```env
HF_TOKEN=your_token
VITE_SERVER_URL=wss://localhost:8998/api/chat
```

## Project Structure

```
luca-talks/
├── src/
│   ├── components/
│   │   ├── VoiceChat.tsx      # Main conversation UI
│   │   ├── AudioVisualizer.tsx # Visual feedback
│   │   └── VoiceSelector.tsx  # Voice dropdown
│   ├── hooks/
│   │   └── useAudioStream.ts  # WebSocket + Audio handling
│   ├── App.tsx
│   └── index.css              # Tailwind + custom styles
├── scripts/
│   ├── start.ps1              # One-command startup
│   └── health-check.ps1       # System diagnostics
├── .env.example
└── README.md
```

## Troubleshooting

### Server won't start

**"CUDA out of memory"**
- Ensure no other GPU-heavy apps are running
- Try `--cpu-offload` flag (slower but uses less VRAM)

**"Torch not compiled with CUDA enabled"**
- Reinstall PyTorch with CUDA: `pip install torch --index-url https://download.pytorch.org/whl/cu121`

### No audio

- Check microphone permissions in browser
- Ensure HTTPS (required for microphone access)
- Accept the self-signed certificate warning

### Connection failed

- Verify server is running: `.\scripts\health-check.ps1`
- Check firewall isn't blocking port 8998

## Development

```powershell
# Install dependencies
npm install

# Start dev server
npm run dev

# Type check
npm run type-check

# Build for production
npm run build
```

## Tech Stack

- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS
- **Backend**: NVIDIA PersonaPlex (Moshi architecture)
- **Audio**: Web Audio API + WebSocket streaming
- **GPU**: CUDA 12.1 + PyTorch 2.4

## License

Client code is MIT. PersonaPlex model is subject to [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/).

## Acknowledgments

- [NVIDIA PersonaPlex](https://github.com/NVIDIA/personaplex)
- [Kyutai Moshi](https://github.com/kyutai-labs/moshi)
