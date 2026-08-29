# 法說會資料自動更新系統

## 這套系統解決什麼問題

**改版前**：法說會資料是人工一家一家查證後寫死在 `stock_analyzer.html` 裡的常數。
以每批 5 家、約 5 分鐘計，要建置 5,000～6,000 家需要 900 批、60～75 小時純執行，
而且每季財報季都要全部重做一次。這不是「Cloud 慢」，是這個做法本身無法規模化。

**改版後**：不再問「這 6,000 家公司誰有新資料？」（要 6,000 次請求），
改問「今天全市場有哪些新申報？」（一天只要幾個請求）。

```
免費公開官方資料源
   ↓  detect-events.mjs（一天幾個請求）
只挑出「今天真的有新事件」的公司
   ↓  analyze-earnings.mjs
Gemini 免費層分析（同一家同一季只做一次）
   ↓
data/ai/*.json commit 回 repo
   ↓
Vercel 靜態檔 → 所有使用者共用同一份分析
```

**實測效果（2026-08-29）**：當日真正有法說會/財報事件的是台股 63 家 + 美股 242 家，
而不是 6,000 家。

## 資料來源（全部免費、官方、已實測 HTTP 200）

| 用途 | 端點 |
|---|---|
| 美股事件偵測 | `www.sec.gov/Archives/edgar/daily-index/{年}/QTR{季}/form.{YYYYMMDD}.idx` |
| 美股代碼對照 | `www.sec.gov/files/company_tickers.json` |
| 上市重大訊息 | `openapi.twse.com.tw/v1/opendata/t187ap04_L` |
| 上市季度損益表 | `openapi.twse.com.tw/v1/opendata/t187ap06_L_ci`（1,035 家，一次請求） |
| 上櫃重大訊息 | `www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O` |
| 上櫃季度損益表 | `www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci`（874 家） |

> ⚠️ **重要更正**：交接記錄長期記載「TWSE 官方 API 全被 403 擋」。實測發現
> `openapi.twse.com.tw` 完全可用，先前的 403 應是從 Vercel 機房 IP 呼叫時被擋。
> 這再次印證交接記錄第 6.19 條的教訓：不要把單一情境的失敗推論成整個來源不可用。

## 零費用保證（使用者硬性規定）

1. **GitHub Actions**：本 repo 是 public，public repo 的 GitHub-hosted runner
   免費且不計分鐘數。
2. **Gemini 只用免費層**。免費層超額的行為是**「拒絕請求（HTTP 429）」而不是「開始計費」**，
   腳本收到 429 就停止，絕不改用任何付費模式。
3. **⚠️ 絕對不要在該 Google Cloud 專案啟用帳單（billing）**。
   Gemini 一旦啟用帳單，免費層會**整個消失**，從第一個 token 就開始計費。
   這是唯一可能讓這套系統產生費用的操作，永遠不要做。
4. **不使用任何資料庫服務**。KV / Upstash / Supabase 的免費層都需另外註冊、
   有額度、條款會變動。這裡用 git repo 當資料庫，沒有這些風險。
5. 另有 `MAX_ANALYSES` 上限，避免一次把當日免費額度用光。

## 檔案說明

| 檔案 | 作用 |
|---|---|
| `detect-events.mjs` | 事件偵測，產生 `data/events/queue.json` |
| `analyze-earnings.mjs` | 消費佇列做 AI 分析，寫出 `data/ai/*.json` |
| `extract-ir.mjs` | 一次性工具：把 IR 全文從 HTML 抽成 `data/ir/*.json` |
| `../.github/workflows/update-earnings.yml` | 每日排程（台灣時間早上 7:00） |

## 手動執行

```bash
# 只看「這次會處理哪些公司」，不呼叫 AI、不寫檔
DRY_RUN=1 node scripts/analyze-earnings.mjs

# 實際執行（需要 GEMINI_KEY）
node scripts/detect-events.mjs
GEMINI_KEY=xxx MAX_ANALYSES=40 node scripts/analyze-earnings.mjs
```

## 需要設定的 Secrets

在 GitHub repo 的 Settings → Secrets and variables → Actions 新增：

- `GEMINI_KEY`：Gemini API 金鑰（AIza 開頭，來自 aistudio.google.com/apikey）

在 Vercel 專案的環境變數新增（供使用者即時查詢時把結果寫回共用快取用）：

- `GITHUB_TOKEN`：具本 repo `contents:write` 權限的 token。
  **沒設也不影響功能**，只是使用者當場觸發的分析不會共用給其他人。

## 美股資料的取得方式

美股用 **SEC XBRL companyfacts**（`data.sec.gov/api/xbrl/companyfacts/CIK{10碼}.json`），
逐家查詢；佇列一天只有數十家，對 SEC 的頻率規範完全無虞。

（另有 frames API 可「一次拿全市場」，但它以**日曆季**對齊，像 NVDA 這種會計年度
不對齊日曆季的公司會查不到營收，故不採用。）

實作時踩到的四個坑，都已處理：

| 問題 | 症狀 | 處理 |
|---|---|---|
| 標籤會換 | Apple 2019 年起改用新的營收標籤，舊標籤停在 2018 年。若「第一個有資料的標籤就採用」，AAPL 會抓到 2018 年、MSFT 抓到 2011 年 | 比較**所有**標籤後取最新那筆 |
| 外國發行人 | 台積電、ASML 申報 20-F/6-K 而非 10-Q/10-K，會全部抓不到 | 表單過濾加入 20-F/40-F/6-K |
| IFRS 準則 | 外國公司資料在 `ifrs-full` 分類法下，標籤名稱完全不同（Revenue vs Revenues） | 同時支援 us-gaap 與 ifrs-full 兩套標籤 |
| 金融業 | 銀行不用一般營收標籤，JPM 原本抓到 2014 年的陳年數字 | 加入金融業標籤，並設**近一年安全閥**：抓到超過 400 天前的資料一律略過 |

> **安全閥的意義**：顯示過期數字比不顯示更糟。寧可略過該公司（保留既有人工內容），
> 也不能把舊數字當成最新財報給使用者看。

### 官方展望與分部營收（`lib/sec-press-release.mjs`）

XBRL 只有結構化「數字」，沒有兩樣最有價值的東西——**公司對下一季的官方展望**、
**分部／產品別營收**。這兩樣寫在公司隨 8-K 申報的財報新聞稿（EX-99.1）裡，SEC 免費公開。

實測 9/9 家成功取得（NVDA / AAPL / WMT / KO / GAP / JPM / TSM / ASML / MSFT）。踩到兩個坑：

| 問題 | 症狀 | 處理 |
|---|---|---|
| 大戶洗版 | JPM 每天發大量 424B2（結構型商品公開說明書），25,937 筆申報裡財報 8-K 被擠到第 80 筆之外，只掃前 80 筆完全找不到 | 掃描整個 recent 陣列 |
| 6-K 不一定是季報 | 台積電每月發「月營收」6-K，會抓到只有 3,281 字的月報而非季報 | 收集多個候選，逐一檢查內容是否真含營收＋獲利字樣 |

新聞稿最長達 14 萬字（台積電 Q2 合併報告），整份送 AI 會吃掉大量免費額度。
`focusExcerpt()` 只擷取展望與分部營收相關段落及前後文（實測壓到 5～40%，
提示詞約 3,400 tokens）。**只做節錄不做改寫**，原文一字不動，
確保 AI 只能引用真實存在的內容。

> ⚠️ Apple 顯示「無展望段落」是**正確的**——蘋果本來就不公布書面財測（見專案總綱第 3.1 節）。

**已知會被略過的公司**：台積電（TSM）等部分外國發行人在 SEC XBRL 裡**只有年報資料、
沒有季度資料**（TSM 最新只到 2024 全年），會被安全閥擋下。這是資料來源本身的限制，
不是程式問題——這些公司本來就有品質更好的人工 IR 內容。

## 目前的限制

1. **沒有免費逐字稿來源**。中小型公司（尤其台股）本來就沒有公開逐字稿，
   自動摘要只能根據財報數字，深度會比人工建置的淺。這是資料源的天花板。
2. **自動分析的品質低於人工建置**。現有 1,423 筆人工內容包含大量判讀
   （「業外收益驅動」「基期失真」等）。因此前端以人工 `data/ir/` 為主，
   自動產生的 `data/earnings/` 接在後面當補充；人工還沒建到的公司才單獨顯示自動摘要。
3. **免費層速率限制**。Gemini 免費層每分鐘約 10 次，腳本間隔 7 秒（約每分鐘 8.5 次）。
   一次執行 40 家約需 5 分鐘。想一次做更多要調高 `MAX_ANALYSES`，但要注意每日總量上限。
