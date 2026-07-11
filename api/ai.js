// Vercel Serverless Function — 伺服器端 AI 代理
// 優先用 Groq（免費、極快、每日額度大）；沒設或失敗才退回 OpenRouter。
// 環境變數：GROQ_KEY（建議，去 console.groq.com 免費申請）、OPENROUTER_KEY（備援）。
// 兩把金鑰都存在 Vercel 伺服器端，不會外流到瀏覽器。
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
  if (!body || !body.messages) { res.status(400).json({ error: 'bad body' }); return; }

  const groqKey = process.env.GROQ_KEY;
  const orKey = process.env.OPENROUTER_KEY;

  // 1) 優先 Groq（快、額度大）。用固定的高品質快速模型，逐一嘗試。
  if (groqKey) {
    const groqModels = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'llama-3.1-8b-instant'];
    for (const gm of groqModels) {
      try {
        const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
          body: JSON.stringify({ model: gm, messages: body.messages, temperature: body.temperature != null ? body.temperature : 0.4 })
        });
        const gt = await gr.text();
        if (gr.ok && gt.indexOf('"choices"') > -1 && gt.indexOf('"content"') > -1) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.status(200).send(gt);
          return;
        }
      } catch (e) {}
    }
    // Groq 全失敗 → 往下用 OpenRouter
  }

  // 2) 退回 OpenRouter（用 client 指定的 model 與參數）
  if (!orKey) {
    res.status(500).json({ error: groqKey ? 'Groq 暫時失敗且未設 OPENROUTER_KEY 備援' : '伺服器尚未設定 GROQ_KEY 或 OPENROUTER_KEY' });
    return;
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + orKey },
      body: JSON.stringify(body)
    });
    const data = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(r.status).send(data);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
