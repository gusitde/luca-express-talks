// Inference Guardian — Dashboard UI Panel
// Renders process table, CUDA stats, reaper log, and fence status.

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types (mirrored from server-side guardian types for the client) ──

interface TrackedProcess {
  pid: number;
  parentPid: number | null;
  role: string;
  startedAt: number;
  lastHeartbeat: number;
  commandLine: string;
  cpuPercent: number;
  memoryMb: number;
  gpuMemoryMb: number | null;
  status: string;
}

interface GpuInfo {
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryFreeMb: number;
  utilizationPercent: number;
  temperature: number;
}

interface GpuProcess {
  pid: number;
  processName: string;
  usedMemoryMb: number;
  isManaged: boolean;
}

interface CudaAlert {
  type: string;
  severity: string;
  message: string;
  pid?: number;
  timestamp: number;
}

interface CudaSnapshot {
  timestamp: number;
  gpu: GpuInfo | null;
  processes: GpuProcess[];
  alerts: CudaAlert[];
}

interface CudaHistoryEntry {
  timestamp: number;
  memoryUsedMb: number;
  utilizationPercent: number;
  temperature: number;
  processCount: number;
}

interface ReaperAction {
  timestamp: number;
  targetPid: number;
  rule: string;
  reason: string;
  outcome: string;
  freedMemoryMb: number | null;
}

interface ReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  maxKillsPerWindow: number;
  windowMs: number;
  rules: Record<string, boolean>;
}

interface FenceStatus {
  activeModels: number;
  vramUsedMb: number;
  vramBudgetMb: number;
  isOverBudget: boolean;
  promptStartedAt: number | null;
  promptTimedOut: boolean;
  locked: boolean;
}

interface GuardianStatus {
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

// ── Helpers ──

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function statusDot(status: string): string {
  if (status === 'healthy') return 'bg-green-500';
  if (status === 'stale') return 'bg-yellow-400';
  if (status === 'zombie') return 'bg-red-500';
  if (status === 'killed') return 'bg-gray-500';
  return 'bg-gray-400';
}

function alertBorder(severity: string): string {
  if (severity === 'critical') return 'border-red-500';
  if (severity === 'warning') return 'border-amber-500';
  return 'border-blue-500';
}

function outcomeColor(outcome: string): string {
  if (outcome === 'killed') return 'text-red-400';
  if (outcome === 'dry-run') return 'text-amber-400';
  if (outcome === 'skipped-safety') return 'text-blue-400';
  return 'text-gray-400';
}

// ── Component ──

export function GuardianPanel() {
  const [status, setStatus] = useState<GuardianStatus | null>(null);
  const [guardianLog, setGuardianLog] = useState<string[]>([]);
  const [isKilling, setIsKilling] = useState<number | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, logRes] = await Promise.all([
        fetch('/api/guardian/status', { cache: 'no-store' }),
        fetch('/api/guardian/log', { cache: 'no-store' }),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (logRes.ok) {
        const payload = (await logRes.json()) as { logs: string[] };
        setGuardianLog(payload.logs ?? []);
      }
    } catch {
      // endpoint may not be available yet
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [guardianLog]);

  const handleKill = useCallback(async (pid: number) => {
    setIsKilling(pid);
    setActionResult(null);
    try {
      const res = await fetch('/api/guardian/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid }),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      setActionResult(data.message);
      fetchStatus();
    } catch {
      setActionResult(`Failed to kill PID ${pid}`);
    } finally {
      setIsKilling(null);
    }
  }, [fetchStatus]);

  const handleToggleDryRun = useCallback(async () => {
    if (!status) return;
    try {
      await fetch('/api/guardian/reaper/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: !status.reaper.config.dryRun }),
      });
      fetchStatus();
    } catch { /* ignore */ }
  }, [status, fetchStatus]);

  const handleToggleReaper = useCallback(async () => {
    if (!status) return;
    try {
      await fetch('/api/guardian/reaper/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !status.reaper.config.enabled }),
      });
      fetchStatus();
    } catch { /* ignore */ }
  }, [status, fetchStatus]);

  const handleResetFence = useCallback(async () => {
    try {
      await fetch('/api/guardian/fence/reset', { method: 'POST' });
      setActionResult('Fence reset.');
      fetchStatus();
    } catch {
      setActionResult('Failed to reset fence.');
    }
  }, [fetchStatus]);

  if (!status) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4">
        <p className="text-sm text-gray-400">Guardian daemon not available. Restart the dev server.</p>
      </div>
    );
  }

  const gpu = status.cuda.gpu;
  const gpuUtilizationPercent = gpu?.utilizationPercent ?? 0;
  const gpuTotalMemoryMb = gpu?.memoryTotalMb ?? 0;
  const vramPercent = gpu && gpu.memoryTotalMb > 0 ? Math.round((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100) : 0;
  const tempPercent = gpu ? Math.min(100, Math.round((gpu.temperature / 100) * 100)) : 0;
  const unmanagedGpuProcs = status.cuda.processes.filter((p) => !p.isManaged);
  const recentKills = status.reaper.recentActions.filter((a) => a.outcome === 'killed');

  // Sparkline for CUDA history
  const historyPath = status.cudaHistory.length >= 2
    ? status.cudaHistory.map((entry, i) => {
        const x = (i / Math.max(1, status.cudaHistory.length - 1)) * 280;
        const y = 40 - (entry.utilizationPercent / 100) * 40;
        return `${x},${y}`;
      }).join(' ')
    : '';
  const memoryHistoryPath = status.cudaHistory.length >= 2
    ? status.cudaHistory.map((entry, i) => {
        const x = (i / Math.max(1, status.cudaHistory.length - 1)) * 280;
        const totalMb = gpu?.memoryTotalMb ?? 16384;
        const y = 40 - (entry.memoryUsedMb / totalMb) * 40;
        return `${x},${y}`;
      }).join(' ')
    : '';
  const tempHistoryPath = status.cudaHistory.length >= 2
    ? status.cudaHistory.map((entry, i) => {
        const x = (i / Math.max(1, status.cudaHistory.length - 1)) * 280;
        const y = 40 - (entry.temperature / 100) * 40;
        return `${x},${y}`;
      }).join(' ')
    : '';

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">&#x1F6E1;&#xFE0F;</span>
          <p className="text-sm font-semibold text-white">Inference Guardian</p>
          <span className={`inline-block w-2 h-2 rounded-full ${status.enabled ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-gray-400">{status.enabled ? 'Active' : 'Stopped'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Uptime: {formatUptime(status.uptimeMs)}</span>
        </div>
      </div>

      {/* GPU Overview */}
      {gpu && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">GPU Memory</p>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-mono text-white">{gpu.memoryUsedMb}</span>
              <span className="text-[10px] text-gray-400">/ {gpu.memoryTotalMb} MB</span>
            </div>
            <div className="w-full h-1.5 rounded bg-gray-800 overflow-hidden">
              <div
                className={`h-full transition-all ${vramPercent > 90 ? 'bg-red-500' : vramPercent > 75 ? 'bg-amber-500' : 'bg-[#76b900]'}`}
                style={{ width: `${vramPercent}%` }}
              />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Utilization</p>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-mono text-white">{gpu.utilizationPercent}%</span>
            </div>
            <div className="w-full h-1.5 rounded bg-gray-800 overflow-hidden">
              <div className="h-full bg-[#84cc16] transition-all" style={{ width: `${gpu.utilizationPercent}%` }} />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Temperature</p>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-mono text-white">{gpu.temperature}°C</span>
            </div>
            <div className="w-full h-1.5 rounded bg-gray-800 overflow-hidden">
              <div
                className={`h-full transition-all ${gpu.temperature > 85 ? 'bg-red-500' : gpu.temperature > 75 ? 'bg-amber-500' : 'bg-cyan-500'}`}
                style={{ width: `${tempPercent}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* GPU name + sparkline */}
      {gpu && (
        <div className="space-y-1">
          <p className="text-xs text-gray-400">{gpu.name}</p>
          {status.cudaHistory.length >= 2 && (
            <svg viewBox="0 0 280 40" className="w-full h-10">
              <line x1="0" y1="0" x2="280" y2="0" stroke="#1f2937" strokeWidth="0.5" />
              <line x1="0" y1="20" x2="280" y2="20" stroke="#111827" strokeWidth="0.5" />
              <line x1="0" y1="40" x2="280" y2="40" stroke="#1f2937" strokeWidth="0.5" />
              <polyline points={memoryHistoryPath} fill="none" stroke="#f59e0b" strokeWidth="1.5" opacity="0.7" />
              <polyline points={historyPath} fill="none" stroke="#84cc16" strokeWidth="1.5" />
              <polyline points={tempHistoryPath} fill="none" stroke="#06b6d4" strokeWidth="1" opacity="0.5" />
            </svg>
          )}
          <div className="flex items-center gap-3 text-[10px] text-gray-500">
            <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 bg-[#84cc16] rounded-full" />Util</span>
            <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full" />VRAM</span>
            <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 bg-cyan-500 rounded-full" />Temp</span>
          </div>
        </div>
      )}

      {/* Alerts */}
      {status.cuda.alerts.length > 0 && (
        <div className="space-y-1">
          {status.cuda.alerts.map((alert, i) => (
            <div key={`alert-${i}`} className={`text-xs px-2 py-1 rounded border-l-2 ${alertBorder(alert.severity)} bg-black/30 text-gray-300`}>
              <span className="font-semibold uppercase text-[10px]">{alert.severity}</span>{' '}
              {alert.message}
            </div>
          ))}
        </div>
      )}

      {/* Managed Processes Table */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-white">Tracked Processes</p>
        {status.processes.length === 0 ? (
          <p className="text-xs text-gray-500">No Python processes detected.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-[10px] uppercase">
                  <th className="py-1 pr-2">PID</th>
                  <th className="py-1 pr-2">Role</th>
                  <th className="py-1 pr-2">CPU</th>
                  <th className="py-1 pr-2">GPU Util</th>
                  <th className="py-1 pr-2">RAM</th>
                  <th className="py-1 pr-2">VRAM</th>
                  <th className="py-1 pr-2">VRAM Util</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {status.processes.map((proc) => (
                  (() => {
                    const hasGpuUsage = (proc.gpuMemoryMb ?? 0) > 0;
                    const processGpuUtil = hasGpuUsage ? gpuUtilizationPercent : 0;
                    const processVramUtil = hasGpuUsage && gpuTotalMemoryMb > 0
                      ? Math.round(((proc.gpuMemoryMb ?? 0) / gpuTotalMemoryMb) * 100)
                      : 0;

                    return (
                  <tr key={proc.pid} className="border-b border-gray-800/50 text-gray-300">
                    <td className="py-1 pr-2 font-mono">{proc.pid}</td>
                    <td className="py-1 pr-2">{proc.role}</td>
                    <td className="py-1 pr-2 font-mono">{proc.cpuPercent}%</td>
                    <td className="py-1 pr-2 font-mono">{hasGpuUsage ? `${processGpuUtil}%` : '0%'}</td>
                    <td className="py-1 pr-2 font-mono">{proc.memoryMb.toFixed(0)} MB</td>
                    <td className="py-1 pr-2 font-mono">{proc.gpuMemoryMb !== null ? `${proc.gpuMemoryMb} MB` : '—'}</td>
                    <td className="py-1 pr-2 font-mono">{hasGpuUsage ? `${processVramUtil}%` : '0%'}</td>
                    <td className="py-1 pr-2">
                      <span className="flex items-center gap-1">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusDot(proc.status)}`} />
                        {proc.status}
                      </span>
                    </td>
                    <td className="py-1">
                      {proc.status !== 'healthy' && (
                        <button
                          onClick={() => handleKill(proc.pid)}
                          disabled={isKilling !== null}
                          className="px-2 py-0.5 text-[10px] bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white rounded transition-colors"
                        >
                          {isKilling === proc.pid ? '...' : 'Kill'}
                        </button>
                      )}
                    </td>
                  </tr>
                    );
                  })()
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Unmanaged GPU Processes */}
      {unmanagedGpuProcs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-amber-400">Unmanaged GPU Processes ({unmanagedGpuProcs.length})</p>
          {unmanagedGpuProcs.map((proc) => (
            <div key={proc.pid} className="flex items-center justify-between text-xs text-gray-300 px-2 py-1 bg-amber-900/20 rounded">
              <span>PID {proc.pid} — {proc.processName} — {proc.usedMemoryMb} MB VRAM</span>
              <button
                onClick={() => handleKill(proc.pid)}
                disabled={isKilling !== null}
                className="px-2 py-0.5 text-[10px] bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white rounded transition-colors"
              >
                Kill
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Fence Status */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-white">Inference Fence</p>
          <div className="text-xs text-gray-300 space-y-0.5">
            <p>Models: <span className="text-white font-mono">{status.fence.activeModels}</span> / 1 slot</p>
            <p>VRAM budget: <span className={`font-mono ${status.fence.isOverBudget ? 'text-red-400' : 'text-white'}`}>
              {status.fence.vramUsedMb} MB / {status.fence.vramBudgetMb} MB
            </span></p>
            <p>Locked: <span className="text-white">{status.fence.locked ? 'yes' : 'no'}</span></p>
            {status.fence.promptTimedOut && (
              <p className="text-red-400 font-semibold">Prompt processing timed out!</p>
            )}
          </div>
          <button
            onClick={handleResetFence}
            className="mt-1 px-2 py-0.5 text-[10px] bg-gray-800 hover:bg-gray-700 text-white rounded transition-colors"
          >
            Reset Fence
          </button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-white">Zombie Reaper</p>
          </div>
          <div className="text-xs text-gray-300 space-y-0.5">
            <p>Status: <span className="text-white">{status.reaper.config.enabled ? 'active' : 'disabled'}</span></p>
            <p>Mode: <span className={`font-mono ${status.reaper.config.dryRun ? 'text-amber-400' : 'text-green-400'}`}>
              {status.reaper.config.dryRun ? 'dry-run' : 'live'}
            </span></p>
            <p>Kills (window): <span className="text-white font-mono">{status.reaper.killsInWindow}</span> / {status.reaper.config.maxKillsPerWindow}</p>
          </div>
          <div className="flex gap-1 mt-1">
            <button
              onClick={handleToggleReaper}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                status.reaper.config.enabled
                  ? 'bg-red-800 hover:bg-red-700 text-white'
                  : 'bg-green-800 hover:bg-green-700 text-white'
              }`}
            >
              {status.reaper.config.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={handleToggleDryRun}
              className="px-2 py-0.5 text-[10px] bg-gray-800 hover:bg-gray-700 text-white rounded transition-colors"
            >
              {status.reaper.config.dryRun ? 'Go Live' : 'Dry Run'}
            </button>
          </div>
        </div>
      </div>

      {/* Reaper Action Log */}
      {status.reaper.recentActions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-white">Recent Reaper Actions ({recentKills.length} kills)</p>
          <div className="max-h-24 overflow-auto rounded border border-gray-800 bg-black/40 p-2 space-y-0.5">
            {status.reaper.recentActions.slice(-20).map((action, i) => (
              <p key={`action-${i}`} className={`text-[10px] font-mono ${outcomeColor(action.outcome)}`}>
                [{new Date(action.timestamp).toLocaleTimeString()}] [{action.rule}] PID {action.targetPid} → {action.outcome}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Action result */}
      {actionResult && (
        <p className="text-xs text-amber-300 bg-amber-900/20 px-2 py-1 rounded">{actionResult}</p>
      )}

      {/* Guardian Log */}
      <div className="space-y-1">
        <p className="text-xs font-semibold text-white">Guardian Log</p>
        <div
          ref={logRef}
          className="max-h-32 overflow-auto rounded border border-gray-800 bg-black/40 p-2 font-mono text-[10px] text-gray-400 space-y-0.5"
        >
          {guardianLog.length === 0 ? (
            <p className="text-gray-600">No events yet.</p>
          ) : (
            guardianLog.slice(-50).map((line, i) => <p key={`gl-${i}`}>{line}</p>)
          )}
        </div>
      </div>
    </div>
  );
}
