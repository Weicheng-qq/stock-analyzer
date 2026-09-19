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

// ⚠️⚠️ 2026-09-19【模型自動探索】—— 為了讓排程在沒人維護的情況下長期運作。
//   原本模型名稱寫死。供應商會定期下架舊模型，寫死的名稱全被下架那天，每日分析就會
//   「每天執行成功、但一家都沒分析到」，而且沒有人會發現。
//   現在：候選＝「偏好清單中仍存在的」＋「向供應商即時查到的可用模型（新版優先）」。
//   查詢失敗就退回偏好清單，行為與改版前相同，不會更糟。查模型清單不消耗生成額度。
//   ⚠️ functions/api/ai.js（網站）有同一套挑選規則，兩邊要一起改。
const PREFERRED = {
  gemini: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct:free']
};

export function rankGemini(ids, preferred) {
  const has = new Set(ids);
  const ver = id => { const m = id.match(/^gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const order = (a, b) => ver(b) - ver(a) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0);
  const stable = ids.filter(id => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(id)).sort(order);
  const preview = ids.filter(id => /^gemini-\d+(\.\d+)?-flash(-lite)?-preview[\w-]*$/.test(id)).sort(order);
  // 排序原則：完整版 flash 一律排在輕量版 flash-lite 前面；同一類裡，人工挑過的偏好模型優先，
  //   其次是查到的最新版。原本「偏好清單全部優先」會讓 3.1-flash-lite（輕量版）搶在 3.8-flash 前面，
  //   只要輕量版能用，更新、更強的完整版就永遠輪不到 —— 2026-09-19 實測正是如此。
  //   現在 Google 出新版 flash 時，App 會自動升級過去，不必改程式。
  const lite = id => /-lite/.test(id);
  const pref = preferred.filter(p => has.has(p));
  const list = [...new Set([
    ...pref.filter(id => !lite(id)), ...stable.filter(id => !lite(id)),
    ...pref.filter(lite), ...stable.filter(lite), ...preview])].slice(0, 5);
  return list.length ? list : preferred.slice();
}
export function rankGroq(ids, preferred) {
  const has = new Set(ids);
  const extra = ids.filter(id => !preferred.includes(id) &&
    !/whisper|guard|tts|playai|embed|distil|compound|allam|prompt/i.test(id));
  const list = [...preferred.filter(p => has.has(p)), ...extra.slice(0, 3)];
  return list.length ? list : preferred.slice();
}
// OpenRouter：只收 :free 結尾的免費模型（零費用鐵則），偏好的優先，再補幾個常見的通用模型。
export function rankOpenRouter(ids, preferred) {
  const free = ids.filter(id => /:free$/.test(id));
  const has = new Set(free);
  const extra = free.filter(id => !preferred.includes(id) &&
    /llama|gemini|qwen|deepseek|gpt-oss|mistral/i.test(id) && !/vision|image|embed/i.test(id));
  const list = [...preferred.filter(p => has.has(p)), ...extra.slice(0, 4)];
  return list.length ? list : preferred.slice();
}

const resolved = {};   // 一次排程執行只查一次
async function modelsFor(provider, key) {
  if (resolved[provider]) return resolved[provider];
  let ids = null;
  try {
    if (provider === 'gemini') {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
      if (r.ok) ids = ((await r.json()).models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => String(m.name).replace(/^models\//, ''));
    } else if (provider === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/models',
        { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
      if (r.ok) ids = ((await r.json()).data || []).filter(m => m.active !== false).map(m => m.id);
    } else if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
      if (r.ok) ids = ((await r.json()).data || []).map(m => m.id);
    }
  } catch (e) { /* 查不到就用偏好清單 */ }
  const rank = { gemini: rankGemini, groq: rankGroq, openrouter: rankOpenRouter }[provider];
  const list = ids ? rank(ids, PREFERRED[provider]) : PREFERRED[provider].slice();
  console.log('   ↳ ' + provider + ' 候選模型' + (ids ? '（即時查詢，共 ' + ids.length + ' 個可用）' : '（查詢失敗，用偏好清單）') + '：' + list.join(', '));
  resolved[provider] = list;
  return list;
}

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
        // extra 可以是函式：依模型決定額外參數。例如 reasoning_effort 只有 gpt-oss 支援，
        //   送給其他模型會直接 400，自動探索補進來的新模型就會全部白白失敗。
        body: JSON.stringify(Object.assign({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 },
          typeof extra === 'function' ? extra(model) : extra))
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

  // 【測試用逃生口】設了 AI_PROXY_URL 就改打網站既有的 /api/ai（它自己也有同樣的三層備援）。
  //   用途：本機沒有金鑰時也能把整條管線跑完做品質驗證，不必等雲端排程。
  //   ⚠️ GitHub Actions 的 workflow 不會設這個變數，正式排程行為完全不變。
  //   ⚠️ 一樣只走免費層，不會產生任何費用。
  if (process.env.AI_PROXY_URL) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 120000);
      const r = await fetch(process.env.AI_PROXY_URL, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
      });
      clearTimeout(to);
      if (r.ok) {
        const j = await r.json();
        const txt = j?.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { const o = JSON.parse(m[0]); aiStats.gemini++; return o; } catch (e) {} }
      }
    } catch (e) {}
    aiStats.failed++;
    return null;
  }

  if (gk) {
    const r = await tryEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', gk, await modelsFor('gemini', gk), prompt);
    if (r.result) { aiStats.gemini++; return r.result; }
    if (r.rateLimited) console.log('   ↳ Gemini 免費額度已用盡，改用備援（不會產生費用）');
  }
  if (qk) {
    const r = await tryEndpoint('https://api.groq.com/openai/v1/chat/completions', qk, await modelsFor('groq', qk), prompt,
      model => (/gpt-oss/.test(model) ? { reasoning_effort: 'medium' } : {}));
    if (r.result) { aiStats.groq++; return r.result; }
    if (r.rateLimited) console.log('   ↳ Groq 免費額度也已用盡，改用 OpenRouter');
  }
  if (ok) {
    const r = await tryEndpoint('https://openrouter.ai/api/v1/chat/completions', ok, await modelsFor('openrouter', ok), prompt);
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
