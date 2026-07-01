// Vercel Serverless Function — 伺服器端 AI 代理
// 金鑰存在 Vercel 環境變數 OPENROUTER_KEY，不會外流到瀏覽器。
// 訪客用你的網站時，AI 請求經此函式帶上金鑰後轉發到 OpenRouter。
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.OPENROUTER_KEY;
  if (!key) { res.status(500).json({ error: '伺服器尚未設定 OPENROUTER_KEY 環境變數' }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const data = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(r.status).send(data);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
