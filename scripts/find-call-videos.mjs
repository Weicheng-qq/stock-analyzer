// 法說會影片自動尋找 —— 從「投資看非凡」頻道找出新上架的【完整公開】法說會影片
//
// 【為什麼需要】
//   法說會影片（IR_CALL_VIDEO）原本是人工寫死在 HTML 裡的，每季都要人工換新；
//   2026-10-18 使用者回報「台積電法說影片還是舊的」——文字摘要每天自動更新到 Q3，影片卻停在 Q2。
//   使用者要求：「即使關機也去執行法說會人工建置……包含影片（如果有）」。
//
// 【只收哪一種影片】（與 IR_CALL_VIDEO 上方註解的收錄規則完全一致）
//   只收「投資看非凡（非凡新聞）」頻道、標題含【完整公開】與「法說」的影片 ——
//   看得到公司高層本人簡報的完整場次。其他頻道的評論、AI 自動生成投影片（NotebookLM 類）一律不收。
//   頻道由「已知是該頻道的影片」反查頻道 ID，再用頻道 ID 過濾，不靠頻道名稱文字比對。
//
// 【做法】（全部是公開頁面，不需要任何 API 金鑰、零費用）
//   ① 從已知影片頁面取得頻道 ID
//   ② 頻道 RSS（最新 15 支）＋ YouTube 搜尋頁（依上傳日期排序）兩路收集候選
//   ③ 標題比對公司名稱（台股名稱清單取自主程式 TW_ALL，同一份不另外維護）
//   ④ 寫入 data/videos/latest.json：{代碼: {id, q, title, published}}，只會換成「更新」的影片
//
// 本機測試：node scripts/find-call-videos.mjs           （DRY_RUN=1 只印結果不寫檔）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'videos', 'latest.json');
const DRY_RUN = process.env.DRY_RUN === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
// 已知屬於「投資看非凡」的【完整公開】法說會影片（IR_CALL_VIDEO 歷來人工收錄過的），用來反查頻道 ID
//   ⚠️ 2026-10-18 第一次執行發現人工收錄的鴻海 Q2「taibJLhKXmY」不屬於這個頻道（反查到別的頻道 ID），已移除；
//   頻道 ID 採多數決，所以混入一支別台的影片也不會選錯頻道。
const SEED = ['GhbjSJ9Szcs', '-u2BzwbeDqg', '2D9nsifg8Ms', '27jMy7OHrGQ', 'UyyeZiz2RPA', 'C5DKdb_OU6Q', 'qEn6dHlz1h4', 'JOhMwPVXRHM'];
const QUERIES = ['投資看非凡 完整公開 法說會', '完整公開 法說會 @投資看非凡'];

async function get(url) {
  for (let i = 1; i <= 3; i++) {
    try { const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(20000) }); if (r.ok) return await r.text(); console.log(`  HTTP ${r.status} ${url.slice(0, 90)}`); }
    catch (e) { console.log(`  失敗 ${url.slice(0, 90)}：${e.message}`); }
    await new Promise(r => setTimeout(r, 1500 * i));
  }
  return '';
}

// ── 公司名稱 → 代碼 ──
const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
const TW_ALL = (() => { try { const m = html.match(/const TW_ALL=(\{.*?\});/s); return new Function('return ' + m[1])(); } catch (e) { return {}; } })();
// 媒體常用的簡稱（TW_ALL 是正式簡稱，標題常再省略「投控」「-KY」等）
const ALIAS = { '2330': ['台積電', 'TSMC'], '3711': ['日月光'], '2317': ['鴻海'], '2454': ['聯發科'], '2303': ['聯電'], '2327': ['國巨'] };
const NAMES = [];
for (const [code, name] of Object.entries(TW_ALL)) {
  if (!/^\d{4}$/.test(code)) continue;   // 只收一般股票（排除 ETF 等 5～6 碼）
  const set = new Set([name, name.replace(/[-*]KY$|\*$/i, ''), name.replace(/投控$/, '')].concat(ALIAS[code] || []));
  for (const n of set) if (n && n.length >= 2) NAMES.push({ code, n });
}
NAMES.sort((a, b) => b.n.length - a.n.length);   // 長的名稱先比，避免「台聯電」被當成「聯電」
function codeOf(title) {
  for (const { code, n } of NAMES) if (title.includes(n)) return code;
  return null;
}

// ── 標題 → 場次標籤 ──
const ZH = { '一': 1, '二': 2, '三': 3, '四': 4 };
function quarterOf(title, published, approxDay) {
  const t = title.replace(/\s+/g, '');
  let y = null, q = null;
  let m = t.match(/(20\d\d)年?(?:第([一二三四1-4])季|Q([1-4]))/i);
  if (m) { y = +m[1]; q = ZH[m[2]] || +m[2] || +m[3]; }
  else if ((m = t.match(/第([一二三四1-4])季|Q([1-4])法說/i))) {
    q = ZH[m[1]] || +m[1] || +m[2];
    // 標題沒寫年份：依上架日期推算（第 4 季法說會在隔年 1～3 月開）
    const d = new Date(published); const pq = Math.floor(d.getUTCMonth() / 3) + 1;
    y = d.getUTCFullYear() - (q >= pq ? 1 : 0);
  }
  const ai = /AI\s*即時翻譯/i.test(title) ? '，AI 即時翻譯版' : '';
  const day = published && !approxDay ? new Date(published).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' }) : '';
  const when = day ? day + ' 上架' : '';
  const tail = (when || ai) ? `（${when}${when ? ai : ai.replace(/^，/, '')}）` : '';
  return y && q ? `${y} 第${'一二三四'[q - 1]}季${tail}` : `法說會${tail || '（' + new Date(published).getUTCFullYear() + ' 年）'}`;
}
const isCall = t => /完整公開/.test(t) && /法說/.test(t);

// ── ① 頻道 ID ──
let channelId = '';
const votes = {};
for (const id of SEED.slice(0, 4)) {
  const page = await get(`https://www.youtube.com/watch?v=${id}`);
  const m = page.match(/"channelId":"(UC[\w-]{22})"/) || page.match(/"externalChannelId":"(UC[\w-]{22})"/);
  if (m) votes[m[1]] = (votes[m[1]] || 0) + 1;
}
channelId = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
if (!channelId) { console.error('❌ 無法從已知影片取得頻道 ID（YouTube 改版或暫時無法連線），這次不更新'); process.exit(0); }
console.log('▶ 投資看非凡 頻道 ID：' + channelId + '（' + JSON.stringify(votes) + '）');

// ── ② 候選影片 ──
const cands = new Map();   // id → {id, title, published}
const rss = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
for (const e of rss.split('<entry>').slice(1)) {
  const id = (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1];
  const title = ((e.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
  if (id && title) cands.set(id, { id, title, published });
}
console.log(`  RSS：${cands.size} 支`);
// 搜尋頁的「3 天前」→ 推算上架日期（只用來排序新舊與推年份，不需要精確到小時）
function relDate(s) {
  s = String(s || ''); const now = Date.now();
  const m = s.match(/(\d+)\s*(秒|分鐘|小時|天|週|周|個月|月|年|second|minute|hour|day|week|month|year)/i);
  if (!m) return new Date(now).toISOString();
  const n = +m[1], u = m[2].toLowerCase();
  const ms = /秒|second/.test(u) ? 1e3 : /分|minute/.test(u) ? 6e4 : /小時|hour/.test(u) ? 36e5 : /天|day/.test(u) ? 864e5 : /週|周|week/.test(u) ? 6048e5 : /月|month/.test(u) ? 2592e6 : 31536e6;
  return new Date(now - n * ms).toISOString();
}
function walk(o, fn) { if (!o || typeof o !== 'object') return; if (o.videoRenderer) fn(o.videoRenderer); for (const k in o) walk(o[k], fn); }
for (const q of QUERIES) {
  const page = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=CAI%253D`);
  const m = page.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s) || page.match(/ytInitialData"\]\s*=\s*(\{.*?\});/s);
  if (!m) { console.log('  搜尋頁解析不到資料：' + q); continue; }
  let data; try { data = JSON.parse(m[1]); } catch (e) { console.log('  搜尋頁 JSON 解析失敗：' + q); continue; }
  let n = 0;
  walk(data, v => {
    const owner = v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || v.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
    const title = v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || '';
    if (owner !== channelId || !v.videoId || !title || cands.has(v.videoId)) return;
    cands.set(v.videoId, { id: v.videoId, title, published: relDate(v.publishedTimeText?.simpleText), approx: true }); n++;
  });
  console.log(`  搜尋「${q}」：新增 ${n} 支本頻道影片`);
}

// ── ③ 比對公司 ──
let state = {};
try { state = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
const found = {};
for (const c of cands.values()) {
  if (!isCall(c.title)) continue;
  const code = codeOf(c.title);
  if (!code) { console.log(`  ⚠️ 認不出公司：${c.title}`); continue; }
  if (!found[code] || c.published > found[code].published) found[code] = c;
}
// 搜尋頁只有「2 個月前」這種相對時間，會讓畫面上的上架日期不準（第一次執行：鴻海實際 8/12、推算成 8/19）。
//   只對「比對成功」的幾支影片再開一次影片頁，取官方的確切上架日期。
for (const c of Object.values(found)) {
  if (!c.approx) continue;
  const page = await get(`https://www.youtube.com/watch?v=${c.id}`);
  const m = page.match(/"publishDate":"([^"]+)"/) || page.match(/itemprop="datePublished" content="([^"]+)"/) || page.match(/"uploadDate":"([^"]+)"/);
  if (m && !isNaN(new Date(m[1]))) { c.published = new Date(m[1]).toISOString(); c.approx = false; }
}
let changed = 0;
for (const [code, c] of Object.entries(found)) {
  const old = state[code];
  const fixDate = old && old.id === c.id && old.approx && !c.approx;   // 同一支影片、這次拿到確切日期 → 更正標籤
  if (old && !fixDate && (old.id === c.id || (old.published || '') >= c.published)) continue;   // 只換成更新的影片
  state[code] = { id: c.id, q: quarterOf(c.title, c.published, c.approx), title: c.title, published: c.published, name: TW_ALL[code] || '', ...(c.approx ? { approx: true } : {}) };
  changed++;
  console.log(`  ✓ ${code} ${TW_ALL[code] || ''}：${c.title}（${c.id}）`);
}
console.log(`▶ 法說會影片：符合 ${Object.keys(found).length} 家，更新 ${changed} 家`);
if (changed && !DRY_RUN) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state, null, 1) + '\n');
}
