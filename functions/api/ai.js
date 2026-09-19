// Cloudflare Pages Function — 伺服器端 AI 代理（對應 Vercel 的 api/ai.js）
//
// 品質優先的三層備援：Gemini（品質最好）→ Groq（快）→ OpenRouter（備援）。
// 環境變數（在 Cloudflare Pages 專案設定 → Variables and Secrets 新增，型別選 Secret）：
//   GEMINI_KEY     去 aistudio.google.com/apikey 免費申請，AIza 開頭（最優先）
//   GROQ_KEY       去 console.groq.com 免費申請，gsk_ 開頭
//   OPENROUTER_KEY 備援，sk-or 開頭
// 三把金鑰都存在伺服器端，不會外流到瀏覽器。任一把沒設就自動跳過、往下一層試。
//
// ⚠️ Vercel 版靠 vercel.json 的 maxDuration:60 把逾時拉長；Cloudflare 沒有這個設定，
//   但 Workers 的限制是「CPU 時間」而不是「等待時間」，而這支幾乎整段都在等 fetch 回來，
//   CPU 用量極低，因此免費方案的 10ms CPU 限制不會卡到。
//   真正的風險是上游模型自己慢，所以每一段都保留原本的 30 秒 AbortController。
//
// ⚠️⚠️ 2026-09-19【模型自動探索】—— 為了讓 App 在沒人維護的情況下長期運作。
//   原本模型名稱寫死在程式裡。Google 會定期下架舊模型（Gemini 2.5 系列就已對新帳號下架過），
//   一旦寫死的名稱全部被下架，AI 分析就會整個失效，而且沒有人會來改程式。
//   現在的做法：候選清單＝「偏好清單中目前仍存在的」＋「向供應商即時查到的可用模型（新版優先）」。
//   查詢結果快取 6 小時；查詢失敗就退回偏好清單，行為與改版前完全相同，不會更糟。
//   查模型清單不消耗任何生成額度。
//   ⚠️ scripts/lib/ai-call.mjs（每日排程）有同一套邏輯，兩邊要一起改。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const JSON_HEAD = { ...CORS, 'Content-Type': 'application/json; charset=utf-8' };

const err = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: JSON_HEAD });

// 上游回來的內容原樣轉發（前端要的是 OpenAI 相容格式，不要在這裡重新包裝）
const passthrough = (text, status, attempts) =>
  new Response(text, { status: status || 200, headers: { ...JSON_HEAD,
    'Access-Control-Expose-Headers': 'X-AI-Attempts',
    ...(attempts ? { 'X-AI-Attempts': encodeURIComponent(attempts.join(' > ')) } : {}) } });

// 判斷上游是不是真的給了可用的回答。只看 HTTP 200 不夠 ——
// 有些供應商會用 200 回一個含 error 欄位的 body，那種要當失敗、往下一層試。
function looksUsable(ok, text) {
  return ok && text.indexOf('"choices"') > -1 && text.indexOf('"content"') > -1;
}

async function askOpenAiCompatible(url, key, payload, timeoutMs = 30000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      signal: ctl.signal,
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(to);
  }
}

// ════════════════════════ 模型自動探索 ════════════════════════
// 偏好順序：人工挑過、品質驗證過的。仍然存在就優先用，被下架了就自動跳過。
const PREFERRED = {
  gemini: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile',
         'moonshotai/kimi-k2-instruct', 'llama-3.1-8b-instant']
};
const MODEL_CACHE_MS = 6 * 3600 * 1000;
// 額度用完（429）的模型先跳過 10 分鐘。每個模型的免費額度分開算，一個用完就換下一個；
//   但如果不記住，每一次請求都會先去撞那個已經用完的模型，白白多等一輪。
const COOLDOWN_MS = 10 * 60 * 1000;
// 逾時（太慢）的模型冷卻 30 分鐘：2026-09-19 實測「最強的先用」上線後，長提示在 3.8／3.7
//   上常常跑超過 30 秒，一次請求要 44～66 秒才回來，超過前端 45 秒上限而被中止重送，
//   整頁卡在「AI 分析中」。慢的模型通常會持續慢一段時間，冷卻久一點才不會每次都卡在它身上。
const SLOW_COOLDOWN_MS = 30 * 60 * 1000;
// 整個請求的時間預算：前端每次最多等 45 秒，伺服器必須在這之前回應（不管成功或失敗），
//   否則前端會中止並重送，同一個請求等於白做。
const TOTAL_BUDGET_MS = 40 * 1000;
const cooldown = {};   // model → 冷卻到何時
const coolingDown = m => (cooldown[m] || 0) > Date.now();
const modelCache = {};   // provider → { t, list, discovered, total }

// Gemini 排序（2026-09-19 使用者指定）：【最強的先用，再依序往下降】。
//   完整版 flash 由新到舊（版本號越新越強；Google 官方頁面也是由新到舊排列），
//   接著輕量版 flash-lite 由新到舊，最後才是 preview 版。
//   刻意不放 Pro：免費方案只剩舊世代的 2.5 Pro（3.x Pro 免費方案不提供），
//   而且 Pro 會先思考再回答，App 的分析提示很長，常超過 30 秒逾時，每次都白等 30 秒才換下一個。
//   各類別分別限量（完整版 4、輕量版 2、preview 1），避免舊世代模型擠進名單。
//   人工驗證過能用的偏好模型若沒排進來，放在最後當保險。
export function rankGemini(ids, preferred) {
  const has = new Set(ids);
  const ver = id => { const m = id.match(/^gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const lite = id => /-lite/.test(id);
  const newestFirst = (a, b) => ver(b) - ver(a) || (lite(a) ? 1 : 0) - (lite(b) ? 1 : 0);
  const stable = ids.filter(id => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(id));
  const full = stable.filter(id => !lite(id)).sort(newestFirst).slice(0, 4);
  const lites = stable.filter(lite).sort(newestFirst).slice(0, 2);
  const preview = ids.filter(id => /^gemini-\d+(\.\d+)?-flash(-lite)?-preview[\w-]*$/.test(id)).sort(newestFirst).slice(0, 1);
  const safety = preferred.filter(p => has.has(p));
  // 保險模型也要照強弱歸位：完整版的放在完整版後面、輕量版的放在輕量版後面，維持「由強到弱」。
  const list = [...new Set([...full, ...safety.filter(id => !lite(id)), ...lites, ...safety.filter(lite), ...preview])];
  return list.length ? list : preferred.slice();
}

// Groq：偏好清單中還在的優先；另外補最多 3 個其他聊天模型當後備（排除語音、審查、嵌入等非聊天模型）。
export function rankGroq(ids, preferred) {
  const has = new Set(ids);
  const extra = ids.filter(id => !preferred.includes(id) &&
    !/whisper|guard|tts|playai|embed|distil|compound|allam|prompt/i.test(id));
  const list = [...preferred.filter(p => has.has(p)), ...extra.slice(0, 3)];
  return list.length ? list : preferred.slice();
}

async function modelsFor(provider, key) {
  const c = modelCache[provider];
  if (c && Date.now() - c.t < MODEL_CACHE_MS) return c.list;
  let ids = null;
  try {
    if (provider === 'gemini') {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        ids = (j.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => String(m.name).replace(/^models\//, ''));
      }
    } else if (provider === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/models',
        { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        ids = (j.data || []).filter(m => m.active !== false).map(m => m.id);
      }
    }
  } catch (e) { /* 查不到就退回偏好清單 */ }
  const list = ids
    ? (provider === 'gemini' ? rankGemini(ids, PREFERRED.gemini) : rankGroq(ids, PREFERRED.groq))
    : PREFERRED[provider].slice();
  // 查詢失敗時只快取 1 分鐘，下一次請求很快會再試，不會卡在舊清單 6 小時。
  modelCache[provider] = {
    t: ids ? Date.now() : Date.now() - MODEL_CACHE_MS + 60000,
    list, discovered: !!ids, total: ids ? ids.length : 0
  };
  return list;
}

// 健康檢查：GET /api/ai?health=1
//   給每日排程的健康檢查用。只查模型清單，不呼叫任何模型，所以不消耗生成額度；
//   也不回傳任何金鑰內容，只回「有沒有設定」與「目前會用哪些模型」。
async function health(env) {
  const out = { ok: false, checkedAt: new Date().toISOString(), providers: {} };
  for (const [name, key] of [['gemini', env.GEMINI_KEY], ['groq', env.GROQ_KEY]]) {
    if (!key) { out.providers[name] = { configured: false }; continue; }
    const list = await modelsFor(name, key);
    const c = modelCache[name] || {};
    out.providers[name] = { configured: true, discovered: !!c.discovered, available: c.total, candidates: list,
      coolingDown: list.filter(coolingDown) };
  }
  out.providers.openrouter = { configured: !!env.OPENROUTER_KEY };
  out.ok = Object.values(out.providers).some(p => p.configured);
  return new Response(JSON.stringify(out), { headers: { ...JSON_HEAD, 'Cache-Control': 'no-store' } });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method === 'GET' && new URL(request.url).searchParams.get('health') === '1') return health(env);
  if (request.method !== 'POST') return err({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || !body.messages) return err({ error: 'bad body' }, 400);

  const temperature = body.temperature != null ? body.temperature : 0.4;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  // 每個模型的嘗試結果（模型名、結果、耗時），放在回應標頭 X-AI-Attempts，方便日後診斷。不含金鑰。
  const attempts = [];
  const geminiKey = env.GEMINI_KEY;
  const groqKey = env.GROQ_KEY;
  const orKey = env.OPENROUTER_KEY;

  // 0) 最優先 Gemini（Google 免費層，品質最好）。用 OpenAI 相容端點，回應格式與 OpenAI 相同。
  if (geminiKey) {
    for (const model of await modelsFor('gemini', geminiKey)) {
      if (coolingDown(model)) { attempts.push(model + ':冷卻中'); continue; }
      const left = deadline - Date.now();
      if (left < 5000) { attempts.push('時間預算用完'); break; }
      const t0 = Date.now();
      try {
        const r = await askOpenAiCompatible(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          geminiKey, { model, messages: body.messages, temperature }, Math.min(30000, left - 1000));
        const ms = Date.now() - t0;
        if (r.status === 429) { cooldown[model] = Date.now() + COOLDOWN_MS; attempts.push(model + ':429額度(' + ms + 'ms)'); continue; }
        if (looksUsable(r.ok, r.text)) { attempts.push(model + ':成功(' + ms + 'ms)'); return passthrough(r.text, 200, attempts); }
        // 5xx（多半是 503 模型過載，新模型剛推出時很常見）：實測要等十幾秒才報錯，冷卻 2 分鐘避免每次都卡一次
        if (r.status >= 500) cooldown[model] = Date.now() + 2 * 60 * 1000;
        attempts.push(model + ':HTTP' + r.status + '(' + ms + 'ms)');
      } catch (e) {
        const ms = Date.now() - t0;
        // AbortError = 超過逾時 → 這個模型對這種長度的提示太慢，冷卻久一點
        if (e && e.name === 'AbortError') { cooldown[model] = Date.now() + SLOW_COOLDOWN_MS; attempts.push(model + ':逾時(' + ms + 'ms)'); }
        else attempts.push(model + ':錯誤(' + ms + 'ms)');
      }
    }
    // Gemini 全失敗（如當日額度用完）→ 往下用 Groq
  }

  // 1) 次選 Groq（快、額度大）。gpt-oss-120b 有推理能力、內容品質較好排第一。
  if (groqKey) {
    for (const model of await modelsFor('groq', groqKey)) {
      if (coolingDown(model)) continue;
      try {
        const payload = { model, messages: body.messages, temperature };
        // 完整分析 prompt 很大（15 個欄位＋官方年報原文，約 5000+ tokens）。
        // high effort 容易思考超過 30 秒逾時、掉回較弱模型；medium 是實測穩定且內容仍豐富的甜蜜點。
        if (model.indexOf('gpt-oss') > -1) payload.reasoning_effort = 'medium';
        const r = await askOpenAiCompatible(
          'https://api.groq.com/openai/v1/chat/completions', groqKey, payload);
        if (r.status === 429) { cooldown[model] = Date.now() + COOLDOWN_MS; continue; }
        if (looksUsable(r.ok, r.text)) return passthrough(r.text);
      } catch (e) { /* 換下一個模型 */ }
    }
    // Groq 全失敗 → 往下用 OpenRouter
  }

  // 2) 退回 OpenRouter（用 client 指定的 model 與參數）
  if (!orKey) {
    return err({
      error: (geminiKey || groqKey)
        ? '上層 AI 暫時失敗且未設 OPENROUTER_KEY 備援'
        : '伺服器尚未設定 GEMINI_KEY / GROQ_KEY / OPENROUTER_KEY',
      attempts
    }, 500);
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + orKey },
      body: JSON.stringify(body)
    });
    return passthrough(await r.text(), r.status);
  } catch (e) {
    return err({ error: String((e && e.message) || e) }, 502);
  }
}
