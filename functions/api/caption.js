// Cloudflare Pages Function — 取得 YouTube 影片的「繁體中文字幕」時間軸資料。
// 對應 Vercel 的 api/caption.js。
//
// ⚠️⚠️【目前為停用狀態，搬過來只是保持對等，不要以為它會動】
//   2026-08-10 實測：本函式部署到雲端後「一律失敗」，所有影片都回
//   {ok:false, reason:"no captionTracks"}。
//   原因：YouTube 對『資料中心 IP』（Vercel/AWS/GCP/Cloudflare 這類雲主機）
//   回傳的 watch 頁面不含 captionTracks，且 timedtext 端點會直接回 429。
//   改用 Innertube(youtubei/v1/player) 也回 400（舊版 API key 已失效，現在需要 PO Token）。
//   同一支程式在一般住宅 IP 可以取到 captionTracks，但 timedtext 仍會 429。
//   結論：在「純前端＋免費雲函式」這個架構下，無法自行取得任意 YouTube 影片的字幕逐字稿。
//   ⚠️ 換到 Cloudflare 並不會改善這件事 —— Cloudflare 的出口 IP 一樣是資料中心 IP。
//   保留本檔的唯一理由，是日後 YouTube 政策放寬或改用自架代理時可以直接啟用。
//   目前實際生效的方案是前端的 _tryZhCaption()（用 YouTube 播放器官方的自動翻譯強制切繁中），
//   前端取不到資料時會安靜退回 YouTube 內建字幕，不影響使用者。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// 字幕內容不會變，快取久一點（邊緣快取 1 天）可大幅降低被 YouTube 限流(429) 的機率。
const CACHE = 's-maxage=86400, stale-while-revalidate=604800';

const json = (obj, status, cache) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    ...(cache ? { 'Cache-Control': CACHE } : {})
  }
});

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const v = String(new URL(request.url).searchParams.get('v') || '').trim();
  if (!/^[\w-]{11}$/.test(v)) return json({ ok: false, reason: 'bad video id' }, 400);

  try {
    const wr = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(v), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }
    });
    const html = await wr.text();

    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) return json({ ok: false, reason: 'no captionTracks' }, 200, true);

    let tracks;
    try { tracks = JSON.parse(m[1].replace(/\\u0026/g, '&')); }
    catch (e) { return json({ ok: false, reason: 'parse captionTracks failed' }, 200, true); }
    if (!tracks.length) return json({ ok: false, reason: 'empty captionTracks' }, 200, true);

    // 選軌優先序：原生繁中 > 原生任何中文 > 可翻譯的軌（通常是英文/自動產生）> 第一軌
    const pick = tracks.find(t => /^zh-(Hant|TW)/i.test(t.languageCode || ''))
      || tracks.find(t => /^zh/i.test(t.languageCode || ''))
      || tracks.find(t => t.isTranslatable)
      || tracks[0];

    const isAlreadyHant = /^zh-(Hant|TW)/i.test(pick.languageCode || '');
    let url = String(pick.baseUrl || '').replace(/\\u0026/g, '&');
    if (!url) return json({ ok: false, reason: 'no baseUrl' }, 200, true);
    url += '&fmt=json3';
    // 已經是繁中就不要再套翻譯（會白繞一圈）；其餘一律請 YouTube 翻成 zh-Hant
    if (!isAlreadyHant) url += '&tlang=zh-Hant';

    const cr = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Referer': 'https://www.youtube.com/' }
    });
    if (!cr.ok) return json({ ok: false, reason: 'timedtext http ' + cr.status }, 200, true);
    const txt = await cr.text();
    if (!txt.trim()) return json({ ok: false, reason: 'empty timedtext' }, 200, true);

    let data;
    try { data = JSON.parse(txt); }
    catch (e) { return json({ ok: false, reason: 'timedtext not json' }, 200, true); }

    const cues = [];
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const s = ev.segs.map(x => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!s) continue;
      cues.push({
        t: +(((ev.tStartMs || 0) / 1000).toFixed(2)),
        d: +(((ev.dDurationMs || 2000) / 1000).toFixed(2)),
        x: s
      });
    }
    if (!cues.length) return json({ ok: false, reason: 'no cues' }, 200, true);

    return json({ ok: true, lang: 'zh-Hant', src: pick.languageCode || '', translated: !isAlreadyHant, cues }, 200, true);
  } catch (e) {
    // 一律回 200 + ok:false，前端收到就安靜退回 YouTube 內建字幕，不影響播放。
    return json({ ok: false, reason: String((e && e.message) || e) });
  }
}
