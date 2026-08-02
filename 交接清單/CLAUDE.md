# 美股/台股 AI 深度分析 APP — 使用者定義的所有原則與細節

> **用途**：此檔是**唯一的完整總綱**，記錄使用者（版主）在所有歷史對話中定義過的原則、架構要求、犯過的錯、Skill 清單與自動化規則。每次開新 session 時，先讀取本檔 + `.claude/skills/交接手冊skill/交接記錄.md`（最新 session 進度）再開始工作。
> **最後更新**：2026-08-02 #3
> **公開網址**：https://weicheng-stock.vercel.app
> **原始碼位置**：`C:\Users\Amber Lin\weicheng claude\股票\`

---

## 1. APP 主旨、架構與內容要求

### 1.1 一句話定位
以「**以合理低估價格，買入擁有強大護城河的公司**」為投資哲學的個股深度分析網站（使用者要求把多餘的「的」刪掉的版本）。名稱為「**美股 AI 深度分析**」，支援美股與台股雙市場切換。

### 1.2 技術架構
- **純靜態單頁應用（SPA）**：單一 HTML 檔（`stock_analyzer.html`），內含全部 HTML/CSS/JS，無框架、無 build、無後端資料庫。
- **兩檔一致鐵則**：`stock_analyzer.html`（本機版）與 `index.html`（線上版）內容必須**完全一致**。每次改完必執行 `cp stock_analyzer.html index.html` 再 commit。可用 `diff -q stock_analyzer.html index.html` 驗證。
- **部署**：Vercel 免費方案，綁定 GitHub repo（Weicheng-qq/stock-analyzer）。`git push origin main` → 自動部署約 1 分鐘上線。
- **資料代理**：`/api/proxy`（Vercel Serverless）代理 SEC / Yahoo / StockAnalysis（繞 CORS）。是**白名單代理**，刻意不當萬用代理。`/api/ai`（Vercel Serverless）伺服器端呼叫免費 AI。
- **AI 模型**：伺服器端優先 Groq（`GROQ_KEY`，快且額度大）、失敗退 OpenRouter（`OPENROUTER_KEY`，`:free` 結尾模型）。訪客免設金鑰即可用（`useServer=!gmKey&&!isLocal`）；進階使用者可自行在 ⚙️ 貼 `gsk_...`(Groq) 或 `sk-or-...`(OpenRouter) 個人金鑰。免費 AI 模型有每日額度限制（OpenRouter 未儲值約每天 50 次；Groq 額度大很多），這是「用量限制」不是「費用」。
- **零費用**：所有環節一律免費——API、模型、託管、資料來源、工具。**任何可能產生費用的方案，必須先詢問使用者並取得明確同意**。
- **本機開發**：另有 `proxy.ps1` + `啟動.bat` 作為本機代理（非必要，線上版已走 Vercel API）。`.claude/launch.json` 設定 `python -m http.server 8765` 供本機預覽。

### 1.3 八大主題選單（`#grpMenu`，`showGroup(n)` / `cardGroup()`）
| 編號 | 選單項目 | 渲染/資料來源 |
|---:|---|---|
| 1 | 大盤指數＋自選股 | Yahoo Finance 即時報價（`loadIndexBar`，60秒刷新） |
| 2 | 關鍵財務指標（含公司股價 co-head 在最上） | SEC EDGAR 10年 / FinMind 10年（台股） |
| 3 | 護城河與彼得林區分類（護城河最上） | AI 分析 + 維基（台股） |
| 4 | 股價估值評估 | Yahoo + AI |
| 5 | 法說會未來前景 | `IR_CALL_SUMMARY`（官網 IR 優先） |
| 6 | 財經新聞（新聞上/目標價下） | Yahoo RSS / 新聞 API |
| 7 | AI 技術分析 | Chart.js + AI |
| 8 | 投資總結 | 版主選股原則 + AI 獨立判斷（見第 4 節） |
| 9 | 產品與服務（排在 2 前面） | `IR_PRODUCTS_SUMMARY`（官網 IR 優先） |

- `cardGroup` 依 `.ct` 文字分組（投資總結需在護城河前判斷，標題含「護城河」）。
- `#results` 是 `.results{display:none}` → `showGroup` 顯示要 `display:block`（非空字串）。
- 主動查詢後 `__jumpAfterSearch` 跳群組 2。

### 1.4 四大指數
- 美股：道瓊/標普500/那斯達克/費半（標題「四大指數」）。
- 台股：加權 `^TWII` + 櫃買 `^TWOII`（標題「加權指數」）。

### 1.5 自選股（`renderWatchlist`）
- 顯示：logo / 名稱 / 當日走勢線 SVG / 股價 / 漲跌 pill / 盤前後 / 漲跌解讀。
- 標題右側「✏️ 編輯」鈕（`toggleWlEdit`/`__wlEdit`）→ 編輯模式顯示 ☰ 拖曳把手，`initWlDrag` 用 pointer 事件一次拖到任意位置（手機觸控 OK），存回 localStorage。
- **預設自選股**：美股 = 台積電(TSM)/谷歌(GOOGL)/輝達(NVDA)/諾和諾德(NVO)；台股 = 台積電(2330)/鴻海(2317)/聯發科(2454)/台達電(2308)。
- **Logo 來源**：美股 FMP `image-stock/{代碼}.png`（DIS 空白 → `LOGO_ALT` 用 parqet）；台股同用 FMP，錯圖用 `TW_LOGO_ALT`（2317 鴻海→FXCOF）、`TW_LOGO_BAD` 退代碼底圖。
- **名稱要正確**：DELL＝戴爾（非台達電）；V＝威士卡（非「視覺」）。手機版名稱不可截斷。

### 1.6 美股/台股雙市場
- 切換機制：`getMarket()/setMarket()`（localStorage `market`，切換後 reload）。
- 漲跌顏色：美股**綠漲紅跌**；台股 `body.mkt-tw` 啟用**紅漲綠跌**（CSS 翻轉 pill/指數/盤前後/走勢線）。
- 台股代碼：純 4 碼數字（如 `'2454'`），不含 `.TW`/`.TWO`。內建 `TW_ALL`（code→name，1983 檔）＋ `TW_OTC`（上櫃 Set）靜態清單。`resolveTwInput(raw)` 支援中文名或代碼、自動判 .TW/.TWO（8299 群聯=.TWO）。`TW_NAMES` = 常用別名小表。
- **因 `/api/proxy` 抓 TWSE/TPEx/MOPS 官方 API 全被 403 擋，才改內建清單**。
- 台股分析：`doSearchTW(symbol)` 路徑——Yahoo 報價 + FinMind 10 年財務 + 維基百科定性 + AI 分析 + IR 常數官網內容。

### 1.7 版面/視覺
- **手機 APP 畫面優先（硬性）**：此站主要設計為手機 APP。所有設計與驗證一律以**手機 APP 實際畫面**為主（`resize_window width:390, height:844`，現代手機尺寸；勿用 375 小尺寸 SE 會過度斷行）。
- **版面已定案，勿主動提議改版**（使用者已否決過 5 種改版風格：Tech Innovation 電子藍、彭博終端機黑橘、紫藍玻璃、淺色專業、黑金奢華）。若使用者提視覺美化，先請他提供喜歡的參考網站/截圖。
- 網站介紹區塊 `#welcome`：2×2 並排版面；投資總結獨立最後一項。切換美股/台股後自動隱藏。
- 財務表格顯示 **10 年**（曾只顯示 7 年，已修正）。
- 已移除「原文翻譯」連結。
- **一律繁體中文回覆**：專有名詞可中譯並括號附英文縮寫（例：應用程式介面（API））。
- **手機預覽鐵則**：每次 Edit 存檔後，編輯器 PostToolUse hook 會自動把「檔案靜態快照（file://，桌面寬、不跑 JS）」推到 Browser 面板，蓋掉手機預覽。正解：用 `preview_start`（name:stock-preview）開 localhost 預覽，`resize_window` 設 390×844，每次要給使用者看之前用 `tabs_select` 把手機分頁拉到最前面再截圖。**收尾一定停在手機畫面。**

### 1.8 Google Play 上架相關
- App 計劃上架 Google Play（PWA 包 TWA/Bubblewrap）。
- 凡涉及「一般使用者會看到的畫面」都以上架為前提：不露技術性設定、金鑰、debug 訊息。
- 設定 Modal 已改為「✅ AI 已內建、免設定即可使用」，金鑰教學收進「進階(選填)」`<details>` 摺疊區。

---

## 2. 以事實為依據，絕不預測（最重要的鐵則）

- 數字**只能來自官方來源**（SEC EDGAR / Yahoo Finance / 公司官網 IR / MOPS / FinMind），**絕不可用 AI 編造、常識臆測或訓練記憶填補**。
- **不做預測性斷言**：不預測股價走勢、不預測營收成長率、不給出目標價。所有「前景展望」內容必須是公司管理層在法說會中**實際說過的話**。
- 定性欄位（產品/競爭對手/護城河等）**禁止回「無公開資料」**——必須用官方年報 + 維基百科組出實際內容。**只有真正查無的「數字」才可留白**。
- 遇到「AI 好像漏抓某事實」→ 先查**官方文件全文**（用 `/api/proxy` 抓 SEC 全文），**不要放寬 prompt 讓 AI 用常識硬補**。

---

## 3. 產品和法說會：公司官方網頁內容為主

### 3.1 總原則
使用者原話：**「所有搜尋的公司，產品和法說會請從公司網址去抓最新的資訊」**、**「與台積電邏輯一樣」**、**「一律從公司官網抓，不要走 SEC 捷徑」**。

- **每間公司**的「法說會 CEO 前景展望」和「產品/營收結構」，都要**先從該公司官網「投資人關係(IR)」專區**找：
  - 法人說明會逐字稿（Prepared Remarks / Transcript）
  - 投資人簡報（Earnings Presentation）
  - 財務報表、營運績效報告
  - 線上會議影片
- **只有在官網 IR 找不到時，才退回 SEC 官方新聞稿**（8-K EX-99.1 或 6-K）。
- 擷取重點特別注重：**最新成長展望 + 資本支出 + 下季財測**。
- 美國公司 IR 頁通常有「Earnings Presentation」+「Prepared Remarks(逐字稿)」PDF，多放在 CDN、無 Cloudflare，curl 即可下載（範例：INTC intc.com/financial-info/financial-results）。
- **AAPL 特殊**：不公布書面財測（展望於法說會口頭），已於摘要註明。

### 3.2 法說會影片
- 法說會內容頁面**最一開始放法說影片**，附**繁體中文字幕**。
- 目前僅台積電(TSM)有實際影片（非凡新聞 `JOhMwPVXRHM`）；其餘美股純語音法說會已改回指向官方 IR 重播頁面。
- `IR_CALL_VIDEO` 常數目前只保留 TSM。

### 3.3 三個核心常數（keyed by 股票代碼，人工判讀寫死）
| 常數 | 內容 | 渲染位置 |
|---|---|---|
| `IR_CALL_SUMMARY` | 法說會前景展望（最新一季） | `#ai_guidance` |
| `IR_PRODUCTS_SUMMARY` | 產品/營收結構（最新一季，比年報新） | `#ai_products` |
| `IR_QUARTERLY_PAGE` | 公司官網 IR 法說會頁面連結 | 來源連結 |

- 每筆格式：`{ quarter, source, html: \`...\` }`。
- 這三個常數的內容**優先於**原本的 SEC/AI 邏輯。
- **IR 內容在 AI 分析完成後才渲染出來**（不是一載入就顯示）。`renderAI()` 負責把 AI 結果與 IR 常數渲染到頁面。
- **競爭對手**因法說材料不涵蓋，維持年報/維基來源（不進這三個常數）。
- 美股 key = 股票代碼字串（如 `'TSM'`、`'NVDA'`）；台股 key = 純數字字串（如 `'2454'`、`'8299'`）。

### 3.4 抓取技巧
1. 官網常有 Cloudflare / Akamai 擋 curl。
2. 用**內建瀏覽器**（`mcp__Claude_Browser__`）開官網 IR earnings 頁 → 取 PDF 連結（多在 q4cdn/CDN，無 Cloudflare 可直接 curl）。
3. 再用「瀏覽器 cookie + 桌面 UA」curl 下載 PDF。
4. 逐字稿 PDF 用 `pdftotext -enc UTF-8` 解析（poppler 已安裝，Python 無 PDF 套件）。
5. 簡報 JPG 可直接 Read 判讀（且常同步申報在 SEC）。
6. **官網 CDN**（q4cdn / cloudfront）多可直接 curl（例：GOOGL=abc.xyz、META、AMZN）。官網 HTML 新聞稿可用瀏覽器 `get_page_text`（MSFT/AAPL）。
7. **SEC 備援**：SEC 8-K 的 EX-99.1（外國公司為 6-K）就是公司自己申報的同一份官方新聞稿。EDGAR 抓法：`data.sec.gov/submissions/CIK{10碼}.json` → 找 item 2.02 的 8-K（或 6-K）→ 用該筆 filing 的 `index.json` 列出檔案 → 抓 exhibit（檔名不一定含 `99`，也可能是 `...earningsrelease.htm`）。
8. **已知擋 curl 的公司**（退回 SEC 同一份文件）：TSLA / LLY（Akamai bot manager，TLS 指紋擋，即使帶 cookie 也 403/000）。
9. **台股官網抓取限制**：台股官網無法自動程式化抓取——`/api/proxy` 是白名單代理（只允許 SEC/Yahoo/StockAnalysis），且瀏覽器直抓官網被 CORS 擋。故台股比照美股做法：Claude 用內建瀏覽器逐間讀官網、人工寫進常數。Browser pane 只支援 localhost，外部公司官網需用 WebFetch（部分 SPA/SSL 會失敗）或 WebSearch。

### 3.5 新增一間公司的標準流程
1. 內建瀏覽器開該公司官網投資人關係頁、取 cookie + 桌面 UA。
2. curl 下載最新一季「投資人簡報/逐字稿 PDF」。
3. `pdftotext -enc UTF-8` 解析。
4. 逐項核對後寫進 `IR_CALL_SUMMARY` + `IR_PRODUCTS_SUMMARY` + `IR_QUARTERLY_PAGE`（數字全照官方原文、金額換算億/兆、標幣別）。
5. **驗證**：`grep -c "'SYM': {"` 應等於 **2**（call + products 各一）；用 Node.js `new Function(objSrc)` 編譯三個常數確認無語法錯誤（template literal 內小心 `` ` `` 與 `${`，寫的內容都避開）；`cp` 同步後 `diff -q`。

### 3.6 兩個物件 anchor 容易搞混（踩過的坑）
- 新增/更新時：**先寫 `IR_CALL_SUMMARY` 的區塊、再寫 `IR_PRODUCTS_SUMMARY`**。
- 兩個物件的 anchor（同一句話）容易搞混——曾把 call 內容誤植到 products。
- 解法：**用「前一檔的獨特句子」當 anchor** 來區分要插入的位置；寫完 `grep -c` 確認 = 2。

### 3.7 金額換算規則
- 美元 billion → **億**（1B = 10 億）。
- 保留原幣別：韓元用「兆韓元」、歐元用「億歐元」、新台幣用「億元（新台幣）」。
- **絕不做 AI 幣別換算**，只照官方原文換算單位。

### 3.8 已建置覆蓋範圍（50+ 美股 + 20 台股）
- **美股首批 30**：TSM、NVO、INTC、LLY、NVDA、MU、GOOGL/GOOG、AAPL、META、MSFT、AMZN、TSLA、AMD、AVGO、ASML、QCOM、UBER、NFLX、BKNG、JPM、JNJ、PFE、COST、DELL、KO、SBUX、DIS、MAR、IHG、SKHY。
- **美股續批（金融/資安/AI 網通半導體/消費/能源/醫療/工業/航太）**：GS、BAC、MS、ORCL、PLTR、IBM、V、MA、WMT、PEP、MCD、XOM、CRWD、PANW、ANET、MRVL、SMCI、ARM、ABNB、VRT、CVX、UNH、ABBV、AMGN、LRCX、CAT、GE、T、NKE、SPOT、BA、SHOP、PYPL。
- **台股 20 間**：2303 聯電、2308 台達電、2317 鴻海、2324 仁寶、2345 聯強、2357 華碩、2379 瑞昱、2382 廣達、2395 研華、2412 中華電、2454 聯發科、3008 大立光、3034 聯詠、3037 欣興、3105 穩懋、3231 緯創、3443 創意、3711 日月光、4938 和碩、8299 群聯。
- **特別註記**：INTC、GOOGL 已更新至 2026 Q2。SHOP 已從外國申報人(6-K)改用美國國內申報(8-K)。ARM 的 SEC 8-K EX-99.1 只是通知→需抓 EX-99.2 或官網。SpaceX（SPCX）未上市無法做。

---

## 4. 投資總結：兩個獨立判斷

投資總結區塊有**兩個獨立的分析**，不可混為一談：

### 4.1 版主選股原則
基於使用者（版主）定義的投資哲學：**「以合理低估價格，買入擁有強大護城河的公司」**。評估面向包括：
- 護城河強度（品牌/專利/轉換成本/網路效應/規模經濟）
- 估值是否合理或低估（本益比/自由現金流收益率等）
- 財務體質（10 年 ROE/毛利率趨勢/負債比）
- 成長動能（法說會管理層指引，非預測）

### 4.2 AI 獨立判斷
AI 根據所有已抓取的事實資料（財務數據 + 法說會 + 產品 + 護城河），做出**獨立的**投資建議（買入/持有/觀望/減碼）。AI 的判斷與版主選股原則**可以不一致**——兩者獨立呈現，讓使用者自行參考。

---

## 5. 美股和台股皆遵守的共通原則

以下原則**不分美股/台股，全部適用**：

1. **以事實為依據，絕不 AI 臆測**（見第 2 節）。
2. **法說會與產品一律「公司官網 IR 優先」**（見第 3 節）。
3. **全部免費**：資料來源、AI 模型、部署一律免費/開源。
4. **一律繁體中文**，專有名詞中譯附英文縮寫。
5. **修正後自我驗證**：改完自己先在瀏覽器操作 golden path 與邊界情況，不能讓使用者測試才發現錯誤。
6. **每季法說會後主動更新**，不等使用者提醒（見第 12 節）。
7. **手機 APP 畫面優先**：所有設計與驗證用 390×844（見第 1.7 節）。
8. **版面已定案，勿主動提議改版**。
9. **兩檔一致**：`stock_analyzer.html` === `index.html`。
10. **不加回 Service Worker**（曾造成無限刷新迴圈）。

### 台股特有補充

#### 台股資料來源對照（全部免費官方）
| 用途 | 美股來源 | 台股對應官方來源 |
|---|---|---|
| 個股報價/基本資料 | Yahoo Finance | **TWSE OpenAPI**（`openapi.twse.com.tw`）、櫃買 TPEx OpenAPI |
| 財務報表（10 年） | SEC EDGAR | **FinMind 免費 API**（CORS-enabled、無需金鑰；原 MOPS `mops.twse.com.tw` 被 403 擋） |
| 法說會（逐字稿/簡報） | 公司官網 IR / SEC 8-K | **公司官網 IR 優先**；退回 **MOPS「法人說明會」專區**（簡報 PDF、影音連結）、重大訊息 |
| 產品/營收結構 | 公司官網 IR | 公司官網 IR + **月營收公告（MOPS）** + 年報 |
| 重大訊息 | SEC 8-K | MOPS 即時重大訊息 |

#### 其他台股注意事項
- 台股代碼用 4 碼純數字（`'2454'`），不含 `.TW`/`.TWO`。上市走 TWSE、上櫃走 TPEx。
- 台股漲跌**紅漲綠跌**（CSS 由 `body.mkt-tw` 控制翻轉）。
- 台股 10 年財務用 **FinMind 免費 API**（`loadTwFinancials()` 用 `TaiwanFinancialStatements` 端點）。
- 台股定性分析（護城河/競爭對手/產品）用**中文維基百科**為事實基底（`fetchWikipediaZh()`，CORS-enabled），取代 AI 腦補，顯示「依維基百科整理」+ 維基連結。
- 雙掛牌股（如台積電 2330）走 `TW_US_EQUIV` 映射到美股代碼（`'2330':'TSM'`），共用美股事實內容。
- 幣別：新台幣，金額換算「億/兆」並標「元（新台幣）」。
- MOPS 抓取常需帶正確表單參數（POST）。

---

## 6. Claude 犯過的錯與解法（教訓清單）

### 6.1 Service Worker 無限刷新迴圈
- **錯**：自己寫的 kill-switch 用 `clients.claim()` + `c.navigate(c.url)` 造成無限迴圈。
- **解法**：SW 改成純 `unregister` + 清 caches，不做 navigate、不 claim。HTML 不再註冊 SW。**永遠不要再加回 SW。**

### 6.2 IR_CALL_SUMMARY 和 IR_PRODUCTS_SUMMARY anchor 搞混
- **錯**：新增/更新公司時，把法說會展望（call）的 HTML 誤植到產品（products）常數裡。
- **解法**：先寫 `IR_CALL_SUMMARY` 再寫 `IR_PRODUCTS_SUMMARY`，用「前一檔的獨特句子」當 anchor 區分插入位置。寫完 `grep -c "'SYM': {"` 確認 = 2。

### 6.3 用桌機畫面驗證（使用者多次糾正）
- **錯**：預覽瀏覽器每次 navigate/reload 會重置回桌機寬度，截圖前忘記重設。
- **解法**：**每次截圖前**都先呼叫 `resize_window width:390,height:844`。收尾一定停在手機畫面。

### 6.4 PostToolUse hook 蓋掉手機預覽
- **錯**：每次 Edit 存檔後，編輯器 PostToolUse hook 自動把「檔案靜態快照（file://，桌面寬、不跑 JS）」推到 Browser 面板，蓋掉手機預覽→使用者看到討厭的桌面畫面。
- **解法**：用 `preview_start`（name:stock-preview）開 localhost 預覽，`resize_window` 設 390×844，用 `tabs_select` 把手機分頁拉到最前面再截圖。收尾一定停在手機畫面。

### 6.5 在 Python inline 用 bash 會被 shell 吃掉的字元
- **錯**：多行 Python 嵌在 bash 裡執行，導致 `[d.]+: command not found`。
- **解法**：多行 Python 改寫成 `.py` 檔再執行。

### 6.6 SEC EDGAR UA 被擋 403
- **錯**：curl 沒帶合規 User-Agent。
- **解法**：SEC 抓取一定帶 `"Mozilla/5.0 ... stock-research aa910517@gmail.com"`。

### 6.7 CIK 查錯公司
- **錯**：IHG 用了 CIK 0001159152，實際是 James Hardie（JHX）。
- **解法**：永遠用 `cik_map.json`（來自 SEC `company_tickers.json`）查 CIK，不要憑記憶。

### 6.8 ARM SEC 附件只有通知、沒有財報數字
- **錯**：SEC 8-K 的 exhibit 99.1 只是「指向官網股東信」的簡短通知，不含任何財務數字。
- **解法**：改抓 exhibit 99.2（完整股東信含 Q2 財測等數據），或直接從官網下載。

### 6.9 台股 AI 全靠腦補（最嚴重的品質問題）
- **錯**：台股 `doSearchTW` 把 `__wikiData` 等全設 null，產品/競爭對手/護城河全靠 AI 現編，內容糟糕且違反「以事實為依據」鐵則。使用者反映：群聯內容糟透了、台積電台股 vs 美股內容不一致。
- **解法**：新增 `fetchWikipediaZh()` 抓中文維基百科（CORS-enabled），`doSearchTW` 在 AI 呼叫前填入 `window.__wikiData`；定性內容改以維基事實為準、畫面顯示「✅ 依維基百科整理」+ 維基連結。再加上 20 間台股官網 IR 常數（`IR_CALL_SUMMARY` / `IR_PRODUCTS_SUMMARY`），官網內容渲染為主、蓋過 AI/維基。

### 6.10 未充分確認就用付費功能
- **錯**：曾在未充分確認下用使用者金鑰測試付費網路搜尋（花費約 US$0.005）。
- **解法**：**任何可能產生費用的操作，即使只是測試一次，也必須先明確告知使用者並取得同意**。

### 6.11 曾主動提議改版（使用者已否決 5 種）
- **錯**：使用 theme-factory 連續提出 5 種視覺風格，全被否決。
- **解法**：不主動提議視覺改版。若使用者提視覺美化，先請他提供喜歡的參考網站/截圖。

### 6.12 台股官方 API 全被 403
- **錯**：`/api/proxy` 抓 TWSE/TPEx/MOPS 官方 API 全被 403 擋。
- **解法**：改用內建靜態清單（`TW_ALL` 1983 檔）+ Yahoo + FinMind 免費 API。

### 6.13 FMP 台股 logo 圖不可靠
- **錯**：FMP 的台股 logo 有些回錯（2317 鴻海回 T 恤照、DIS 美股回空白）。
- **解法**：`TW_LOGO_ALT`（如 2317→FXCOF 替代代碼）、`TW_LOGO_BAD`（退回代碼底圖）、`LOGO_ALT`（美股如 DIS→parqet 來源）。

### 6.14 Chart.js 在 display:none 容器建立→canvas 0×0
- **錯**：技術分析圖在隱藏群組建立，canvas 寬高為 0。
- **解法**：`showGroup` 顯示群組 7 時，若 `techChart` 寬為 0 則重跑 `loadTechnical`。

### 6.15 金鑰外流
- **錯**：使用者在對話中截圖/貼出金鑰（`gsk_` 或 `sk-or-` 開頭）。
- **解法**：視為已外流，須提醒使用者重新產生，不可再使用。

---

## 7. 關鍵財務數據：同樣以公司官方網頁為主

### 7.1 美股財務數據來源優先順序
1. **SEC EDGAR（官方）**：10 年毛利率/淨利率/ROE/營收成長率。`data.sec.gov/submissions/CIK{10碼}.json` → 找 10-K/20-F/40-F/6-K。`isAnnualForm` 接受四種表單；`extractAnnual` 用「財年結束月份」比對；`pickUnit(units, instant)` 挑年度資料最多的幣別。
2. **Yahoo Finance**：最新季度/年度數據、即時股價、技術分析圖表。
3. **公司官網 IR**：法說會中公布的最新季度營收/EPS/毛利率（`IR_CALL_SUMMARY` 和 `IR_PRODUCTS_SUMMARY` 中已人工寫入，比年報更新）。

### 7.2 台股財務數據來源
1. **FinMind 免費 API**（CORS-enabled、無需金鑰）：10 年年度營收/毛利率/淨利率/ROE。`loadTwFinancials()` 已重寫為 FinMind `TaiwanFinancialStatements` 端點，key = 台股代碼不含 `.TW`。
2. **Yahoo Finance（.TW/.TWO）**：即時股價、技術分析圖表。
3. **公司官網 IR**（同美股邏輯，20 間已建常數）。

### 7.3 鐵則
- 財務數字若公司官網 IR 有最新版（比 SEC/FinMind 更新一季），以官網 IR 為準。
- 不用 AI 推算、插值或預測任何財務數字。

---

## 8. 過去上下文所有重要細節

### 8.1 已完成的重大功能
- **自選股拖曳排序**：原本 ▲▼ 按鈕改為「✏️ 編輯模式 + ☰ 拖曳把手」（pointer 事件 + touch-action:none 支援手機觸控）。
- **喚回即時刷新**：手機從背景喚回(PWA/bfcache)時股價停舊值。新增 `refreshLiveData()` 監聽 `visibilitychange`/`pageshow persisted`(強制)/`focus`，回前景就地重抓自選股股價+走勢+指數（15 秒節流）。
- **自選股字體放大**：logo 30→34px、公司名/股價 14.5→16px、代碼 11→12px、漲跌幅 pill 12.5→14px。指數列同步放大：名稱 14.5→16、數值 14→17、漲跌幅 12.5→14.5px。
- **設定 Modal 上架友善版**：伺服器端 `/api/ai` 已用伺服器端金鑰免費代跑 AI，使用者免設金鑰即可用。原本金鑰教學改收進「進階(選填)」`<details>` 摺疊區。
- **拆分大盤指數與自選股**為兩個獨立選單項目。
- **切換美股/台股後隱藏歡迎介紹**：`#welcome` 區塊自動隱藏。
- **台股 10 年年度財務**改用 FinMind（從 Yahoo 4 年升級）。
- **台股維基百科事實基底**：`fetchWikipediaZh()` 從中文維基百科抓定性資料，取代 AI 腦補。已端到端實測群聯 8299：產品=NAND 控制晶片/SSD/隨身碟/記憶卡控制晶片、競爭對手=慧榮/美光/三星、排名=全球獨立 NAND 控制晶片龍頭，全部正確有來源。
- **台股 AI 提示詞語境化**：`callGemini` 台股 ctx 加 `market:'tw'`，提示詞改「你是專業台股分析師」並註明台灣上市/上櫃、金額以新台幣為主、定性以中文維基為依據。
- **雙掛牌共用美股內容**：`TW_US_EQUIV` 映射台積電 2330→TSM，`doSearchTW` 對雙掛牌股把 `window.__symbolForLinks` 指向美股代碼 → `renderAI` 渲染該美股已建的官方產品/法說會展望事實，股價仍顯示 NT$。
- **台股 20 間官網 IR 建置完成**（IR_CALL_SUMMARY + IR_PRODUCTS_SUMMARY + IR_QUARTERLY_PAGE 各 20 間）。
- **美股 50+ 間官網 IR 全數建置完成**。

### 8.2 關鍵前端函式速查
| 函式/常數 | 功能 |
|---|---|
| `renderAI()` | 把 AI 分析結果與 IR 常數渲染到頁面 |
| `doSearch(symbol)` | 美股個股分析主流程 |
| `doSearchTW(symbol)` | 台股個股分析主流程 |
| `loadTwFinancials(symbol,gen)` | FinMind 抓台股 10 年財務 |
| `fetchWikipediaZh(name,code)` | 抓中文維基百科（台股定性基底） |
| `callGemini(ctx)` | 呼叫 AI（Groq/OpenRouter） |
| `showGroup(n)` / `cardGroup()` | 主題選單切換 |
| `loadIndexBar()` | 四大指數/加權指數（60 秒刷新） |
| `renderWatchlist()` | 自選股渲染（含走勢線 SVG） |
| `getMarket()` / `setMarket()` | 美股/台股切換 |
| `resolveTwInput(raw)` | 台股代碼↔名稱解析 |
| `refreshLiveData()` | 喚回即時刷新（visibilitychange/pageshow/focus） |
| `toggleWlEdit()` / `initWlDrag()` | 自選股編輯模式＋拖曳排序 |
| `loadTechnical()` | 技術分析圖表（Chart.js） |
| `fillNews()` | 新聞渲染 |
| `isAnnualForm()` / `extractAnnual()` / `pickUnit()` | SEC 10 年財務資料解析 |

### 8.3 2026 Q2 財報季 IR 常數更新狀態（截至 2026-08-02）

#### 美股（已更新 19+ 檔）
AAPL / MSFT / META / AMZN / V / MA / QCOM / KO / XOM / CVX / ABBV / VRT / BA / PYPL / SBUX / TSLA / ARM / LRCX / SKHY 等。

#### 台股 20 間 Q2 更新狀態
| 代碼 | 公司 | 目前季度 | 狀態 |
|------|------|---------|------|
| 2303 | 聯電 | Q2 | ✅ 已更新 |
| 2308 | 台達電 | Q2 | ✅ 已更新 |
| 2317 | 鴻海 | Q2 | ✅ 已更新 |
| 2324 | 仁寶 | Q1 | 📅 Q2 法說會待公告 |
| 2345 | 聯強 | Q1 | 📅 Q2 法說會待公告 |
| 2357 | 華碩 | Q1 | 📅 Q2 法說會待公告 |
| 2379 | 瑞昱 | Q2 | ✅ 已更新（7/30 法說會） |
| 2382 | 廣達 | Q2（月營收） | ⏳ 8/12 正式法說會後補 EPS/毛利率 |
| 2395 | 研華 | Q1 | 📅 8/5 法說會 |
| 2412 | 中華電 | Q1 | 📅 Q2 法說會待公告 |
| 2454 | 聯發科 | Q2 | ✅ 已更新 |
| 3008 | 大立光 | Q2 | ✅ 已更新（7/9 法說會） |
| 3034 | 聯詠 | Q1 | 📅 Q2 法說會待公告 |
| 3037 | 欣興 | Q2 | ✅ 已更新（7/29 法說會） |
| 3105 | 穩懋 | Q2 | ✅ 已更新 |
| 3231 | 緯創 | Q1 | ✅ 已更新（Q1 財報＋6/4 法說會） |
| 3443 | 創意 | Q2 | ✅ 已更新 |
| 3711 | 日月光 | Q2 | ✅ 已更新（7 月法說會） |
| 4938 | 和碩 | Q1 | 📅 8/12 法說會 |
| 8299 | 群聯 | Q1 | 📅 8/13 法說會 |

#### 美股即將到來
- SPOT Q2（8/4）、NVO H1（~8/5-6）、SMCI 正式版（8/11）
- 8 月中下旬密集：AMD/PLTR/UBER/ABNB/MCD/DIS 等

### 8.4 已知待修問題
- ~~台股估值卡本益比~~：✅ 已完成（loadYahooFin + computePe5yRange + renderTwPeChecklist）。
- ~~setMarket + doSearchTW 競態~~：✅ 已釐清非缺陷。`setMarket` 本身就是「寫 localStorage → `location.reload()`」，程式化連續呼叫時 doSearch 跑在即將被重載銷毀的頁面上，故看似未渲染。真實使用者點市場鈕→頁面重載→再輸入搜尋，流程正常。**自動化測試須分兩步**：先 `setMarket` 等重載完成，再設 `searchInput` 值呼叫 `doSearch()`。
- 美股法說影片：僅台積電有實際影像；美股純語音改回官方 IR 重播；`IR_CALL_VIDEO` 只留 TSM。
- ~~雙掛牌美股事實內容僅台積電~~：✅ 已完成。`TW_US_EQUIV`（台股→美股，2330→TSM）＋ `US_TW_EQUIV`（美股 ADR→台股，UMC→2303／ASX→3711／CHT→2412）雙向共用官方事實。

---

## 9. 建立過的 Skill

### 9.1 交接手冊skill
- **路徑**：`.claude/skills/交接手冊skill/`（含 `SKILL.md` + `交接記錄.md`）
- **觸發**：使用者開新 session 輸入 `/交接手冊skill` 或叫 Claude「讀交接清單」。
- **功能**：讀取 `交接記錄.md`，用 1-2 句話確認接續主題與上次進度，依照未完成事項繼續工作。

### 9.2 股票APP
- **路徑**：`.claude/skills/股票APP/SKILL.md`
- **觸發**：使用者提到「股票APP」。
- **功能**：用建立美股網站的同一套精神與方法，建立或擴充台股版深度分析功能。核心精神完全沿用本檔所列所有原則。
- **台股資料來源**：見第 5 節「台股資料來源對照表」。
- **建立步驟**：
  1. 沿用美股版的版面、樣式、`renderAI()` 渲染邏輯，改台股資料源與代碼。
  2. 逐間台股公司照「新增一間公司標準流程」（第 3.5 節）建三個常數。
  3. 驗證：`grep -c` = 2、Node.js 編譯、`cp` 同步、瀏覽器實際操作。
  4. Vercel 免費部署，`git push` 上線。
- **預設自選股**：台積電(2330)/鴻海(2317)/聯發科(2454)/台達電(2308)。

---

## 10. 上下文管理：自動壓縮與交接

- **當上下文內容滿 70% 以上**，自動先壓縮上下文。
- **若無法再壓縮，需要換新 session 時**：
  1. 先更新交接記錄（`.claude/skills/交接手冊skill/交接記錄.md`）。
  2. 主動通知使用者需要開新 session。
- **當使用者開新對話時**：
  1. 先讀取本檔（`交接清單/CLAUDE.md`）+ 交接記錄（`.claude/skills/交接手冊skill/交接記錄.md`）。
  2. **確認「需求完成狀態總表」（附錄 B）是否有遺漏未完成的項目**——若有，主動列出並詢問使用者要否繼續處理。
  3. **比對今天日期 vs 各公司法說會時程**，檢查有無新法說會已發布但常數未更新。
  4. 再開始工作。
- 這是**永久性規則**，每個 session 都適用。

---

## 11. 每次對話告一段落，自動更新交接清單

- 每次與使用者的對話告一段落（使用者說「先這樣」、「今天到這」、一段工作完成、或 session 即將結束），**自動更新以下文件**：
  1. `.claude/skills/交接手冊skill/交接記錄.md`（最新 session 做了什麼 + 待辦 + 踩坑）
  2. 本檔 `交接清單/CLAUDE.md`（若有新的原則/架構變更/犯錯教訓需補記）
- 更新內容包括：
  - 本次完成了什麼
  - 尚未完成/待辦事項
  - 犯過的新錯誤與修正方式
  - 使用者新強調的偏好與限制
  - 各公司 IR 常數目前停在哪一季

---

## 12. 每間公司法說會隔天，自動更新法說內容

### 12.1 主動更新責任
使用者三次強調（原話）：
1. **「INTEL 和 Google 有新法說會怎麼沒更新」**
2. **「你可以自己每季法說會後自己去更新，不要我提醒你才去做」**
3. **「以後若有其他公司的最新法說會，你要自動去更新網站資訊，不要被我發現你沒更新最新資訊」**

### 12.2 落實做法
- **每次與使用者對話（不限主題）**，開場先快速比對「今天日期 vs 各公司財報時程」。
- 凡是已發布但常數還停在舊季的，**主動抓官網 IR 更新、不用等使用者開口**。
- 美股可用 SEC EDGAR（`data.sec.gov/submissions/CIK{10碼}.json` → 找 8-K item 2.02）批次檢查哪些公司有新財報但常數未更新。工具腳本在 scratchpad：`check_q2.py`（需先下載 `cik_map.json`，SEC `company_tickers.json`）。
- 台股用 WebSearch 搜尋「公司名 法說會 最新季度」確認是否已舉辦。

### 12.3 時程參考（主要公司）
| 公司 | 法說會通常時間 | 備註 |
|---|---|---|
| TSM 台積電 | 每年 1/4/7/10 月中 | 目前站上 2026 Q2，下次 Q3 約 10 月中 |
| NVO 諾和諾德 | 每年 2/5/8/11 月初 | 目前站上 Q1，H1 約 8/5-6 |
| 美股多數 | 每年 1/4/7/10 月下旬密集 | 財報季 |
| 台股多數 | 每年 3/5/8/11 月 | 季報後法說會 |

### 12.4 全自動排程不採用
- 理由：排程雲端代理可能產生費用（違反零費用鐵則）、背景排程拿不到互動瀏覽器（Cloudflare 必擋）。
- **折衷做法**：每次與使用者對話時主動檢查，相當於「每間公司法說會隔天」（因使用者幾乎每天都有對話）。

---

## 附錄 A：環境與踩坑速查

- **工作目錄**：`C:\Users\Amber Lin\weicheng claude\股票`
- **Shell**：PowerShell（主）+ Bash（POSIX 腳本）
- **Python 中文輸出**：用 `PYTHONIOENCODING=utf-8` + `sys.stdout.buffer.write(...encode())`，避免 cp950 UnicodeEncodeError
- **Python 讀檔**：用 Windows 路徑（`C:/...`）非 `/c/...`
- **SEC UA**：`Mozilla/5.0 (...) AppleWebKit/537.36 stock-research aa910517@gmail.com`
- **SEC exhibit 抓法**：用該筆 filing 的 `index.json` 列檔最穩（檔名不一定含 `99`，也可能是 `...earningsrelease.htm`）
- **語法驗證**：Python 抽出最大 `<script>` 存 `_c.js` → `node --check`。或 Node.js `new Function(objSrc)` 編譯三個常數。Template literal 內小心 `` ` `` 與 `${`。
- **預覽伺服器**：`.claude/launch.json` 設定 `python -m http.server 8765`
- **Git**：`git push origin main` → Vercel 自動部署
- **本機代理**：`proxy.ps1` + `啟動.bat`（非必要，線上版已走 Vercel API）
- **金鑰安全**：若使用者曾在對話中截圖/貼出金鑰（`gsk_` 或 `sk-or-` 開頭），視為已外流，須提醒重新產生

---

## 檔案索引

| 檔案 | 位置 | 用途 |
|---|---|---|
| 本檔 `CLAUDE.md` | `交接清單/` | **完整總綱**（原則、架構、犯錯、Skill、自動化規則） |
| `交接記錄.md` | `.claude/skills/交接手冊skill/` | **最新 session 進度**（做了什麼 + 待辦）、每次對話結束時更新 |
| `SKILL.md` | `.claude/skills/股票APP/` | 股票APP 正式技能定義（`/股票APP` 觸發） |
| `SKILL.md` | `.claude/skills/交接手冊skill/` | 交接手冊技能定義（`/交接手冊skill` 觸發） |
| `skill架構內容.xlsx` | `交接清單/` | 使用者原話精神紀錄（Excel 參考） |
| `stock_analyzer.html` / `index.html` | 專案根目錄 | 主程式（必一致） |

---

## 附錄 B：需求完成狀態總表

> **用途**：每次開新 session 時，對照此表確認是否有遺漏未完成的項目。
> **圖例**：✅ 已完成 ｜ ⏳ 進行中 ｜ 📅 排程中（等日期/事件） ｜ ❌ 未開始

### B.1 核心架構與部署
| 狀態 | 需求 | 說明 |
|:---:|------|------|
| ✅ | 單一 HTML SPA | `stock_analyzer.html` 內含全部 HTML/CSS/JS |
| ✅ | 兩檔一致鐵則 | `stock_analyzer.html` === `index.html`，改完必 cp |
| ✅ | Vercel 免費部署 | `git push` → 自動部署 |
| ✅ | `/api/proxy` 白名單代理 | 代理 SEC/Yahoo/StockAnalysis（繞 CORS） |
| ✅ | `/api/ai` 伺服器端 AI | 免費 Groq/OpenRouter，訪客免設金鑰 |
| ✅ | 零費用政策 | 所有環節一律免費 |
| ✅ | 一律繁體中文 | 專有名詞中譯附英文縮寫 |
| ✅ | 本機代理 proxy.ps1 | 非必要，線上版已走 Vercel API |

### B.2 資料來源
| 狀態 | 需求 | 說明 |
|:---:|------|------|
| ✅ | SEC EDGAR 10 年財務（美股） | 毛利率/淨利率/ROE/營收 |
| ✅ | Yahoo Finance 即時報價 | 股價/走勢/技術分析 |
| ✅ | FinMind 10 年財務（台股） | 取代 MOPS（被 403 擋） |
| ✅ | 公司官網 IR 優先 | 法說會/產品一律官網 IR 先 |
| ✅ | 中文維基百科（台股定性） | 護城河/產品/競爭對手的事實基底 |
| ✅ | Yahoo 補充最新年度/季度 | SEC 申報延遲時用 Yahoo 補值 |

### B.3 內容與分析功能
| 狀態 | 需求 | 說明 |
|:---:|------|------|
| ✅ | 50+ 美股 IR 常數 | IR_CALL_SUMMARY + IR_PRODUCTS_SUMMARY |
| ✅ | 20 台股 IR 常數 | 同上，keyed by 4 碼數字 |
| ✅ | IR_QUARTERLY_PAGE 連結 | 20 台股＋50+美股官方 IR 頁面連結 |
| ✅ | 八大主題選單 | showGroup(1~9) 分組 |
| ✅ | AI 分析（Groq/OpenRouter） | 免費模型，伺服器端代跑 |
| ✅ | 彼得林區六大分類 | AI 依原著邏輯自行判斷 |
| ✅ | 護城河分析 | 品牌/專利/轉換成本/網路效應/規模經濟 |
| ✅ | 競爭對手分析 | 前三大競爭對手 & 世界排名 |
| ✅ | 年營收圖表（美股） | Chart.js 長條圖＋成長率折線 |
| ✅ | 技術分析圖表 | K 線/均線/布林軌道 |
| ✅ | 財經新聞 | Yahoo RSS |
| ✅ | 投資大行目標價（美股） | StockAnalysis 或 Yahoo |
| ✅ | 兩個投資判斷 | 版主選股原則 + AI 獨立判斷 |
| ✅ | 法說會影片（TSM） | 非凡新聞 YouTube 嵌入 |

### B.4 估值與選股準則
| 狀態 | 需求 | 說明 |
|:---:|------|------|
| ✅ | 美股本益比（Yahoo trailing） | 現值＋歷史季度 |
| ✅ | 美股 5 年本益比區間＋視覺化 gauge | pe-gauge 滑動條 |
| ✅ | 美股競爭對手本益比比較 | 抓三家對手的 PE |
| ✅ | 美股 7 項選股準則檢查清單 | 淨利率/毛利率/ROE/營收/本益比等 |
| ✅ | 美股版主選股判斷（verdict） | 買入觀察區/好公司待價格/暫不符合 |
| ✅ | **台股本益比** | Yahoo timeseries trailingPeRatio，已於 doSearchTW 中載入 |
| ✅ | **台股 5 年本益比區間＋gauge** | computePe5yRange + renderTwPeChecklist 量表 |
| ✅ | **台股 7 項選股準則檢查清單** | 7 項自動檢核（淨利率/毛利率/ROE/營收/成長/本益比×2） |
| ✅ | **台股版主選股判斷（verdict）** | tw_chk_verdict 自動歸納買入/觀察/暫不符合 |

### B.5 UI/UX
| 狀態 | 需求 | 說明 |
|:---:|------|------|
| ✅ | 手機 APP 畫面優先（390×844） | 所有設計/驗證以手機為主 |
| ✅ | 美股/台股雙市場切換 | getMarket/setMarket + localStorage |
| ✅ | 台股紅漲綠跌 | body.mkt-tw CSS 翻轉 |
| ✅ | 自選股拖曳排序 | ☰ 拖曳把手 + pointer 事件（手機觸控 OK） |
| ✅ | 預設自選股 | 美股 TSM/GOOGL/NVDA/NVO；台股 2330/2317/2454/2308 |
| ✅ | Logo 容錯機制 | LOGO_ALT/TW_LOGO_ALT/TW_LOGO_BAD |
| ✅ | 四大指數/加權指數 | 60 秒自動刷新 |
| ✅ | 歡迎介紹區 2×2 | 切換市場後自動隱藏 |
| ✅ | 喚回即時刷新 | visibilitychange/pageshow/focus 觸發 |
| ✅ | 自選股字體放大 | logo 34px、名稱 16px 等 |
| ✅ | 設定 Modal 上架版 | AI 內建免設定，金鑰收進摺疊區 |
| ✅ | 永不加回 Service Worker | 曾造成無限刷新迴圈 |
| ✅ | 版面定案不主動改版 | 已否決 5 種風格 |
| ✅ | 財務表格顯示 10 年 | 曾只顯示 7 年，已修正 |

### B.6 自動化規則
| 狀態 | 需求 | 說明 |
|:---:|------|------|
| ✅ | 每季法說會後主動更新 | 不等使用者提醒 |
| ✅ | 上下文滿 70% 自動壓縮 | PreCompact hook |
| ✅ | 對話告一段落自動更新交接 | 更新交接記錄.md + CLAUDE.md |
| ✅ | 開新 session 先讀交接清單 | 讀本檔＋交接記錄 |
| ✅ | 開新 session 確認未完成項目 | 對照此表 + 法說會時程 |
| ✅ | 修正後自我驗證 | 改完自己先在瀏覽器操作 |

### B.7 已知待修問題
| 狀態 | 問題 | 說明 |
|:---:|------|------|
| ✅ | 台股估值卡本益比 | 已完成：loadYahooFin + computePe5yRange + renderTwPeChecklist |
| ✅ | ~~setMarket/doSearchTW 競態~~ | 非缺陷：`setMarket` 本質是 `location.reload()`，程式化連呼會被重載中斷。真實使用者點按鈕→重載→再搜尋完全正常。**測試時須分兩步**：先 setMarket 等重載完，再設值搜尋 |
| ✅ | ~~美股法說影片僅 TSM~~ | 非缺陷：美股法說會本身多為純語音（audio webcast），無影像可放。台積電有非凡新聞電視轉播故獨有。其餘退回官方 IR 重播頁按鈕，符合「以事實為依據」原則 |
| ✅ | 雙掛牌 ADR | US_TW_EQUIV 反向對照：UMC→2303/ASX→3711/CHT→2412 共用台股官方事實 |
| ❌ | Google Play 上架 | TWA/Bubblewrap 包裝，尚未實際提交 |

### B.8 法說會排程更新（依日期）
| 狀態 | 日期 | 公司 | 說明 |
|:---:|------|------|------|
| 📅 | 8/4 | SPOT Q2 | 美股 |
| 📅 | 8/5 | 研華(2395) Q2 | 台股法說會 |
| 📅 | ~8/5-6 | NVO H1 | 美股 |
| 📅 | 8/11 | SMCI 正式版 | 美股 |
| 📅 | 8/12 | 廣達(2382) Q2 正式 | 台股法說會，目前已有月營收 |
| 📅 | 8/12 | 和碩(4938) Q2 | 台股法說會 |
| 📅 | 8/13 | 群聯(8299) Q2 | 台股法說會 |
| 📅 | 8 月中下旬 | AMD/PLTR/UBER/ABNB/MCD/DIS | 美股密集 |
| 📅 | 待公告 | 華碩(2357)/聯詠(3034)/中華電(2412)/仁寶(2324) | 台股 Q2 法說會日期未定 |
