# OpenCode Go Usage Checker

Local dashboard that reads your saved OpenCode Go sessions and shows current usage limits (Rolling / Weekly / Monthly percentages).

[English](#features) · [中文](#中文說明)

## Features

- **Auto-detect login sessions** — opens Chrome with CDP, detects auth cookie automatically, no manual file copying
- **Per-account isolation** — each account runs its own headless Chrome scrape; concurrent scrapes don't interfere
- **Auto-refresh** — dashboard polls every 60 seconds, API calls use cache-busting
- **LAN accessible** — server binds to `0.0.0.0:3333`, firewall rule auto-added
- **HTTPS** — self-signed cert included, works on localhost and LAN
- **Usage display** — shows Rolling, Weekly, Monthly usage percentages with color coding (green < 70%, yellow 70-90%, red > 90%)

## Quick Start

```bash
cd ocwrapper
npm install
node app.js server --port 3333
```

Open `https://localhost:3333` in your browser.

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
| `/api/add-account` | POST | Add account (`{ name, provider }`) |
| `/api/add-status` | GET | Current add-account status |
| `/api/delete-account` | POST | Delete account (`{ name }`) |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `3333` | Server port |
| `OPENCODE_BROWSER_PATH` | auto-detect | Path to Chrome/Edge executable |
| `OPENCODE_SCRAPE_INTERVAL` | `60000` | Auto-scrape interval in ms |

## How It Works

1. **Login flow**: Opens Chrome with remote debugging port (CDP), polls for `auth` cookie on `opencode.ai`. Once detected, saves the browser profile and storage state to `sessions/<email>/`. Falls back to profile inspection if Chrome closes quickly.

2. **Scrape flow**: For each account, launches a headless Chromium with the saved session, navigates to `opencode.ai/go`, extracts usage limits from the page, saves to `data/<email>.json`.

3. **Dashboard**: Reads `data/*.json` and displays usage percentages. Auto-refreshes every 60 seconds.

## File Structure

```
ocwrapper/
├── app.js              # Main server + scrape logic
├── public/
│   └── index.html      # Dashboard UI
├── sessions/           # Saved browser profiles (one dir per account)
├── data/               # Scraped usage data (JSON per account)
├── cert.pem            # Self-signed TLS cert
├── key.pem             # TLS private key
└── package.json
```

## 中文說明

這是一個本地 dashboard，用來查看你的 OpenCode Go 用量限制。

### 功能
- 自動偵測登入 session，不用手動複製檔案
- 每個帳號獨立運行 headless Chrome，不會互相干擾
- 每 60 秒自動更新
- 可以從區網其他裝置訪問

### 使用方式
1. 執行 `node app.js server --port 3333`
2. 瀏覽器開啟 `https://localhost:3333`
3. 在 Add Account 欄位輸入帳號名稱
4. 點 Add GitHub 或 Add Google
5. Chrome 會自動開啟登入頁面
6. 登入成功後 session 會自動儲存（通常 1-2 秒內）
7. 不需要手動關閉 Chrome，隨時可以關

### 注意事項
- 首次使用需要 `npm install` 安裝相依套件
- 使用自簽憑證，瀏覽器會跳出憑證警告，接受即可
- 如果要在區網訪問，需要允許 TCP 3333 埠的連線
- 帳號資料存在 `sessions/` 目錄，用量數據存在 `data/` 目錄
