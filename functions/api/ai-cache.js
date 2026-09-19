// Cloudflare Pages Function — 共用 AI 分析快取（寫入端）。對應 Vercel 的 api/ai-cache.js。
//
// 【為什麼需要這支】
// 原本 AI 分析結果只存在「每個使用者自己的 localStorage」，鍵含日期、每天過期。
// 後果：1000 個使用者看同一檔股票 = 1000 次 AI 呼叫，隔天再看又是 1000 次。
// 使用者越多、免費額度燒得越快，完全違反「一場法說會只分析一次、全體共用」的原則。
//
// 【解法：用 GitHub repo 當資料庫，零費用】
// 分析結果以 JSON 檔 commit 進 repo 的 data/ai/，部署後就是靜態檔，
// 之後所有使用者「讀」都直接走 CDN 靜態檔（不經過這支函式、不花任何額度），
// 只有「第一個」發現資料過期的使用者會真的呼叫 AI，並把結果寫回來給後人共用。
//
// 【為什麼不用資料庫】
// KV / Upstash / Supabase 的免費層都需另外註冊、有額度、條款會變動。
// 使用者的硬性規定是「永久零費用、不綁任何付款方式」，git repo 沒有這些風險，
// 而且天然有版本控制（資料寫壞可以 revert）。
//
// 【環境變數】GITHUB_TOKEN — 需有本 repo 的 contents:write 權限。
//   沒設定時直接回 501，前端會靜默略過（分析仍可用，只是不會共用給其他人）。
//
// ⚠️ 與 Vercel 版最大的實作差異：Workers 沒有 Node 的 Buffer，
//   不能用 Buffer.from(s,'utf8').toString('base64')。中文會被 btoa 直接拒絕
//   （btoa 只吃 Latin-1），所以必須先用 TextEncoder 轉成位元組再逐byte組字串。
//   這一步寫錯不會噴錯，而是會把中文寫成亂碼存進 repo —— 所以下面有專門的註解。

const REPO = 'Weicheng-qq/stock-analyzer';
const DIR = 'data/ai';

// 【防濫用】本端點是公開的，任何人都能 POST，而每次寫入都會在 repo 產生一個 commit。
//   實測發現若只檢查前綴，用隨便編的 key（如 gem_TEST_INVALID）就能寫進垃圾檔，
//   等於開放任何人污染 repo。因此鍵必須完全符合前端實際會產生的格式：
//     {前綴}_{股票代碼}_{季度標記}   例如 gem_2454_2026Q2、indep_TSM_2026Q2
const KEY_SHAPE = /^(gem|indep)_[A-Za-z0-9.-]{1,10}_(20\d\d(Q[1-4]|FY|H[12]|H[0-9a-z]{1,10}|M(0[1-9]|1[0-2]))|XH[0-9a-z]{1,10})$/;

// 分析結果至少要有幾個預期欄位，擋掉空物件或亂塞的內容
const EXPECTED_FIELDS = ['products', 'moat', 'catalysts', 'risks', 'valuation', 'verdict', 'rating',
  'reason', 'double', 'lynch_type', 'revenue', 'eps', 'margins', 'outlook', 'keyPoints'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
});

// UTF-8 安全的 base64。⚠️ 不可以直接 btoa(payload)：
//   btoa 只接受 Latin-1，遇到中文會丟 InvalidCharacterError；
//   而就算不丟錯，少了 TextEncoder 這一步也會把多位元組字元切壞，
//   結果是 repo 裡存進一份亂碼 JSON，而且要等有人讀到才會發現。
function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = env.GITHUB_TOKEN;
  if (!token) return json({ error: 'GITHUB_TOKEN 未設定，略過共用快取寫入' }, 501);

  let body;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || !body.key || !body.result) return json({ error: 'bad body' }, 400);

  const key = String(body.key);
  if (!KEY_SHAPE.test(key)) return json({ error: 'bad key' }, 400);

  // 結果必須是物件
  if (typeof body.result !== 'object' || Array.isArray(body.result) || body.result === null) {
    return json({ error: 'bad result' }, 400);
  }
  // 必須看起來像一份真正的分析結果，擋掉空物件／隨意內容
  const nFields = EXPECTED_FIELDS
    .filter(f => typeof body.result[f] === 'string' && body.result[f].trim()).length;
  if (nFields < 3) return json({ error: 'result does not look like an analysis' }, 400);

  const payload = JSON.stringify({
    key,
    quarter: body.quarter ? String(body.quarter).slice(0, 60) : '',
    savedAt: new Date().toISOString(),
    result: body.result
  }, null, 1);
  // 正常一份分析約 3~6KB，20KB 已遠超正常值
  if (payload.length > 20000) return json({ error: 'result too large' }, 413);

  const api = `https://api.github.com/repos/${REPO}/contents/${DIR}/${key}.json`;
  const gh = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'stock-analyzer-ai-cache',
    'Content-Type': 'application/json'
  };

  try {
    // 已存在就不覆寫：同一家公司同一季只分析一次，先寫先贏，
    // 避免互相蓋來蓋去產生無謂 commit。
    const head = await fetch(api, { headers: gh });
    if (head.ok) return json({ ok: true, skipped: 'already exists' });

    const put = await fetch(api, {
      method: 'PUT',
      headers: gh,
      body: JSON.stringify({
        message: `AI快取：${key}`,
        content: base64Utf8(payload)
      })
    });
    if (!put.ok) {
      const t = await put.text();
      return json({ error: 'github write failed', detail: t.slice(0, 300) }, 502);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}
