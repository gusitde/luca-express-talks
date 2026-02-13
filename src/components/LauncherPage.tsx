import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceSelector } from './VoiceSelector';

interface LauncherPageProps {
  serverUrl: string;
  serverUrlSource: 'env' | 'proxy';
  defaultVoicePrompt: string;
  defaultTextPrompt: string;
  onOpenMaintenance: () => void;
  onStart: (config: { voicePrompt: string; textPrompt: string }) => void;
}

type PreflightStatus = 'pending' | 'running' | 'pass' | 'fail';
type PreflightKey = 'secureContext' | 'microphonePermission' | 'serverReachability' | 'websocketHandshake';

interface PreflightCheck {
  key: PreflightKey;
  label: string;
  status: PreflightStatus;
  message: string;
}

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

const DEFAULT_CHECKS: PreflightCheck[] = [
  {
    key: 'secureContext',
    label: 'Browser audio prerequisites',
    status: 'pending',
    message: 'Waiting to run...',
  },
  {
    key: 'microphonePermission',
    label: 'Microphone permission',
    status: 'pending',
    message: 'Waiting to run...',
  },
  {
    key: 'serverReachability',
    label: 'PersonaPlex server reachability',
    status: 'pending',
    message: 'Waiting to run...',
  },
  {
    key: 'websocketHandshake',
    label: 'WebSocket handshake',
    status: 'pending',
    message: 'Waiting to run...',
  },
];

function getCheckDotClass(status: PreflightStatus) {
  if (status === 'pass') return 'bg-green-500';
  if (status === 'fail') return 'bg-red-500';
  if (status === 'running') return 'bg-yellow-400';
  return 'bg-gray-500';
}

function toServerRootUrl(serverUrl: string) {
  const parsed = new URL(serverUrl);
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${parsed.host}`;
}

function toDirectBackendWsUrl(serverUrl: string) {
  const direct = new URL(serverUrl);
  direct.protocol = 'ws:';
  direct.hostname = '127.0.0.1';
  direct.port = '8998';
  direct.pathname = '/api/chat';
  return direct.toString();
}

function toDiagnosticHost(serverUrl: string) {
  const parsed = new URL(serverUrl);
  if (parsed.hostname !== 'localhost') return parsed.host;

  const currentHost = window.location.hostname;
  const mappedHost = currentHost && currentHost !== 'localhost' ? currentHost : '127.0.0.1';
  return parsed.port ? `${mappedHost}:${parsed.port}` : mappedHost;
}

export function LauncherPage({ serverUrl, serverUrlSource, defaultVoicePrompt, defaultTextPrompt, onOpenMaintenance, onStart }: LauncherPageProps) {
  const [voicePrompt, setVoicePrompt] = useState(defaultVoicePrompt);
  const [textPrompt, setTextPrompt] = useState(defaultTextPrompt);
  const [checks, setChecks] = useState<PreflightCheck[]>(DEFAULT_CHECKS);
  const [isRunningPreflight, setIsRunningPreflight] = useState(false);
  const [preflightLogs, setPreflightLogs] = useState<string[]>([]);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendLogs, setBackendLogs] = useState<string[]>([]);
  const [isBackendActionRunning, setIsBackendActionRunning] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);
  const backendLogsContainerRef = useRef<HTMLDivElement | null>(null);
  const hasAutoRunRef = useRef(false);
  const preflightRunIdRef = useRef(0);
  const activeWsRef = useRef<WebSocket | null>(null);

  const appendLog = useCallback((entry: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setPreflightLogs((previous) => {
      const next = [...previous, `[${timestamp}] ${entry}`];
      return next.slice(-200);
    });
  }, []);

  useEffect(() => {
    if (!logsContainerRef.current) return;
    logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
  }, [preflightLogs]);

  useEffect(() => {
    if (!backendLogsContainerRef.current) return;
    backendLogsContainerRef.current.scrollTop = backendLogsContainerRef.current.scrollHeight;
  }, [backendLogs]);

  const loadBackendDiagnostics = useCallback(async () => {
    try {
      const [statusResponse, logsResponse] = await Promise.all([
        fetch('/api/diag/server/status', { cache: 'no-store' }),
        fetch('/api/diag/server/logs', { cache: 'no-store' }),
      ]);

      const status = (await statusResponse.json()) as BackendStatus;
      const logsPayload = (await logsResponse.json()) as BackendLogsResponse;
      setBackendStatus(status);
      setBackendLogs(logsPayload.logs ?? []);
    } catch {
      setBackendStatus(null);
      setBackendLogs([]);
    }
  }, []);

  useEffect(() => {
    loadBackendDiagnostics();
    const interval = window.setInterval(loadBackendDiagnostics, 2000);
    return () => window.clearInterval(interval);
  }, [loadBackendDiagnostics]);

  const runBackendAction = useCallback(async (action: 'warmup' | 'dismount' | 'restart') => {
    setIsBackendActionRunning(true);
    try {
      await fetch(`/api/diag/server/${action}`, { method: 'POST' });
      await loadBackendDiagnostics();
    } finally {
      setIsBackendActionRunning(false);
    }
  }, [loadBackendDiagnostics]);

  const updateCheck = useCallback((key: PreflightKey, status: PreflightStatus, message: string) => {
    setChecks((previous) => previous.map((check) => (
      check.key === key ? { ...check, status, message } : check
    )));
  }, []);

  const runPreflight = useCallback(async () => {
    preflightRunIdRef.current += 1;
    const runId = preflightRunIdRef.current;

    if (activeWsRef.current) {
      appendLog('INFO closing previous preflight websocket');
      activeWsRef.current.close();
      activeWsRef.current = null;
    }

    setChecks(DEFAULT_CHECKS);
    setIsRunningPreflight(true);
    appendLog(`INFO preflight started (run=${runId})`);
    const diagnosticHost = toDiagnosticHost(serverUrl);
    appendLog(
      `INFO websocket URL source=${serverUrlSource === 'env' ? 'env (VITE_SERVER_URL)' : 'proxy default (/api/chat)'} host=${diagnosticHost}`,
    );

    const isStaleRun = () => runId !== preflightRunIdRef.current;
    const stopIfStale = () => {
      if (!isStaleRun()) return false;
      appendLog(`INFO preflight run=${runId} cancelled (newer run started)`);
      setIsRunningPreflight(false);
      return true;
    };

    updateCheck('secureContext', 'running', 'Checking browser capabilities...');
    appendLog('SEND check browser audio prerequisites');
    const hasAudioApi = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    const isSecure = typeof window !== 'undefined' && window.isSecureContext;
    if (stopIfStale()) return;
    if (!hasAudioApi || !isSecure) {
      const reason = !hasAudioApi
        ? 'Browser does not support microphone capture API.'
        : 'Secure context required (use https://localhost or localhost).';
      updateCheck('secureContext', 'fail', reason);
      appendLog(`RECV browser prerequisites fail: ${reason}`);
      updateCheck('microphonePermission', 'fail', 'Blocked because browser prerequisites failed.');
      updateCheck('serverReachability', 'pending', 'Skipped due to previous failure.');
      updateCheck('websocketHandshake', 'pending', 'Skipped due to previous failure.');
      appendLog(`INFO preflight finished with failure (run=${runId})`);
      setIsRunningPreflight(false);
      return;
    }
    updateCheck('secureContext', 'pass', 'Browser audio APIs are available.');
    appendLog('RECV browser prerequisites pass');

    updateCheck('microphonePermission', 'running', 'Checking permission state...');
    appendLog('SEND query microphone permission');
    try {
      if ('permissions' in navigator && navigator.permissions?.query) {
        const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (stopIfStale()) return;
        if (permission.state === 'denied') {
          updateCheck('microphonePermission', 'fail', 'Microphone permission is denied in browser settings.');
          appendLog('RECV microphone permission denied');
          updateCheck('serverReachability', 'pending', 'Skipped due to previous failure.');
          updateCheck('websocketHandshake', 'pending', 'Skipped due to previous failure.');
          appendLog(`INFO preflight finished with failure (run=${runId})`);
          setIsRunningPreflight(false);
          return;
        }
        if (permission.state === 'prompt') {
          updateCheck('microphonePermission', 'pass', 'Permission will be requested when connecting.');
          appendLog('RECV microphone permission prompt');
        } else {
          updateCheck('microphonePermission', 'pass', 'Microphone permission is granted.');
          appendLog('RECV microphone permission granted');
        }
      } else {
        updateCheck('microphonePermission', 'pass', 'Permission API unavailable; browser will prompt on connect.');
        appendLog('RECV microphone permission API unavailable (treated as pass)');
      }
    } catch {
      updateCheck('microphonePermission', 'pass', 'Permission check skipped; browser will prompt on connect.');
      appendLog('RECV microphone permission check error (treated as pass)');
    }

    updateCheck('serverReachability', 'running', 'Checking server reachability...');
    try {
      const rootUrl = toServerRootUrl(serverUrl);
      const warmupWindowMs = 60000;
      const startedAt = Date.now();
      let attempt = 0;
      let reachable = false;
      let servingReady = false;
      let usedDiagStatus = false;

      appendLog(`SEND reachability probe ${rootUrl}`);

      const tryDiagnosticStatus = async () => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 3000);
        try {
          const response = await fetch('/api/diag/server/status', {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok) return false;
          const payload = (await response.json()) as Partial<BackendStatus>;
          usedDiagStatus = true;

          const running = Boolean(payload?.running);
          const modelLoaded = Boolean(payload?.modelLoaded);
          const phase = (payload?.phase ?? '').toLowerCase();
          servingReady = modelLoaded || phase === 'serving';
          return running;
        } catch {
          return false;
        } finally {
          window.clearTimeout(timeoutId);
        }
      };

      while (!reachable && Date.now() - startedAt < warmupWindowMs) {
        attempt += 1;
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = Math.max(0, warmupWindowMs - elapsedMs);
        if (attempt > 1) {
          updateCheck(
            'serverReachability',
            'running',
            `Server warming up... retrying HTTPS (${attempt}) with ${Math.ceil(remainingMs / 1000)}s left.`,
          );
          appendLog(`INFO server warming up - retry ${attempt}, ${Math.ceil(remainingMs / 1000)}s remaining`);
        }

        const diagnosticsReachable = await tryDiagnosticStatus();
        if (diagnosticsReachable) {
          if (servingReady) {
            reachable = true;
            break;
          }

          updateCheck(
            'serverReachability',
            'running',
            `Server process is up but model still warming (${attempt}); waiting for serving state...`,
          );
          appendLog('INFO backend running but not yet serving; waiting before websocket test');
          if (Date.now() - startedAt >= warmupWindowMs) {
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          continue;
        }

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 10000);
        try {
          await fetch(rootUrl, { method: 'GET', cache: 'no-store', mode: 'no-cors', signal: controller.signal });
          reachable = true;
        } catch {
          if (stopIfStale()) return;
          if (Date.now() - startedAt >= warmupWindowMs) {
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
        } finally {
          window.clearTimeout(timeoutId);
        }
      }

      if (!reachable) {
        throw new Error('https-reachability-timeout');
      }

      if (stopIfStale()) return;
      updateCheck('serverReachability', 'pass', `Server responded at ${rootUrl}.`);
      appendLog(usedDiagStatus
        ? 'RECV server ready (serving) via /api/diag/server/status'
        : `RECV HTTPS reachable at ${rootUrl}`);
    } catch {
      updateCheck('serverReachability', 'fail', 'Cannot reach server after warmup window. Verify server is running and TLS certificate is accepted.');
      appendLog('RECV HTTPS reachability failed after warmup retries');
      updateCheck('websocketHandshake', 'pending', 'Skipped due to previous failure.');
      appendLog(`INFO preflight finished with failure (run=${runId})`);
      setIsRunningPreflight(false);
      return;
    }

    updateCheck('websocketHandshake', 'running', 'Testing websocket connection...');
    appendLog('SEND WebSocket CONNECT /api/chat?...');
    try {
      const tryHandshake = (baseUrl: string, label: string) => new Promise<void>((resolve, reject) => {
        const wsUrl = new URL(baseUrl);
        wsUrl.searchParams.set('voice_prompt', (voicePrompt || 'NATF2.pt').trim());
        wsUrl.searchParams.set('audio_format', 'pcm_f32');
        wsUrl.searchParams.set('text_prompt', textPrompt.trim());
        appendLog(`SEND WebSocket URL ${wsUrl.toString()} (${label})`);

        let settled = false;
        let opened = false;
        const ws = new WebSocket(wsUrl.toString());
        activeWsRef.current = ws;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          appendLog(`RECV WebSocket timeout while waiting for open (${label})`);
          reject(new Error('timeout'));
        }, 8000);

        ws.onopen = () => {
          if (stopIfStale()) {
            ws.close();
            return;
          }
          if (settled) return;
          opened = true;
          settled = true;
          window.clearTimeout(timeoutId);
          appendLog(`RECV WebSocket open (${label})`);
          appendLog('SEND WebSocket close preflight-ok');
          ws.close(1000, 'preflight-ok');
          resolve();
        };

        ws.onerror = () => {
          if (stopIfStale()) {
            ws.close();
            return;
          }
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          appendLog(`RECV WebSocket error event (${label})`);
          reject(new Error('ws-error'));
        };

        ws.onclose = (event) => {
          if (activeWsRef.current === ws) {
            activeWsRef.current = null;
          }
          if (stopIfStale()) return;
          if (settled || opened) return;
          settled = true;
          window.clearTimeout(timeoutId);
          appendLog(`RECV WebSocket close code=${event.code} reason=${event.reason || 'none'} (${label})`);
          reject(new Error(`ws-closed-before-open:${event.code}`));
        };
      });

      const directBackendUrl = toDirectBackendWsUrl(serverUrl);
      try {
        await tryHandshake(serverUrl, 'proxy');
      } catch (firstError) {
        appendLog('INFO proxy websocket handshake failed, trying direct backend URL');
        await tryHandshake(directBackendUrl, 'direct-backend');
      }
      updateCheck('websocketHandshake', 'pass', 'Realtime endpoint is ready.');
      appendLog('RECV WebSocket handshake pass');
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown-error';
      if (reason === 'timeout') {
        updateCheck(
          'websocketHandshake',
          'pass',
          'Handshake probe timed out, but startup can continue. Live connect will retry and wait for server readiness.',
        );
        appendLog('WARN preflight websocket probe timed out; allowing startup and deferring to live connect retries');
        appendLog(`INFO preflight finished with success (run=${runId})`);
        setIsRunningPreflight(false);
        return;
      }

      const reasonMap: Record<string, string> = {
        timeout: 'WebSocket timeout. Model may still be loading or server is busy.',
        'ws-error': 'WebSocket error. Check TLS certificate trust and endpoint path.',
      };
      const knownReason = reasonMap[reason];
      updateCheck(
        'websocketHandshake',
        'fail',
        knownReason ?? `WebSocket closed before open (${reason}). Check server logs for query/voice prompt errors.`,
      );
      appendLog(`RECV WebSocket handshake failed: ${reason}`);
      appendLog(`INFO preflight finished with failure (run=${runId})`);
      setIsRunningPreflight(false);
      return;
    }

    appendLog(`INFO preflight finished with success (run=${runId})`);
    setIsRunningPreflight(false);
  }, [appendLog, serverUrl, textPrompt, updateCheck, voicePrompt]);

  const restartAndRecheck = useCallback(async () => {
    appendLog('INFO restart + preflight requested');
    await runBackendAction('restart');
    await runPreflight();
  }, [appendLog, runBackendAction, runPreflight]);

  useEffect(() => {
    if (hasAutoRunRef.current) return;
    hasAutoRunRef.current = true;
    runPreflight();
  }, [runPreflight]);

  useEffect(() => {
    return () => {
      if (activeWsRef.current) {
        activeWsRef.current.close();
        activeWsRef.current = null;
      }
    };
  }, []);

  const allChecksPassed = useMemo(
    () => checks.length > 0 && checks.every((check) => check.status === 'pass'),
    [checks],
  );

  const isStartDisabled = isRunningPreflight || !allChecksPassed || !textPrompt.trim();
  const modelLoaded = backendStatus?.modelLoaded ?? false;
  const warmupProgress = backendStatus?.warmupProgress ?? 0;
  const showWarmupProgress = (backendStatus?.running ?? false) && !modelLoaded;

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6">
      <div className="w-full max-w-xl bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">Luca Express Talk</h1>
          <p className="text-gray-400 mt-2">Choose a voice, set the initial system prompt, then start.</p>
          <div className="mt-3">
            <button
              type="button"
              onClick={onOpenMaintenance}
              className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded-md transition-colors"
            >
              Open Maintenance & Settings
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Model control</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={loadBackendDiagnostics}
                disabled={isBackendActionRunning}
                className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                Refresh
              </button>
              {!modelLoaded && (
                <button
                  type="button"
                  onClick={() => runBackendAction('warmup')}
                  disabled={isBackendActionRunning}
                  className="px-3 py-1 text-xs bg-[#76b900] hover:bg-[#5a8f00] disabled:opacity-50 text-white rounded-md transition-colors"
                >
                  Warm Up Model
                </button>
              )}
              <button
                type="button"
                onClick={() => runBackendAction('restart')}
                disabled={isBackendActionRunning}
                className="px-3 py-1 text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                Restart Server
              </button>
              {modelLoaded && (
                <button
                  type="button"
                  onClick={() => runBackendAction('dismount')}
                  disabled={isBackendActionRunning}
                  className="px-3 py-1 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-md transition-colors"
                >
                  Dismount Model
                </button>
              )}
            </div>
          </div>

          <div className="rounded-md border border-gray-800 bg-black/40 p-3 text-xs text-gray-300 space-y-1">
            <p>Status: <span className="text-white">{backendStatus?.running ? 'running' : 'stopped'}</span></p>
            <p>Phase: <span className="text-white">{backendStatus?.phase ?? 'unknown'}</span></p>
            <p>Model loaded: <span className="text-white">{modelLoaded ? 'yes' : 'no'}</span></p>
            <p>Uptime: <span className="text-white">{backendStatus?.uptimeSec ?? 0}s</span></p>
            <p>HF token in dev server env: <span className="text-white">{backendStatus?.hfTokenSet ? 'yes' : 'no'}</span></p>
            <p>PID: <span className="text-white">{backendStatus?.pid ?? 'n/a'}</span></p>
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

          <div>
            <p className="text-sm font-semibold text-white mb-2">Warmup streaming status</p>
            <div
              ref={backendLogsContainerRef}
              className="max-h-44 overflow-auto rounded-md border border-gray-800 bg-black/50 p-3 font-mono text-xs text-gray-300 space-y-1"
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
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Preflight status</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={restartAndRecheck}
                disabled={isRunningPreflight || isBackendActionRunning}
                className="px-3 py-1 text-xs bg-[#76b900] hover:bg-[#5a8f00] disabled:opacity-50 text-white rounded-md transition-colors"
              >
                Restart + Recheck
              </button>
              <button
                type="button"
                onClick={() => runBackendAction('restart')}
                disabled={isRunningPreflight || isBackendActionRunning}
                className="px-3 py-1 text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                Restart server
              </button>
              <button
                type="button"
                onClick={() => setPreflightLogs([])}
                className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded-md transition-colors"
              >
                Clear logs
              </button>
              <button
                type="button"
                onClick={runPreflight}
                disabled={isRunningPreflight}
                className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {isRunningPreflight ? 'Checking...' : 'Run checks again'}
              </button>
            </div>
          </div>

          <ul className="space-y-2">
            {checks.map((check) => (
              <li key={check.key} className="text-sm">
                <div className="flex items-center gap-2 text-white">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${getCheckDotClass(check.status)}`} />
                  <span>{check.label}</span>
                </div>
                <p className="text-xs text-gray-400 ml-4 mt-1">{check.message}</p>
              </li>
            ))}
          </ul>

          <p className="text-xs text-gray-500">
            Server-side checks like HF token and GPU memory are still validated in your server shell startup.
          </p>

          <div>
            <p className="text-sm font-semibold text-white mb-2">Live logs</p>
            <div
              ref={logsContainerRef}
              className="max-h-44 overflow-auto rounded-md border border-gray-800 bg-black/50 p-3 font-mono text-xs text-gray-300 space-y-1"
            >
              {preflightLogs.length === 0 ? (
                <p className="text-gray-500">No logs yet.</p>
              ) : (
                preflightLogs.map((log, index) => (
                  <p key={`${log}-${index}`}>{log}</p>
                ))
              )}
            </div>
          </div>
        </div>

        <VoiceSelector value={voicePrompt} onChange={setVoicePrompt} />

        <div>
          <label htmlFor="launcher-system-prompt" className="block text-sm text-gray-400 mb-2">
            Initial System Prompt
          </label>
          <textarea
            id="launcher-system-prompt"
            value={textPrompt}
            onChange={(e) => setTextPrompt(e.target.value)}
            rows={4}
            className="w-full bg-gray-950 text-white rounded-lg p-3 border border-gray-700 focus:border-[#76b900] focus:outline-none"
            placeholder="Describe Luca's behavior..."
          />
        </div>

        <button
          onClick={() => onStart({ voicePrompt, textPrompt })}
          disabled={isStartDisabled}
          className="w-full py-3 bg-[#76b900] hover:bg-[#5a8f00] disabled:bg-gray-700 disabled:text-gray-400 text-white font-semibold rounded-lg transition-colors"
          aria-label="Start Luca Express Talk"
        >
          {isRunningPreflight ? 'Running preflight...' : 'Start'}
        </button>
      </div>
    </div>
  );
}
