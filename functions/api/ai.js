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
// ⚠️ Gemini 模型名稱會隨世代更新而下架（2.5 系列已對新帳號下架）。
//   若整批失效，去 ai.google.dev/gemini-api/docs/models 查目前有效的模型名再改這裡。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const JSON_HEAD = { ...CORS, 'Content-Type': 'application/json; charset=utf-8' };

const err = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: JSON_HEAD });

// 上游回來的內容原樣轉發（前端要的是 OpenAI 相容格式，不要在這裡重新包裝）
const passthrough = (text, status) =>
  new Response(text, { status: status || 200, headers: JSON_HEAD });

// 判斷上游是不是真的給了可用的回答。只看 HTTP 200 不夠 ——
// 有些供應商會用 200 回一個含 error 欄位的 body，那種要當失敗、往下一層試。
function looksUsable(ok, text) {
  return ok && text.indexOf('"choices"') > -1 && text.indexOf('"content"') > -1;
}

async function askOpenAiCompatible(url, key, payload) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 30000);
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

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return err({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || !body.messages) return err({ error: 'bad body' }, 400);

  const temperature = body.temperature != null ? body.temperature : 0.4;
  const geminiKey = env.GEMINI_KEY;
  const groqKey = env.GROQ_KEY;
  const orKey = env.OPENROUTER_KEY;

  // 0) 最優先 Gemini（Google 免費層，品質最好）。用 OpenAI 相容端點，回應格式與 OpenAI 相同。
  if (geminiKey) {
    for (const model of ['gemini-3.5-flash', 'gemini-3.1-flash-lite']) {
      try {
        const r = await askOpenAiCompatible(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          geminiKey, { model, messages: body.messages, temperature });
        if (looksUsable(r.ok, r.text)) return passthrough(r.text);
      } catch (e) { /* 這個模型不通就換下一個 */ }
    }
    // Gemini 全失敗（如當日額度用完）→ 往下用 Groq
  }

  // 1) 次選 Groq（快、額度大）。gpt-oss-120b 有推理能力、內容品質較好排第一。
  if (groqKey) {
    const groqModels = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile',
                        'moonshotai/kimi-k2-instruct', 'llama-3.1-8b-instant'];
    for (const model of groqModels) {
      try {
        const payload = { model, messages: body.messages, temperature };
        // 完整分析 prompt 很大（15 個欄位＋官方年報原文，約 5000+ tokens）。
        // high effort 容易思考超過 30 秒逾時、掉回較弱模型；medium 是實測穩定且內容仍豐富的甜蜜點。
        if (model.indexOf('gpt-oss') > -1) payload.reasoning_effort = 'medium';
        const r = await askOpenAiCompatible(
          'https://api.groq.com/openai/v1/chat/completions', groqKey, payload);
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
        : '伺服器尚未設定 GEMINI_KEY / GROQ_KEY / OPENROUTER_KEY'
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
