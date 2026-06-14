#!/usr/bin/env node
/**
 * OpenCode Go — background server launcher with auto-restart + health checks.
 *
 * Spawns the Express server, monitors it via HTTP health checks,
 * and restarts on crash or hang. Use instead of `node app.js server`.
 *
 * Usage:
 *   node start-bg.js              (default port 3333)
 *   node start-bg.js --port 4444
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? args[portIdx + 1] : '3333';

const NODE_OPTS = [
  '--expose-gc',
  '--max-old-space-size=1024',
  '--unhandled-rejections=warn',
];

let restartCount = 0;
let healthTimer = null;
let healthFailCount = 0;
let isShuttingDown = false;

function isPortAlreadyUp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/status`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// ── Health check ─────────────────────────────────────────────
//
// Key rules:
//  - timeout must exceed the longest single scrape stall
//  - check every 30s
//  - allow multiple consecutive failures before killing
//
const HEALTH_INTERVAL_MS = Number(process.env.OCWRAPPER_HEALTH_INTERVAL_MS || 30000);
const HEALTH_TIMEOUT_MS  = Number(process.env.OCWRAPPER_HEALTH_TIMEOUT_MS || 60000);
const MAX_HEALTH_FAILS   = Number(process.env.OCWRAPPER_MAX_HEALTH_FAILS || 4);

function healthCheck(child) {
  if (healthTimer) clearInterval(healthTimer);

  healthTimer = setInterval(() => {
    if (!child || child.killed || child.exitCode !== null || isShuttingDown) {
      clearInterval(healthTimer);
      healthTimer = null;
      return;
    }

    const req = http.get(`http://127.0.0.1:${PORT}/api/status`, (res) => {
      res.resume();
      healthFailCount = 0; // healthy — reset counter
    });
    req.setTimeout(HEALTH_TIMEOUT_MS, () => {
      req.destroy();
      healthFailCount++;
      if (healthFailCount >= MAX_HEALTH_FAILS) {
        console.log(`[bg] health failed ${healthFailCount}x — server unresponsive, killing PID ${child.pid}`);
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
        try { require('child_process').spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
        healthFailCount = 0;
      } else {
        console.log(`[bg] health check failed (${healthFailCount}/${MAX_HEALTH_FAILS}) — waiting`);
      }
    });
    req.on('error', () => {
      // error fires after req.destroy() from timeout, or ECONNREFUSED
    });
    req.end();
  }, HEALTH_INTERVAL_MS);
}

// ── Start server ────────────────────────────────────────────
async function start() {
  if (await isPortAlreadyUp(PORT)) {
    console.log(`[bg] ocwrapper already running on port ${PORT}; skipping duplicate start`);
    return;
  }

  const child = spawn('node', [...NODE_OPTS, 'app.js', 'server', '--port', PORT], {
    cwd: __dirname,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  const startedAt = Date.now();
  console.log(`[bg] started PID ${child.pid} on port ${PORT}`);

  // Start health checks after a brief grace period for first scrape
  setTimeout(() => healthCheck(child), 15000);

  child.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`[bg] server exited after ${elapsed}s (code=${code} signal=${signal})`);

    restartCount++;

    const backoff = Math.min(1000 * Math.pow(2, restartCount - 1), 30000);

    if (elapsed < 5 && code !== 0) {
      console.log(`[bg] quick exit (${elapsed}s), waiting ${backoff}ms before retry (attempt #${restartCount})…`);
      setTimeout(start, backoff);
    } else {
      console.log(`[bg] restarting… (attempt #${restartCount})`);
      setImmediate(start);
    }
  });

  child.on('error', (err) => {
    if (isShuttingDown) return;
    console.error(`[bg] spawn error: ${err.message}`);
    setTimeout(start, 5000);
  });
}

// ── Clean shutdown ──────────────────────────────────────────
process.on('SIGINT', () => {
  isShuttingDown = true;
  console.log('[bg] SIGINT — exiting');
  process.exit(0);
});
process.on('SIGTERM', () => {
  isShuttingDown = true;
  console.log('[bg] SIGTERM — exiting');
  process.exit(0);
});

start();

setInterval(() => {}, 30000);
console.log(`[bg] OpenCode Go launcher (port ${PORT}) — auto-restart + health checks enabled`);
