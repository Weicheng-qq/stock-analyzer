# 記帳APP（隨手記帳）— 交接清單

> 新 session 提到「記帳APP／記帳 App／隨手記帳」要繼續時，先讀這份。
> 最後更新：2026-10-22（第二版：自動記帳 — Android App 讀 LINE 銀行通知＋載具發票匯入）

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

## 6.5 自動記帳（第二版，2026-10-22）
使用者需求：「不想手動記帳，自動讀 LINE 上富邦、華南的聊天內容＋統一發票對獎 APP 的載具」。使用者手機是 **Android**。

### 可行性結論（重要，別再重查）
- **LINE 沒有任何 API 能讀個人聊天內容**。唯一自動的方法：Android 的「通知存取權」（NotificationListenerService）讀 LINE 跳出的通知。**iPhone 系統完全不允許**，iPhone 只能用「傳送聊天記錄」匯入。
- **統一發票兌獎 APP 不開放資料**。載具發票來源＝財政部「電子發票整合服務平台」：
  - 現在：使用者在平台網站匯出載具消費明細檔 → App 匯入（免費、官方）。
  - 全自動：財政部 API 需向財政資訊中心申請 AppID＋APIKey，查到的申請文件對象是**營業人**，個人能否申請不確定 → 使用者同意「先做匯入，同時試申請 API」。**尚未申請**。
- 雲端 session 連不到 dl.google.com／maven.google.com（403），**本機無法編 APK** → 用 GitHub Actions 編譯（public repo 免費）。

### 架構
- `expense/parse.js`：解析核心（純函式，Node 可測）：`parseBankMessage`（銀行訊息→ tx／review／ignore）、`parseLineExport`（LINE 匯出 txt）、`parseInvoiceCsv`（載具明細，`表頭=M|…` 格式與一般 CSV 都吃）、`guessCat`（依店名／品名關鍵字分類）、`msgKey`（去重指紋）。
- `expense/test/parse.test.js`：15 項測試，`node expense/test/parse.test.js`；APK 編譯前 CI 會先跑。
- `expense/app.js` 自動記帳引擎：`processMessages`、`addAuto`、`importInvoices`、`pullNative`。
  - **發票＋刷卡通知合併**：支出、金額相同、日期差 ≤3 天、來源不同 → 合併成一筆（標「LINE＋發票」），不重複計算。
  - **待確認（inbox）**：轉帳轉出／轉入（可能是自己帳戶互轉）、**繳信用卡費**（避免與逐筆刷卡重複）、外幣、看不出收支方向 → 不自動記，首頁顯示讓使用者確認或忽略。
  - 驗證碼、廣告、非交易訊息 → 忽略。
  - `db.seen` 存處理過的訊息指紋（上限 5000），重複匯入／重複通知不會重記。
  - 資料新欄位：`tx.src`（line／invoice）、`tx.inv`、`tx.merged`、`tx.raw`（原文）、`tx.catAuto`；`db.inbox`、`db.seen`、`db.keywords`（預設 富邦、華南，設定頁可改）。
- `expense-android/`：原生 Android 外殼（Java、無 Kotlin）
  - `MainActivity`：WebView 經 `WebViewAssetLoader` 載入 `https://appassets.androidplatform.net/assets/web/index.html`（Gradle `copyWeb` 把 `expense/` 複製進 APK，排除 交接清單／test／sw.js）。處理檔案選擇、返回鍵（JS `__onBack`）、「分享」進來的 LINE 聊天記錄／載具檔。
  - `NotifyService`：只收 `jp.naver.line.android`、聊天室名稱含關鍵字的通知；略過群組摘要；支援 MessagingStyle 多則訊息。**只照抄原文**，解析全在 JS。
  - `Store`：SharedPreferences 暫存待處理通知；JS 存檔後才 `ack` 刪除（App 被殺也不漏記）。
  - `Bridge`（`window.AndroidBridge`）：isListenerEnabled／openListenerSettings／openBatterySettings／getPending／ack／setKeywords／takeSharedText／saveFile（WebView 不支援 blob 下載，改存到「下載」資料夾）。
  - 簽章金鑰 `expense-android/app/expense-release.jks`（密碼 expense-app）**已 commit 且必須永遠不換**：換金鑰的 APK 不能覆蓋安裝，使用者得移除 App＝記帳資料消失。風險：repo 公開，他人理論上可做同簽章 APK，但需使用者自己去安裝才有影響。
  - versionCode＝GitHub Actions run number，新版可直接覆蓋安裝。
- `.github/workflows/build-expense-apk.yml`：push 到 main 或 `claude/expense-*` 且改到 expense 相關檔案時編譯 → 更新 Release **`expense-app-latest`**（固定網址，附 expense-app.apk）。
  下載網址：https://github.com/weicheng-qq/stock-analyzer/releases/tag/expense-app-latest

### 自動更新（2026-10-22 使用者要求「打開 App 直接就是新版」）
- CI 每次編譯在 Release `expense-app-latest` 放 **expense-app.apk、web.zip、update.json**（update.json 最後上傳）。
  update.json＝{versionCode, webHash, nativeHash, webZipSha256, commit}。webHash＝expense/ 畫面檔（同 APK 內 assets/web 清單）逐檔 sha256 再合併；nativeHash＝expense-android/ 全部 git 檔案。兩者也用 env 傳進 gradle → `BuildConfig.WEB_HASH／NATIVE_HASH`。
- `Updater.java`：開 App（onResume，最多 10 分鐘一次）抓 update.json：
  - nativeHash 不同且 versionCode 較新 → JS `__nativeUpdate()` 首頁顯示「App 有新版本」→ 按「更新」→ `installUpdate` 下載 APK、PackageInstaller 安裝（系統一定會跳確認；第一次要允許「隨手記帳」安裝應用程式）。此時**不換畫面**（新畫面可能依賴新主程式）。
  - 只有 webHash 不同 → 背景下載 web.zip、驗 SHA-256、解壓到 files/web-live → JS `__updateReady()` 重新整理（正在輸入就等關面板）。`LivePathHandler` 讓 /assets/web/ 優先讀 web-live，origin 不變＝localStorage 資料不受影響。
  - 安全網：新畫面換上後 JS 要呼叫 `bootOk()`；連續 3 次啟動沒回報 → 刪掉、退回 APK 內建版、該 webHash 列入黑名單。APK 更新（內建 WEB_HASH 改變）時清掉舊 web-live。
- Manifest 新增 INTERNET、REQUEST_INSTALL_PACKAGES。
- ✅ 2026-10-22 使用者已手動裝好含自動更新的版本（e3d4cd7，versionCode 10）。之後畫面改動自動套用、主程式改動按「更新」。
- 只改 `expense/` 畫面／解析規則 → 使用者開 App 就自動更新；改 `expense-android/` → 使用者要按一次「更新」。**優先把修改放在 JS 端**。

### 載具發票自動化（2026-10-22 調查結論）
- 使用者問「載具要怎麼自動記帳」（附統一發票兌獎 App 截圖）。結論：**免費全自動做不到**。
  - 統一發票兌獎 App 不開放資料、每張發票不推播。
  - 財政部電子發票 API：需向財資中心申請 AppID＋APIKey（規格以營業人／統編為主），且**要綁固定 IP**（API 規格 2.0、使用規範 law-out.mof.gov.tw GL010122）→ 手機／Cloudflare 免費方案沒有固定 IP，要付費 → 不做。
- 採用：**每月到電子發票整合服務平台匯出 → 分享給隨手記帳**（parseInvoiceCsv 已支援 `表頭=M|…` 與一般 CSV）。新版平台的匯出位置與格式**尚未確認**，已請使用者找匯出按鈕並傳檔案或截圖。
- 備案：平台「消費發票彙整通知」Email（需信箱驗證）→ 從 Gmail 分享文字給 App（格式未知，需要樣本）。

### 使用者在手機上要做的事
1. 下載安裝 APK（允許「安裝不明來源的應用程式」）。
2. App → 設定 → 自動記帳 →「開啟」→ 允許「隨手記帳」的通知存取權。
3. LINE → 設定 → 提醒 → 開啟「顯示訊息內容」（否則通知裡沒有金額）。
4. 電池最佳化設為「不限制」（小米／OPPO／vivo 等還要允許「自啟動」）。
5. 補登舊交易：LINE 銀行聊天室 → 傳送聊天記錄 → 分享給「隨手記帳」。
6. 載具：財政部電子發票整合服務平台 → 手機條碼登入 → 消費明細匯出 → 分享給「隨手記帳」或在設定頁匯入。

### 真實銀行訊息格式（2026-10-22 使用者截圖，已寫進測試）
- **兩家都是 LINE 卡片訊息（Flex Message）**。⚠️ Flex 的通知只顯示銀行設定的 altText（摘要），**卡片內容不一定在通知裡** → 沒金額的交易通知改成放「待確認」請使用者補金額（不漏掉）。實際通知長怎樣：看 App 設定頁「最近收到的訊息（診斷用）」（`db.log`，最近 50 則原文＋解讀結果）。
- 華南信用卡：`💳刷卡金額： NT$ 1,812 元／👉交易時間：2026/10/22 10:51／👉卡號末四碼：9111／👉商店名稱：中華電信股份有限公司／※外幣消費金額以…新臺幣…` → 自動記支出、商店＝中華電信、分類居家。
- 富邦帳戶：`存款入帳／NT$2,985／入帳時間 2026/10/22 13:48／帳號末四碼 0436／交易摘要 CD轉收`（欄位無冒號，表格排版）→ 待確認（入帳可能是自己帳戶互轉）。
- 2026-10-22 使用者已更新到 bfcb5fd 版（含診斷畫面），等真實通知／聊天記錄匯入結果。
- ✅ **2026-10-22 已證實**：使用者匯入華南 LINE 聊天記錄，診斷畫面顯示卡片訊息匯出／通知都只有 altText「[📫您有一筆刷卡消費通知]」，**LINE 拿不到金額**。
- **改走銀行 App 推播＋銀行簡訊**（同一個通知存取權）：`NotifyService.fromOtherApp` 收「App 名稱／通知標題／內容」含關鍵字的通知（排除常駐通知與本 App）；Manifest 加 `<queries>`（MAIN/LAUNCHER）才查得到其他 App 名稱。LINE 仍只收聊天室名稱符合的。
- `dropPlaceholders`：同銀行有金額的通知記帳後，刪掉 30 分鐘內沒金額的 LINE 待確認，避免重複。
- **待驗證**：富邦／華南手機銀行 App、信用卡 App 推播與簡訊的真實文字（等使用者開推播後看診斷畫面）。
- 若通知確定拿不到金額：備案是 AccessibilityService 讀 LINE 畫面（Play Protect 很敏感、不建議），或請使用者用「傳送聊天記錄」匯入（匯出檔對 Flex 也可能只有 altText，待驗證）。

### 尚未確認（需要使用者提供）
- **富邦、華南 LINE 通知的真實文字格式**：目前規則依常見台灣銀行通知寫成，沒看過真實訊息。請使用者貼幾則（遮掉帳號）→ 用設定頁「測試」框或加進 `test/parse.test.js` 調整。
- 財政部載具匯出檔的實際欄位（新版平台可能改格式）——拿到真實檔案再驗證。
- ✅ 2026-10-22 第一次 GitHub Actions 編譯成功（run #1，APK 約 390KB，已確認 assets/web 內容正確）。**尚未在真機上測試**通知讀取。
- 2026-10-22 使用者回報「下載卡住」（App 內建瀏覽器下載畫面不動，其實已下載完 398KB）→「還是不能安裝」。CI 已加 `apksigner verify`：v2 簽章有效、package tw.weicheng.expense、minSdk 26（Android 8+）→ **APK 本身沒問題，是手機端安裝攔截**。等使用者提供錯誤畫面截圖＋手機型號。
- 使用者手機：**三星 Galaxy S22 Ultra**（One UI 6/7、Android 14/15）。三星要點：①「自動封鎖程式」(Auto Blocker，設定→安全性與隱私權) 會擋所有非商店 APK，須先關閉；②特殊存取權限→安裝不明應用程式→我的檔案／Chrome 允許；③ Android 13+ 側載 App 的通知存取權是「受限制的設定」，要到 應用程式→隨手記帳→⋮→允許受限制的設定；④電池→背景使用限制→永不休眠的應用程式 加入隨手記帳，否則會被休眠漏記。
- ✅ 2026-10-22 **安裝成功**。真正原因：使用者從 Claude App 內建瀏覽器（Custom Tab）點下載連結，畫面顯示已下載 398KB 但**檔案沒存進手機**。解法：複製網址 → 直接開 Chrome App 貼上下載。**以後給 APK 連結時一律提醒「用 Chrome 開」**。下一步：開通知存取權（受限制的設定）並用真實 LINE 銀行通知測試。

## 7. 犯過的錯與解法
- 金額格式化寫成 `Math.round(n*100/100)`（沒有四捨五入到小數 2 位）→ 改 `Math.round(n*100)/100`。
- 負數顯示成「NT$-176.5」→ `money()` 改為「−NT$176.5」。
- 上億金額會超出卡片 → `.stat-num` 用 `clamp()` 字級＋`overflow-wrap:anywhere`；圓環中央數字太長時縮小字級。
- 右下角 ＋ 按鈕擋住最後一張卡片 → `main` 底部加 72px 留白。
- `.month { display:flex }` 蓋掉 `hidden` 屬性，月份切換在總覽／設定也出現 → 加全域 `[hidden]{display:none!important}`。
- 解析：「於10/21在星巴克消費」店名抓成「10/21在星巴克」→ 去掉開頭日期與「在」；「交易通知＋商店：」沒寫「消費」被丟進待確認 → 有「商店：」欄位就視為支出。
- 雲端連不到 Google Maven → 用 Maven Central 的 Robolectric `android-all` jar＋自寫 WebViewAssetLoader stub 做 javac 編譯檢查（scratchpad，不進 repo）。

## 8. 測試方式
- 本機：在 repo 根目錄 `python3 -m http.server 8765` → 開 `http://localhost:8765/expense/`。
- 自動化：Playwright（雲端環境已預裝 Chromium：`/opt/node-tools/node_modules/playwright`），以 390×844 手機尺寸實際點按新增／編輯／搜尋／預算／重新整理後資料仍在／SW 註冊成功，console 0 錯誤。

## 9. 工具／Skill／MCP／API Key
- 未安裝任何 MCP、API Key、CLI；未建立新 Skill。
- 使用到的只有：Python PIL（畫 PNG 圖示）、Playwright（測試）、keytool（產生簽章金鑰）、GitHub Actions（編譯 APK）。
- 待申請（使用者本人）：財政部電子發票 API AppID（免費；申請表在電子發票整合服務平台）。

## 10. 之後可以做（建議，尚未實作）
0. 財政部 API 申請到 AppID 後：做「載具自動同步」（需 Cloudflare Pages Function 轉送＋簽章，手機條碼驗證碼只存在手機）。
1. **上架 Google Play**（注意：Google Play 對「通知存取權」審查嚴格，自動記帳版上架可能被拒）（可賺錢管道）：用免費的 Bubblewrap／PWABuilder 把 PWA 包成 TWA，只需付 Google Play 一次性 US$25 註冊費（**需使用者同意才做**）。
2. 雲端同步（多裝置）：可用 Firebase 免費方案或 Cloudflare KV，但要登入機制，需評估。
3. 固定支出（每月房租、訂閱自動記一筆）、多帳戶（現金／信用卡）、多幣別、發票載具匯入。
4. 獲利：App 內放 Google AdSense（網頁版）或做「進階版」一次買斷。
