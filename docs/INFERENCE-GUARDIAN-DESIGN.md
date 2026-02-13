# Inference Guardian — Design Document

## Overview

**Inference Guardian** is a lightweight background daemon that protects the Luca Talks system from zombie processes, GPU memory leaks, orphaned CUDA contexts, and runaway inference threads. It runs alongside the Vite dev server and provides both automated cleanup and a real-time dashboard via REST API.

---

## Problem Statement

During development and runtime, several failure modes cause system degradation:

| Problem | Symptom | Impact |
|---|---|---|
| Zombie Python processes | Old `moshi.server` instances not killed | GPU VRAM full, new server can't load model |
| Orphaned CUDA contexts | Crashed processes leave GPU memory allocated | 14+ GB stuck, requires manual `nvidia-smi` |
| Duplicate model loads | Multiple inference workers compete for VRAM | Thrashing, 3s+ per step instead of ~0.3s |
| Runaway threads | Prompt processing hangs indefinitely | WebSocket timeout, no audio response |
| Port conflicts | Port 8998 held by dead process | Server fails to bind |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Vite Dev Server                    │
│  ┌───────────────┐  ┌────────────────────────────┐  │
│  │ React Frontend│  │  /api/diag/* endpoints     │  │
│  └───────────────┘  └────────────────────────────┘  │
│                           │                          │
│              ┌────────────▼────────────────┐        │
│              │   Inference Guardian Daemon  │        │
│              │                             │        │
│              │  ┌─────────────────────┐    │        │
│              │  │  Process Tracker    │    │        │
│              │  │  - PID registry     │    │        │
│              │  │  - Parent/child map │    │        │
│              │  │  - Heartbeat monitor│    │        │
│              │  └─────────────────────┘    │        │
│              │                             │        │
│              │  ┌─────────────────────┐    │        │
│              │  │  CUDA Monitor       │    │        │
│              │  │  - VRAM usage/pid   │    │        │
│              │  │  - Context tracker  │    │        │
│              │  │  - Utilization log  │    │        │
│              │  └─────────────────────┘    │        │
│              │                             │        │
│              │  ┌─────────────────────┐    │        │
│              │  │  Zombie Reaper      │    │        │
│              │  │  - Orphan detection │    │        │
│              │  │  - Auto-kill policy │    │        │
│              │  │  - Port reclaim     │    │        │
│              │  └─────────────────────┘    │        │
│              │                             │        │
│              │  ┌─────────────────────┐    │        │
│              │  │  Inference Fence    │    │        │
│              │  │  - Max 1 model rule │    │        │
│              │  │  - VRAM budget      │    │        │
│              │  │  - Timeout watchdog │    │        │
│              │  └─────────────────────┘    │        │
│              └─────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
         │              │              │
    ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐
    │ Windows │   │ nvidia-smi│  │ Port    │
    │ Process │   │ / NVML    │  │ Scanner │
    │ Table   │   │           │  │         │
    └─────────┘   └───────────┘  └─────────┘
```

---

## Module Design

### 1. Process Tracker (`processTracker.ts`)

Maintains a live registry of all managed Python/inference processes.

**Data Model:**
```typescript
interface TrackedProcess {
  pid: number;
  parentPid: number | null;
  role: 'backend-server' | 'model-worker' | 'unknown';
  startedAt: number;
  lastHeartbeat: number;
  commandLine: string;
  cpuPercent: number;
  memoryMb: number;
  status: 'healthy' | 'stale' | 'zombie' | 'killed';
}
```

**Behavior:**
- Polls every **5 seconds** via `Get-Process` / `Get-CimInstance Win32_Process`
- Builds parent-child tree to identify worker processes spawned by the backend
- Marks processes as `stale` if no CPU activity for 60 seconds while GPU is idle
- Marks processes as `zombie` if parent PID no longer exists
- Exposes `/api/guardian/processes` endpoint

### 2. CUDA Monitor (`cudaMonitor.ts`)

Tracks GPU memory allocation, utilization, and per-process VRAM ownership.

**Data Model:**
```typescript
interface CudaSnapshot {
  timestamp: number;
  gpu: {
    name: string;
    memoryUsedMb: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    utilizationPercent: number;
    temperature: number;
  };
  processes: Array<{
    pid: number;
    processName: string;
    usedMemoryMb: number;
    isManaged: boolean;  // true if in ProcessTracker registry
  }>;
  alerts: CudaAlert[];
}

interface CudaAlert {
  type: 'vram-leak' | 'unmanaged-process' | 'over-budget' | 'thermal';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  pid?: number;
  timestamp: number;
}
```

**Behavior:**
- Polls `nvidia-smi` every **10 seconds** for GPU stats + per-process memory
- Cross-references GPU-using PIDs with ProcessTracker registry
- Flags **unmanaged processes** (using GPU but not in our registry) as potential zombies
- Tracks VRAM budget: alerts if used > 14 GB (leaving < 2 GB for KV cache)
- Keeps rolling 5-minute history for the dashboard sparkline
- Exposes `/api/guardian/cuda` and `/api/guardian/cuda/history`

### 3. Zombie Reaper (`zombieReaper.ts`)

Automated cleanup engine with configurable kill policies.

**Kill Policy Rules (evaluated in order):**

| # | Rule | Condition | Action | Cooldown |
|---|---|---|---|---|
| 1 | Orphan kill | Python process on GPU, parent dead | Kill process | immediate |
| 2 | Duplicate model | >1 process using >4 GB VRAM | Kill oldest non-managed | 10s |
| 3 | Port squatter | Port 8998 held by non-managed PID | Kill holder | 5s |
| 4 | Stale worker | No CPU activity for 120s, GPU idle | Kill process | 30s |
| 5 | VRAM hog | Unmanaged process using >2 GB VRAM for >60s | Kill process | 30s |

**Safety Guards:**
- Never kills a process in the `ProcessTracker` registry marked `healthy`
- Requires 2 consecutive detection cycles before kill (no single-poll kills)
- Logs every kill action with full context to `/api/guardian/reaper/log`
- Dry-run mode available via config flag
- Maximum 3 kills per 5-minute window (circuit breaker)

**Data Model:**
```typescript
interface ReaperAction {
  timestamp: number;
  targetPid: number;
  rule: string;
  reason: string;
  outcome: 'killed' | 'failed' | 'skipped-safety' | 'dry-run';
  freedMemoryMb: number | null;
}

interface ReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  maxKillsPerWindow: number;
  windowMs: number;
  rules: Record<string, boolean>;  // toggle individual rules
}
```

### 4. Inference Fence (`inferenceFence.ts`)

Ensures only one model instance runs at a time and enforces resource budgets.

**Constraints:**
```typescript
interface FenceConfig {
  maxConcurrentModels: 1;
  vramBudgetMb: 12288;         // 12 GB for model (leaves 4 GB for KV/activations)
  promptTimeoutMs: 300000;     // 5 min max for system prompt processing
  inferenceStepTimeoutMs: 10000; // 10s max per step (expect ~0.5-1s)
  maxConnectionsPerModel: 1;   // PersonaPlex is single-user
}
```

**Behavior:**
- Before starting a new backend, checks if an existing model is loaded anywhere
- If existing model found on GPU → triggers Zombie Reaper rule #2
- Monitors prompt processing duration via backend logs
- If prompt processing exceeds `promptTimeoutMs`, force-restarts the backend
- Tracks per-step inference timing from server logs (regex on step duration)
- Exposes `/api/guardian/fence/status`

---

## REST API Endpoints

All mounted under the Vite dev server middleware:

| Method | Path | Description |
|---|---|---|
| GET | `/api/guardian/status` | Overall guardian health + summary |
| GET | `/api/guardian/processes` | All tracked processes |
| GET | `/api/guardian/cuda` | Current CUDA snapshot |
| GET | `/api/guardian/cuda/history` | 5-min VRAM/utilization history |
| GET | `/api/guardian/reaper/log` | Recent reaper actions |
| GET | `/api/guardian/fence/status` | Inference fence state |
| POST | `/api/guardian/reaper/config` | Update reaper config (enable/disable rules) |
| POST | `/api/guardian/kill/:pid` | Manual kill with safety checks |
| POST | `/api/guardian/fence/reset` | Reset fence (clear stuck locks) |

---

## Dashboard Integration

A new **Guardian Panel** in the Maintenance page showing:

```
┌─────────────────────────────────────────────┐
│  🛡️ Inference Guardian              [ON]   │
├─────────────────────────────────────────────┤
│                                             │
│  GPU Memory    ████████████████░░░░ 14.3/16 │
│  GPU Util      ████████████████████ 99%     │
│  Temperature   ██████████░░░░░░░░░░ 72°C    │
│                                             │
│  Managed Processes                          │
│  ┌──────┬────────────┬───────┬──────────┐   │
│  │ PID  │ Role       │ VRAM  │ Status   │   │
│  ├──────┼────────────┼───────┼──────────┤   │
│  │12976 │ server     │  0 MB │ healthy  │   │
│  │20796 │ worker     │ 14 GB │ healthy  │   │
│  └──────┴────────────┴───────┴──────────┘   │
│                                             │
│  Unmanaged GPU Processes: 0                 │
│  Zombie Kills (last hour): 0               │
│  Fence: 1/1 model slots used               │
│                                             │
│  [Kill Zombies]  [Reset Fence]  [Dry Run]   │
└─────────────────────────────────────────────┘
```

---

## File Structure

```
luca-talks/
├── src/
│   ├── guardian/
│   │   ├── index.ts              # Guardian daemon entry + polling loop
│   │   ├── processTracker.ts     # Process registry & heartbeat
│   │   ├── cudaMonitor.ts        # nvidia-smi polling & VRAM tracking
│   │   ├── zombieReaper.ts       # Kill policy engine
│   │   ├── inferenceFence.ts     # Model concurrency & budget control
│   │   ├── types.ts              # Shared interfaces
│   │   └── vitePlugin.ts         # Vite middleware integration
│   └── components/
│       └── GuardianPanel.tsx     # Dashboard UI component
└── docs/
    └── INFERENCE-GUARDIAN-DESIGN.md   # This file
```

---

## Implementation Phases

### Phase 1 — Core Monitoring (MVP)
- Process Tracker with PID registry
- CUDA Monitor with nvidia-smi polling
- REST endpoints for status/processes/cuda
- Basic Guardian Panel in Maintenance page

### Phase 2 — Automated Cleanup
- Zombie Reaper with all 5 kill rules
- Safety guards and circuit breaker
- Reaper action log and config endpoint
- Kill confirmation UI

### Phase 3 — Inference Fence
- Model concurrency enforcement
- Prompt timeout watchdog
- Per-step timing tracker
- VRAM budget alerts

### Phase 4 — Hardening
- Persistent reaper log (file-backed)
- Startup scan (find zombies before backend launches)
- GPU temperature monitoring + thermal throttle alerts
- Windows Event Log integration for crash forensics

---

## Configuration

```typescript
// Default guardian config
const GUARDIAN_DEFAULTS = {
  pollIntervalMs: 5000,          // Process poll frequency
  cudaPollIntervalMs: 10000,     // GPU poll frequency
  historyRetentionMs: 300000,    // 5 min rolling history
  reaper: {
    enabled: true,
    dryRun: false,               // Set true for testing
    maxKillsPerWindow: 3,
    windowMs: 300000,
    rules: {
      orphanKill: true,
      duplicateModel: true,
      portSquatter: true,
      staleWorker: true,
      vramHog: true,
    },
  },
  fence: {
    maxConcurrentModels: 1,
    vramBudgetMb: 12288,
    promptTimeoutMs: 300000,
    inferenceStepTimeoutMs: 10000,
  },
};
```

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Accidentally kill user's other Python work | Only targets processes with GPU usage + matching command patterns (`moshi.server`, model paths) |
| nvidia-smi not available | Graceful degradation — CUDA monitor disabled, process tracking still works |
| Reaper too aggressive | 2-cycle confirmation, circuit breaker, dry-run mode, per-rule toggles |
| Performance overhead | Polls are lightweight shell commands; 5-10s intervals are negligible |
| Race condition on kill | Lock around reaper actions; verify PID still exists before kill |

---

## Status

**🟡 AWAITING IMPLEMENTATION APPROVAL**

Proceed with Phase 1 (Core Monitoring MVP)?
