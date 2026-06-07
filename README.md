# OpenCode Go Usage Checker

Local dashboard that reads your saved OpenCode Go sessions and shows current usage limits (Rolling / Weekly / Monthly percentages).

[English](#features) · [中文](#中文說明)

## Features

- **Auto-detect login sessions** — opens Chrome with CDP, detects auth cookie automatically, no manual file copying
- **Per-account isolation** — each account runs its own headless Chrome scrape; concurrent scrapes don't interfere
- **Auto-refresh** — dashboard polls every 60 seconds, API calls use cache-busting
- **Crash-resilient** — server auto-restarts on crash via watchdog process with health checks, frontend reconnects automatically
- **Abort-capable** — stuck scrape cycles are auto-aborted and Chrome cleaned up; prevents process accumulation
- **Memory-managed** — GC hints between scrape cycles, sequential account delays, heap size capped at 1GB
- **LAN accessible** — server binds to `:::3333` (all IPv4 + IPv6 interfaces)
- **HTTPS** — self-signed cert included, works on localhost and LAN
- **Usage display** — shows Rolling, Weekly, Monthly usage percentages with color coding (green < 70%, yellow 70-90%, red > 90%)
- **Reward detection** — scans Go page for sign-up reward buttons, shows count per account on dashboard
- **Apply rewards** — one-click apply sign-up rewards from dashboard; automatically re-scrapes usage after applying

## Quick Start

```bash
cd ocwrapper
npm install

# Production (recommended) — auto-restarts on crash
node start-bg.js --port 3333

# Or just start directly
node app.js server --port 3333
```

Open `https://localhost:3333` in your browser.

### Windows Batch

```
start.bat        # launches start-bg.js in background with auto-restart
```

## How It Works

### Watchdog (`start-bg.js`)

Runs the Express server as a child process. If the server crashes:
- Prints exit code and runtime duration
- Restarts immediately (or after 10s delay if exit was <5s, indicating a startup error)
- Runs with `--expose-gc` and `--max-old-space-size=1024` to reduce OOM risk
- Health checks run every 30s with 90s timeout; 5 consecutive failures trigger a kill + restart
- Tolerates slow scrape responses without false-positive restarts

### Memory Management

Each auto-scrape cycle (4 accounts, ~60s interval):
1. Per-account timeout: 120s (accounts with 50+ usage rows need extra time)
2. Overall cycle timeout: 10 min (prevents infinite hang)
3. Safety reset: if cycle runs >12 min, AbortController cancels remaining accounts and cleans up Chrome
4. Pre-cleanup: orphaned Chrome processes are killed before each account
5. A 2-second delay between accounts lets Node settle
6. `global.gc()` is called after each account and at the end of the cycle
7. Memory usage (RSS, heap, external) is logged per cycle for diagnostics

### Frontend Reconnection

The dashboard polls `/api/status` every 10 seconds. If the server goes offline and comes back:
- The "Server status" card shows "Offline" during downtime
- On reconnect, the frontend automatically reloads all account data
- No manual page refresh needed

## Add an Account

1. Enter an email/name in the **Add Account** field
2. Click **Add GitHub** or **Add Google**
3. Chrome opens to `opencode.ai/auth`
4. Log in via Google or GitHub
5. Session saves automatically (usually within 1-2 seconds of login)
6. You can close Chrome whenever — no need to wait

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/accounts` | GET | List all saved accounts with usage data |
| `/api/status` | GET | Server status (auto-scrape state, interval) |
| `/api/refresh` | POST | Trigger manual scrape of all accounts |
| `/api/add-account/:name` | POST | Add account (body: `{ provider }`) |
| `/api/add-status` | GET | Current add-account status |
| `/api/accounts/:name` | DELETE | Delete account |
| `/api/scrape/:name` | POST | Scrape single account |
| `/api/scrape-all` | POST | Scrape all accounts |
| `/api/rewards/:name` | GET | Get reward count for account |
| `/api/rewards/:name/apply` | POST | Apply one reward (auto re-scrapes after) |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `OPENCODE_BROWSER_PATH` | auto-detect | Path to Chrome/Edge executable |

The server port is set via `--port` flag (default: 3333).

## File Structure

```
ocwrapper/
├── app.js              # Main server + scrape logic
├── start-bg.js         # Watchdog launcher with auto-restart
├── start.bat           # Windows batch launcher
├── public/
│   └── index.html      # Dashboard UI
├── sessions/           # Saved browser profiles (one dir per account)
├── data/               # Scraped usage data (JSON per account)
├── cert.pem            # Self-signed TLS cert
├── key.pem             # TLS private key
└── package.json
```

## 中文說明

本地 dashboard，查看 OpenCode Go 用量限制。

### 功能
- 自動偵測登入 session，不用手動複製檔案
- 每個帳號獨立 headless Chrome，不互相干擾
- 每 60 秒自動更新
- 區網其他裝置可訪問
- server crash 後自動重啟，前端自動重連
- memory 管理：GC 提示、heap 上限 1GB

### 使用方式

```bash
# 推薦：自動重啟
node start-bg.js --port 3333

# Windows
start.bat

# 直接啟動
node app.js server --port 3333
```

1. 瀏覽器開啟 `https://localhost:3333`
2. 在 Add Account 欄位輸入帳號名稱
3. 點 Add GitHub 或 Add Google
4. Chrome 自動開啟登入頁面
5. 登入成功後 session 自動儲存（1-2 秒內）
6. 不需要手動關閉 Chrome

### 排障

- server 被砍掉後 `start-bg.js` 會自動重啟，終端機會看到 `[bg] server exited after Xs`
- 抓取卡住時 safety reset 會自動 abort 並清理 Chrome，不會累積殭屍進程
- 前端顯示 "Offline" 表示 server 暫時不可用，重啟後會自動刷新
- `app.js` 會在每個 scrape 週期後印 `[memory] rss=XXXMB heap=XXX/XXXMB` 方便診斷
