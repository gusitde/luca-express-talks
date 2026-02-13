import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceSelector } from './VoiceSelector';
import { GuardianPanel } from './GuardianPanel';
import { BackendMonitor } from './BackendMonitor';

interface BackendStatus {
  running: boolean;
  pid: number | null;
  phase: string;
  warmupProgress: number;
  modelLoaded: boolean;
  uptimeSec: number;
  hfTokenSet: boolean;
  logCount: number;
}

interface BackendLogsResponse {
  logs: string[];
  phase: string;
}

interface GpuStats {
  available: boolean;
  reason?: string;
  name?: string;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  utilizationGpu?: number;
  timestamp?: number;
}

interface GpuSample {
  timestamp: number;
  utilization: number;
  memoryPercent: number;
}

interface NetworkIpResponse {
  ip?: string;
}

interface MaintenancePageProps {
  serverUrl: string;
  voicePrompt: string;
  textPrompt: string;
  onChangeVoicePrompt: (value: string) => void;
  onChangeTextPrompt: (value: string) => void;
  onBack: () => void;
}

function getLocalUrlVariants(serverUrl: string, lanIp: string | null) {
  try {
    const parsed = new URL(serverUrl);
    const localhostUrl = new URL(parsed.toString());
    localhostUrl.hostname = 'localhost';

    const loopbackUrl = new URL(parsed.toString());
    loopbackUrl.hostname = '127.0.0.1';

    const lanUrl = new URL(parsed.toString());
    if (lanIp && lanIp.trim()) {
      lanUrl.hostname = lanIp.trim();
    }

    return {
      localhost: localhostUrl.toString(),
      loopback: loopbackUrl.toString(),
      lan: lanUrl.toString(),
    };
  } catch {
    return {
      localhost: serverUrl,
      loopback: serverUrl,
      lan: serverUrl,
    };
  }
}

export function MaintenancePage({
  serverUrl,
  voicePrompt,
  textPrompt,
  onChangeVoicePrompt,
  onChangeTextPrompt,
  onBack,
}: MaintenancePageProps) {
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendLogs, setBackendLogs] = useState<string[]>([]);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [gpuHistory, setGpuHistory] = useState<GpuSample[]>([]);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [isActionRunning, setIsActionRunning] = useState(false);
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  const loadAllDiagnostics = useCallback(async () => {
    try {
      const [statusResponse, logsResponse, gpuResponse, networkIpResponse] = await Promise.all([
        fetch('/api/diag/server/status', { cache: 'no-store' }),
        fetch('/api/diag/server/logs', { cache: 'no-store' }),
        fetch('/api/diag/gpu', { cache: 'no-store' }),
        fetch('/api/diag/network-ip', { cache: 'no-store' }),
      ]);

      const status = (await statusResponse.json()) as BackendStatus;
      const logsPayload = (await logsResponse.json()) as BackendLogsResponse;
      const gpu = (await gpuResponse.json()) as GpuStats;
      const network = (await networkIpResponse.json()) as NetworkIpResponse;
      setBackendStatus(status);
      setBackendLogs(logsPayload.logs ?? []);
      setGpuStats(gpu);
      setLanIp(network.ip?.trim() ? network.ip.trim() : null);

      if (gpu.available) {
        const usedMb = gpu.memoryUsedMb ?? 0;
        const totalMb = gpu.memoryTotalMb ?? 0;
        const memoryPercent = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;
        const utilization = Math.min(100, Math.max(0, gpu.utilizationGpu ?? 0));
        const timestamp = gpu.timestamp ?? Date.now();

        setGpuHistory((previous) => {
          const last = previous[previous.length - 1];
          if (last && last.timestamp === timestamp) {
            return previous;
          }

          const next = [...previous, { timestamp, utilization, memoryPercent }];
          return next.slice(-45);
        });
      }
    } catch {
      setBackendStatus(null);
      setBackendLogs([]);
      setGpuStats({ available: false, reason: 'diag-endpoint-unavailable' });
      setLanIp(null);
    }
  }, []);

  useEffect(() => {
    loadAllDiagnostics();
  }, [loadAllDiagnostics]);

  useEffect(() => {
    if (!isAutoRefresh) return;
    const interval = window.setInterval(loadAllDiagnostics, 2000);
    return () => window.clearInterval(interval);
  }, [isAutoRefresh, loadAllDiagnostics]);

  useEffect(() => {
    if (!logsContainerRef.current) return;
    logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
  }, [backendLogs]);

  const runBackendAction = useCallback(async (action: 'warmup' | 'dismount' | 'restart') => {
    setIsActionRunning(true);
    try {
      await fetch(`/api/diag/server/${action}`, { method: 'POST' });
      await loadAllDiagnostics();
    } finally {
      setIsActionRunning(false);
    }
  }, [loadAllDiagnostics]);

  const gpuPercent = useMemo(() => {
    if (!gpuStats?.available || !gpuStats.memoryTotalMb || gpuStats.memoryTotalMb <= 0) return 0;
    return Math.min(100, Math.round(((gpuStats.memoryUsedMb ?? 0) / gpuStats.memoryTotalMb) * 100));
  }, [gpuStats]);
  const serverUrlVariants = useMemo(() => getLocalUrlVariants(serverUrl, lanIp), [serverUrl, lanIp]);
  const modelLoaded = backendStatus?.modelLoaded ?? false;
  const warmupProgress = backendStatus?.warmupProgress ?? 0;
  const showWarmupProgress = (backendStatus?.running ?? false) && !modelLoaded;

  const utilizationPath = useMemo(() => {
    if (gpuHistory.length < 2) return '';
    const width = 280;
    const height = 64;
    return gpuHistory
      .map((sample, index) => {
        const x = (index / Math.max(1, gpuHistory.length - 1)) * width;
        const y = height - (sample.utilization / 100) * height;
        return `${x},${y}`;
      })
      .join(' ');
  }, [gpuHistory]);

  const memoryPath = useMemo(() => {
    if (gpuHistory.length < 2) return '';
    const width = 280;
    const height = 64;
    return gpuHistory
      .map((sample, index) => {
        const x = (index / Math.max(1, gpuHistory.length - 1)) * width;
        const y = height - (sample.memoryPercent / 100) * height;
        return `${x},${y}`;
      })
      .join(' ');
  }, [gpuHistory]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-6">
      <div className="w-full max-w-5xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="text-sm text-gray-400 hover:text-white transition-colors"
            aria-label="Back to launcher"
          >
            ← Back to launcher
          </button>
          <button
            onClick={loadAllDiagnostics}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded-md transition-colors"
          >
            Refresh now
          </button>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
          <div>
            <h1 className="text-3xl font-bold text-white">Maintenance & Settings</h1>
            <p className="text-gray-400 mt-1">Server controls, diagnostics, and startup defaults for Luca Express Talk.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-3">
              <p className="text-sm font-semibold text-white">Server lifecycle</p>
              <div className="flex flex-wrap gap-2">
                {!modelLoaded && (
                  <button
                    type="button"
                    onClick={() => runBackendAction('warmup')}
                    disabled={isActionRunning}
                    className="px-3 py-1 text-xs bg-[#76b900] hover:bg-[#5a8f00] disabled:opacity-50 text-white rounded-md transition-colors"
                  >
                    Warm Up Model
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => runBackendAction('restart')}
                  disabled={isActionRunning}
                  className="px-3 py-1 text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md transition-colors"
                >
                  Restart Server
                </button>
                {modelLoaded && (
                  <button
                    type="button"
                    onClick={() => runBackendAction('dismount')}
                    disabled={isActionRunning}
                    className="px-3 py-1 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-md transition-colors"
                  >
                    Dismount Model
                  </button>
                )}
              </div>
              <div className="rounded-md border border-gray-800 bg-black/40 p-3 text-xs text-gray-300 space-y-1">
                <p>Status: <span className="text-white">{backendStatus?.running ? 'running' : 'stopped'}</span></p>
                <p>Phase: <span className="text-white">{backendStatus?.phase ?? 'unknown'}</span></p>
                <p>Model loaded: <span className="text-white">{modelLoaded ? 'yes' : 'no'}</span></p>
                <p>Uptime: <span className="text-white">{backendStatus?.uptimeSec ?? 0}s</span></p>
                <p>PID: <span className="text-white">{backendStatus?.pid ?? 'n/a'}</span></p>
                <p>HF token in dev env: <span className="text-white">{backendStatus?.hfTokenSet ? 'yes' : 'no'}</span></p>
              </div>
              {showWarmupProgress && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-gray-300">
                    <span>Model warmup progress</span>
                    <span>{warmupProgress}%</span>
                  </div>
                  <div className="w-full h-2 rounded bg-gray-800 overflow-hidden">
                    <div className="h-full bg-[#76b900] transition-all duration-300" style={{ width: `${warmupProgress}%` }} />
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-3">
              <p className="text-sm font-semibold text-white">GPU diagnostics</p>
              {!gpuStats?.available ? (
                <p className="text-xs text-gray-400">GPU stats unavailable ({gpuStats?.reason ?? 'unknown'}).</p>
              ) : (
                <>
                  <p className="text-xs text-gray-300">{gpuStats.name}</p>
                  <p className="text-xs text-gray-300">
                    VRAM: {gpuStats.memoryUsedMb} MB / {gpuStats.memoryTotalMb} MB ({gpuPercent}%)
                  </p>
                  <div className="w-full h-2 rounded bg-gray-800 overflow-hidden">
                    <div className="h-full bg-[#76b900]" style={{ width: `${gpuPercent}%` }} />
                  </div>
                  <p className="text-xs text-gray-300">GPU utilization: {gpuStats.utilizationGpu}%</p>
                  <div className="rounded-md border border-gray-800 bg-black/40 p-2">
                    <div className="flex items-center justify-between mb-1 text-[10px] text-gray-400">
                      <span>History (last {gpuHistory.length} samples)</span>
                      <span>Utilization + VRAM%</span>
                    </div>
                    {gpuHistory.length < 2 ? (
                      <p className="text-[10px] text-gray-500">Collecting GPU samples...</p>
                    ) : (
                      <svg viewBox="0 0 280 64" className="w-full h-16">
                        <line x1="0" y1="0" x2="280" y2="0" stroke="#374151" strokeWidth="1" />
                        <line x1="0" y1="32" x2="280" y2="32" stroke="#1f2937" strokeWidth="1" />
                        <line x1="0" y1="64" x2="280" y2="64" stroke="#374151" strokeWidth="1" />
                        <polyline points={memoryPath} fill="none" stroke="#f59e0b" strokeWidth="2" />
                        <polyline points={utilizationPath} fill="none" stroke="#84cc16" strokeWidth="2" />
                      </svg>
                    )}
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
                      <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-[#84cc16] rounded-full" />Utilization</span>
                      <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-amber-500 rounded-full" />VRAM %</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500">Updated: {gpuStats.timestamp ? new Date(gpuStats.timestamp).toLocaleTimeString() : 'n/a'}</p>
                </>
              )}
            </div>
          </div>

          {/* Backend Process Monitor */}
          <BackendMonitor />

          <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white">Backend logs</p>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-300 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isAutoRefresh}
                    onChange={(e) => setIsAutoRefresh(e.target.checked)}
                  />
                  Auto refresh
                </label>
              </div>
            </div>
            <div
              ref={logsContainerRef}
              className="max-h-56 overflow-auto rounded-md border border-gray-800 bg-black/50 p-3 font-mono text-xs text-gray-300 space-y-1"
            >
              {backendLogs.length === 0 ? (
                <p className="text-gray-500">No backend logs yet.</p>
              ) : (
                backendLogs.map((line, index) => (
                  <p key={`${line}-${index}`}>{line}</p>
                ))
              )}
            </div>
          </div>

          {/* Inference Guardian */}
          <GuardianPanel />

          <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-3">
            <p className="text-sm font-semibold text-white">Startup settings</p>
            <p className="text-xs text-gray-400">These defaults are used when you press Start from Launcher.</p>

            <VoiceSelector value={voicePrompt} onChange={onChangeVoicePrompt} />

            <div>
              <label htmlFor="maintenance-system-prompt" className="block text-sm text-gray-400 mb-2">
                Default System Prompt
              </label>
              <textarea
                id="maintenance-system-prompt"
                value={textPrompt}
                onChange={(e) => onChangeTextPrompt(e.target.value)}
                rows={4}
                className="w-full bg-gray-950 text-white rounded-lg p-3 border border-gray-700 focus:border-[#76b900] focus:outline-none"
                placeholder="Describe Luca's behavior..."
              />
            </div>

            <div className="rounded-md border border-gray-800 bg-black/40 p-3 text-xs text-gray-300 space-y-1">
              <p>Server URL (active): <span className="text-white break-all">{serverUrl}</span></p>
              <p>Server URL (IP): <span className="text-white break-all">{serverUrlVariants.loopback}</span></p>
              <p>Server URL (LAN IP): <span className="text-white break-all">{serverUrlVariants.lan}</span></p>
              <p>Server URL (localhost): <span className="text-white break-all">{serverUrlVariants.localhost}</span></p>
              <p>Settings are applied immediately.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
