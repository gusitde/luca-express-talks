import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---- types ---- */

interface ConnectionRow {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  pid: number;
}

interface ProcessInfo {
  pid: number;
  workingSetMb: number;
  cpuSeconds: number;
  threads: number;
  handleCount: number;
  startTime: string;
}

interface ChildProcess {
  pid: number;
  name: string;
  workingSetMb: number;
}

interface ConnectionsPayload {
  backendPid: number | null;
  connections: ConnectionRow[];
  connectionCount: number;
  stateCounts: Record<string, number>;
  processInfo: ProcessInfo | null;
  childProcesses: ChildProcess[];
  timestamp: number;
  error?: string;
}

interface Snapshot {
  timestamp: number;
  established: number;
  closeWait: number;
  listen: number;
  timeWait: number;
  total: number;
  memoryMb: number;
}

const STATE_COLORS: Record<string, string> = {
  Listen: '#22d3ee',      // cyan
  Established: '#84cc16', // lime
  CloseWait: '#f87171',   // red
  TimeWait: '#facc15',    // yellow
  FinWait1: '#f59e0b',    // amber
  FinWait2: '#fb923c',    // orange
  SynSent: '#a78bfa',     // violet
  SynReceived: '#c084fc', // purple
  Closing: '#ef4444',     // red
  LastAck: '#e879f9',     // fuchsia
};

const MAX_HISTORY = 60;

/* ---- component ---- */

export function BackendMonitor() {
  const [data, setData] = useState<ConnectionsPayload | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [isPolling, setIsPolling] = useState(true);
  const [isKilling, setIsKilling] = useState(false);
  const [killResult, setKillResult] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      const response = await fetch('/api/diag/server/connections', { cache: 'no-store' });
      const payload = (await response.json()) as ConnectionsPayload;
      setData(payload);

      if (!payload.error) {
        const sc = payload.stateCounts;
        setHistory((prev) => {
          const snap: Snapshot = {
            timestamp: payload.timestamp,
            established: sc['Established'] ?? sc['2'] ?? 0,
            closeWait: sc['CloseWait'] ?? sc['8'] ?? 0,
            listen: sc['Listen'] ?? sc['1'] ?? 0,
            timeWait: sc['TimeWait'] ?? sc['4'] ?? 0,
            total: payload.connectionCount,
            memoryMb: payload.processInfo?.workingSetMb ?? 0,
          };
          // skip dups
          const last = prev[prev.length - 1];
          if (last && last.timestamp === snap.timestamp) return prev;
          return [...prev, snap].slice(-MAX_HISTORY);
        });
      }
    } catch {
      // endpoint may not exist yet
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    if (!isPolling) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = window.setInterval(fetchConnections, 3000);
    return () => {
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    };
  }, [isPolling, fetchConnections]);

  const killZombies = useCallback(async () => {
    setIsKilling(true);
    setKillResult(null);
    try {
      const response = await fetch('/api/diag/server/kill-zombies', { method: 'POST' });
      const result = (await response.json()) as { ok: boolean; zombieCount?: number; action?: string; error?: string };
      if (result.ok) {
        setKillResult(`Cleared ${result.zombieCount ?? 0} zombies (${result.action})`);
      } else {
        setKillResult(`Error: ${result.error ?? 'unknown'}`);
      }
      await fetchConnections();
    } catch (err) {
      setKillResult(`Failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setIsKilling(false);
    }
  }, [fetchConnections]);

  /* ---- derived ---- */

  const sc = data?.stateCounts ?? {};
  const established = sc['Established'] ?? sc['2'] ?? 0;
  const closeWait = sc['CloseWait'] ?? sc['8'] ?? 0;
  const listen = sc['Listen'] ?? sc['1'] ?? 0;
  const timeWait = sc['TimeWait'] ?? sc['4'] ?? 0;
  const totalConns = data?.connectionCount ?? 0;
  const hasZombies = closeWait > 0;
  const healthColor = closeWait > 5 ? '#ef4444' : closeWait > 0 ? '#f59e0b' : established > 10 ? '#f59e0b' : '#22c55e';
  const healthLabel = closeWait > 5 ? 'Unhealthy' : closeWait > 0 ? 'Degraded' : established > 10 ? 'Busy' : 'Healthy';

  /* ---- sparkline SVG ---- */

  const sparkWidth = 280;
  const sparkHeight = 48;

  const makePath = useCallback((accessor: (s: Snapshot) => number, maxVal: number) => {
    if (history.length < 2) return '';
    const clampMax = maxVal > 0 ? maxVal : 1;
    return history
      .map((s, i) => {
        const x = (i / Math.max(1, history.length - 1)) * sparkWidth;
        const y = sparkHeight - (Math.min(accessor(s), clampMax) / clampMax) * sparkHeight;
        return `${x},${y}`;
      })
      .join(' ');
  }, [history]);

  const maxConn = useMemo(() => Math.max(4, ...history.map((s) => s.total)), [history]);
  const establishedPath = makePath((s) => s.established, maxConn);
  const closeWaitPath = makePath((s) => s.closeWait, maxConn);
  const totalPath = makePath((s) => s.total, maxConn);

  const maxMem = useMemo(() => Math.max(100, ...history.map((s) => s.memoryMb)), [history]);
  const memoryPath = makePath((s) => s.memoryMb, maxMem);

  /* ---- state breakdown bar ---- */

  const stateEntries = useMemo(() => {
    if (!data?.stateCounts) return [];
    return Object.entries(data.stateCounts)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a);
  }, [data]);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-4">
      {/* header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold text-white">Backend Process Monitor</p>
          <span
            className="inline-block w-2 h-2 rounded-full animate-pulse"
            style={{ backgroundColor: healthColor }}
            title={healthLabel}
          />
          <span className="text-[10px] font-medium" style={{ color: healthColor }}>{healthLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-gray-400 flex items-center gap-1">
            <input
              type="checkbox"
              checked={isPolling}
              onChange={(e) => setIsPolling(e.target.checked)}
              className="accent-[#76b900]"
            />
            Auto-poll
          </label>
          <button
            onClick={fetchConnections}
            className="px-2 py-0.5 text-[10px] bg-gray-800 hover:bg-gray-700 text-white rounded transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* summary counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <CounterCard label="Total Conns" value={totalConns} color="#94a3b8" />
        <CounterCard label="Listening" value={listen} color="#22d3ee" />
        <CounterCard label="Established" value={established} color="#84cc16" />
        <CounterCard label="CloseWait" value={closeWait} color={closeWait > 0 ? '#f87171' : '#6b7280'} />
        <CounterCard label="TimeWait" value={timeWait} color="#facc15" />
        <CounterCard label="PID" value={data?.backendPid ?? 'n/a'} color="#94a3b8" />
      </div>

      {/* state breakdown bar */}
      {totalConns > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-gray-400">Connection states</p>
          <div className="flex h-3 w-full rounded overflow-hidden">
            {stateEntries.map(([state, count]) => (
              <div
                key={state}
                style={{
                  width: `${(count / totalConns) * 100}%`,
                  backgroundColor: STATE_COLORS[state] ?? '#6b7280',
                }}
                title={`${state}: ${count}`}
                className="transition-all duration-300"
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400">
            {stateEntries.map(([state, count]) => (
              <span key={state} className="flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ backgroundColor: STATE_COLORS[state] ?? '#6b7280' }}
                />
                {state}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* sparkline chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-md border border-gray-800 bg-black/40 p-2">
          <p className="text-[10px] text-gray-400 mb-1">Connection history ({history.length} samples)</p>
          {history.length < 2 ? (
            <p className="text-[10px] text-gray-500">Collecting samples...</p>
          ) : (
            <svg viewBox={`0 0 ${sparkWidth} ${sparkHeight}`} className="w-full h-12">
              <line x1="0" y1={sparkHeight} x2={sparkWidth} y2={sparkHeight} stroke="#374151" strokeWidth="0.5" />
              <line x1="0" y1={sparkHeight / 2} x2={sparkWidth} y2={sparkHeight / 2} stroke="#1f2937" strokeWidth="0.5" />
              <polyline points={totalPath} fill="none" stroke="#94a3b8" strokeWidth="1.5" opacity="0.4" />
              <polyline points={establishedPath} fill="none" stroke="#84cc16" strokeWidth="1.5" />
              <polyline points={closeWaitPath} fill="none" stroke="#f87171" strokeWidth="1.5" />
            </svg>
          )}
          <div className="flex gap-3 mt-0.5 text-[10px] text-gray-500">
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-[#84cc16]" />Established</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-[#f87171]" />CloseWait</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-[#94a3b8] opacity-40" />Total</span>
          </div>
        </div>

        <div className="rounded-md border border-gray-800 bg-black/40 p-2">
          <p className="text-[10px] text-gray-400 mb-1">Process memory ({data?.processInfo?.workingSetMb ?? 0} MB)</p>
          {history.length < 2 ? (
            <p className="text-[10px] text-gray-500">Collecting samples...</p>
          ) : (
            <svg viewBox={`0 0 ${sparkWidth} ${sparkHeight}`} className="w-full h-12">
              <line x1="0" y1={sparkHeight} x2={sparkWidth} y2={sparkHeight} stroke="#374151" strokeWidth="0.5" />
              <line x1="0" y1={sparkHeight / 2} x2={sparkWidth} y2={sparkHeight / 2} stroke="#1f2937" strokeWidth="0.5" />
              <polyline points={memoryPath} fill="none" stroke="#38bdf8" strokeWidth="1.5" />
            </svg>
          )}
          <div className="flex gap-3 mt-0.5 text-[10px] text-gray-500">
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-[#38bdf8]" />Working Set</span>
          </div>
        </div>
      </div>

      {/* process details */}
      {data?.processInfo && (
        <div className="rounded-md border border-gray-800 bg-black/40 p-3 text-xs text-gray-300 space-y-1">
          <p className="text-[10px] text-gray-400 font-semibold mb-1">Process details</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-1">
            <p>PID: <span className="text-white">{data.processInfo.pid}</span></p>
            <p>Memory: <span className="text-white">{data.processInfo.workingSetMb} MB</span></p>
            <p>CPU time: <span className="text-white">{data.processInfo.cpuSeconds}s</span></p>
            <p>Threads: <span className="text-white">{data.processInfo.threads}</span></p>
            <p>Handles: <span className="text-white">{data.processInfo.handleCount}</span></p>
            <p>Started: <span className="text-white">{data.processInfo.startTime ? new Date(data.processInfo.startTime).toLocaleTimeString() : 'n/a'}</span></p>
          </div>
        </div>
      )}

      {/* child processes */}
      {data?.childProcesses && data.childProcesses.length > 0 && (
        <div className="rounded-md border border-gray-800 bg-black/40 p-3 text-xs text-gray-300 space-y-1">
          <p className="text-[10px] text-gray-400 font-semibold mb-1">Child processes ({data.childProcesses.length})</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {data.childProcesses.map((cp) => (
              <p key={cp.pid}>
                <span className="text-gray-500">PID {cp.pid}</span>{' '}
                <span className="text-white">{cp.name}</span>{' '}
                <span className="text-gray-400">({cp.workingSetMb} MB)</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {/* zombie action + connection table */}
      <div className="flex items-center gap-3">
        {hasZombies && (
          <button
            onClick={killZombies}
            disabled={isKilling}
            className="px-3 py-1 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            {isKilling ? 'Clearing...' : `Clear ${closeWait} Zombie Connection${closeWait !== 1 ? 's' : ''}`}
          </button>
        )}
        {killResult && <span className="text-[10px] text-gray-400">{killResult}</span>}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto px-2 py-0.5 text-[10px] bg-gray-800 hover:bg-gray-700 text-white rounded transition-colors"
        >
          {expanded ? 'Hide' : 'Show'} connection table
        </button>
      </div>

      {/* expanded connection table */}
      {expanded && data?.connections && (
        <div className="max-h-48 overflow-auto rounded-md border border-gray-800 bg-black/50">
          <table className="w-full text-[11px] text-gray-300">
            <thead className="bg-gray-900 sticky top-0">
              <tr>
                <th className="text-left px-2 py-1 font-medium text-gray-400">Local</th>
                <th className="text-left px-2 py-1 font-medium text-gray-400">Remote</th>
                <th className="text-left px-2 py-1 font-medium text-gray-400">State</th>
                <th className="text-left px-2 py-1 font-medium text-gray-400">PID</th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((conn, i) => {
                const stateColor = STATE_COLORS[conn.state] ?? '#6b7280';
                return (
                  <tr key={`${conn.remoteAddress}:${conn.remotePort}-${i}`} className="border-t border-gray-800/50 hover:bg-gray-900/50">
                    <td className="px-2 py-0.5 font-mono">{conn.localAddress}:{conn.localPort}</td>
                    <td className="px-2 py-0.5 font-mono">{conn.remoteAddress}:{conn.remotePort}</td>
                    <td className="px-2 py-0.5">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stateColor }} />
                        {conn.state}
                      </span>
                    </td>
                    <td className="px-2 py-0.5 font-mono">{conn.pid}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* last update */}
      <p className="text-[10px] text-gray-600 text-right">
        Last updated: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : 'never'}
      </p>
    </div>
  );
}

/* ---- helper components ---- */

function CounterCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-md border border-gray-800 bg-black/40 px-3 py-2 text-center">
      <p className="text-[10px] text-gray-500">{label}</p>
      <p className="text-lg font-bold tabular-nums" style={{ color }}>{value}</p>
    </div>
  );
}
