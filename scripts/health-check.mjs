// 每日健康檢查 —— 讓 App 在沒有人（也沒有 Claude）照顧時，壞掉了還是會有人知道。
//
// 【為什麼需要】
//   這個 App 的每一條資料路徑都依賴外部服務：證交所、Yahoo、SEC、Google Gemini、GitHub。
//   任何一個改版、下架或權杖到期，網站就會安靜地壞掉 —— 報價防呆會顯示「—」而不是錯價，
//   這很安全，但也代表「壞了卻沒人發現」。
//   這支腳本由 GitHub Actions 每個平日早上跑一次；只要有一項失敗，整個工作就標成失敗，
//   GitHub 會自動寄 email 通知 repo 擁有者。收到信之後照《永久運作手冊.md》處理即可。
//
// 【零費用】只用 GitHub Actions（public repo 免費）＋ 每天 1 次 AI 呼叫（Gemini 免費層）。
//
// 本機執行：node scripts/health-check.mjs
import fs from 'fs';

const SITE = (process.env.SITE_URL || 'https://weicheng-stock.pages.dev').replace(/\/+$/, '');
const LEGACY = 'https://weicheng-stock.vercel.app';
const REPO = process.env.GITHUB_REPOSITORY || 'Weicheng-qq/stock-analyzer';
const UA = { 'User-Agent': 'stock-analyzer-health-check' };

const results = [];   // { name, ok, level: 'fail'|'warn', detail, fix }

async function fetchT(url, opt = {}, ms = 30000) {
  return fetch(url, { ...opt, signal: AbortSignal.timeout(ms) });
}
const proxied = u => SITE + '/api/proxy?url=' + encodeURIComponent(u);

// 每一項最多試 3 次、間隔 20 秒。網路偶爾抖一下不該讓你收到錯誤通知。
async function check(name, fn, { level = 'fail', fix = '' } = {}) {
  let last = '';
  for (let i = 1; i <= 3; i++) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, level, detail: detail || 'OK' });
      console.log('✅ ' + name + (detail ? '：' + detail : ''));
      return;
    } catch (e) {
      last = String((e && e.message) || e);
      if (i < 3) await new Promise(r => setTimeout(r, 20000));
    }
  }
  results.push({ name, ok: false, level, detail: last, fix });
  console.log((level === 'fail' ? '❌ ' : '⚠️ ') + name + '：' + last);
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ① 網站本體
await check('網站首頁', async () => {
  const r = await fetchT(SITE + '/?hc=' + Date.now(), { headers: UA });
  must(r.ok, 'HTTP ' + r.status);
  const t = await r.text();
  for (const f of ['validateTwQuote', 'sanitizeAiHtml', '__tzSelfTest']) must(t.includes(f), '首頁缺少 ' + f + '（部署內容可能不完整）');
  return 'HTTP 200，防呆程式都在';
}, { fix: '到 Cloudflare → Workers & Pages → weicheng-stock → Deployments 看最新一次部署是否失敗' });

// ② 台股報價（證交所 MIS）
await check('台股報價（證交所）', async () => {
  const r = await fetchT(proxied('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0'));
  must(r.ok, 'HTTP ' + r.status);
  const row = ((await r.json()).msgArray || [])[0];
  must(row && row.c === '2330', '證交所沒有回傳台積電資料（API 可能改版）');
  must(parseFloat(row.y) > 0, '昨收價不是正數：' + row.y);
  return '台積電 昨收 ' + parseFloat(row.y) + '，交易日 ' + row.d;
}, { fix: '證交所 MIS API 可能改版或封鎖了 Cloudflare 的 IP。App 會顯示「—」而不是錯價，不會誤導使用者' });

// ③ 美股報價（Yahoo）
await check('美股報價（Yahoo）', async () => {
  const r = await fetchT(proxied('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d'));
  must(r.ok, 'HTTP ' + r.status);
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  must(m && m.regularMarketPrice > 0, 'Yahoo 沒有回傳 AAPL 價格（非官方 API，可能改版）');
  return 'AAPL ' + m.regularMarketPrice;
}, { fix: 'Yahoo 是非官方 API，改版時需要改程式。美股報價會顯示「—」' });

// ④ 財報（SEC EDGAR）
await check('美股財報（SEC）', async () => {
  const r = await fetchT(proxied('https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json'));
  must(r.ok, 'HTTP ' + r.status);
  const j = await r.json();
  must(j && j.units, 'SEC 回傳格式不對');
  return 'Apple 營收資料正常';
}, { fix: 'SEC 很少改版；若持續失敗，可能是 SEC 要求的 User-Agent 規則變了（functions/api/proxy.js）' });

// ⑤ AI 設定（不消耗額度）
await check('AI 模型設定', async () => {
  const r = await fetchT(SITE + '/api/ai?health=1');
  must(r.ok, 'HTTP ' + r.status);
  const j = await r.json();
  const g = j.providers && j.providers.gemini;
  must(g && g.configured, 'Cloudflare 上沒有設定 GEMINI_KEY');
  must(g.candidates && g.candidates.length, '找不到任何可用的 Gemini 模型');
  return 'Gemini 候選：' + g.candidates.join(', ') + (g.discovered ? '' : '（⚠️ 即時查詢失敗，用內建清單）');
}, { fix: '金鑰失效：到 aistudio.google.com/apikey 產生新金鑰，貼到 Cloudflare 的 GEMINI_KEY（Secret），再重新部署' });

// ⑥ AI 實際產生內容（每天 1 次，免費層）
await check('AI 分析產生', async () => {
  const r = await fetchT(SITE + '/api/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], temperature: 0 })
  }, 90000);
  const j = await r.json().catch(() => ({}));
  const txt = j?.choices?.[0]?.message?.content || '';
  must(r.ok && txt.trim(), 'AI 沒有回應：' + (j.error || ('HTTP ' + r.status)));
  return (j.model ? '模型 ' + j.model + '，' : '') + '回覆「' + txt.trim().slice(0, 20) + '」';
}, { fix: '先看「AI 模型設定」那一項。若設定正常但這項失敗，多半是當天免費額度用完，隔天會自動恢復；連續多天失敗才需要處理' });

// ⑦ AI 共用快取的 GitHub 權杖（會到期）
await check('AI 快取權杖（GitHub）', async () => {
  // 用一筆「一定已經存在」的快取測試：權杖有效 → 回 skipped；權杖失效 → 回 github write failed。
  //   已存在的檔案不會被覆寫，所以這項檢查不會在 repo 裡產生任何 commit。
  const dir = 'data/ai';
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).find(x => /^gem_.+\.json$/.test(x)) : null;
  must(f, '找不到任何既有的 AI 快取檔可供測試');
  const key = f.replace(/\.json$/, '');
  // ⚠️ 安全閥：一定要先確認這個檔案真的存在於 GitHub 上。萬一不存在，下面的請求會把
  //   「health-check」這種假內容當成真的分析寫進 repo，之後使用者就會看到它。
  const raw = await fetchT('https://raw.githubusercontent.com/' + REPO + '/main/' + dir + '/' + f, { headers: UA });
  must(raw.ok, '測試用的快取檔 ' + f + ' 不在 GitHub 上，為避免寫入假資料而略過（HTTP ' + raw.status + '）');
  const r = await fetchT(SITE + '/api/ai-cache', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, result: { moat: 'health-check', products: 'health-check', risks: 'health-check' } })
  });
  const j = await r.json().catch(() => ({}));
  must(r.ok && j.ok, '權杖可能已過期或被刪除：' + (j.error || ('HTTP ' + r.status)) + (j.detail ? ' ' + String(j.detail).slice(0, 80) : ''));
  return '權杖有效（' + key + '）';
}, { fix: '到 github.com/settings/personal-access-tokens 點 cloudflare-pages-ai-cache → Regenerate token，貼到 Cloudflare 的 GITHUB_TOKEN（Secret），再重新部署。網站其他功能不受影響' });

// ⑧ 每日法說會排程是否真的有在產出
await check('每日法說會分析有新資料', async () => {
  const headers = { ...UA, 'Accept': 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const r = await fetchT('https://api.github.com/repos/' + REPO + '/commits?path=data/earnings&per_page=1', { headers });
  must(r.ok, 'GitHub API HTTP ' + r.status);
  const c = (await r.json())[0];
  must(c, '找不到任何法說會分析紀錄');
  const days = (Date.now() - new Date(c.commit.committer.date).getTime()) / 86400000;
  must(days < 21, '已經 ' + Math.floor(days) + ' 天沒有新的法說會分析（排程可能在「執行成功但沒產出」）');
  return '最近一次 ' + Math.floor(days) + ' 天前';
}, { fix: '到 GitHub repo → Actions → 每日法說會更新，看最近幾次的執行紀錄。常見原因是 GitHub 上的 GEMINI_KEY secret 失效' });

// ⑨ 使用者查看紀錄（只提醒，不算失敗）：沒有它，每日排程仍會照五階段順序運作
await check('使用者查看紀錄（匿名統計）', async () => {
  const r = await fetchT(SITE + '/api/demand?days=3');
  const j = await r.json().catch(() => ({}));
  must(r.ok && j.ok, j.error || ('HTTP ' + r.status));
  return '最近 3 天有人查看 ' + j.count + ' 家';
}, { level: 'warn', fix: 'Cloudflare 的 KV 綁定（變數名 DEMAND）沒設或失效。沒設也能運作，只是每日更新不會優先處理大家點過的公司。設定方式見《永久運作手冊》〈四-6〉' });

// ⑩ 舊網址轉址（只提醒，不算失敗）
await check('舊網址轉址（Vercel）', async () => {
  const r = await fetchT(LEGACY + '/', { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  must(r.status >= 300 && r.status < 400 && loc.startsWith(SITE), '舊網址沒有轉到新網址（HTTP ' + r.status + '）');
  return '308 → ' + loc;
}, { level: 'warn', fix: '只影響使用舊連結的人。確認 vercel.json 仍是單一轉址規則、Vercel 專案沒有被刪除' });

// ── 結果 ──
const fails = results.filter(x => !x.ok && x.level === 'fail');
const warns = results.filter(x => !x.ok && x.level === 'warn');
const lines = [
  '## ' + (fails.length ? '❌ 有 ' + fails.length + ' 項異常' : '✅ 全部正常') + '　（' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC）',
  '',
  '| 檢查項目 | 結果 | 說明 |', '|---|---|---|',
  ...results.map(x => '| ' + x.name + ' | ' + (x.ok ? '✅' : (x.level === 'fail' ? '❌' : '⚠️')) + ' | ' + String(x.detail).replace(/\|/g, '/') + ' |')
];
if (fails.length || warns.length) {
  lines.push('', '### 怎麼處理（詳見 repo 裡的《永久運作手冊.md》）');
  for (const x of [...fails, ...warns]) lines.push('- **' + x.name + '**：' + x.fix);
}
const summary = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
console.log('\n' + summary);
// 有任何一項「失敗」就讓工作失敗 → GitHub 自動寄 email 給 repo 擁有者。「提醒」不寄信。
process.exit(fails.length ? 1 : 0);
