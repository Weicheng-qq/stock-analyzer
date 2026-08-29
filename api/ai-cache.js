// Vercel Serverless Function — 共用 AI 分析快取（寫入端）
//
// 【為什麼需要這支】
// 原本 AI 分析結果只存在「每個使用者自己的 localStorage」，而且鍵含日期、每天過期。
// 後果：1000 個使用者看同一檔股票 = 1000 次 Gemini 呼叫，隔天再看又是 1000 次。
// 使用者數越多、Gemini 免費額度燒得越快，完全違反「一場法說會只分析一次、全體共用」的原則。
//
// 【解法：用 GitHub repo 當資料庫，零費用】
// 分析結果以 JSON 檔 commit 進 repo 的 data/ai/ 目錄，Vercel 自動部署後就是靜態檔，
// 之後所有使用者「讀」都直接走 CDN 靜態檔（不經過這支函式、不花任何額度），
// 只有「第一個」發現資料過期的使用者會真的呼叫 Gemini，並把結果寫回來給後人共用。
//
// 【為什麼不用資料庫】
// Vercel KV / Upstash / Supabase 的免費層都需另外註冊、有額度、條款會變動。
// 使用者的硬性規定是「永久零費用、不綁任何付款方式」，git repo 沒有這些風險，
// 而且天然有版本控制（資料寫壞可以 revert）。
//
// 【環境變數】GITHUB_TOKEN — 需有本 repo 的 contents:write 權限。
//   沒設定時本函式直接回 501，前端會靜默略過（分析仍可用，只是不會共用給其他人）。
const REPO = 'Weicheng-qq/stock-analyzer';
const DIR = 'data/ai';

// 只接受這些前綴，避免被當成任意檔案寫入的後門
const ALLOWED_PREFIX = /^(gem|indep)_/;
// 鍵只允許英數、底線、連字號、點（擋掉 ../ 這類路徑穿越）
const SAFE_KEY = /^[A-Za-z0-9_.-]{3,120}$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const token = process.env.GITHUB_TOKEN;
  if (!token) { res.status(501).json({ error: 'GITHUB_TOKEN 未設定，略過共用快取寫入' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
  if (!body || !body.key || !body.result) { res.status(400).json({ error: 'bad body' }); return; }

  const key = String(body.key);
  if (!SAFE_KEY.test(key) || !ALLOWED_PREFIX.test(key)) { res.status(400).json({ error: 'bad key' }); return; }

  // 結果必須是物件，且序列化後不得過大（正常一份分析約 3~6KB，20KB 已遠超正常值）
  if (typeof body.result !== 'object' || Array.isArray(body.result)) { res.status(400).json({ error: 'bad result' }); return; }
  const payload = JSON.stringify({
    key,
    quarter: body.quarter ? String(body.quarter).slice(0, 60) : '',
    savedAt: new Date().toISOString(),
    result: body.result
  }, null, 1);
  if (payload.length > 20000) { res.status(413).json({ error: 'result too large' }); return; }

  const path = `${DIR}/${key}.json`;
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const gh = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'stock-analyzer-ai-cache',
    'Content-Type': 'application/json'
  };

  try {
    // 已存在就不覆寫：同一家公司同一季只分析一次，先寫先贏，避免互相蓋來蓋去產生無謂 commit
    const head = await fetch(api, { headers: gh });
    if (head.ok) { res.status(200).json({ ok: true, skipped: 'already exists' }); return; }

    const put = await fetch(api, {
      method: 'PUT',
      headers: gh,
      body: JSON.stringify({
        message: `AI快取：${key}`,
        content: Buffer.from(payload, 'utf8').toString('base64')
      })
    });
    if (!put.ok) {
      const t = await put.text();
      res.status(502).json({ error: 'github write failed', detail: t.slice(0, 300) });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
