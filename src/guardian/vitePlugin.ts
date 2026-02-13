// Inference Guardian — Vite Plugin
// Exposes guardian REST endpoints as Vite dev-server middleware.

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as guardian from './index.js';
import * as reaper from './zombieReaper.js';
import * as fence from './inferenceFence.js';

function sendJson(res: ServerResponse, payload: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

type ViteServer = {
  middlewares: {
    use: (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
    ) => void;
  };
};

export function guardianPlugin() {
  return {
    name: 'inference-guardian',
    configureServer(server: ViteServer) {
      // Start the guardian daemon when Vite starts
      guardian.start();

      // ── GET /api/guardian/status ──
      server.middlewares.use('/api/guardian/status', async (_req, res) => {
        sendJson(res, guardian.getStatus());
      });

      // ── GET /api/guardian/processes ──
      server.middlewares.use('/api/guardian/processes', async (_req, res) => {
        const status = guardian.getStatus();
        sendJson(res, { processes: status.processes });
      });

      // ── GET /api/guardian/cuda ──
      server.middlewares.use('/api/guardian/cuda', async (_req, res) => {
        const status = guardian.getStatus();
        sendJson(res, status.cuda);
      });

      // ── GET /api/guardian/cuda/history ──
      server.middlewares.use('/api/guardian/cuda/history', async (_req, res) => {
        const status = guardian.getStatus();
        sendJson(res, { history: status.cudaHistory });
      });

      // ── GET /api/guardian/reaper/log ──
      server.middlewares.use('/api/guardian/reaper/log', async (_req, res) => {
        const status = guardian.getStatus();
        sendJson(res, {
          actions: status.reaper.recentActions,
          killsInWindow: status.reaper.killsInWindow,
          config: status.reaper.config,
        });
      });

      // ── POST /api/guardian/reaper/config ──
      server.middlewares.use('/api/guardian/reaper/config', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' }, 405);
          return;
        }
        try {
          const body = await readBody(req);
          const patch = JSON.parse(body);
          const updated = reaper.updateConfig(patch);
          sendJson(res, { ok: true, config: updated });
        } catch (err) {
          sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'parse-error' }, 400);
        }
      });

      // ── GET /api/guardian/fence/status ──
      server.middlewares.use('/api/guardian/fence/status', async (_req, res) => {
        const status = guardian.getStatus();
        sendJson(res, status.fence);
      });

      // ── POST /api/guardian/fence/reset ──
      server.middlewares.use('/api/guardian/fence/reset', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' }, 405);
          return;
        }
        fence.resetFence();
        sendJson(res, { ok: true, message: 'Fence reset successfully.' });
      });

      // ── POST /api/guardian/kill/:pid ──
      server.middlewares.use('/api/guardian/kill', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method-not-allowed' }, 405);
          return;
        }
        try {
          const body = await readBody(req);
          const { pid } = JSON.parse(body) as { pid: number };
          if (!pid || typeof pid !== 'number') {
            sendJson(res, { ok: false, error: 'pid is required (number)' }, 400);
            return;
          }
          const result = await guardian.manualKill(pid);
          sendJson(res, { ok: result.success, message: result.message });
        } catch (err) {
          sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'parse-error' }, 400);
        }
      });

      // ── GET /api/guardian/log ──
      server.middlewares.use('/api/guardian/log', async (_req, res) => {
        sendJson(res, { logs: guardian.getLog() });
      });
    },
  };
}
