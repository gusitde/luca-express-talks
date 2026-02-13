// Inference Guardian — Shared type definitions

// ── Process Tracker ──

export type ProcessRole = 'backend-server' | 'model-worker' | 'unknown';
export type ProcessHealth = 'healthy' | 'stale' | 'zombie' | 'killed';

export interface TrackedProcess {
  pid: number;
  parentPid: number | null;
  role: ProcessRole;
  startedAt: number;
  lastHeartbeat: number;
  commandLine: string;
  cpuPercent: number;
  memoryMb: number;
  gpuMemoryMb: number | null;
  status: ProcessHealth;
}

// ── CUDA Monitor ──

export interface GpuInfo {
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryFreeMb: number;
  utilizationPercent: number;
  temperature: number;
}

export interface GpuProcess {
  pid: number;
  processName: string;
  usedMemoryMb: number;
  isManaged: boolean;
}

export type CudaAlertType = 'vram-leak' | 'unmanaged-process' | 'over-budget' | 'thermal';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface CudaAlert {
  type: CudaAlertType;
  severity: AlertSeverity;
  message: string;
  pid?: number;
  timestamp: number;
}

export interface CudaSnapshot {
  timestamp: number;
  gpu: GpuInfo | null;
  processes: GpuProcess[];
  alerts: CudaAlert[];
}

export interface CudaHistoryEntry {
  timestamp: number;
  memoryUsedMb: number;
  utilizationPercent: number;
  temperature: number;
  processCount: number;
}

// ── Zombie Reaper ──

export type ReaperRuleName =
  | 'orphan-kill'
  | 'duplicate-model'
  | 'port-squatter'
  | 'stale-worker'
  | 'vram-hog';

export type ReaperOutcome = 'killed' | 'failed' | 'skipped-safety' | 'dry-run';

export interface ReaperAction {
  timestamp: number;
  targetPid: number;
  rule: ReaperRuleName;
  reason: string;
  outcome: ReaperOutcome;
  freedMemoryMb: number | null;
}

export interface ReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  maxKillsPerWindow: number;
  windowMs: number;
  rules: Record<ReaperRuleName, boolean>;
}

// ── Inference Fence ──

export interface FenceConfig {
  maxConcurrentModels: number;
  vramBudgetMb: number;
  promptTimeoutMs: number;
  inferenceStepTimeoutMs: number;
  maxConnectionsPerModel: number;
}

export interface FenceStatus {
  activeModels: number;
  vramUsedMb: number;
  vramBudgetMb: number;
  isOverBudget: boolean;
  promptStartedAt: number | null;
  promptTimedOut: boolean;
  locked: boolean;
}

// ── Guardian Status (aggregate) ──

export interface GuardianStatus {
  enabled: boolean;
  uptimeMs: number;
  lastPollAt: number;
  processes: TrackedProcess[];
  cuda: CudaSnapshot;
  cudaHistory: CudaHistoryEntry[];
  reaper: {
    config: ReaperConfig;
    recentActions: ReaperAction[];
    killsInWindow: number;
  };
  fence: FenceStatus;
}

// ── Guardian config defaults ──

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  enabled: true,
  dryRun: false,
  maxKillsPerWindow: 3,
  windowMs: 300_000,
  rules: {
    'orphan-kill': true,
    'duplicate-model': true,
    'port-squatter': true,
    'stale-worker': true,
    'vram-hog': true,
  },
};

export const DEFAULT_FENCE_CONFIG: FenceConfig = {
  maxConcurrentModels: 1,
  vramBudgetMb: 12_288,
  promptTimeoutMs: 300_000,
  inferenceStepTimeoutMs: 10_000,
  maxConnectionsPerModel: 1,
};

export const GUARDIAN_POLL_INTERVAL_MS = 5_000;
export const CUDA_POLL_INTERVAL_MS = 10_000;
export const HISTORY_RETENTION_MS = 300_000;
export const HISTORY_MAX_ENTRIES = 120;
