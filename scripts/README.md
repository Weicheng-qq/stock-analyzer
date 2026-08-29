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

## 目前的限制

1. **美股分析尚未接上**。`detect-events.mjs` 已能偵測美股事件（SEC 每日索引運作正常），
   但 `analyze-earnings.mjs` 目前只處理台股——因為台股有官方 OpenAPI 一次給出
   全部公司的季度損益表，美股則需要逐家解析 SEC 的 8-K EX-99.1，工作量大得多。
   美股目前仍靠既有的 1,423 筆人工建置內容。
2. **沒有免費逐字稿來源**。中小型公司（尤其台股）本來就沒有公開逐字稿，
   分析深度會比大型股淺。這是資料源的天花板，不是架構能解決的。
3. **自動分析的品質低於人工建置**。現有 1,423 筆人工內容包含大量判讀
   （「業外收益驅動」「基期失真」等），自動化後靠 Gemini 判讀會有落差。
   因此前端仍以人工建置的 `data/ir/` 為優先，自動產生的 `data/ai/` 為補充。
