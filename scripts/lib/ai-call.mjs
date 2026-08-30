// 共用的 AI 呼叫：Gemini → Groq → OpenRouter 三層備援
//
// 【為什麼需要這個】
// 網站的 /api/ai 本來就有三層備援（Gemini 額度用完自動改用 Groq，再不行用 OpenRouter），
// 所以使用者從來不會感覺到「額度用光」——備援默默接手了。
// 但排程腳本原本只用 Gemini、沒有備援，Gemini 一被拒絕就整個停止：
//   2026-08-30 首次執行時，評分/重大異動/本週事件都正常產出，
//   但「今日必看 0 則、市場總結未產生、AI 用了 0 次」，就是這個原因。
// 這支模組把網站既有的備援邏輯搬到排程端，兩邊行為一致。
//
// 【零費用鐵則不變】三家都只用免費層：
//   - Gemini：免費層超額回 429（拒絕），不會計費。⚠️ 該 Google Cloud 專案永遠不要啟用帳單。
//   - Groq：免費額度大，超額同樣是拒絕。
//   - OpenRouter：只用 `:free` 結尾的免費模型。
// 三家都用完就回 null，呼叫端據此停止——任何情況下都不會產生費用。

const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const OR_MODELS = ['google/gemini-2.0-flash-exp:free', 'meta-llama/llama-3.3-70b-instruct:free'];

// 各層的用量統計，供腳本結束時回報「實際用了哪一層」
export const aiStats = { gemini: 0, groq: 0, openrouter: 0, failed: 0, exhausted: false };

async function tryEndpoint(url, key, models, prompt, extra = {}) {
  for (const model of models) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 45000);
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(Object.assign({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }, extra))
      });
      clearTimeout(to);
      if (r.status === 429) return { rateLimited: true };   // 這一層額度用完 → 換下一層
      if (!r.ok) continue;                                   // 這個模型不行 → 換下一個模型
      const j = await r.json();
      const txt = j?.choices?.[0]?.message?.content || '';
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { return { result: JSON.parse(m[0]) }; } catch (e) {} }
    } catch (e) { /* 逾時或網路問題 → 換下一個模型 */ }
  }
  return { failed: true };
}

// 回傳解析後的 JSON 物件；三層都失敗回 null
export async function callAI(prompt) {
  const gk = process.env.GEMINI_KEY, qk = process.env.GROQ_KEY, ok = process.env.OPENROUTER_KEY;

  if (gk) {
    const r = await tryEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', gk, GEMINI_MODELS, prompt);
    if (r.result) { aiStats.gemini++; return r.result; }
    if (r.rateLimited) console.log('   ↳ Gemini 免費額度已用盡，改用備援（不會產生費用）');
  }
  if (qk) {
    const r = await tryEndpoint('https://api.groq.com/openai/v1/chat/completions', qk, GROQ_MODELS, prompt, { reasoning_effort: 'medium' });
    if (r.result) { aiStats.groq++; return r.result; }
    if (r.rateLimited) console.log('   ↳ Groq 免費額度也已用盡，改用 OpenRouter');
  }
  if (ok) {
    const r = await tryEndpoint('https://openrouter.ai/api/v1/chat/completions', ok, OR_MODELS, prompt);
    if (r.result) { aiStats.openrouter++; return r.result; }
  }
  aiStats.failed++;
  // 三層都不通才視為真的沒額度了，呼叫端據此提前結束
  if (!gk && !qk && !ok) aiStats.exhausted = true;
  return null;
}

// 連續失敗過多時判定為「所有免費層都用盡」，讓呼叫端停止而不是空轉
export function shouldStop() {
  return aiStats.failed >= 5 && (aiStats.gemini + aiStats.groq + aiStats.openrouter) === 0;
}
