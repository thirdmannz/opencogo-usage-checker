#!/usr/bin/env node
/**
 * OpenCode Go — single-instance watchdog launcher.
 *
 * Spawns the Express server, monitors it via HTTP + scrape-thread health
 * checks, and restarts on crash, hang, or memory exhaustion.
 *
 * Usage:
 *   node start-bg.js              (default port 3333)
 *   node start-bg.js --port 4444
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? args[portIdx + 1] : '3333';

const BASE = 'C:\\Projects\\ocwrapper';
const BG_LOG = path.join(BASE, 'bg.log');
const HEALTH_INTERVAL = 15000;
const HEALTH_TIMEOUT = 8000;
const STOP_TIMEOUT = 10000;
const RESTART_DELAY = 3000;
const MAX_FAILURES = 3;

// Set process title so it's identifiable — do NOT kill this process
process.title = 'ocwrapper-guardian';

let child = null;
let healthTimer = null;
let isShuttingDown = false;
let consecutiveFailures = 0;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[bg ${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(BG_LOG, line + '\n'); } catch {}
}

function rss() {
  try { return Math.round(process.memoryUsage().rss / 1024 / 1024); } catch { return 0; }
}

function healthCheck() {
  if (!child || child.killed || child.exitCode !== null || isShuttingDown) return;

  const start = Date.now();
  const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: HEALTH_TIMEOUT }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      const ms = Date.now() - start;
      if (res.statusCode !== 200) {
        log(`health FAIL — HTTP ${res.statusCode} (${ms}ms)`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_FAILURES) restartChild();
        return;
      }
      try {
        const h = JSON.parse(body);
        consecutiveFailures = 0;
        if (h.memory_mb > 1100) {
          log(`memory ${h.memory_mb}MB > 1100 — forcing restart`);
          return restartChild();
        }
        if (h.blocked_ms > 60000) {
          log(`scrape blocked ${h.blocked_ms}ms > 60s — forcing restart`);
          return restartChild();
        }
        log(`health OK — RSS ${h.memory_mb}MB, pending ${h.scrape_pending||0}, blocked ${h.blocked_ms}ms (${ms}ms)`);
      } catch {
        consecutiveFailures = 0;
        log(`health OK (no payload yet, ${ms}ms)`);
      }
    });
  });
  req.on('error', (err) => {
    log(`health ERROR — ${err.code || err.message}`);
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) restartChild();
  });
  req.end();
}

function startChild() {
  if (isShuttingDown) return;
  log(`starting app.js on port ${PORT}...`);
  consecutiveFailures = 0;

  child = spawn('node', [
    '--expose-gc', '--max-old-space-size=1024',
    'app.js', 'server', `--port=${PORT}`
  ], {
    cwd: BASE,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  child.stdout.on('data', (d) => {
    const text = d.toString();
    process.stdout.write(`[app:out] ${text}`);
    try { fs.appendFileSync(path.join(BASE, 'server.log'), text); } catch {}
  });
  child.stderr.on('data', (d) => {
    const text = d.toString();
    process.stderr.write(`[app:err] ${text}`);
    try { fs.appendFileSync(path.join(BASE, 'server.log'), `[ERR] ${text}`); } catch {}
  });

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`);
    if (!isShuttingDown) setTimeout(startChild, RESTART_DELAY);
  });

  child.on('exit', (code, sig) => {
    const why = sig ? `signal ${sig}` : `code ${code}`;
    log(`child exited (${why})`);
    child = null;
    if (!isShuttingDown) {
      log(`restarting in ${RESTART_DELAY}ms...`);
      setTimeout(startChild, RESTART_DELAY);
    }
  });
}

function restartChild() {
  if (!child || child.killed) { startChild(); return; }
  log(`restarting child (failures: ${consecutiveFailures})`);
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    if (child && !child.killed) try { process.kill(child.pid, 'SIGKILL'); } catch {}
    startChild();
  }, STOP_TIMEOUT);
}

function stop() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('shutting down...');
  if (healthTimer) clearInterval(healthTimer);
  if (child && !child.killed) {
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => process.exit(0), STOP_TIMEOUT);
  } else {
    process.exit(0);
  }
}

// ── Main ─────────────────────────────────────────────────
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

startChild();

setTimeout(() => {
  healthTimer = setInterval(healthCheck, HEALTH_INTERVAL);
  log(`health checks started (every ${HEALTH_INTERVAL/1000}s)`);
}, 10000);

log(`🚀 OpenCode Go launcher (port ${PORT}) — auto-restart + health checks enabled`);
