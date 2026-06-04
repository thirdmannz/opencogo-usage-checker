     1. 開第一個帳號登入
        cd /c/ocwrapper && node app.js add github-a
     2. 第二個帳號
        cd /c/ocwrapper && node app.js add github-b
     3. 開面板
        cd /c/ocwrapper && node app.js server --port 3333

     目前已完成：
     - 專案在 C:\ocwrapper
     - WebUI 可打開 http://127.0.0.1:3333
     - 已做好多帳號 session 儲存架構
     - 已做好抓用量 API 與前端表格

     要注意一點：
     - 我現在沒法替你真的登入你的 GitHub / Google 帳號
     - 你登入完按 Enter，腳本才會存 session

     如果你要，我下一步可以直接補兩個東西：
     - 自動列出每個帳號的登入狀態
     - 自動每隔 N 分鐘刷新一次用量，不用手動按按鈕

     做完了，路徑在 C:\ocwrapper。

     現在有：
     - C:\ocwrapper\app.js
     - C:\ocwrapper\public\index.html
     - C:\ocwrapper\sessions\
     - C:\ocwrapper\data\

     可用指令：
     - 啟動面板：cd /c/ocwrapper && node app.js server --port 3333
     - 加帳號：cd /c/ocwrapper && node app.js add github-a
     - 列帳號：cd /c/ocwrapper && node app.js list
     - 抓全部用量：cd /c/ocwrapper && node app.js scrape

     我也驗證了：
     - http://127.0.0.1:3333 有回 200
     - server 已正常起來

     限制：
     - 我不能替你直接登入你的 GitHub / Google 帳號
     - 你要自己在開出的瀏覽器完成登入，回到終端按 Enter，才會存 session

     下一步如果你要，我可以繼續補：                  hermes
     1. 自動每 10 分鐘刷新一次用量
     2. 顯示每個帳號是否已過期
     3. 加匯出 JSON / CSV 按鈕