// Vercel Serverless Function — 取得 YouTube 影片的「繁體中文字幕」時間軸資料
//
// 為什麼要自己抓字幕，而不是用 YouTube 播放器內建字幕？
//   內建字幕有三個無法解決的問題(使用者實測回報)：
//   ①語言不一致：有些影片有簡體原生字幕軌，YouTube 會優先選它，變成一下繁體一下簡體
//   ②位置不受控：全螢幕時字幕貼在「播放器」底部，而播放器是滿版的，字幕就跑到手機畫面最下面，
//     離影片本身很遠
//   ③樣式/大小不一致，且直播存檔完全沒有字幕軌
//   自己抓字幕資料、用自己的 DOM 疊在影片正下方，上述三點就全部由我們掌控。
//
// 作法：抓 watch 頁 → 解析 ytInitialPlayerResponse 裡的 captionTracks → 取其 baseUrl
//       (該網址是 YouTube 簽章過的，帶 &tlang=zh-Hant 就是 YouTube 官方的繁中翻譯字幕)
// 回傳：{ ok:true, cues:[{t:起始秒, d:持續秒, x:"字幕文字"}], lang:"zh-Hant" }
// 失敗一律回 { ok:false, reason } —— 前端收到就安靜退回 YouTube 內建字幕，不影響播放。
//
// ⚠️⚠️ 2026-08-10 實測結果(重要，接手前必讀，不要重複踩這個坑)：
//   本函式部署到 Vercel 後「一律失敗」，所有影片都回 {ok:false, reason:"no captionTracks"}。
//   原因：YouTube 對『資料中心IP』(Vercel/AWS/GCP 這類雲主機)回傳的 watch 頁面不含 captionTracks，
//   而且 timedtext 端點會直接回 429 Too Many Requests；改用 Innertube(youtubei/v1/player) 也回 400
//   (舊版 API key 已失效，現在需要 PO Token)。同一支程式在一般住宅IP可以取到 captionTracks，
//   但 timedtext 仍會 429，所以也無法在本機批次預先產生字幕檔。
//   結論：在「純前端＋免費雲函式」這個架構下，無法自行取得任意 YouTube 影片的字幕逐字稿。
//   目前實際生效的字幕方案是前端的 _tryZhCaption()(用 YouTube 播放器官方的自動翻譯強制切成繁中)。
//   本檔案保留為「若日後 YouTube policy 放寬或改用自架代理就能直接啟用」的備援，
//   前端取不到資料時會安靜退回 YouTube 內建字幕，不影響使用者。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const v = String(req.query.v || '').trim();
  if (!/^[\w-]{11}$/.test(v)) { res.status(400).json({ ok: false, reason: 'bad video id' }); return; }

  // 字幕內容不會變，快取久一點(邊緣快取1天)可大幅降低被 YouTube 限流(429)的機率
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');

  try {
    const wr = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(v), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }
    });
    const html = await wr.text();

    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) { res.status(200).json({ ok: false, reason: 'no captionTracks' }); return; }

    let tracks;
    try { tracks = JSON.parse(m[1].replace(/\\u0026/g, '&')); }
    catch (e) { res.status(200).json({ ok: false, reason: 'parse captionTracks failed' }); return; }
    if (!tracks.length) { res.status(200).json({ ok: false, reason: 'empty captionTracks' }); return; }

    // 選軌優先序：原生繁中 > 原生任何中文 > 可翻譯的軌(通常是英文/自動產生) > 第一軌
    const pick = tracks.find(t => /^zh-(Hant|TW)/i.test(t.languageCode || ''))
      || tracks.find(t => /^zh/i.test(t.languageCode || ''))
      || tracks.find(t => t.isTranslatable)
      || tracks[0];

    const isAlreadyHant = /^zh-(Hant|TW)/i.test(pick.languageCode || '');
    let url = String(pick.baseUrl || '').replace(/\\u0026/g, '&');
    if (!url) { res.status(200).json({ ok: false, reason: 'no baseUrl' }); return; }
    url += '&fmt=json3';
    // 已經是繁中就不要再套翻譯(會白繞一圈)；其餘一律請 YouTube 翻成 zh-Hant
    if (!isAlreadyHant) url += '&tlang=zh-Hant';

    const cr = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Referer': 'https://www.youtube.com/' }
    });
    if (!cr.ok) { res.status(200).json({ ok: false, reason: 'timedtext http ' + cr.status }); return; }
    const txt = await cr.text();
    if (!txt.trim()) { res.status(200).json({ ok: false, reason: 'empty timedtext' }); return; }

    let data;
    try { data = JSON.parse(txt); }
    catch (e) { res.status(200).json({ ok: false, reason: 'timedtext not json' }); return; }

    const cues = [];
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const s = ev.segs.map(x => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!s) continue;
      cues.push({ t: +(((ev.tStartMs || 0) / 1000).toFixed(2)), d: +(((ev.dDurationMs || 2000) / 1000).toFixed(2)), x: s });
    }
    if (!cues.length) { res.status(200).json({ ok: false, reason: 'no cues' }); return; }

    res.status(200).json({ ok: true, lang: 'zh-Hant', src: pick.languageCode || '', translated: !isAlreadyHant, cues });
  } catch (e) {
    res.status(200).json({ ok: false, reason: String((e && e.message) || e) });
  }
}
