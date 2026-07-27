# 美股AI深度分析網站 — 專案專用提醒（本資料夾自動載入）

> 這是「股票」專案的操作原則。全域偏好（零費用、繁體中文、修正後自我驗證等）另見 `~/.claude/CLAUDE.md`，此處只放**本專案專屬**的重點，避免重複。

## 專案基本
- 公開網址：https://weicheng-stock.vercel.app ｜ 部署：`git push` → Vercel 自動部署（約1分鐘）
- **`stock_analyzer.html`（本機版）與 `index.html`（線上版）內容必須完全一致**：每次改完 `stock_analyzer.html` 都要 `cp stock_analyzer.html index.html` 再 commit。
- 完整技術交接：專案根目錄 `專案交接文件.md`（歷史踩坑、函式位置全記錄）。

## 以事實為依據（最重要的鐵則）
- 數字只能來自官方來源（SEC EDGAR / Yahoo / 公司官網 IR），**絕不可 AI 編造或用常識/訓練記憶臆測**，不做預測性斷言。
- 定性欄位（產品/競爭對手/護城河等）禁止回「無公開資料」，要用官方年報+維基組出實際內容；只有真正查無的「數字」才可留白。
- 遇到「AI 好像漏抓某事實」時，先查**官方文件全文**（用 /api/proxy 抓 SEC 全文），不要放寬 prompt 讓 AI 用常識硬補。

## 法說會內容：官網 IR 優先（每季主動更新，不等使用者提醒）
- **每間公司的「法說會 CEO 前景展望」都要先從該公司官網「投資人關係(IR)」找**法人說明會逐字稿、簡報、財務報表、營運績效報告、線上會議影片，擷取重點（特別是**最新成長展望 + 資本支出**）；**官網找不到才退回 SEC 官方新聞稿**。
- 官網常有 Cloudflare 擋 curl → 用**內建瀏覽器(mcp__Claude_Browser__)**登入取得 session cookie，read_page 拿檔案連結，再用「瀏覽器 cookie + 桌面 UA」curl 下載 PDF；逐字稿用 `pdftotext -enc UTF-8` 解析，簡報 JPG 可直接 Read 判讀（且常同步申報在 SEC）。
- 兩個常數（keyed by 股票代碼）：`IR_CALL_SUMMARY`（法說會展望，渲染於 `ai_guidance`）＋ `IR_PRODUCTS_SUMMARY`（產品/營收結構最新一季，渲染於 `ai_products`，比年報新）；另 `IR_QUARTERLY_PAGE` 放官網法說會頁連結。皆人工判讀寫死、優先於原本 SEC/AI 邏輯。競爭對手因法說材料不涵蓋、維持年報來源。
- **使用者要求：自選股裡「所有公司」產品與法說會都要官網 IR 優先（與台積電同邏輯）**。這是逐間手動建置、每季更新，分批進行。
  - **✅ 全部完成（50+ 檔，自選股 IR 官網優先全數建置）**：
    - 首批 30：TSM、NVO、INTC、LLY、NVDA、MU、GOOGL/GOOG、AAPL、META、MSFT、AMZN、TSLA、AMD、AVGO、ASML、QCOM、UBER、NFLX、BKNG、JPM、JNJ、PFE、COST、DELL、KO、SBUX、DIS、MAR、IHG、SKHY。
    - 續批 21（金融/資安/AI網通半導體/消費/能源/醫療/工業/航太）：GS、BAC、MS、ORCL、PLTR、IBM、V、MA、WMT、PEP、MCD、XOM、CRWD、PANW、ANET、MRVL、SMCI、ARM、ABNB、VRT、CVX、UNH、ABBV、AMGN、LRCX、CAT、GE、T、NKE、SPOT、BA、SHOP、PYPL。
    - INTC、GOOGL 已更新至 2026 Q2；SHOP 已改用美國國內申報(8-K，非6-K)。
    - （SPCX/SpaceX 未上市無法做）
  - **每季維護**：各檔每季法說後需人工更新對應 `IR_CALL_SUMMARY`＋`IR_PRODUCTS_SUMMARY`（見上方時程與取材技巧）。新增/更新時注意：先寫 IR_CALL_SUMMARY 的區塊、再寫 IR_PRODUCTS_SUMMARY，兩個物件的 anchor 容易搞混（曾把 call 內容誤植到 products，需用前一檔的獨特句子當 anchor 區分）。
  - 官網擋curl的(TSLA/LLY用Akamai bot manager，TLS指紋擋curl即使帶cookie也403/000)→退回SEC同一份官方8-K EX-99.1(內容相同)。
  - 官網CDN(q4cdn/CDN)多可直接curl(GOOGL/META/AMZN)；官網HTML新聞稿可用瀏覽器get_page_text(MSFT/AAPL)；少數官網擋curl(禮來Akamai)則退回SEC同一份官方文件。
  - **⚠️使用者明確要求：一律從「公司官網」抓，不要走 SEC 捷徑**（雖然SEC的8-K EX-99.1是同一份檔案，但使用者要官網來源、且官網常有更完整的簡報/逐字稿）。做法：內建瀏覽器開官網IR earnings頁→取PDF連結(多在q4cdn/CDN、無Cloudflare可直接curl)→pdftotext。範例：GOOGL=abc.xyz(q4cdn CDN)、AAPL=apple.com/newsroom、TSM/NVO=官網簡報/逐字稿。Python讀檔用Windows路徑(C:/...)非/c/...。
  - 蘋果不公布書面財測(展望於法說會口頭)，已於摘要註明。
  - **SPCX（SpaceX）無法做**：SpaceX 未上市、無公開財報/官方 IR 法說會，已告知使用者確認是否保留。
  - 美國公司 IR 頁通常有「Earnings Presentation」＋「Prepared Remarks(逐字稿)」PDF，多放在 CDN、無 Cloudflare，curl 即可下載（範例：INTC intc.com/financial-info/financial-results）。
- **新增一間公司的標準流程**：①內建瀏覽器開該公司官網投資人關係頁、取 cookie＋桌面UA ②curl 下載最新一季「投資人簡報／逐字稿 PDF」 ③`pdftotext -enc UTF-8` 解析 ④逐項核對後寫進 `IR_CALL_SUMMARY`＋`IR_PRODUCTS_SUMMARY`＋`IR_QUARTERLY_PAGE`（數字全照官方原文、金額換算億/兆、標幣別）。範例做法見 NVO：官網 financial-results 頁 → Q1-2026-investor-presentation.pdf。
- **主動更新責任在我**：每次與使用者對話（不限主題）都主動檢查已建置公司(TSM/NVO...)及自選股有無「比常數裡更新的一季」尚未更新，有的話主動提出並立刻依 IR 優先原則更新。時程：TSM 約每年 1/4/7/10 月中(站上 2026 Q2、下次 2026 Q3 約10月中)；NVO 約 2/5/8/11 月初(站上 2026 Q1、下次 2026 H1 約 2026/8/5)。
- 全自動排程不採用：可能計費（違反零費用）且背景排程拿不到互動瀏覽器、必卡 Cloudflare。

## 版面/視覺
- **手機 APP 畫面優先（硬性）**：此站主要設計為手機 APP，所有版面設計與完成後驗證，一律以「手機 APP 實際畫面」為主。驗證時用內建瀏覽器 `resize_window` 設 `width:390,height:844`（現代手機；勿用 375 小尺寸 SE 驗證，會過度斷行），實際截圖確認後再回報。設計新版面先想手機直式窄畫面。
- 版面已定案，勿主動提議改版（使用者已否決過 5 種改版風格）。
- 網站介紹區塊(#welcome)永久釘在標題與自選股之間、不隱藏；2×2 並排版面；投資總結獨立最後一項。
