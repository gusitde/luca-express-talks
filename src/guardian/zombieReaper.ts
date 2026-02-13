// Inference Guardian — Zombie Reaper
// Automated cleanup engine with configurable kill policies and safety guards.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TrackedProcess, CudaSnapshot, ReaperAction, ReaperConfig, ReaperRuleName } from './types.js';
import { DEFAULT_REAPER_CONFIG } from './types.js';
import { isManagedPid, safeKillPid, isPidAlive } from './processTracker.js';

const execFileAsync = promisify(execFile);

// ── State ──

let config: ReaperConfig = { ...DEFAULT_REAPER_CONFIG };
const actionLog: ReaperAction[] = [];

// Candidates seen in previous cycle (for 2-cycle confirmation)
const candidates = new Map<number, { rule: ReaperRuleName; reason: string; firstSeenAt: number }>();

export function getConfig(): ReaperConfig {
  return { ...config };
}

export function updateConfig(patch: Partial<ReaperConfig>): ReaperConfig {
  config = { ...config, ...patch };
  if (patch.rules) {
    config.rules = { ...config.rules, ...patch.rules };
  }
  return { ...config };
}

export function getActionLog(): ReaperAction[] {
  return [...actionLog];
}

export function getKillsInWindow(): number {
  const cutoff = Date.now() - config.windowMs;
  return actionLog.filter((a) => a.timestamp > cutoff && a.outcome === 'killed').length;
}

/**
 * Run one reaper evaluation cycle.
 * Returns any actions taken (kills, dry-runs, skips).
 */
export async function evaluate(
  processes: TrackedProcess[],
  cudaSnapshot: CudaSnapshot,
  managedBackendPid: number | null,
): Promise<ReaperAction[]> {
  if (!config.enabled) return [];

  const actions: ReaperAction[] = [];
  const currentCandidates = new Map<number, { rule: ReaperRuleName; reason: string }>();

  // ── Rule 1: Orphan kill ──
  if (config.rules['orphan-kill']) {
    for (const proc of processes) {
      if (proc.status === 'zombie' && !isManagedPid(proc.pid)) {
        currentCandidates.set(proc.pid, {
          rule: 'orphan-kill',
          reason: `PID ${proc.pid} is orphaned (parent ${proc.parentPid} dead), using ${proc.gpuMemoryMb ?? 0} MB VRAM.`,
        });
      }
    }
  }

  // ── Rule 2: Duplicate model ──
  if (config.rules['duplicate-model']) {
    const gpuHogs = cudaSnapshot.processes.filter((p) => p.usedMemoryMb > 4000);
    if (gpuHogs.length > 1) {
      // Find the unmanaged ones to kill (keep the managed one)
      for (const hog of gpuHogs) {
        if (!hog.isManaged) {
          currentCandidates.set(hog.pid, {
            rule: 'duplicate-model',
            reason: `PID ${hog.pid} using ${hog.usedMemoryMb} MB VRAM — duplicate model detected (${gpuHogs.length} processes >4GB).`,
          });
        }
      }
    }
  }

  // ── Rule 3: Port squatter ──
  if (config.rules['port-squatter']) {
    const portOwner = await getPortOwner(8998);
    if (portOwner !== null && portOwner !== managedBackendPid && !isManagedPid(portOwner)) {
      currentCandidates.set(portOwner, {
        rule: 'port-squatter',
        reason: `PID ${portOwner} holding port 8998 but is not the managed backend.`,
      });
    }
  }

  // ── Rule 4: Stale worker ──
  if (config.rules['stale-worker']) {
    for (const proc of processes) {
      if (proc.status === 'stale' && !isManagedPid(proc.pid)) {
        currentCandidates.set(proc.pid, {
          rule: 'stale-worker',
          reason: `PID ${proc.pid} has no CPU activity for multiple cycles and owns ${proc.gpuMemoryMb ?? 0} MB VRAM.`,
        });
      }
    }
  }

  // ── Rule 5: VRAM hog ──
  if (config.rules['vram-hog']) {
    for (const gpuProc of cudaSnapshot.processes) {
      if (!gpuProc.isManaged && gpuProc.usedMemoryMb > 2000) {
        // Check that this PID is not the managed backend or its children
        const tracked = processes.find((p) => p.pid === gpuProc.pid);
        if (tracked && tracked.role === 'unknown') {
          currentCandidates.set(gpuProc.pid, {
            rule: 'vram-hog',
            reason: `Unmanaged PID ${gpuProc.pid} using ${gpuProc.usedMemoryMb} MB VRAM for unknown purpose.`,
          });
        }
      }
    }
  }

  // ── 2-cycle confirmation ──
  const killsInWindow = getKillsInWindow();
  for (const [pid, info] of currentCandidates) {
    const prev = candidates.get(pid);
    if (!prev || prev.rule !== info.rule) {
      // First time seen for this rule — register and skip
      candidates.set(pid, { ...info, firstSeenAt: Date.now() });
      continue;
    }

    // Confirmed — candidate was seen in previous cycle too
    const action = await executeKill(pid, info.rule, info.reason, killsInWindow + actions.filter((a) => a.outcome === 'killed').length);
    actions.push(action);
  }

  // Prune candidates not seen this cycle
  for (const pid of candidates.keys()) {
    if (!currentCandidates.has(pid)) {
      candidates.delete(pid);
    }
  }

  // Persist actions
  for (const action of actions) {
    actionLog.push(action);
  }
  // Trim action log to last 100 entries
  while (actionLog.length > 100) {
    actionLog.shift();
  }

  return actions;
}

// ── Kill execution ──

async function executeKill(
  pid: number,
  rule: ReaperRuleName,
  reason: string,
  currentKillCount: number,
): Promise<ReaperAction> {
  const now = Date.now();

  // Safety: circuit breaker
  if (currentKillCount >= config.maxKillsPerWindow) {
    return {
      timestamp: now,
      targetPid: pid,
      rule,
      reason,
      outcome: 'skipped-safety',
      freedMemoryMb: null,
    };
  }

  // Safety: never kill managed healthy processes
  if (isManagedPid(pid)) {
    return {
      timestamp: now,
      targetPid: pid,
      rule,
      reason: `${reason} (skipped: PID is in managed registry)`,
      outcome: 'skipped-safety',
      freedMemoryMb: null,
    };
  }

  // Dry run mode
  if (config.dryRun) {
    return {
      timestamp: now,
      targetPid: pid,
      rule,
      reason,
      outcome: 'dry-run',
      freedMemoryMb: null,
    };
  }

  // Verify still alive
  const alive = await isPidAlive(pid);
  if (!alive) {
    return {
      timestamp: now,
      targetPid: pid,
      rule,
      reason: `${reason} (already dead)`,
      outcome: 'skipped-safety',
      freedMemoryMb: null,
    };
  }

  // Execute kill
  const killed = await safeKillPid(pid);
  candidates.delete(pid);

  return {
    timestamp: now,
    targetPid: pid,
    rule,
    reason,
    outcome: killed ? 'killed' : 'failed',
    freedMemoryMb: null, // Will be measured on next CUDA poll
  };
}

// ── Helpers ──

async function getPortOwner(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ]);
    const pid = Number(stdout.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
