// Inference Guardian — Main daemon entry
// Orchestrates polling loops for process tracking, CUDA monitoring, and automated cleanup.

import type { GuardianStatus, CudaSnapshot } from './types.js';
import { GUARDIAN_POLL_INTERVAL_MS, CUDA_POLL_INTERVAL_MS } from './types.js';
import { scanProcesses, registerManagedPid, unregisterManagedPid, getManagedPids, safeKillPid } from './processTracker.js';
import { pollCuda, getHistory, getGpuPidMemoryMap } from './cudaMonitor.js';
import * as reaper from './zombieReaper.js';
import * as fence from './inferenceFence.js';
import type { TrackedProcess } from './types.js';

// ── Daemon state ──

let running = false;
let startedAt = 0;
let processTimer: ReturnType<typeof setInterval> | null = null;
let cudaTimer: ReturnType<typeof setInterval> | null = null;

let latestProcesses: TrackedProcess[] = [];
let latestCuda: CudaSnapshot = { timestamp: 0, gpu: null, processes: [], alerts: [] };
let managedBackendPid: number | null = null;

// Log buffer for guardian events
const guardianLog: string[] = [];
function glog(msg: string) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  guardianLog.push(entry);
  while (guardianLog.length > 300) guardianLog.shift();
}

// ── Lifecycle ──

export function start(): void {
  if (running) return;
  running = true;
  startedAt = Date.now();
  glog('Guardian daemon started');

  // Initial poll immediately
  runProcessPoll();
  runCudaPoll();

  // Schedule recurring polls
  processTimer = setInterval(runProcessPoll, GUARDIAN_POLL_INTERVAL_MS);
  cudaTimer = setInterval(runCudaPoll, CUDA_POLL_INTERVAL_MS);
}

export function stop(): void {
  if (!running) return;
  running = false;
  if (processTimer) clearInterval(processTimer);
  if (cudaTimer) clearInterval(cudaTimer);
  processTimer = null;
  cudaTimer = null;
  glog('Guardian daemon stopped');
}

export function isRunning(): boolean {
  return running;
}

// ── Backend PID management (called by Vite plugin when backend starts/stops) ──

export function setManagedBackendPid(pid: number): void {
  managedBackendPid = pid;
  registerManagedPid(pid);
  glog(`Registered managed backend PID ${pid}`);
}

export function clearManagedBackendPid(pid: number): void {
  if (managedBackendPid === pid) managedBackendPid = null;
  unregisterManagedPid(pid);
  glog(`Unregistered managed backend PID ${pid}`);
}

export function registerChildPid(pid: number): void {
  registerManagedPid(pid);
  glog(`Registered managed child PID ${pid}`);
}

// ── Manual kill ──

export async function manualKill(pid: number): Promise<{ success: boolean; message: string }> {
  const managed = getManagedPids();
  if (managed.includes(pid)) {
    return { success: false, message: `PID ${pid} is in the managed registry. Use server restart instead.` };
  }

  const killed = await safeKillPid(pid);
  const msg = killed
    ? `PID ${pid} killed successfully.`
    : `Failed to kill PID ${pid} — may already be dead or require elevated privileges.`;
  glog(msg);
  return { success: killed, message: msg };
}

// ── Poll functions ──

async function runProcessPoll(): Promise<void> {
  try {
    const gpuMap = await getGpuPidMemoryMap();
    latestProcesses = await scanProcesses(gpuMap);

    // Auto-register children of managed backend
    if (managedBackendPid !== null) {
      for (const proc of latestProcesses) {
        if (proc.parentPid === managedBackendPid && !getManagedPids().includes(proc.pid)) {
          registerChildPid(proc.pid);
        }
      }
    }
  } catch (err) {
    glog(`Process poll error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

async function runCudaPoll(): Promise<void> {
  try {
    latestCuda = await pollCuda();

    // Run reaper evaluation
    const actions = await reaper.evaluate(latestProcesses, latestCuda, managedBackendPid);
    for (const action of actions) {
      glog(`REAPER [${action.rule}] ${action.outcome}: ${action.reason}`);
    }

    // Run fence evaluation (log warnings)
    const fenceStatus = fence.evaluate(latestProcesses, latestCuda);
    if (fenceStatus.isOverBudget) {
      glog(`FENCE Warning: VRAM ${fenceStatus.vramUsedMb} MB exceeds budget ${fenceStatus.vramBudgetMb} MB`);
    }
    if (fenceStatus.promptTimedOut) {
      glog(`FENCE Warning: Prompt processing has timed out`);
    }
  } catch (err) {
    glog(`CUDA poll error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ── Status API ──

export function getStatus(): GuardianStatus {
  return {
    enabled: running,
    uptimeMs: running ? Date.now() - startedAt : 0,
    lastPollAt: latestCuda.timestamp,
    processes: latestProcesses,
    cuda: latestCuda,
    cudaHistory: getHistory(),
    reaper: {
      config: reaper.getConfig(),
      recentActions: reaper.getActionLog(),
      killsInWindow: reaper.getKillsInWindow(),
    },
    fence: fence.evaluate(latestProcesses, latestCuda),
  };
}

export function getLog(): string[] {
  return [...guardianLog];
}
