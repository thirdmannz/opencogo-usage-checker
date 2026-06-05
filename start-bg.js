/**
 * OpenCode Go — background server launcher with auto-restart.
 *
 * Starts the Express server and restarts it if it crashes.
 * Run this instead of `node app.js server` for production use.
 *
 * Usage:
 *   node start-bg.js              (default port 3333)
 *   node start-bg.js --port 4444
 */
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? args[portIdx + 1] : '3333';

const NODE_OPTS = [
  '--expose-gc',
  '--max-old-space-size=1024',
];

function start() {
  const child = spawn('node', [...NODE_OPTS, 'app.js', 'server', '--port', PORT], {
    cwd: __dirname,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  const startedAt = Date.now();

  child.on('exit', (code, signal) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`[bg] server exited after ${elapsed}s (code=${code} signal=${signal})`);

    // Restart unless it exited immediately (<5s) — that likely means a startup error
    if (elapsed < 5 && code !== 0) {
      console.error(`[bg] server exited too quickly (${elapsed}s), waiting 10s before retry…`);
      setTimeout(start, 10000);
    } else {
      console.log(`[bg] restarting…`);
      setImmediate(start);
    }
  });

  child.on('error', (err) => {
    console.error(`[bg] spawn error: ${err.message}`);
    console.log('[bg] restarting in 5s…');
    setTimeout(start, 5000);
  });
}

start();

// Keep the event loop alive (start-bg itself never exits)
setInterval(() => {}, 30000);
console.log(`[bg] OpenCode Go background launcher (port ${PORT}) — auto-restart enabled`);
