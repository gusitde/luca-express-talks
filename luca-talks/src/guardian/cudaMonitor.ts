// Inference Guardian — CUDA Monitor
// Polls nvidia-smi for GPU stats and per-process VRAM ownership.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CudaSnapshot, GpuInfo, GpuProcess, CudaAlert, CudaHistoryEntry } from './types.js';
import { HISTORY_MAX_ENTRIES } from './types.js';
import { isManagedPid } from './processTracker.js';

const execFileAsync = promisify(execFile);

// Rolling history buffer
const history: CudaHistoryEntry[] = [];

// Previous snapshot for leak detection
let previousSnapshot: CudaSnapshot | null = null;

// VRAM budget threshold (configurable at runtime)
let vramBudgetMb = 14_000; // alert when used exceeds this

export function setVramBudget(budgetMb: number): void {
  vramBudgetMb = budgetMb;
}

export function getHistory(): CudaHistoryEntry[] {
  return [...history];
}

/**
 * Poll nvidia-smi and return a full CUDA snapshot with alerts.
 */
export async function pollCuda(): Promise<CudaSnapshot> {
  const now = Date.now();
  const gpu = await queryGpuInfo();
  const processes = await queryGpuProcesses();
  const alerts = generateAlerts(gpu, processes, now);

  const snapshot: CudaSnapshot = { timestamp: now, gpu, processes, alerts };

  // Update history
  if (gpu) {
    history.push({
      timestamp: now,
      memoryUsedMb: gpu.memoryUsedMb,
      utilizationPercent: gpu.utilizationPercent,
      temperature: gpu.temperature,
      processCount: processes.length,
    });
    while (history.length > HISTORY_MAX_ENTRIES) {
      history.shift();
    }
  }

  previousSnapshot = snapshot;
  return snapshot;
}

/**
 * Build a map of PID → GPU memory (MB) from nvidia-smi compute-apps.
 */
export async function getGpuPidMemoryMap(): Promise<Map<number, number>> {
  const processes = await queryGpuProcesses();
  const map = new Map<number, number>();
  for (const p of processes) {
    map.set(p.pid, p.usedMemoryMb);
  }
  return map;
}

// ── nvidia-smi queries ──

async function queryGpuInfo(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.used,memory.total,memory.free,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ]);

    const line = stdout.trim().split('\n')[0];
    if (!line) return null;

    const [name, usedStr, totalStr, freeStr, utilStr, tempStr] = line.split(',').map((s) => s.trim());
    return {
      name: name ?? 'Unknown GPU',
      memoryUsedMb: Number(usedStr) || 0,
      memoryTotalMb: Number(totalStr) || 0,
      memoryFreeMb: Number(freeStr) || 0,
      utilizationPercent: Number(utilStr) || 0,
      temperature: Number(tempStr) || 0,
    };
  } catch {
    return null;
  }
}

async function queryGpuProcesses(): Promise<GpuProcess[]> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-compute-apps=pid,process_name,used_memory',
      '--format=csv,noheader,nounits',
    ]);

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    return trimmed.split('\n').map((line) => {
      const parts = line.split(',').map((s) => s.trim());
      const pid = Number(parts[0]) || 0;
      return {
        pid,
        processName: parts[1] ?? 'unknown',
        usedMemoryMb: Number(parts[2]) || 0,
        isManaged: isManagedPid(pid),
      };
    }).filter((p) => p.pid > 0);
  } catch {
    return [];
  }
}

// ── Alert generation ──

function generateAlerts(gpu: GpuInfo | null, processes: GpuProcess[], now: number): CudaAlert[] {
  const alerts: CudaAlert[] = [];

  if (!gpu) return alerts;

  // Over-budget alert
  if (gpu.memoryUsedMb > vramBudgetMb) {
    alerts.push({
      type: 'over-budget',
      severity: 'warning',
      message: `VRAM usage ${gpu.memoryUsedMb} MB exceeds budget of ${vramBudgetMb} MB.`,
      timestamp: now,
    });
  }

  // Thermal alert
  if (gpu.temperature >= 90) {
    alerts.push({
      type: 'thermal',
      severity: 'critical',
      message: `GPU temperature ${gpu.temperature}°C is critically high.`,
      timestamp: now,
    });
  } else if (gpu.temperature >= 80) {
    alerts.push({
      type: 'thermal',
      severity: 'warning',
      message: `GPU temperature ${gpu.temperature}°C is elevated.`,
      timestamp: now,
    });
  }

  // Unmanaged process on GPU
  for (const proc of processes) {
    if (!proc.isManaged && proc.usedMemoryMb > 100) {
      alerts.push({
        type: 'unmanaged-process',
        severity: 'warning',
        message: `Unmanaged process PID ${proc.pid} (${proc.processName}) using ${proc.usedMemoryMb} MB VRAM.`,
        pid: proc.pid,
        timestamp: now,
      });
    }
  }

  // VRAM leak detection: memory growing while no managed process is actively using GPU
  if (previousSnapshot?.gpu) {
    const prevUsed = previousSnapshot.gpu.memoryUsedMb;
    const delta = gpu.memoryUsedMb - prevUsed;
    const managedProcesses = processes.filter((p) => p.isManaged);
    if (delta > 500 && managedProcesses.length === 0) {
      alerts.push({
        type: 'vram-leak',
        severity: 'warning',
        message: `VRAM grew by ${delta} MB with no managed processes on GPU. Possible leak.`,
        timestamp: now,
      });
    }
  }

  return alerts;
}
