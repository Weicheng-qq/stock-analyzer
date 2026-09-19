# 搬到 Cloudflare Pages 部署教學

> 為什麼要搬：Vercel Hobby 方案**僅限非商業用途**，明文包含「放廣告」與「向使用者收費」。
> 只要將來要靠 AdMob 或訂閱獲利，就必須離開 Hobby（Pro 為 US$20/月）。
> Cloudflare Pages 免費方案**允許商業用途**，而報價代理早就在 Cloudflare 上穩定運作。
>
> 全程免費，不需要綁信用卡。

## 已經準備好的檔案（不用動）

| 檔案 | 對應原本 Vercel 的 | 說明 |
|---|---|---|
| `functions/api/proxy.js` | `api/proxy.js` | 資料代理（SEC、Yahoo、證交所…） |
| `functions/api/ai.js` | `api/ai.js` | 伺服器端 AI（Gemini → Groq → OpenRouter） |
| `functions/api/ai-cache.js` | `api/ai-cache.js` | AI 結果共用快取（寫回 GitHub） |
| `functions/api/caption.js` | `api/caption.js` | 字幕（目前停用，保持對等） |
| `_headers` | `vercel.json` 的 headers | HTML 不快取、資料檔快取 |

`api/` 與 `vercel.json` **先不要刪**：搬家期間 Vercel 要繼續正常服務，兩邊並行。

---

## 步驟 1：建立 Pages 專案

1. 登入 <https://dash.cloudflare.com>
2. 左側選單 **Compute (Workers)** → **Workers & Pages**
3. 右上 **Create** → 切到 **Pages** 分頁 → **Connect to Git**
4. 授權 GitHub，選擇 repo **`Weicheng-qq/stock-analyzer`** → **Begin setup**

## 步驟 2：建置設定（重點：全部留空）

| 欄位 | 填什麼 |
|---|---|
| Project name | 例如 `weicheng-stock`（會變成 `weicheng-stock.pages.dev`） |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | **留空** |
| Build output directory | **留空**（或填 `/`） |

> 這是純靜態網站，沒有任何建置步驟。填了建置指令反而會失敗。

先**不要**按 Save and Deploy，繼續步驟 3。

## 步驟 3：環境變數（金鑰）

同一頁往下展開 **Environment variables (advanced)**，新增下面四個。
**Type 一律選 Secret**（加密，設定後無法再讀出，只能覆寫）：

| 變數名稱 | 值從哪裡拿 |
|---|---|
| `GEMINI_KEY` | Vercel 專案 → Settings → Environment Variables 裡同名的值 |
| `GROQ_KEY` | 同上 |
| `OPENROUTER_KEY` | 同上 |
| `GITHUB_TOKEN` | 同上 |

> ⚠️ 如果 Vercel 上的值被標成 Sensitive 而看不到，就去原本的網站重新產生一把：
> Gemini → aistudio.google.com/apikey、Groq → console.groq.com、
> OpenRouter → openrouter.ai/keys、GitHub → Settings → Developer settings → Fine-grained tokens
> （只給本 repo 的 **Contents: Read and write** 權限）。全部免費。

沒設金鑰也能部署，只是 AI 分析會回「伺服器尚未設定金鑰」，股價與財報照常。

## 步驟 4：部署

按 **Save and Deploy**，約 1 分鐘。完成後會給你一個網址：

```
https://weicheng-stock.pages.dev
```

**把這個網址貼給 Claude**，會用跟 Vercel 版相同的整套測試驗證一遍
（報價防呆 15 項、時區 16 項、XSS 11 項、完整分析 golden path、各種失敗情境）。

之後每次 `git push`，Cloudflare 與 Vercel **兩邊都會自動部署**，不用手動同步。

## 步驟 5（驗證通過後）：決定正式網址

見下一節。**這一步要在做 Android 包裝（TWA）之前決定。**

---

## ⚠️ 為什麼網址要在包 Android App 之前定案

Google Play 上的 App 若是用 TWA 包裝網站，會透過 `/.well-known/assetlinks.json`
**綁定一個網域**。App 上架後若要換網域，就必須發一版新的 App 更新，
而舊版使用者在更新前會看到瀏覽器網址列、或直接打不開。

目前專案裡**還沒有** `assetlinks.json`，代表 Android 包裝還沒做 —— 現在換最便宜。

| 選項 | 費用 | 可商業用途 | 建議 |
|---|---|---|---|
| `weicheng-stock.vercel.app` | 免費 | ❌ | 只在確定永不放廣告時 |
| `weicheng-stock.pages.dev` | 免費 | ✅ | **建議**：免費且保留未來獲利的可能 |
| 自己的網域（例如 `.com`） | 每年約 NT$300–500 | ✅ | 最有彈性，但**需付費**，要先確認 |

## 本機測試（開發用）

```bash
npx wrangler pages dev . --port 8789
```

本機測試用的假金鑰放在 `.dev.vars`（已加入 `.gitignore`，不會進版控）。
