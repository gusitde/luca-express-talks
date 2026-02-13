import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { guardianPlugin } from './src/guardian/vitePlugin'
import * as guardian from './src/guardian/index'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface BackendState {
  process: ChildProcess | null
  logs: string[]
  phase: string
  startedAt: number | null
  warmupProgress: number
  modelLoaded: boolean
  portOwnerPid: number | null
}

const backendState: BackendState = {
  process: null,
  logs: [],
  phase: 'stopped',
  startedAt: null,
  warmupProgress: 0,
  modelLoaded: false,
  portOwnerPid: null,
}

function phaseToProgress(phase: string) {
  if (phase === 'starting') return 5
  if (phase === 'loading_mimi') return 20
  if (phase === 'mimi_loaded') return 35
  if (phase === 'loading_moshi') return 60
  if (phase === 'moshi_loaded') return 80
  if (phase === 'warming_up_model') return 90
  if (phase === 'serving') return 100
  return 0
}

function pushBackendLog(line: string) {
  const withTime = `[${new Date().toLocaleTimeString()}] ${line}`
  backendState.logs = [...backendState.logs, withTime].slice(-600)
}

function detectPhase(logLine: string) {
  const line = logLine.toLowerCase()
  if (line.includes('loading mimi')) backendState.phase = 'loading_mimi'
  else if (line.includes('mimi loaded')) backendState.phase = 'mimi_loaded'
  else if (line.includes('loading moshi')) backendState.phase = 'loading_moshi'
  else if (line.includes('moshi loaded')) backendState.phase = 'moshi_loaded'
  else if (line.includes('warming up the model')) backendState.phase = 'warming_up_model'
  else if (line.includes('running on https://') || line.includes('running on http://')) backendState.phase = 'serving'

  const explicitPercent = line.match(/\b(\d{1,3})%\b/)
  if (explicitPercent) {
    const parsed = Number(explicitPercent[1])
    if (!Number.isNaN(parsed)) {
      backendState.warmupProgress = Math.min(100, Math.max(0, parsed))
    }
  }

  const phaseProgress = phaseToProgress(backendState.phase)
  if (phaseProgress > backendState.warmupProgress) {
    backendState.warmupProgress = phaseProgress
  }

  backendState.modelLoaded = backendState.phase === 'serving'
}

function sendJson(res: ServerResponse, payload: unknown) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function getListeningPidOnPort(port: number) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
      ])
      const raw = stdout.trim()
      if (!raw) return null
      const pid = Number(raw)
      return Number.isFinite(pid) && pid > 0 ? pid : null
    }

    const { stdout } = await execFileAsync('lsof', ['-t', `-i:${port}`])
    const firstLine = stdout.trim().split(/\r?\n/)[0]
    const pid = Number(firstLine)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function reclaimBackendPort(port: number) {
  const currentPid = backendState.process?.pid ?? null
  const ownerPid = await getListeningPidOnPort(port)
  backendState.portOwnerPid = ownerPid
  if (!ownerPid) return { reclaimed: false, ownerPid: null }
  if (currentPid && ownerPid === currentPid) {
    return { reclaimed: false, ownerPid }
  }

  try {
    pushBackendLog(`INFO reclaiming port ${port} from pid ${ownerPid}`)
    process.kill(ownerPid)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const stillOwnedBy = await getListeningPidOnPort(port)
    backendState.portOwnerPid = stillOwnedBy
    const reclaimed = !stillOwnedBy
    if (reclaimed) {
      pushBackendLog(`INFO port ${port} reclaimed`)
    } else {
      pushBackendLog(`WARN port ${port} still owned by pid ${stillOwnedBy}`)
    }
    return { reclaimed, ownerPid }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown-error'
    pushBackendLog(`WARN failed to reclaim port ${port}: ${message}`)
    return { reclaimed: false, ownerPid }
  }
}

function getPreferredLanIp() {
  const interfaces = os.networkInterfaces()
  for (const infos of Object.values(interfaces)) {
    if (!infos) continue
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address
      }
    }
  }
  return '127.0.0.1'
}

function safeStopBackend() {
  if (!backendState.process) return
  pushBackendLog('INFO stop requested')
  // Kill the real server process if we detected a different PID
  const realPid = backendState.portOwnerPid
  if (realPid && realPid !== backendState.process.pid) {
    try {
      process.kill(realPid)
      pushBackendLog(`INFO killed real backend PID ${realPid}`)
    } catch {
      // already dead
    }
  }
  backendState.process.kill()
}

async function restartBackendProcess() {
  const runningProcess = backendState.process
  if (runningProcess && !runningProcess.killed) {
    pushBackendLog('INFO restart requested')
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }

      runningProcess.once('exit', finish)
      safeStopBackend()
      setTimeout(finish, 4000)
    })
  }

  return startBackendProcess()
}

async function startBackendProcess() {
  if (backendState.process && !backendState.process.killed) {
    return { started: false, reason: 'already-running' }
  }

  const reclaim = await reclaimBackendPort(8998)
  if (backendState.portOwnerPid && !reclaim.reclaimed) {
    backendState.phase = 'port_in_use'
    backendState.warmupProgress = 0
    backendState.modelLoaded = false
    pushBackendLog(`ERROR cannot start backend, port 8998 is in use by pid ${backendState.portOwnerPid}`)
    return { started: false, reason: 'port-in-use', ownerPid: backendState.portOwnerPid }
  }

  const workspaceRoot = path.resolve(process.cwd(), '..')
  const pythonExe = path.join(workspaceRoot, 'personaplex-env', 'Scripts', 'python.exe')
  const sslDir = path.join(os.tmpdir(), 'ssl_luca')
  const localModelPath = path.join(workspaceRoot, 'personaplex-7b-v1', 'model.safetensors')
  const localTokenizerPath = path.join(workspaceRoot, 'personaplex-7b-v1', 'tokenizer_spm_32k_3.model')
  mkdirSync(sslDir, { recursive: true })

  backendState.logs = []
  backendState.phase = 'starting'
  backendState.startedAt = Date.now()
  backendState.warmupProgress = phaseToProgress('starting')
  backendState.modelLoaded = false
  backendState.portOwnerPid = null
  pushBackendLog(`INFO starting backend with ${pythonExe}`)
  pushBackendLog(`INFO local model path ${localModelPath}`)
  pushBackendLog(`INFO local tokenizer path ${localTokenizerPath}`)

  const args = ['-m', 'moshi.server', '--cpu-offload', '--static', 'none']
  if (path.isAbsolute(localModelPath)) {
    args.push('--moshi-weight', localModelPath)
  }
  if (path.isAbsolute(localTokenizerPath)) {
    args.push('--tokenizer', localTokenizerPath)
  }

  const child = spawn(pythonExe, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NO_TORCH_COMPILE: '1',
      NO_CUDA_GRAPH: '1',
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backendState.process = child

  // Register with Inference Guardian
  if (child.pid) {
    guardian.setManagedBackendPid(child.pid)
  }

  // On Windows, `python.exe` may be a thin launcher that spawns the
  // real interpreter as a child process.  We periodically check for
  // the PID that is actually listening on port 8998 so that kill /
  // reclaim logic targets the correct process.
  const pidPollingInterval = setInterval(async () => {
    if (!backendState.process || backendState.process.killed) {
      clearInterval(pidPollingInterval)
      return
    }
    const ownerPid = await getListeningPidOnPort(8998)
    if (ownerPid && ownerPid !== child.pid) {
      backendState.portOwnerPid = ownerPid
      guardian.setManagedBackendPid(ownerPid)
      pushBackendLog(`INFO real backend PID detected: ${ownerPid} (launcher PID ${child.pid})`)
      clearInterval(pidPollingInterval)
    }
  }, 3000)

  child.on('exit', () => clearInterval(pidPollingInterval))

  const handleChunk = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = chunk.toString('utf8')
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    for (const line of lines) {
      pushBackendLog(`${stream.toUpperCase()} ${line}`)
      detectPhase(line)
    }
  }

  child.stdout.on('data', (chunk: Buffer) => handleChunk(chunk, 'stdout'))
  child.stderr.on('data', (chunk: Buffer) => handleChunk(chunk, 'stderr'))
  child.on('exit', (code, signal) => {
    pushBackendLog(`INFO backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    if (child.pid) guardian.clearManagedBackendPid(child.pid)
    backendState.phase = 'stopped'
    backendState.warmupProgress = 0
    backendState.modelLoaded = false
    backendState.portOwnerPid = null
    backendState.process = null
  })
  child.on('error', (err: Error) => {
    pushBackendLog(`ERROR backend start failed: ${err.message}`)
    backendState.phase = 'error'
    backendState.warmupProgress = 0
    backendState.modelLoaded = false
    backendState.portOwnerPid = null
    backendState.process = null
  })

  return { started: true }
}

function diagnosticsPlugin() {
  return {
    name: 'diagnostics-endpoints',
    configureServer(server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) => void } }) {
      server.middlewares.use('/api/diag/gpu', async (_req, res) => {
        try {
          const { stdout } = await execFileAsync('nvidia-smi', [
            '--query-gpu=name,memory.used,memory.total,utilization.gpu',
            '--format=csv,noheader,nounits',
          ])

          const firstLine = stdout.trim().split('\n')[0]
          if (!firstLine) {
            sendJson(res, { available: false, reason: 'empty-output' })
            return
          }

          const [name, memoryUsedMb, memoryTotalMb, utilizationGpu] = firstLine.split(',').map((value: string) => value.trim())
          sendJson(res, {
            available: true,
            name,
            memoryUsedMb: Number(memoryUsedMb),
            memoryTotalMb: Number(memoryTotalMb),
            utilizationGpu: Number(utilizationGpu),
            timestamp: Date.now(),
          })
        } catch {
          sendJson(res, { available: false, reason: 'nvidia-smi-unavailable' })
        }
      })

      server.middlewares.use('/api/diag/network-ip', async (_req, res) => {
        sendJson(res, { ip: getPreferredLanIp() })
      })

      server.middlewares.use('/api/diag/server/status', async (_req, res) => {
        const running = !!backendState.process && !backendState.process.killed
        // Ping the backend's /healthz endpoint to check if the event loop is responsive
        let backendResponsive = false
        let lockLocked = false
        if (running) {
          try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 3000)
            const resp = await fetch('http://127.0.0.1:8998/healthz', { signal: controller.signal })
            clearTimeout(timer)
            if (resp.ok) {
              const data = await resp.json() as Record<string, unknown>
              backendResponsive = true
              lockLocked = Boolean(data.lock_locked)
            }
          } catch {
            // backend not responding
          }
        }
        sendJson(res, {
          running,
          backendResponsive,
          lockLocked,
          pid: backendState.process?.pid ?? null,
          realPid: backendState.portOwnerPid,
          portOwnerPid: backendState.portOwnerPid,
          phase: backendState.phase,
          warmupProgress: backendState.warmupProgress,
          modelLoaded: backendState.modelLoaded,
          uptimeSec: backendState.startedAt ? Math.round((Date.now() - backendState.startedAt) / 1000) : 0,
          hfTokenSet: Boolean(process.env.HF_TOKEN),
          logCount: backendState.logs.length,
        })
      })

      server.middlewares.use('/api/diag/server/logs', async (_req, res) => {
        sendJson(res, { logs: backendState.logs, phase: backendState.phase })
      })

      server.middlewares.use('/api/diag/server/warmup', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' })
          return
        }

        const result = await startBackendProcess()
        sendJson(res, { ok: true, ...result, phase: backendState.phase })
      })

      server.middlewares.use('/api/diag/server/dismount', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' })
          return
        }

        safeStopBackend()
        sendJson(res, { ok: true, phase: backendState.phase })
      })

      server.middlewares.use('/api/diag/server/restart', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' })
          return
        }

        const result = await restartBackendProcess()
        sendJson(res, { ok: true, ...result, phase: backendState.phase })
      })

      server.middlewares.use('/api/diag/server/connections', async (_req, res) => {
        try {
          const backendPid = backendState.process?.pid ?? null

          // --- TCP connections on port 8998 ---
          let connections: { localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number }[] = []
          try {
            const { stdout } = await execFileAsync('powershell', [
              '-NoProfile', '-Command',
              `Get-NetTCPConnection -LocalPort 8998 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress`,
            ])
            const raw = stdout.trim()
            if (raw) {
              const parsed = JSON.parse(raw)
              const rows = Array.isArray(parsed) ? parsed : [parsed]
              connections = rows.map((r: Record<string, unknown>) => ({
                localAddress: String(r.LocalAddress ?? ''),
                localPort: Number(r.LocalPort ?? 0),
                remoteAddress: String(r.RemoteAddress ?? ''),
                remotePort: Number(r.RemotePort ?? 0),
                state: String(r.State ?? ''),
                pid: Number(r.OwningProcess ?? 0),
              }))
            }
          } catch {
            // powershell may fail on non-Windows or if no connections
          }

          const stateCounts: Record<string, number> = {}
          for (const c of connections) {
            const s = String(c.state)
            stateCounts[s] = (stateCounts[s] ?? 0) + 1
          }

          // --- Process info ---
          let processInfo: { pid: number; workingSetMb: number; cpuSeconds: number; threads: number; handleCount: number; startTime: string } | null = null
          if (backendPid) {
            try {
              const { stdout } = await execFileAsync('powershell', [
                '-NoProfile', '-Command',
                `Get-Process -Id ${backendPid} -ErrorAction SilentlyContinue | Select-Object Id,@{N='WorkingSetMb';E={[math]::Round($_.WorkingSet64/1MB,1)}},@{N='CpuSeconds';E={[math]::Round($_.TotalProcessorTime.TotalSeconds,1)}},@{N='Threads';E={$_.Threads.Count}},HandleCount,@{N='StartTime';E={$_.StartTime.ToString('o')}} | ConvertTo-Json -Compress`,
              ])
              const raw = stdout.trim()
              if (raw) {
                const p = JSON.parse(raw) as Record<string, unknown>
                processInfo = {
                  pid: Number(p.Id ?? backendPid),
                  workingSetMb: Number(p.WorkingSetMb ?? 0),
                  cpuSeconds: Number(p.CpuSeconds ?? 0),
                  threads: Number(p.Threads ?? 0),
                  handleCount: Number(p.HandleCount ?? 0),
                  startTime: String(p.StartTime ?? ''),
                }
              }
            } catch {
              // process info unavailable
            }
          }

          // --- Child processes ---
          let childProcesses: { pid: number; name: string; workingSetMb: number }[] = []
          if (backendPid) {
            try {
              const { stdout } = await execFileAsync('powershell', [
                '-NoProfile', '-Command',
                `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${backendPid} } | Select-Object ProcessId,Name,@{N='WorkingSetMb';E={[math]::Round($_.WorkingSetSize/1MB,1)}} | ConvertTo-Json -Compress`,
              ])
              const raw = stdout.trim()
              if (raw) {
                const parsed = JSON.parse(raw)
                const rows = Array.isArray(parsed) ? parsed : [parsed]
                childProcesses = rows.map((r: Record<string, unknown>) => ({
                  pid: Number(r.ProcessId ?? 0),
                  name: String(r.Name ?? ''),
                  workingSetMb: Number(r.WorkingSetMb ?? 0),
                }))
              }
            } catch {
              // child processes unavailable
            }
          }

          sendJson(res, {
            backendPid,
            connections,
            connectionCount: connections.length,
            stateCounts,
            processInfo,
            childProcesses,
            timestamp: Date.now(),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown'
          sendJson(res, { error: message })
        }
      })

      server.middlewares.use('/api/diag/server/kill-zombies', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' })
          return
        }

        try {
          // Find CloseWait connections on port 8998 and force-close via resetport
          const { stdout } = await execFileAsync('powershell', [
            '-NoProfile', '-Command',
            `Get-NetTCPConnection -LocalPort 8998 -State CloseWait -ErrorAction SilentlyContinue | Select-Object RemoteAddress,RemotePort | ConvertTo-Json -Compress`,
          ])
          const raw = stdout.trim()
          let zombieCount = 0
          if (raw) {
            const parsed = JSON.parse(raw)
            const rows = Array.isArray(parsed) ? parsed : [parsed]
            zombieCount = rows.length
          }

          // Best we can do is restart the backend to clear all zombie connections
          if (zombieCount > 0) {
            pushBackendLog(`INFO clearing ${zombieCount} zombie (CloseWait) connections via restart`)
            const result = await restartBackendProcess()
            sendJson(res, { ok: true, zombieCount, action: 'restarted', ...result })
          } else {
            sendJson(res, { ok: true, zombieCount: 0, action: 'none-needed' })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown'
          sendJson(res, { ok: false, error: message })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), diagnosticsPlugin(), guardianPlugin()],
  server: {
    host: true,
    proxy: {
      '/api/chat': {
        target: 'http://127.0.0.1:8998',
        ws: true,
        secure: false,
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:8998',
        ws: true,
        secure: false,
        changeOrigin: true,
      },
    },
  },
})
