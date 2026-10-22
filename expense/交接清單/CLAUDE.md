# 記帳APP（隨手記帳）— 交接清單

> 新 session 提到「記帳APP／記帳 App／隨手記帳」要繼續時，先讀這份。
> 最後更新：2026-10-22（第一版建立）

## 1. 這是什麼
- 手機記帳 App，做成 **PWA 網頁 App**：手機瀏覽器打開 →「加入主畫面」→ 像一般 App 一樣使用、可離線。
- **完全免費**：不需要 Apple（US$99/年）或 Google Play（US$25 一次）開發者帳號，不用任何 API Key、不連任何伺服器、不收費。
- 資料**只存在使用者手機本機**（localStorage，key = `expense.v1`），不上傳、不蒐集。
- 介面全部繁體中文，幣別 NT$。

## 2. 位置與部署
- 原始碼：`stock-analyzer` repo 的 `expense/` 資料夾（與股票網站同一個 repo）。
- 開發分支：`claude/expense-tracking-app-xgvzg8`。
- 部署：與股票網站相同的 **Cloudflare Pages**（`main` 被 push 後自動部署）。
  合併到 main 後網址為 **https://weicheng-stock.pages.dev/expense/**
- 根目錄 `_headers` 已加 `/expense/`、`index.html`、`sw.js`、`app.js` 的 no-cache 規則（推新版用）。

## 3. 檔案
| 檔案 | 用途 |
|---|---|
| `index.html` | 外框：頂部標題／月份切換、底部 4 個分頁、新增記帳的底部面板＋數字鍵盤 |
| `app.js` | 全部邏輯（純 JavaScript，無任何外部函式庫） |
| `style.css` | 樣式，含深色模式（跟隨手機系統） |
| `sw.js` | Service Worker，只為離線開啟；範圍限 `/expense/` |
| `manifest.json` | PWA 設定（名稱、圖示、standalone） |
| `icon.svg`、`icon-192.png`、`icon-512.png` | App 圖示（PNG 由 Python PIL 依 SVG 同樣設計畫出） |

## 4. 功能（v1）
- **總覽**：本月支出／收入／結餘、預算進度條＋「接下來 N 天平均每天可花多少」、今天的紀錄、最近 5 筆。
- **明細**：按月份切換、依日期分組（今天／昨天／星期）、搜尋分類或備註、點一筆可編輯或刪除。
- **統計**：甜甜圈圖（SVG 自繪）＋分類排行、每日支出長條圖、日均支出（本月以「到今天的天數」平均）。
- **設定**：每月預算、新增／刪除分類（自訂 emoji）、匯出 CSV（含 BOM，Excel 不亂碼）、JSON 備份／還原、全部清除（雙重確認）。
- 新增面板：支出／收入切換、分類格、日期、備註、自製數字鍵盤（最多 2 位小數、上限 9 位數）；電腦上可用實體鍵盤（Enter 完成、Esc 取消）。

## 5. 資料結構（localStorage `expense.v1`）
```json
{ "tx":   [{ "id": "…", "type": "expense|income", "amount": 120.5, "cat": "food", "date": "2026-10-22", "note": "午餐", "ts": "ISO 時間" }],
  "cats": [{ "id": "food", "name": "餐飲", "icon": "🍱", "type": "expense" }],
  "budget": 15000 }
```
- 刪除分類後，舊紀錄顯示為「❔ 未分類」（不會刪紀錄）。每種類型至少保留 1 個分類。
- 還原會驗證格式（日期、金額、類型），不符就拒絕，不會覆蓋現有資料。

## 6. 重要原則與注意事項
- ⚠️ **本網域曾因 Service Worker 造成無限重整**（見根目錄 `sw.js`，現在是 kill-switch）。
  記帳 App 的 SW 因此刻意：網路優先（永遠不卡舊版）、不呼叫 `clients.claim()`、不主動 reload 頁面、只刪 `expense-` 開頭的快取。
  改 `sw.js` 時要維持這些規則；改了 `FILES` 清單請把 `CACHE` 版本號 +1。
- 根目錄 kill-switch SW 若在某台裝置上啟動，會清掉所有快取（含 `expense-v1`）——只影響離線快取，**不影響記帳資料**（資料在 localStorage）。
- 資料只在單一手機：換手機前要「設定 → 備份」，新手機「還原」。iOS 長時間不開啟可能清除網站資料，已呼叫 `navigator.storage.persist()` 降低機率，但仍建議定期備份。

## 7. 犯過的錯與解法
- 金額格式化寫成 `Math.round(n*100/100)`（沒有四捨五入到小數 2 位）→ 改 `Math.round(n*100)/100`。
- 負數顯示成「NT$-176.5」→ `money()` 改為「−NT$176.5」。
- 上億金額會超出卡片 → `.stat-num` 用 `clamp()` 字級＋`overflow-wrap:anywhere`；圓環中央數字太長時縮小字級。
- 右下角 ＋ 按鈕擋住最後一張卡片 → `main` 底部加 72px 留白。

## 8. 測試方式
- 本機：在 repo 根目錄 `python3 -m http.server 8765` → 開 `http://localhost:8765/expense/`。
- 自動化：Playwright（雲端環境已預裝 Chromium：`/opt/node-tools/node_modules/playwright`），以 390×844 手機尺寸實際點按新增／編輯／搜尋／預算／重新整理後資料仍在／SW 註冊成功，console 0 錯誤。

## 9. 工具／Skill／MCP／API Key
- 未安裝任何 MCP、API Key、CLI；未建立新 Skill。
- 使用到的只有：Python PIL（畫 PNG 圖示）、Playwright（測試）。

## 10. 之後可以做（建議，尚未實作）
1. **上架 Google Play**（可賺錢管道）：用免費的 Bubblewrap／PWABuilder 把 PWA 包成 TWA，只需付 Google Play 一次性 US$25 註冊費（**需使用者同意才做**）。
2. 雲端同步（多裝置）：可用 Firebase 免費方案或 Cloudflare KV，但要登入機制，需評估。
3. 固定支出（每月房租、訂閱自動記一筆）、多帳戶（現金／信用卡）、多幣別、發票載具匯入。
4. 獲利：App 內放 Google AdSense（網頁版）或做「進階版」一次買斷。
