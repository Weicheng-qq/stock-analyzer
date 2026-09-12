# 報價代理（Cloudflare Worker）— 選填，全程免費

## 這是什麼？為什麼會有這個資料夾？

即時報價是本 App 打最兇的請求：盤中每 5 秒一輪，而且**一定要經過伺服器代轉**
（證交所 `mis.twse.com.tw` 與 Yahoo Finance 都不送 CORS 標頭，瀏覽器不能直接打）。

預設走的是本專案的 `api/proxy.js`（跑在 Vercel 上）。它免費，但有兩個天花板：

| | Vercel Hobby（預設） | Cloudflare Workers 免費版 |
|---|---|---|
| 額度 | 每月 **100 萬次** Function 呼叫 | 每天 **10 萬次**（約每月 300 萬次） |
| 超過之後 | **不能加購，停用等 30 天** | 當天超量才擋，隔天自動恢復 |
| 商業用途 | ❌ 明文禁止（要 Pro，US$20/月） | ✅ 允許 |

以「每人每天看 20 分鐘、每 5 秒更新一次」估算，Vercel 免費額度大約支撐 **100 位使用者**。
**你自己一個人用，永遠不會碰到上限，這個資料夾可以完全忽略。**
只有在你真的把 App 上架、使用者變多，或之後打算靠它賺錢時，才需要照下面做一次。

## 部署步驟（約 5 分鐘，不需要信用卡）

1. 到 <https://dash.cloudflare.com/sign-up> 註冊一個免費帳號（免費方案不需要信用卡）。
2. 左側 **Build** 區塊 → 點 **Compute** → **Workers** → 右上角 **Create**。
   > ⚠️ Cloudflare 在 2026 年改版過側邊欄。舊版是「Workers & Pages」，新版改到
   > **Compute** 底下。中間首頁那顆「Create app」也能到，但它會先問要不要從 Git
   > 匯入範本，多繞一圈 —— 走 Compute → Workers 最短。
3. 取一個名字（例如 `stock-quote-proxy`）→ **Deploy**。
4. 部署完成後點 **Edit code**，把編輯器裡的預設內容**全部刪掉**，
   貼上本資料夾的 [`quote-proxy.js`](./quote-proxy.js) 全文 → 右上角 **Deploy**。
5. 複製它給你的網址，長得像 `https://stock-quote-proxy.你的帳號.workers.dev`。
6. 先自己測一次它活著沒有：把下面這串貼到瀏覽器網址列（前半段換成你自己的網址），
   看到一堆 JSON、裡面有 `"n":"台積電"` 就成功：
   `https://你的網址.workers.dev/?url=https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw%26json=1`
   若看到 `{"error":"host not allowed"}`，代表程式碼有貼對（白名單正在運作），只是網址打錯。
7. 回到 App → 右上角 **⚙️** → 展開「**進階：自建報價代理**」→ 貼上該網址
   （只要 `https://xxx.workers.dev` 這段，後面的 `/?url=...` **不要帶**）→ **儲存金鑰**。

## 怎麼確認有生效？

⚠️ **畫面上看不出來現在走的是 Worker 還是 Vercel** —— 兩者顯示完全一樣（標題列都是
`證交所即時（TWSE）`）。要真的確認，去 Cloudflare 後台 → 你的 Worker → **Metrics**，
看 Requests 數字有沒有在長；有在長就是接上了。

自動退回機制（2026-09-12 於線上實測過）：
- 故意填一個不存在的 Worker 網址 → 2330 仍正常顯示 2410（TWSE），耗時 1.6 秒
  （它先試你的、失敗才換回 `/api/proxy`，所以會慢約 1.5 秒，但不會看不到股價）。
- 清空欄位 → 立刻回到 `/api/proxy`。

⚠️ 這是**每台裝置各自的設定**（存在瀏覽器 localStorage）：你在電腦設了，手機不會跟著變，
其他使用者更不會。所以填這個欄位只有你自己會走 Worker。

## 注意事項

- 這支 Worker 的白名單（只允許證交所與 Yahoo 報價）刻意與 `api/proxy.js` 一致。
  **兩邊要一起維護**，只改一邊會造成「用 Worker 的人看得到、用預設的人看不到」這種難查的問題。
- 快取設定 `s-maxage=5` 也必須與前端 `refreshLivePrices()` 的 `gap`（5000 毫秒）對齊，
  只改單邊沒有意義：前端比快取快，多打的那幾次只會拿到同一份快取；前端比快取慢，快取就白設。
- 設定只存在你自己的瀏覽器（localStorage），不會上傳到任何地方。
  換句話說，**這是每位使用者各自的設定**；若你想讓所有使用者都走 Worker，
  要改的是 `stock_analyzer.html` 裡 `quoteProxyBase()` 的預設值，而不是這個欄位。
