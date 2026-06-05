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
  '--unhandled-rejections=warn',   // log but DON'T terminate on unhandled rejections
];

let restartCount = 0;
let healthTimer = null;

let healthFailCount = 0;
const MAX_HEALTH_FAILS = 2; // allow up to 2 consecutive failures (~40s) before killing

function healthCheck(child) {
  if (healthTimer) clearInterval(healthTimer);

  healthTimer = setInterval(() => {
    if (!child || child.killed || child.exitCode !== null) {
      clearInterval(healthTimer);
      healthTimer = null;
      return;
    }

    const req = http.get(`http://127.0.0.1:${PORT}/api/status`, { timeout: 10000 }, (res) => {
      res.resume(); // drain response
      healthFailCount = 0; // healthy — reset counter
    });
    req.on('error', () => {
      healthFailCount++;
      if (healthFailCount >= MAX_HEALTH_FAILS) {
        // Server unresponsive for multiple checks — force-kill so watchdog restarts it
        console.log(`[bg] health failed ${healthFailCount}x — server unresponsive, killing PID ${child.pid}`);
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
        try { require('child_process').spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
        healthFailCount = 0;
      } else {
        console.log(`[bg] health check failed (${healthFailCount}/${MAX_HEALTH_FAILS}) — waiting`);
      }
    });
    req.end();
  }, 20000); // check every 20s
}

function start() {
  const child = spawn('node', [...NODE_OPTS, 'app.js', 'server', '--port', PORT], {
    cwd: __dirname,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  const startedAt = Date.now();
  console.log(`[bg] started PID ${child.pid} on port ${PORT}`);

  // Start health checks after a brief grace period
  setTimeout(() => healthCheck(child), 8000);

  child.on('exit', (code, signal) => {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`[bg] server exited after ${elapsed}s (code=${code} signal=${signal})`);

    restartCount++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
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
    console.error(`[bg] spawn error: ${err.message}`);
    setTimeout(start, 5000);
  });
}

start();

// Keep event loop alive
setInterval(() => {}, 30000);
console.log(`[bg] OpenCode Go launcher (port ${PORT}) — auto-restart + health checks enabled`);
