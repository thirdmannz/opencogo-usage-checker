#!/usr/bin/env node
/**
 * OpenCode Go Multi-Account Wrapper
 *
 * CLI:
 *   node app.js add <name>        — OAuth login for a GitHub account
 *   node app.js remove <name>     — Delete saved account
 *   node app.js list              — Show saved accounts
 *   node app.js scrape [name]     — Scrape usage (all or specific)
 *   node app.js server            — Start WebUI on port 3333
 *   node app.js server --port N   — Custom port
 */

const express = require('express');
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');

// ── Crash safety ─────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[safety] UNHANDLED REJECTION: ${reason?.message || reason}`);
  console.error(reason?.stack || '(no stack)');
  // Don't exit — log and let the server continue
});
process.on('uncaughtException', (err) => {
  console.error(`[safety] UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack);
  // Don't exit — log and let the server continue
});

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitMsSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function extractWorkspaceBase(url) {
  const match = String(url || '').match(/https:\/\/opencode\.ai\/workspace\/[^/?#]+/i);
  return match ? match[0] : null;
}

function workspaceGoUrl(workspaceUrl) {
  const base = extractWorkspaceBase(workspaceUrl);
  return base ? `${base}/go` : null;
}

function workspaceUsageUrl(workspaceUrl) {
  const base = extractWorkspaceBase(workspaceUrl);
  return base ? `${base}/usage` : null;
}

function normalizeProvider(provider, name = '') {
  const loweredName = String(name || '').trim().toLowerCase();
  if (/@(gmail|googlemail)\.com$/.test(loweredName)) return 'google';
  const raw = String(provider || '').trim().toLowerCase();
  if (raw === 'google' || raw === 'github') return raw;
  return 'github';
}

function providerLabel(provider, name = '') {
  const value = normalizeProvider(provider, name);
  return value === 'google' ? 'Google' : 'GitHub';
}

function formatMoney(amount, digits = 4) {
  const value = Number.parseFloat(amount);
  if (!Number.isFinite(value)) return `$0.${'0'.repeat(digits)}`;
  return `$${value.toFixed(digits)}`;
}

function parseGoLimitText(body) {
  const lines = String(body || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const labels = [
    { key: 'rolling', label: 'Rolling Usage' },
    { key: 'weekly', label: 'Weekly Usage' },
    { key: 'monthly', label: 'Monthly Usage' },
  ];
  const limits = [];

  for (const item of labels) {
    const idx = lines.findIndex(line => line.toLowerCase() === item.label.toLowerCase());
    if (idx === -1) continue;
    const window = lines.slice(idx + 1, idx + 8);
    const percentage = window.find(line => /^\d+(?:\.\d+)?%$/.test(line)) || null;
    const reset = window.find(line => /^resets\s+in\s+/i.test(line)) || null;
    limits.push({
      key: item.key,
      label: item.label,
      percentage,
      reset,
      percentValue: percentage ? Number.parseFloat(percentage) : null,
    });
  }

  return limits;
}

function listHeadlessChromePids() {
  const patterns = ['chrome-headless-shell.exe', 'chrome.exe'];
  const pids = new Set();
  try {
    for (const pattern of patterns) {
      const result = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${pattern}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0 && result.stdout && !/No tasks are running/i.test(result.stdout)) {
        for (const line of result.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
          const match = line.match(/^"[^"]+","(\d+)"/);
          if (match) pids.add(match[1]);
        }
      }
    }
  } catch {}
  return [...pids];
}

function killNewHeadlessChromePids(existingPids) {
  const before = new Set((existingPids || []).map(String));
  for (const pid of listHeadlessChromePids()) {
    if (before.has(String(pid))) continue;
    try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBrowserExecutable() {
  const home = os.homedir();
  const candidates = [
    process.env.OPENCODE_BROWSER_PATH,
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const direct = firstExistingPath(candidates);
  if (direct) return direct;

  for (const name of ['chrome.exe', 'chrome', 'msedge.exe', 'msedge']) {
    try {
      const result = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0 && result.stdout) {
        const found = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (found && fs.existsSync(found)) return found;
      }
    } catch {}
  }

  return null;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close(() => resolve(port));
    });
  });
}

async function launchSystemBrowser(loginUrl, userDataDir) {
  const executable = findBrowserExecutable();
  if (!executable) {
    throw new Error('找不到系統 Chrome/Edge。請安裝 Chrome，或設定 OPENCODE_BROWSER_PATH。');
  }

  const port = await getFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-popup-blocking',
    '--start-maximized',
    `--user-data-dir=${userDataDir}`,
    '--new-window',
    loginUrl,
  ];

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { executable, port, child };
}

async function connectOverCdpWithRetry(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (err) {
      lastErr = err;
      await waitMs(500);
    }
  }
  throw new Error(`無法連上系統瀏覽器的 CDP 埠 ${port}: ${lastErr?.message || 'unknown error'}`);
}

async function launchManualBrowser(loginUrl, userDataDir) {
  const executable = findBrowserExecutable();
  if (!executable) {
    throw new Error('找不到系統 Chrome/Edge。請安裝 Chrome，或設定 OPENCODE_BROWSER_PATH。');
  }

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-popup-blocking',
    '--start-maximized',
    `--user-data-dir=${userDataDir}`,
    '--new-window',
    loginUrl,
  ];

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { executable, child };
}

async function waitForBrowserClose(child, timeoutMs = 10 * 60 * 1000) {
  return await new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ ok: false, timeout: true });
    }, timeoutMs);

    child.once('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: true, code, signal });
    });
  });
}

async function verifyLoggedInProfile(profileDir) {
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://opencode.ai/auth', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Check for auth cookie on opencode.ai — this is the definitive proof
    const cookies = await context.cookies('https://opencode.ai').catch(() => []);
    const authCookie = cookies.find(c => c.name === 'auth' && c.domain.includes('opencode.ai'));
    if (!authCookie) {
      return { ok: false, error: 'No auth cookie found on opencode.ai. The login may not have completed. Re-login and close the browser, then try again.' };
    }
    console.log(`[verify] auth cookie found on opencode.ai (expires: ${new Date(authCookie.expires * 1000).toISOString()})`);

    const storageStateFile = path.join(profileDir, 'state.json');
    await context.storageState({ path: storageStateFile });

    // Try to get usage data from the page
    const url = page.url();
    console.log(`[verify] current URL: ${url}`);
    let workspaceUrl = null;
    if (url.includes('/go')) {
      const link = await page.locator('a[href*="/workspace/"]').first().getAttribute('href').catch(() => null);
      if (link) workspaceUrl = extractWorkspaceBase(link);
    }
    const result = await page.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const data = {};
      const sessMatch = body.match(/Sessions\s+(\d[\d,]*)/i);
      const msgMatch = body.match(/Messages\s+(\d[\d,]*)/i);
      const daysMatch = body.match(/Days\s+(\d[\d,]*)/i);
      const costMatch = body.match(/Total Cost\s+\$?([\d,.]+)/i);
      const avgMatch = body.match(/Avg.*?Cost.*?\$?([\d,.]+)/i);
      const inputMatch = body.match(/Input\s+\$?([\d,.]+)/i);
      const outputMatch = body.match(/Output\s+\$?([\d,.]+)/i);

      if (sessMatch) data.sessions = sessMatch[1];
      if (msgMatch) data.messages = msgMatch[1];
      if (daysMatch) data.days = daysMatch[1];
      if (costMatch) data.totalCost = costMatch[1];
      if (avgMatch) data.avgCost = avgMatch[1];
      if (inputMatch) data.inputCost = inputMatch[1];
      if (outputMatch) data.outputCost = outputMatch[1];
      data._raw = body.substring(0, 5000);
      data._url = window.location.href;
      data._timestamp = new Date().toISOString();
      return data;
    });

    return { ok: true, storageStateFile, result, workspaceUrl: workspaceUrl || extractWorkspaceBase(page.url()) || page.url() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function getRemoteDebugTargets(port) {
  return await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function waitForBrowserTargetUrl(port, predicate, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    try {
      const targets = await getRemoteDebugTargets(port);
      lastSeen = targets.map(t => t?.url).filter(Boolean);
      const match = targets.find(t => t && typeof t.url === 'string' && predicate(t.url, t));
      if (match) return { ok: true, target: match, targets };
    } catch (err) {
      lastSeen = [`[json/list error] ${err.message}`];
    }
    await waitMs(1000);
  }
  return { ok: false, targets: lastSeen };
}

async function closeBrowserProcess(browser, child) {
  try { if (browser) await browser.close(); } catch {}
  if (child && !child.killed) {
    try { child.kill(); } catch {}
    await waitMs(500);
    if (!child.killed) {
      try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
  }
}

// ── Config ──────────────────────────────────────────────────────
const BASE_DIR = __dirname;
const SESSION_DIR = path.join(BASE_DIR, 'sessions');
const DATA_DIR = path.join(BASE_DIR, 'data');
const PORTAL_BASE = 'https://opencode.ai';
const GO_URL = 'https://opencode.ai/go';
const AUTO_SCRAPE_MS = 60_000;

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Kill any orphaned headless Chrome PIDs from a previous crash
killNewHeadlessChromePids([]);

// ── Account helpers ─────────────────────────────────────────────
function profileDir(name) { return path.join(SESSION_DIR, name); }
function sessionStateFile(name) { return path.join(profileDir(name), 'state.json'); }
function dataFile(name) { return path.join(DATA_DIR, `${name}.json`); }

// ── SSE (Server-Sent Events) ───────────────────────────────────
const sseClients = new Set();

function sseSend(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

function sseHeartbeat() {
  for (const client of sseClients) {
    try { client.write(':hb\n\n'); } catch { sseClients.delete(client); }
  }
}
setInterval(sseHeartbeat, 30000);

// ── Auto-scrape state ──────────────────────────────────────────
let autoScrapeRunning = false;
let autoScrapeTimer = null;
let lastAutoScrapeAt = null;
let lastAutoScrapeResult = null;

let addAccountState = { status: 'idle', name: null, error: null, startedAt: null };
let addLoginAbort = new AbortController();
let activeAddContext = null;

function listAccounts() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs.readdirSync(SESSION_DIR).filter(f => {
    if (/_old_\d+$/i.test(f)) return false;
    if (/[-_]temp$/i.test(f)) return false;
    try { return fs.statSync(profileDir(f)).isDirectory(); } catch { return false; }
  });
}

function inferProviderFromSessionState(name) {
  const file = sessionStateFile(name);
  if (!fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const domains = cookies.map(cookie => String(cookie?.domain || '').toLowerCase());
    if (domains.some(domain => domain.includes('google.com') || domain.includes('gstatic.com'))) return 'google';
    if (domains.some(domain => domain.includes('github.com') || domain.includes('githubusercontent.com'))) return 'github';
  } catch {}
  return null;
}

function accountMeta(name) {
  const df = dataFile(name);
  const loggedIn = fs.existsSync(sessionStateFile(name));
  if (!fs.existsSync(df)) {
    return { name, status: 'no-data', loggedIn, provider: normalizeProvider(inferProviderFromSessionState(name), name) };
  }
  try {
    const d = JSON.parse(fs.readFileSync(df, 'utf-8'));
    return {
      name,
      loggedIn,
      ...d,
      provider: normalizeProvider(d.provider || d.authProvider || d.loginProvider || inferProviderFromSessionState(name), name),
    };
  } catch {
    return { name, status: 'parse-error', loggedIn, provider: normalizeProvider(inferProviderFromSessionState(name), name) };
  }
}

function saveAccountData(name, data) {
  fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 2), 'utf-8');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { fs.copyFileSync(from, to); break; } catch (e) {
          if (attempt < 2) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); continue; }
          console.log(`[copyDir] skip locked: ${path.basename(to)} (${e.code})`);
        }
      }
    }
  }
}

function safeRmDir(dirPath, label = '') {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(dirPath, { recursive: true, force: true }); return true; } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY') {
        const wait = 500 + attempt * 500;
        if (label) console.log(`[safeRmDir] ${label}: retry in ${wait}ms (${e.code})`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
        continue;
      }
      throw e;
    }
  }
  // Last resort: rename so it's out of the way, delete later
  try {
    const renamed = dirPath + '_old_' + Date.now();
    fs.renameSync(dirPath, renamed);
    console.log(`[safeRmDir] ${label}: renamed to ${path.basename(renamed)} (will be cleaned up on next run)`);
    return true;
  } catch (e) {
    console.error(`[safeRmDir] ${label}: FAILED — ${e.code}: ${e.message}`);
    return false;
  }
}

async function findAuthenticatedGoPage(context) {
  for (const current of context.pages()) {
    const url = current.url();
    if (!url.includes('opencode.ai')) continue;
    if (url.includes('/login') || url.includes('/signin') || url.includes('/github') || url.includes('/google')) continue;
    const authMeta = await current.locator('meta[name="opencode:auth"]').getAttribute('content').catch(() => null);
    if (authMeta === 'true') return current;
  }
  return null;
}

async function waitForAuthCallback(page, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const url = page.url();
    if (url.includes('/callback') && url.includes('auth.opencode.ai')) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const authMeta = await page.locator('meta[name="opencode:auth"]').getAttribute('content').catch(() => null);
      console.log(`[diag] callback URL: ${url}`);
      console.log(`[diag] callback body (first 200): ${bodyText.slice(0, 200)}`);
      console.log(`[diag] opencode:auth meta: ${authMeta}`);
      // Dump cookies at callback stage
      const cbCookies = await page.context().cookies('https://auth.opencode.ai').catch(() => []);
      console.log(`[diag] callback cookies on auth.opencode.ai: ${cbCookies.length}`);
      cbCookies.forEach(c => console.log(`  ${c.name} = ${c.value.slice(0,30)}... sameSite=${c.sameSite}`));
      const mainCookies = await page.context().cookies('https://opencode.ai').catch(() => []);
      console.log(`[diag] callback cookies on opencode.ai: ${mainCookies.length}`);
      mainCookies.forEach(c => console.log(`  ${c.name} = ${c.value.slice(0,30)}... sameSite=${c.sameSite}`));
      if (authMeta === 'true') return { ok: true, page };
      if (!/unknown state|expired|switch(ed)? in the middle/i.test(bodyText)) continue;
      return { ok: false, error: bodyText.trim() || 'auth callback failed', page };
    }
    const authPage = await findAuthenticatedGoPage(page.context());
    if (authPage) return { ok: true, page: authPage };
  }
  return { ok: false, error: 'Timeout waiting for auth callback', page };
}

// ── Browser helpers ─────────────────────────────────────────────
async function runLoginFlow(name, provider = 'github', { returnStateOnly = false, signal } = {}) {
  const cleanProvider = String(provider || 'github').toLowerCase();
  const pdir = profileDir(name);
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-go-'));
  const authUrl = 'https://opencode.ai/auth';

  console.log(`\n[add] Opening browser for login: ${name} (${cleanProvider})`);
  console.log(`[add] Log in via Google/GitHub. Session saves automatically.\n`);

  // Open Chrome WITH remote debugging port so we can poll cookies via CDP
  const browserRun = await launchSystemBrowser(authUrl, tempProfileDir);
  console.log(`[add] Browser: ${browserRun.executable} (CDP: ${browserRun.port})`);

  // Give Chrome a moment to start CDP
  await waitMs(3000);

  const deadline = Date.now() + 5 * 60 * 1000;
  let cdpBrowser = null;
  let saved = false;
  let workspaceUrl = null;

  while (Date.now() < deadline && !saved && !signal?.aborted) {
    try {
      // Connect to Chrome via CDP (reuse connection)
      if (!cdpBrowser) {
        cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${browserRun.port}`).catch(() => null);
      }
      if (!cdpBrowser) { await waitMs(1000); continue; }

      // Check all contexts for the user having completed login.
      // DON'T force-navigate to /go on auth cookie alone — the `/auth`
      // page sets the `auth` cookie during OAuth callback, but the user
      // may still be on GitHub's login form. Interrupting them with a
      // forced navigation causes "invalid auth token" when they go back.
      // Instead: wait for the page to NATURALLY reach /go or /workspace/...
      for (const ctx of cdpBrowser.contexts()) {
        // Find pages that have navigated PAST the auth flow
        const landedPages = [];
        for (const page of ctx.pages()) {
          const url = page.url();
          // Only consider opencode.ai pages
          if (!url.includes('opencode.ai') && !url.includes('auth.opencode.ai')) continue;
          // Skip pages still in the auth/authorize flow
          if (url.includes('/auth') || url.includes('/authorize') || url.includes('/login') || url.includes('/signin')) continue;
          // Skip GitHub/Google OAuth pages
          if (url.includes('github.com/') || url.includes('accounts.google.com/')) continue;
          landedPages.push({ page, url });
        }
        if (landedPages.length === 0) continue;

        // User completed login — verify auth cookie
        const cookies = await ctx.cookies('https://opencode.ai').catch(() => []);
        const authCookie = cookies.find(c => c.name === 'auth' && c.domain.includes('opencode.ai'));
        if (!authCookie) continue;

        console.log(`[add] Login complete — page: ${landedPages[0].url}`);
        console.log(`[add] Auth cookie detected (expires: ${new Date(authCookie.expires * 1000).toISOString()})`);

        // Brief settle before workspace URL detection
        await waitMsSignal(2000, signal);

        // Try to find workspace URL from the landed pages
        for (const { page } of landedPages) {
          const base = extractWorkspaceBase(page.url());
          if (base) { workspaceUrl = base; break; }
          // Check for workspace link (common on /go landing page)
          const link = await page.locator('a[href*="/workspace/"]').first().getAttribute('href').catch(() => null);
          if (link) workspaceUrl = extractWorkspaceBase(link);
        }

        console.log(`[add] Session ready — saving (workspace: ${workspaceUrl || '—'})`);

        if (!returnStateOnly) {
          const stateFile = path.join(tempProfileDir, 'state.json');
          await ctx.storageState({ path: stateFile });

          safeRmDir(pdir, name);
          copyDir(tempProfileDir, pdir);
          fs.copyFileSync(stateFile, sessionStateFile(name));
          saveAccountData(name, { name, provider: normalizeProvider(cleanProvider, name), savedAt: new Date().toISOString(), status: 'saved', workspaceUrl: workspaceUrl || null });
          console.log(`[add] Session saved for "${name}"\n`);
          saved = true;
        } else {
          const stateFile = path.join(tempProfileDir, 'state.json');
          await ctx.storageState({ path: stateFile });
          saved = true;
        }
        break;
      }
    } catch (err) {
      // Browser might have closed or CDP disconnected — reconnect next tick
      cdpBrowser = null;
    }

    if (!saved) await waitMs(1000);
  }

  if (cdpBrowser) await cdpBrowser.close().catch(() => {});

  // Early exit on abort: kill browser, clean temp dir
  if (!saved && signal?.aborted) {
    console.log(`[add] Login aborted for "${name}"`);
    if (browserRun?.child?.pid) {
      try { process.kill(-browserRun.child.pid); } catch { try { process.kill(browserRun.child.pid); } catch {} }
    }
    safeRmDir(tempProfileDir, `${name}-temp`);
    return { ok: false, error: 'Login aborted' };
  }

  // Fallback: if the browser was closed quickly, inspect the temp profile once more.
  if (!saved) {
    const verify = await verifyLoggedInProfile(tempProfileDir);
    if (verify.ok) {
      workspaceUrl = verify.workspaceUrl || workspaceUrl;
      if (!returnStateOnly) {
        safeRmDir(pdir, name);
        copyDir(tempProfileDir, pdir);
        fs.copyFileSync(verify.storageStateFile, sessionStateFile(name));
        saveAccountData(name, { name, provider: normalizeProvider(cleanProvider, name), savedAt: new Date().toISOString(), status: 'saved', workspaceUrl: workspaceUrl || null });
        console.log(`[add] Session saved for "${name}" (fallback)\n`);
      }
      saved = true;
    }
  }

  if (!saved) {
    console.log(`[add] Login not completed. Nothing saved.`);
    safeRmDir(tempProfileDir, `${name}-temp`);
    return { ok: false, error: 'Login not completed or timed out' };
  }

  safeRmDir(tempProfileDir, `${name}-temp`);
  return { ok: true, result: { saved: true, workspaceUrl } };
}

async function openLoginBrowser(name, provider = 'github') {
  return runLoginFlow(name, provider, { returnStateOnly: false });
}

async function webAddAccount(name, provider = 'github', signal) {
  addAccountState = { status: 'opening', name, error: null, startedAt: new Date().toISOString() };
  console.log(`[web-add] opening browser for "${name}" (${String(provider || 'github').toLowerCase()})...`);

  try {
    addAccountState.status = 'logging_in';
    const result = await runLoginFlow(name, provider, { returnStateOnly: false, signal });
    // If this login was superseded by a newer request, don't touch state
    if (addAccountState.name !== name) return { name, error: 'superseded' };
    if (!result.ok) {
      addAccountState.status = 'error';
      addAccountState.error = result.error;
      return { name, error: result.error };
    }

    addAccountState.status = 'saving';
    addAccountState.error = null;
    addAccountState.status = 'done';
    console.log(`[web-add] session saved for "${name}"`);
    sseSend('add-complete', { name, status: 'done' });

    const scrapeResult = await scrapeAccount(name);
    return scrapeResult;
  } catch (err) {
    if (addAccountState.name !== name) return { name, error: 'superseded' };
    addAccountState.status = 'error';
    addAccountState.error = err.message;
    return { name, error: err.message };
  }
}

const activeScrapePromises = new Map();
const activeScrapeContexts = new Map();

function cleanupAccountArtifacts(name) {
  if (!fs.existsSync(SESSION_DIR)) return;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const oldDirRe = new RegExp(`^${escaped}_old_\\d+$`, 'i');
  const tempDirRe = new RegExp(`^${escaped}[-_]temp$`, 'i');
  for (const entry of fs.readdirSync(SESSION_DIR)) {
    if (!oldDirRe.test(entry) && !tempDirRe.test(entry)) continue;
    safeRmDir(path.join(SESSION_DIR, entry), `${name}-artifact`);
  }
}

async function closeActiveAccountBrowser(name) {
  const key = String(name);
  const context = activeScrapeContexts.get(key);
  if (context) {
    try {
      // Get browser FIRST before closing context
      const browser = context.browser();
      await context.close().catch(() => {});
      if (browser && browser.isConnected()) await browser.close().catch(() => {});
    } catch {}
  }
  activeScrapeContexts.delete(key);
}


/** Safe wrapper — returns null if page/context/browser is closed */
async function safePageOp(fn) {
  try {
    return await fn();
  } catch (e) {
    if (/Target (page|context|browser) has been closed/i.test(e.message) || /Session closed/i.test(e.message)) {
      return null;  // caller knows page is dead
    }
    throw e;
  }
}

/** Wait for page to be alive and stable */
function isPageAlive(page) {
  return page && !page.isClosed() && page.context() && !page.context().browser()?.isConnected() === false;
}

async function scrapeAccount(name, _isRetry = false) {
  const pdir = profileDir(name);
  const key = String(name);

  if (!fs.existsSync(pdir)) {
    return { name, error: 'No saved session. Run: node app.js add ' + name };
  }

  if (!_isRetry && activeScrapePromises.has(key)) return activeScrapePromises.get(key);

  const scrapePromise = (async () => {
    let browser;
    let context;
    try {
      const storageStateFile = sessionStateFile(name);
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      });
      context = await browser.newContext({
        storageState: storageStateFile,
        viewport: { width: 1280, height: 800 },
      });
      activeScrapeContexts.set(key, context);

      const rootPage = await context.newPage();
      await rootPage.goto('https://opencode.ai/go', { waitUntil: 'load', timeout: 20000 }).catch(() => {});
      // Page may have been redirected to login or closed after goto
      if (rootPage.isClosed()) {
        return { name, error: 'Page closed after navigation — session may be expired. Re-login: node app.js add ' + name, scrapedAt: new Date().toISOString() };
      }
      await rootPage.waitForTimeout(1500);

      const cookies = await context.cookies('https://opencode.ai').catch(() => []);
      const authCookie = cookies.find(c => c.name === 'auth' && c.domain.includes('opencode.ai'));
      const authMeta = await rootPage.locator('meta[name="opencode:auth"]').getAttribute('content').catch(() => null);
      if (!authCookie && authMeta !== 'true') {
        return { name, error: 'Not authenticated on OpenCode. Re-login: node app.js add ' + name };
      }

      const existingData = fs.existsSync(dataFile(name)) ? JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) : {};
      const existingProvider = existingData.provider || existingData.authProvider || existingData.loginProvider || null;
      const candidateUrls = [
        rootPage.url(),
        existingData._url,
        existingData.workspaceUrl,
        existingData._workspaceUrl,
      ].filter(Boolean);

      let workspaceUrl = null;
      for (const candidate of candidateUrls) {
        const base = extractWorkspaceBase(candidate);
        if (base) { workspaceUrl = `${base}/usage`; break; }
      }

      if (!workspaceUrl && !rootPage.isClosed()) {
        await rootPage.waitForLoadState('domcontentloaded').catch(() => {});
        const href = await rootPage.evaluate(() => {
          const a = Array.from(document.querySelectorAll('a[href*="/workspace/"]')).find(el => el.href && el.href.includes('/workspace/'));
          return a ? a.href : null;
        }).catch(() => null);
        const text = await rootPage.locator('body').innerText().catch(() => '');
        const textMatch = text.match(/https:\/\/opencode\.ai\/workspace\/[^\s]+/i);
        const candidate = href || (textMatch ? textMatch[0] : null);
        const base = candidate ? extractWorkspaceBase(candidate) : null;
        if (base) workspaceUrl = `${base}/usage`;
      }

      if (!workspaceUrl) {
        return { name, error: 'Could not determine workspace URL for usage page.', scrapedAt: new Date().toISOString() };
      }

      const page = rootPage;
      page.setDefaultTimeout(20000);
      const goUrl = workspaceGoUrl(workspaceUrl);
      let goLimits = [];
      let goUrlFinal = null;
      if (goUrl) {
        const navOk = await safePageOp(() => page.goto(goUrl, { waitUntil: 'load', timeout: 20000 }));
        if (navOk === null) {
          return { name, error: 'Browser closed while navigating to Go page — session may be expired. Re-login.', scrapedAt: new Date().toISOString() };
        }
        await safePageOp(() => page.waitForTimeout(1500));
        goUrlFinal = page.isClosed() ? null : page.url();
        const goText = await page.locator('body').innerText().catch(() => '');
        goLimits = parseGoLimitText(goText);
      }

      if (rootPage.isClosed()) {
        return { name, error: 'Page closed after Go page — browser may have crashed. Re-login.', scrapedAt: new Date().toISOString() };
      }
      await page.goto(workspaceUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
      if (page.isClosed()) {
        return { name, error: 'Page closed after navigating to usage page.', scrapedAt: new Date().toISOString() };
      }
      await page.waitForTimeout(1500);

      const result = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        const data = {};
        const totalBalance = body.match(/Current balance\s+\$([\d,.]+)/i);
        const sessMatch = body.match(/Sessions\s+(\d[\d,]*)/i);
        const msgMatch = body.match(/Messages\s+(\d[\d,]*)/i);
        const daysMatch = body.match(/Days\s+(\d[\d,]*)/i);
        const costMatch = body.match(/Total Cost\s+\$?([\d,.]+)/i);
        const avgMatch = body.match(/Avg.*?Cost.*?\$?([\d,.]+)/i);
        const inputMatch = body.match(/Input\s+\$?([\d,.]+)/i);
        const outputMatch = body.match(/Output\s+\$?([\d,.]+)/i);

        if (totalBalance) data.currentBalance = totalBalance[1];
        if (sessMatch) data.sessions = sessMatch[1];
        if (msgMatch) data.messages = msgMatch[1];
        if (daysMatch) data.days = daysMatch[1];
        if (costMatch) data.totalCost = costMatch[1];
        if (avgMatch) data.avgCost = avgMatch[1];
        if (inputMatch) data.inputCost = inputMatch[1];
        if (outputMatch) data.outputCost = outputMatch[1];

        const tables = document.querySelectorAll('table');
        const models = [];
        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          for (let i = 0; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 2) {
              const row = [];
              for (const cell of cells) row.push(cell.textContent.trim());
              models.push({ cells: row, raw: row.join(' | ') });
            }
          }
        }
        if (models.length === 0) {
          const allDivs = document.querySelectorAll('[class*="model"], [class*="row"], [class*="item"]');
          for (const div of allDivs) {
            const text = div.textContent.trim();
            if (text.length > 5 && text.length < 200 && text.includes('$')) {
              models.push({ cells: [text], raw: text });
            }
          }
        }

        const usageRows = models.map(row => {
          const cells = Array.isArray(row.cells) ? row.cells : [];
          const costText = cells[4] || '';
          const costValue = (costText.match(/\$([\d,.]+)/) || [])[1] || null;
          return {
            date: cells[0] || null,
            model: cells[1] || null,
            input: cells[2] || null,
            output: cells[3] || null,
            cost: cells[4] || null,
            session: cells[5] || null,
            costValue,
            raw: row.raw || cells.join(' | '),
          };
        });
        const totalUsageCost = usageRows.reduce((sum, row) => sum + (parseFloat(row.costValue || '0') || 0), 0);
        if (!data.totalCost && usageRows.length) data.totalCost = totalUsageCost.toFixed(4);

        const usageBars = Array.from(document.querySelectorAll('[data-item]')).map(el => ({
          kind: el.getAttribute('data-kind') || null,
          model: el.getAttribute('data-model') || null,
          value: el.querySelector('[data-value]')?.textContent.trim() || null,
          name: el.querySelector('[data-name]')?.textContent.trim() || null,
          x: el.style.getPropertyValue('--x') || null,
          y: el.style.getPropertyValue('--y') || null,
        })).filter(item => item.name || item.value || item.model);

        data.models = models;
        data.usageRows = usageRows;
        data.usageRowCount = usageRows.length;
        data.usageBars = usageBars;
        data.usageBarCount = usageBars.length;
        data._raw = body.substring(0, 5000);
        data._url = window.location.href;
        data._timestamp = new Date().toISOString();
        data._workspace = Array.from(document.querySelectorAll('a[href*="/workspace/"]')).map(a => a.href).find(Boolean) || null;
        return data;
      });

      const output = {
        name,
        scrapedAt: new Date().toISOString(),
        workspaceUrl,
        goUrl: goUrlFinal || goUrl,
        goLimits,
        ...result,
        provider: normalizeProvider(existingProvider || result.provider, name),
      };
      saveAccountData(name, output);
      return output;
    } catch (err) {
      const errResult = { name, error: err.message, scrapedAt: new Date().toISOString() };
      saveAccountData(name, errResult);
      return errResult;
    } finally {
      activeScrapeContexts.delete(key);
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      cleanupAccountArtifacts(name);
    }
  })();

  activeScrapePromises.set(key, scrapePromise);
  try {
    return await scrapePromise;
  } finally {
    activeScrapePromises.delete(key);
  }
}

async function scrapeAllAccounts() {
  // Clean orphaned headless Chrome PIDs before launching new ones
  killNewHeadlessChromePids([]); // Kill ALL before starting clean
  const names = listAccounts();
  const results = [];

  // OVERALL safety: if the entire cycle takes > 5 minutes, force-return to unstick autoScrapeRunning
  let done = false;
  const overallTimer = setTimeout(() => {
    if (!done) {
      console.error('[scrapeAllAccounts] OVERALL TIMEOUT after 5min — force-returning');
      killNewHeadlessChromePids([]);
    }
  }, 5 * 60 * 1000);

  try {
    const ACCOUNT_TIMEOUT_MS = 60_000; // 60s per account max

  for (const name of names) {
    try {
      // Race the scrape against a per-account timeout
      // Timeout handler does NOT try to close the browser (that can hang too)
      // Instead, just returns timeout error and moves on
      let timer;
      const result = await Promise.race([
        scrapeAccount(name).finally(() => clearTimeout(timer)),
        new Promise(resolve => {
          timer = setTimeout(() => {
            console.log(`[scrape] ${name}: timed out after ${ACCOUNT_TIMEOUT_MS/1000}s`);
            const errResult = { name, error: `Scrape timed out (>${ACCOUNT_TIMEOUT_MS/1000}s)`, scrapedAt: new Date().toISOString() };
            saveAccountData(name, errResult);
            resolve(errResult);
          }, ACCOUNT_TIMEOUT_MS);
        }),
      ]);
      results.push(result);
    } catch (err) {
      results.push({ name, error: err.message, scrapedAt: new Date().toISOString() });
    }
    // Delay between accounts to reduce memory pressure
    await waitMs(2000);
    // Hint GC after each account scrape
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch {}
    }
  }
  } catch (err) {
    console.error(`[scrapeAllAccounts] cycle error: ${err.message}`);
  } finally {
    done = true;
    clearTimeout(overallTimer);
    lastAutoScrapeAt = lastAutoScrapeAt ||
    new Date().toISOString();
    lastAutoScrapeResult = results;
    sseSend('scrape-complete', { at: lastAutoScrapeAt, count: results.length, results });
    killNewHeadlessChromePids([]);
    if (typeof global.gc === 'function') { try { global.gc(); } catch {} }
    const mem = process.memoryUsage();
    console.log(`[memory] rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB ext=${Math.round(mem.external / 1024 / 1024)}MB`);
  }
  return results;
}

function startAutoScrape() {
  if (autoScrapeTimer) return;

  const tick = async () => {
    if (autoScrapeRunning) {
      // Safety: if autoScrapeRunning for >5 min, force-reset
      if (lastAutoScrapeAt === null || (Date.now() - new Date(lastAutoScrapeAt).getTime()) > 5 * 60 * 1000) {
        console.error('[auto] SAFETY: previous scrape appears stuck, force-resetting');
        autoScrapeRunning = false;
      } else {
        return;
      }
    }
    autoScrapeRunning = true;
    try {
      const count = listAccounts().length;
      if (count > 0) {
        console.log(`[auto] refreshing ${count} accounts...`);
        await scrapeAllAccounts();
        console.log(`[auto] refresh complete at ${new Date().toISOString()}`);
      }
    } catch (err) {
      console.error(`[auto] refresh failed: ${err.message}`);
    } finally {
      autoScrapeRunning = false;
    }
  };

  tick();
  autoScrapeTimer = setInterval(tick, AUTO_SCRAPE_MS);
}

// ── Express server ──────────────────────────────────────────────
function createServer(port) {
  const app = express();
  app.use(express.json());
  // Prevent browser caching of static files
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });
  app.use(express.static(path.join(BASE_DIR, 'public')));

  // SSE event stream — real-time push to the dashboard
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');
    sseClients.add(res);
    // Send current state immediately
    sseSend('server-state', {
      autoScrapeRunning,
      lastAutoScrapeAt,
      accountCount: listAccounts().length,
      intervalMs: AUTO_SCRAPE_MS,
    });
    req.on('close', () => { sseClients.delete(res); });
  });

  // List accounts
  app.get('/api/accounts', (req, res) => {
    const accounts = listAccounts().map(name => accountMeta(name));
    res.json(accounts);
  });

  app.get('/api/status', (req, res) => {
    res.json({
      autoScrapeRunning,
      lastAutoScrapeAt,
      accountCount: listAccounts().length,
      intervalMs: AUTO_SCRAPE_MS,
      lastAutoScrapeResult,
    });
  });

  // Scrape single account
  app.post('/api/scrape/:name', async (req, res) => {
    const { name } = req.params;
    if (!fs.existsSync(profileDir(name))) {
      return res.status(404).json({ error: `Account "${name}" not found` });
    }
    try {
      const result = await scrapeAccount(name);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scrape all accounts
  app.post('/api/scrape-all', async (req, res) => {
    try {
      const results = await scrapeAllAccounts();
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  let refreshInProgress = false;
  app.post('/api/refresh', async (req, res) => {
    if (refreshInProgress) return res.json({ ok: false, error: 'Refresh already in progress' });
    refreshInProgress = true;
    try {
      const results = await scrapeAllAccounts();
      res.json({ ok: true, count: results.length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      refreshInProgress = false;
    }
  });

  app.get('/api/add-status', (req, res) => {
    res.json(addAccountState);
  });

  app.post('/api/add-account/:name', async (req, res) => {
    const { name } = req.params;
    if (!name || name.length < 1) {
      return res.status(400).json({ error: 'Account name required' });
    }
    // If another login is in progress, abort it and restart
    if (addAccountState.status !== 'idle' && addAccountState.status !== 'done' && addAccountState.status !== 'error') {
      const prevName = addAccountState.name;
      console.log(`[web-add] Aborting login for "${prevName}" — new request for "${name}"`);
      addLoginAbort.abort();
      // Wait a moment for cleanup, then reset
      await waitMs(300);
      addAccountState = { status: 'idle', name: null, error: null, startedAt: null };
    }
    // Create fresh abort controller for this new login
    addLoginAbort = new AbortController();
    addAccountState = { status: 'opening', name, error: null, startedAt: new Date().toISOString() };
    webAddAccount(name, req.body?.provider || 'github', addLoginAbort.signal).catch(err => {
      console.error(`[web-add] unexpected error: ${err.message}`);
    });
    res.json({ ok: true, name, status: 'opening' });
  });

  // Delete account
  app.delete('/api/accounts/:name', async (req, res) => {
    const { name } = req.params;
    const pdir = profileDir(name);
    const dfile = dataFile(name);
    try {
      if (addAccountState.name === name && activeAddContext) {
        await activeAddContext.close().catch(() => {});
        activeAddContext = null;
        addAccountState = { status: 'idle', name: null, error: null, startedAt: null };
      }
      await closeActiveAccountBrowser(name);
      safeRmDir(pdir, name);
      if (fs.existsSync(dfile)) fs.unlinkSync(dfile);
      cleanupAccountArtifacts(name);
      res.json({ ok: true, deleted: name });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, deleted: name });
    }
  });

  const keyPath = path.join(BASE_DIR, 'key.pem');
  const certPath = path.join(BASE_DIR, 'cert.pem');
  const hasTls = fs.existsSync(keyPath) && fs.existsSync(certPath);
  const server = hasTls ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app) : http.createServer(app);
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  OpenCode Go Usage Dashboard`);
    console.log(hasTls ? `  https://localhost:${port}` : `  http://localhost:${port}`);
    console.log(hasTls ? `  https://127.0.0.1:${port}` : `  http://127.0.0.1:${port}`);
    console.log(`  Accounts saved: ${listAccounts().length}`);
    console.log(`  Sessions dir: ${SESSION_DIR}`);
    console.log(`  Auto refresh: every ${Math.round(AUTO_SCRAPE_MS / 1000)}s\n`);
    startAutoScrape();
  });
}

// ── CLI ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'add': {
      const name = args[1];
      const provider = args[2] || 'github';
      if (!name) { console.error('Usage: node app.js add <account-name> [github|google]'); process.exit(1); }
      await openLoginBrowser(name, provider);
      break;
    }

    case 'web-add': {
      const name = args[1];
      const provider = args[2] || 'github';
      if (!name) { console.error('Usage: node app.js web-add <account-name> [github|google]'); process.exit(1); }
      await webAddAccount(name, provider);
      break;
    }

    case 'remove':
    case 'rm': {
      const name = args[1];
      if (!name) { console.error('Usage: node app.js remove <account-name>'); process.exit(1); }
      const pdir = profileDir(name);
      const dfile = dataFile(name);
      safeRmDir(pdir, name);
      if (fs.existsSync(dfile)) fs.unlinkSync(dfile);
      console.log(`Removed: ${name}`);
      break;
    }

    case 'list':
    case 'ls': {
      const accounts = listAccounts();
      if (accounts.length === 0) {
        console.log('No accounts saved. Run: node app.js add <name>');
        break;
      }
      console.log('Saved accounts:');
      for (const name of accounts) {
        const meta = accountMeta(name);
        const cost = meta.totalCost || '—';
        const msgs = meta.messages || '—';
        const last = meta.scrapedAt ? new Date(meta.scrapedAt).toLocaleString() : 'never scraped';
        console.log(`  ${name.padEnd(16)} cost: $${cost}  msgs: ${msgs}  scraped: ${last}`);
      }
      break;
    }

    case 'scrape': {
      const name = args[1];
      if (name) {
        const result = await scrapeAccount(name);
        console.log(JSON.stringify(result, null, 2));
      } else {
        const names = listAccounts();
        if (names.length === 0) { console.log('No accounts. Run: node app.js add <name>'); break; }
        for (const n of names) {
          const result = await scrapeAccount(n);
          console.log(JSON.stringify(result, null, 2));
        }
      }
      break;
    }

    case 'server':
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) || 3333 : 3333;
      createServer(port);
      break;
    }

    default:
      console.log(`
OpenCode Go Multi-Account Wrapper

Commands:
  node app.js add <name>          Login via OAuth (opens browser)
  node app.js remove <name>       Delete account data
  node app.js list                Show all saved accounts
  node app.js scrape [name]       Scrape usage (all or one)
  node app.js server              Start WebUI on port 3333
  node app.js server --port N     Custom port
  POST /api/refresh               Force refresh all accounts now
      `);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
