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

// 【防濫用】本端點是公開的，任何人都能 POST，而每次寫入都會在 repo 產生一個 commit。
//   實測發現若只檢查前綴，用隨便編的 key（如 gem_TEST_INVALID）就能寫進垃圾檔，
//   等於開放任何人污染 repo。因此鍵必須完全符合前端實際會產生的格式：
//     {前綴}_{股票代碼}_{季度標記}
//   例如 gem_2454_2026Q2、indep_TSM_2026Q2、gem_GOOGL_2025FY
//   季度標記對應 __quarterTag() 的四種輸出：季(Q1-4)／全年(FY)／半年(H1,H2)／
//   非制式寫法的雜湊(H+base36)／尚無IR常數時的年月(M01-M12)。
//   最後的 XH... 是 quarter 字串裡連年份都沒有時的退路（例如「官方揭露業務結構」這種寫法）。
const KEY_SHAPE = /^(gem|indep)_[A-Za-z0-9.-]{1,10}_(20\d\d(Q[1-4]|FY|H[12]|H[0-9a-z]{1,10}|M(0[1-9]|1[0-2]))|XH[0-9a-z]{1,10})$/;

// 分析結果至少要有幾個預期欄位，擋掉空物件或亂塞的內容
const EXPECTED_FIELDS = ['products', 'moat', 'catalysts', 'risks', 'valuation', 'verdict', 'rating',
  'reason', 'double', 'lynch_type', 'revenue', 'eps', 'margins', 'outlook', 'keyPoints'];

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
  if (!KEY_SHAPE.test(key)) { res.status(400).json({ error: 'bad key' }); return; }

  // 結果必須是物件，且序列化後不得過大（正常一份分析約 3~6KB，20KB 已遠超正常值）
  if (typeof body.result !== 'object' || Array.isArray(body.result) || body.result === null) { res.status(400).json({ error: 'bad result' }); return; }
  // 必須看起來像一份真正的分析結果，擋掉空物件／隨意內容
  const nFields = EXPECTED_FIELDS.filter(f => typeof body.result[f] === 'string' && body.result[f].trim()).length;
  if (nFields < 3) { res.status(400).json({ error: 'result does not look like an analysis' }); return; }
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
