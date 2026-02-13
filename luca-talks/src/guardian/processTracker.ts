// Inference Guardian — Process Tracker
// Maintains a live registry of all managed Python/inference processes.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TrackedProcess, ProcessRole, ProcessHealth } from './types.js';

const execFileAsync = promisify(execFile);

/** Raw row returned by Win32_Process + Get-Process join. */
interface RawProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
  cpuSeconds: number;
  workingSetMb: number;
}

// PIDs we have explicitly registered as "ours"
const managedPids = new Set<number>();

// Last CPU snapshot per PID for delta calculations
const lastCpuSnapshot = new Map<number, { cpuSeconds: number; timestamp: number }>();

// Consecutive stale cycles per PID (for 2-cycle confirmation)
const staleCycles = new Map<number, number>();

// ── Public API ──

export function registerManagedPid(pid: number): void {
  managedPids.add(pid);
  staleCycles.delete(pid);
}

export function unregisterManagedPid(pid: number): void {
  managedPids.delete(pid);
  lastCpuSnapshot.delete(pid);
  staleCycles.delete(pid);
}

export function isManagedPid(pid: number): boolean {
  return managedPids.has(pid);
}

export function getManagedPids(): number[] {
  return [...managedPids];
}

/**
 * Scan all Python processes on the system and return tracked process records.
 * Cross-references with `managedPids` to assign roles and health.
 */
export async function scanProcesses(
  gpuPidMemoryMap: Map<number, number>,
): Promise<TrackedProcess[]> {
  const rawProcesses = await listPythonProcesses();
  const alivePids = new Set(rawProcesses.map((p) => p.pid));
  const now = Date.now();
  const result: TrackedProcess[] = [];

  for (const raw of rawProcesses) {
    const role = classifyRole(raw);
    const gpuMem = gpuPidMemoryMap.get(raw.pid) ?? null;

    // CPU activity delta
    const prev = lastCpuSnapshot.get(raw.pid);
    let cpuPercent = 0;
    if (prev) {
      const dtSec = (now - prev.timestamp) / 1000;
      if (dtSec > 0) {
        cpuPercent = Math.min(100, Math.round(((raw.cpuSeconds - prev.cpuSeconds) / dtSec) * 100));
      }
    }
    lastCpuSnapshot.set(raw.pid, { cpuSeconds: raw.cpuSeconds, timestamp: now });

    const status = determineHealth(raw, role, cpuPercent, gpuMem, alivePids);

    result.push({
      pid: raw.pid,
      parentPid: raw.parentPid,
      role,
      startedAt: now, // We don't have real start time from snapshot; will be overwritten on register
      lastHeartbeat: now,
      commandLine: raw.commandLine,
      cpuPercent,
      memoryMb: raw.workingSetMb,
      gpuMemoryMb: gpuMem,
      status,
    });
  }

  // Prune stale entries from lastCpuSnapshot for dead processes
  for (const pid of lastCpuSnapshot.keys()) {
    if (!alivePids.has(pid)) {
      lastCpuSnapshot.delete(pid);
      staleCycles.delete(pid);
    }
  }

  return result;
}

/**
 * Check if a PID is still alive.
 */
export async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a PID with safety checks.
 * Returns true if the kill signal was sent successfully.
 */
export async function safeKillPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

// ── Internal helpers ──

async function listPythonProcesses(): Promise<RawProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" | ForEach-Object {
        $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($proc) {
          [PSCustomObject]@{
            PID = $_.ProcessId
            ParentPID = $_.ParentProcessId
            Name = $_.Name
            CmdLine = ($_.CommandLine -replace '\\r|\\n',' ')
            CPU = [math]::Round($proc.CPU, 2)
            WS_MB = [math]::Round($proc.WorkingSet64 / 1MB, 1)
          }
        }
      } | ConvertTo-Json -Compress`,
    ]);

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '') return [];

    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items.map((item: Record<string, unknown>) => ({
      pid: Number(item.PID),
      parentPid: Number(item.ParentPID),
      name: String(item.Name ?? ''),
      commandLine: String(item.CmdLine ?? ''),
      cpuSeconds: Number(item.CPU ?? 0),
      workingSetMb: Number(item.WS_MB ?? 0),
    }));
  } catch {
    return [];
  }
}

function classifyRole(raw: RawProcessInfo): ProcessRole {
  const cmd = raw.commandLine.toLowerCase();
  if (cmd.includes('moshi.server') || cmd.includes('moshi\\server')) {
    return managedPids.has(raw.pid) ? 'backend-server' : 'unknown';
  }
  // Child workers spawned by a managed PID
  if (managedPids.has(raw.parentPid)) {
    return 'model-worker';
  }
  if (managedPids.has(raw.pid)) {
    return 'backend-server';
  }
  return 'unknown';
}

function determineHealth(
  raw: RawProcessInfo,
  role: ProcessRole,
  cpuPercent: number,
  gpuMemMb: number | null,
  alivePids: Set<number>,
): ProcessHealth {
  // If parent is dead and not init, it's a zombie
  if (raw.parentPid > 1 && !alivePids.has(raw.parentPid) && !managedPids.has(raw.pid)) {
    const cycles = (staleCycles.get(raw.pid) ?? 0) + 1;
    staleCycles.set(raw.pid, cycles);
    if (cycles >= 2) return 'zombie';
  }

  // A non-managed process sitting on GPU with no CPU activity
  if (role === 'unknown' && gpuMemMb !== null && gpuMemMb > 500 && cpuPercent <= 1) {
    const cycles = (staleCycles.get(raw.pid) ?? 0) + 1;
    staleCycles.set(raw.pid, cycles);
    if (cycles >= 3) return 'stale';
  }

  // Managed processes or active ones are healthy
  staleCycles.delete(raw.pid);
  return 'healthy';
}
