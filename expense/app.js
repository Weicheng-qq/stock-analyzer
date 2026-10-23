// 隨手記帳 —— 純前端 PWA，資料只存在本機 localStorage，不連任何伺服器、不收費。
'use strict';

const STORE_KEY = 'expense.v1';
const DEFAULT_CATS = [
  { id: 'food', name: '餐飲', icon: '🍱', type: 'expense' },
  { id: 'drink', name: '飲料', icon: '🧋', type: 'expense' },
  { id: 'traffic', name: '交通', icon: '🚇', type: 'expense' },
  { id: 'shop', name: '購物', icon: '🛍️', type: 'expense' },
  { id: 'daily', name: '日用', icon: '🧻', type: 'expense' },
  { id: 'home', name: '居家', icon: '🏠', type: 'expense' },
  { id: 'fun', name: '娛樂', icon: '🎮', type: 'expense' },
  { id: 'medical', name: '醫療', icon: '💊', type: 'expense' },
  { id: 'study', name: '學習', icon: '📚', type: 'expense' },
  { id: 'other', name: '其他', icon: '📦', type: 'expense' },
  { id: 'salary', name: '薪水', icon: '💰', type: 'income' },
  { id: 'bonus', name: '獎金', icon: '🎁', type: 'income' },
  { id: 'invest', name: '投資', icon: '📈', type: 'income' },
  { id: 'side', name: '副業', icon: '💼', type: 'income' },
  { id: 'other_in', name: '其他', icon: '🪙', type: 'income' },
];
const COLORS = ['#0f766e', '#ea580c', '#2563eb', '#ca8a04', '#9333ea', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#64748b'];

// ---------- 資料 ----------
// tx[].src：undefined＝手動、'line'＝銀行 LINE 通知、'invoice'＝載具發票；tx[].inv＝發票號碼；tx[].merged＝兩個來源已合併成一筆
// inbox：自動抓到但看不懂（轉帳、卡費、外幣…）的訊息，等使用者確認
// seen：處理過的訊息指紋，重複匯入／重複通知不會記兩次
const DEFAULT_KEYWORDS = ['富邦', '華南'];
const fresh = () => ({ tx: [], cats: DEFAULT_CATS.slice(), budget: 0, inbox: [], seen: [], log: [], rules: [], keywords: DEFAULT_KEYWORDS.slice() });
let db = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (Array.isArray(d.tx) && Array.isArray(d.cats)) return { ...fresh(), ...d };
    }
  } catch (e) {}
  return fresh();
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (e) {
    toast('儲存失敗：手機儲存空間不足或處於私密瀏覽模式');
  }
}
// 請瀏覽器把資料標成「持久保存」，降低被系統自動清掉的機率。
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// 舊資料整理（依新規則）：清掉金額不明的待確認、重新檢查自動記的 LINE 紀錄（使用者沒改過的才動）
function migrate() {
  if (typeof Parse === 'undefined') return;
  const before = db.inbox.length + db.tx.length;
  db.inbox = db.inbox.filter((m) => m.amount != null && !Parse.parseBankMessage(m.text, m.date).weak);
  db.tx = db.tx.filter((t) => !(t.src === 'line' && t.catAuto !== false && !t.merged && t.raw
    && Parse.parseBankMessage(t.raw, t.date).weak));
  if (db.inbox.length + db.tx.length !== before) save();
}
migrate();

// ---------- 工具 ----------
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const money = (n) => (n < 0 ? '−' : '') + 'NT$' + (Math.round(Math.abs(n) * 100) / 100).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const catOf = (id) => db.cats.find((c) => c.id === id) || { name: '未分類', icon: '❔' };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function dayLabel(s) {
  const today = ymd(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  const [Y, M, D] = s.split('-').map(Number);
  const w = WEEK[new Date(Y, M - 1, D).getDay()];
  if (s === today) return `今天 · ${M}/${D}（${w}）`;
  if (s === ymd(y)) return `昨天 · ${M}/${D}（${w}）`;
  return `${M}/${D}（${w}）`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}
const monthTx = (m) => db.tx.filter((t) => t.date.startsWith(m));
const sum = (arr, type) => arr.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0);

// ---------- 畫面切換 ----------
let tab = 'home';
let curMonth = ym(new Date());
let query = '';

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  render();
  window.scrollTo(0, 0);
}));
$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
function shiftMonth(n) {
  const [y, m] = curMonth.split('-').map(Number);
  curMonth = ym(new Date(y, m - 1 + n, 1));
  render();
}

function render() {
  const titles = { home: '隨手記帳', list: '明細', stats: '統計', settings: '設定' };
  $('#title').textContent = titles[tab];
  $('#monthBar').hidden = !(tab === 'list' || tab === 'stats');
  const [y, m] = curMonth.split('-').map(Number);
  $('#monthLabel').textContent = `${y} 年 ${m} 月`;
  $('#fab').hidden = tab === 'settings';
  ({ home: renderHome, list: renderList, stats: renderStats, settings: renderSettings })[tab]();
}

function txRow(t) {
  const c = catOf(t.cat);
  const sign = t.type === 'expense' ? '−' : '+';
  const badge = t.merged ? '<span class="badge merged">LINE＋發票</span>'
    : t.src === 'line' ? '<span class="badge line">LINE</span>'
    : t.src === 'invoice' ? '<span class="badge invoice">發票</span>' : '';
  return `<button class="tx" data-id="${t.id}">
    <span class="ico">${c.icon}</span>
    <span class="mid"><div class="name">${esc(c.name)}${badge}</div>${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}${t.memo ? `<div class="note memo-line">🔖 ${esc(t.memo)}</div>` : ''}</span>
    <span class="amt ${t.type === 'expense' ? 'exp' : 'inc'}">${sign}${money(t.amount)}</span>
  </button>`;
}
function bindRows() {
  document.querySelectorAll('.tx[data-id]').forEach((el) => el.addEventListener('click', () => openSheet(db.tx.find((t) => t.id === el.dataset.id))));
}
const byNewest = (a, b) => (b.date + b.ts).localeCompare(a.date + a.ts);

function renderHome() {
  const now = new Date();
  const m = ym(now);
  const list = monthTx(m);
  const exp = sum(list, 'expense'), inc = sum(list, 'income');
  const todayTx = db.tx.filter((t) => t.date === ymd(now)).sort(byNewest);
  const todayExp = sum(todayTx, 'expense');
  let budgetHtml = '';
  if (db.budget > 0) {
    const pct = exp / db.budget;
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
    const left = db.budget - exp;
    budgetHtml = `<div class="card"><h3>本月預算 ${money(db.budget)}</h3>
      <div class="bar ${pct > 1 ? 'over' : ''}"><i style="width:${Math.min(100, pct * 100)}%"></i></div>
      <div class="hint">${left >= 0
        ? `還剩 ${money(left)}，接下來 ${daysLeft} 天平均每天可花 ${money(left / daysLeft)}`
        : `已超支 ${money(-left)}`}</div></div>`;
  } else {
    budgetHtml = `<div class="card hint">到「設定」填入每月預算，就能看到每天還能花多少。</div>`;
  }
  const recent = db.tx.slice().sort(byNewest).filter((t) => t.date !== ymd(now)).slice(0, 5);
  const inbox = db.inbox.slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const inboxHtml = inbox.length ? `<div class="card"><h3>⚠️ 待確認 ${inbox.length} 筆（自動抓到但不確定，點一下確認或忽略）</h3>
    ${inbox.map((m) => `<button class="inbox-item" data-inbox="${m.id}">
      <div><b>${m.amount ? money(m.amount) : '金額不明'}</b> <span class="hint">${esc(m.sender)} · ${m.date.slice(5).replace('-', '/')} ${m.time}</span></div>
      <div class="why">${esc(m.reason)}</div><div class="txt">${esc(m.text)}</div></button>`).join('')}</div>` : '';
  $('#view').innerHTML = `
    ${updateBannerHtml()}
    ${autoStatusHtml()}
    ${inboxHtml}
    <div class="card summary">
      <div class="big"><div class="stat-label">${now.getMonth() + 1} 月支出</div><div class="stat-num exp">${money(exp)}</div></div>
      <div><div class="stat-label">本月收入</div><div class="stat-num inc">${money(inc)}</div></div>
      <div><div class="stat-label">結餘</div><div class="stat-num">${money(inc - exp)}</div></div>
    </div>
    ${budgetHtml}
    <div class="card"><h3>今天 · 支出 ${money(todayExp)}</h3>
      ${todayTx.length ? todayTx.map(txRow).join('') : '<div class="empty">今天還沒記帳，按右下角 ＋ 開始</div>'}
    </div>
    ${recent.length ? `<div class="card"><h3>最近幾筆</h3>${recent.map(txRow).join('')}</div>` : ''}`;
  bindRows();
  document.querySelectorAll('[data-inbox]').forEach((el) => el.addEventListener('click', () => openInbox(el.dataset.inbox)));
  const up = $('#doUpdate');
  if (up) up.addEventListener('click', () => toast(bridgeCall('installUpdate') || '更新失敗'));
  const go = $('#goAuto');
  if (go) go.addEventListener('click', () => document.querySelector('.tabs [data-tab=settings]').click());
}

// 首頁頂端的自動記帳狀態：Android App 內顯示通知權限狀態；網頁版提示可以匯入
function autoStatusHtml() {
  if (isAndroid()) {
    if (bridgeCall('isListenerEnabled') === true) return '';
    return `<div class="card"><h3>🔔 自動記帳尚未開啟</h3>
      <div class="hint">需要允許「讀取通知」，才能自動記下富邦、華南的 LINE 交易通知。</div>
      <button class="btn" id="goAuto" style="margin-top:10px">前往設定</button></div>`;
  }
  if (db.tx.some((t) => t.src)) return '';
  return `<div class="card"><h3>⚡ 不想手動記帳？</h3>
    <div class="hint">到「設定 → 自動記帳」匯入 LINE 銀行聊天記錄或載具發票明細，就會自動分類記好。</div>
    <button class="btn" id="goAuto" style="margin-top:10px">前往設定</button></div>`;
}

function renderList() {
  const q = query.trim().toLowerCase();
  const list = monthTx(curMonth).filter((t) => !q || (catOf(t.cat).name + ' ' + (t.note || '') + ' ' + (t.memo || '')).toLowerCase().includes(q)).sort(byNewest);
  const groups = {};
  list.forEach((t) => (groups[t.date] = groups[t.date] || []).push(t));
  const html = Object.keys(groups).map((d) => {
    const g = groups[d];
    return `<div class="day-head"><span>${dayLabel(d)}</span><span>支出 ${money(sum(g, 'expense'))}${sum(g, 'income') ? ` · 收入 ${money(sum(g, 'income'))}` : ''}</span></div>
      <div class="card">${g.map(txRow).join('')}</div>`;
  }).join('');
  $('#view').innerHTML = `<input class="search" id="search" type="search" placeholder="搜尋分類、店名或自訂類別" value="${esc(query)}">
    ${html || `<div class="empty">${q ? '找不到符合的紀錄' : '這個月沒有紀錄'}</div>`}`;
  const s = $('#search');
  s.addEventListener('input', () => {
    query = s.value;
    const pos = s.selectionStart;
    renderList();
    const ns = $('#search'); ns.focus(); ns.setSelectionRange(pos, pos);
  });
  bindRows();
}

function renderStats() {
  const list = monthTx(curMonth);
  const exp = sum(list, 'expense'), inc = sum(list, 'income');
  const byCat = {};
  list.filter((t) => t.type === 'expense').forEach((t) => { byCat[t.cat] = (byCat[t.cat] || 0) + t.amount; });
  const ranks = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  // 甜甜圈圖（SVG，不依賴外部函式庫）
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = ranks.map(([, v], i) => {
    const len = (v / exp) * C;
    const s = `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="26"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 90 90)"/>`;
    off += len;
    return s;
  }).join('');
  const donut = `<svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="支出分類比例">
    <circle r="${R}" cx="90" cy="90" fill="none" stroke="var(--line)" stroke-width="26"/>${arcs}
    <text x="90" y="84" text-anchor="middle" font-size="12" fill="var(--muted)">總支出</text>
    <text x="90" y="104" text-anchor="middle" font-size="${money(exp).length > 12 ? 12 : 16}" font-weight="700" fill="var(--text)">${money(exp)}</text></svg>`;

  // 每日支出長條
  const [y, m] = curMonth.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const daily = Array(days).fill(0);
  list.filter((t) => t.type === 'expense').forEach((t) => { daily[Number(t.date.slice(8)) - 1] += t.amount; });
  const maxD = Math.max(...daily, 1);
  const isThisMonth = curMonth === ym(new Date());
  const passed = isThisMonth ? new Date().getDate() : days;

  $('#view').innerHTML = `
    <div class="card summary">
      <div><div class="stat-label">支出</div><div class="stat-num exp">${money(exp)}</div></div>
      <div><div class="stat-label">收入</div><div class="stat-num inc">${money(inc)}</div></div>
      <div><div class="stat-label">日均支出</div><div class="stat-num">${money(exp / passed)}</div></div>
      <div><div class="stat-label">結餘</div><div class="stat-num">${money(inc - exp)}</div></div>
    </div>
    ${ranks.length ? `<div class="card"><h3>支出分類</h3><div class="donut-wrap">${donut}</div>
      ${ranks.map(([id, v], i) => {
        const c = catOf(id);
        return `<div class="rank"><span class="ico">${c.icon}</span><div class="mid">
          <div class="top-line"><span><i class="dot" style="background:${COLORS[i % COLORS.length]}"></i>${esc(c.name)} ${(v / exp * 100).toFixed(1)}%</span><b>${money(v)}</b></div>
          <div class="bar"><i style="width:${v / ranks[0][1] * 100}%;background:${COLORS[i % COLORS.length]}"></i></div></div></div>`;
      }).join('')}</div>
    <div class="card"><h3>每日支出（最高 ${money(maxD)}）</h3>
      <div class="daily">${daily.map((v, i) => `<i style="height:${v / maxD * 100}%" title="${m}/${i + 1} ${money(v)}"></i>`).join('')}</div>
      <div class="daily-axis"><span>1 日</span><span>${Math.ceil(days / 2)} 日</span><span>${days} 日</span></div></div>`
    : '<div class="empty">這個月還沒有支出紀錄</div>'}`;
}

function renderSettings() {
  const chips = (type) => db.cats.filter((c) => c.type === type).map((c) =>
    `<span class="chip">${c.icon} ${esc(c.name)}<button class="x" data-del="${c.id}" aria-label="刪除分類 ${esc(c.name)}">✕</button></span>`).join('');
  const android = isAndroid();
  const listenerOn = android && bridgeCall('isListenerEnabled') === true;
  const autoCard = `<div class="card"><h3>⚡ 自動記帳</h3>
    ${android ? `
      <div class="set-row"><span>讀取銀行通知（LINE／銀行 App／簡訊） ${listenerOn ? '<span class="ok">已開啟</span>' : '<span class="warn">未開啟</span>'}</span>
        <button class="btn" id="openListener">${listenerOn ? '設定' : '開啟'}</button></div>
      <div class="set-row"><span class="grow">避免被系統關閉（電池最佳化設為「不限制」）</span><button class="btn" id="openBattery">設定</button></div>
      <ol class="steps">
        <li>按上面「開啟」→ 找到「隨手記帳」→ 允許</li>
        <li>⭐ 打開富邦、華南「手機銀行／信用卡 App」的交易推播（LINE 卡片通知沒有金額，銀行 App 推播或簡訊才有）</li>
        <li>LINE → 設定 → 提醒 → 開啟「顯示訊息內容」</li>
        <li>之後通知一跳出來就會自動記帳；只有 LINE 通知時會放「待確認」提醒你補金額</li>
      </ol>` : `<p class="hint" style="margin:0 0 6px">Android App 可以在 LINE 通知跳出來時自動記帳；網頁版請用下方匯入。</p>`}
    <div class="set-row"><span class="grow">銀行聊天室關鍵字（用逗號分隔）</span></div>
    <input class="search" id="keywords" value="${esc(db.keywords.join('，'))}" aria-label="銀行聊天室關鍵字">
    <div class="set-row"><span class="grow">匯入 LINE 聊天記錄<div class="hint">補登過去的交易：LINE 銀行聊天室 → ≡ → 設定 → 傳送聊天記錄${android ? ' → 選「隨手記帳」，或存檔後按這裡' : '，存檔後按這裡'}</div></span><button class="btn" id="importLine">匯入</button></div>
    <div class="set-row"><span class="grow">匯入載具發票明細<div class="hint">財政部電子發票整合服務平台 → 登入手機條碼 → 消費紀錄查詢 → 匯出 CSV，再按這裡</div></span><button class="btn" id="importInv">匯入</button></div>
    <div class="set-row set-col"><div class="hint" style="margin-bottom:6px">測試：貼上一則銀行訊息，看 App 會怎麼解讀（不會記帳）</div>
      <textarea id="testMsg" placeholder="例：您的信用卡於10/21在全聯消費新臺幣256元"></textarea>
      <div id="testOut" class="hint"></div></div>
    <details class="set-row set-col"><summary>最近收到的訊息（${db.log.length} 則，診斷用）</summary>
      ${db.log.length ? db.log.map((l) => `<div class="inbox-item"><div><b>${{ tx: '✅ 已記帳', review: '⚠️ 待確認', ignore: '— 略過' }[l.status]}</b>
        <span class="hint">${esc(l.sender)} · ${esc(l.at)}${l.amount ? ' · ' + money(l.amount) : ''}</span></div>
        ${l.reason ? `<div class="why">${esc(l.reason)}</div>` : ''}<div class="txt">${esc(l.text)}</div></div>`).join('')
      : `<p class="hint">還沒收到任何${android ? '富邦／華南的 LINE 通知' : '訊息'}。${android ? '如果剛剛明明有通知卻沒出現，請確認上面「讀取 LINE 銀行通知」是「已開啟」，以及 LINE 有開「顯示訊息內容」。' : ''}</p>`}
    </details>
  </div>`;
  $('#view').innerHTML = `
    ${autoCard}
    <div class="card"><h3>預算</h3>
      <div class="set-row"><span>每月支出預算</span><input id="budget" type="number" inputmode="decimal" min="0" placeholder="未設定" value="${db.budget || ''}"></div>
    </div>
    <div class="card"><h3>支出分類</h3><div class="chips">${chips('expense')}</div>
      <h3 style="margin-top:16px">收入分類</h3><div class="chips">${chips('income')}</div>
      <div class="add-cat">
        <input class="emo" id="newIcon" maxlength="4" placeholder="🙂" aria-label="圖示">
        <input class="nm" id="newName" maxlength="8" placeholder="新分類名稱" aria-label="分類名稱">
        <select id="newType" aria-label="類型"><option value="expense">支出</option><option value="income">收入</option></select>
        <button class="btn" id="addCat">新增</button>
      </div>
    </div>
    <div class="card"><h3>🏷️ 自動分類規則（店名或通知內容含關鍵字 → 分類）</h3>
      ${db.rules.map((r) => `<div class="set-row"><span class="grow">${esc(r.kws.join('、'))} → ${catOf(r.cat).icon} ${esc(catOf(r.cat).name)}</span>
        <button class="x link danger" data-delrule="${r.id}" aria-label="刪除規則">✕</button></div>`).join('') || '<p class="hint">還沒有規則</p>'}
      <div class="add-cat">
        <input class="nm" id="ruleKw" placeholder="關鍵字（例：麥當勞）" aria-label="關鍵字">
        <select id="ruleCatSel" aria-label="分類">${db.cats.filter((c) => c.type === 'expense').map((c) => `<option value="${c.id}">${c.icon} ${esc(c.name)}</option>`).join('')}</select>
        <button class="btn" id="addRule">新增</button>
      </div>
      <p class="hint">也可以在明細點一筆、改分類時勾「以後都歸到這個分類」。</p>
    </div>
    <div class="card"><h3>資料（只存在這支手機，換手機前請先備份）</h3>
      <div class="set-row"><span>匯出 Excel 可開的 CSV</span><button class="btn" id="exportCsv">匯出</button></div>
      <div class="set-row"><span>備份全部資料（JSON）</span><button class="btn" id="backup">備份</button></div>
      <div class="set-row"><span>從備份檔還原</span><button class="btn" id="restore">還原</button></div>
      <div class="set-row"><span>共 ${db.tx.length} 筆紀錄</span><button class="btn danger" id="wipe">全部清除</button></div>
    </div>
    ${android ? `<div class="card"><div class="set-row"><span class="grow">目前版本 ${esc(bridgeCall('appVersion') || '')}</span><button class="btn" id="checkUpd">檢查更新</button></div></div>` : ''}
    <p class="hint" style="text-align:center">隨手記帳 · 免費、離線可用、不蒐集任何資料</p>`;

  if (android) {
    $('#checkUpd').addEventListener('click', () => {
      if (typeof AndroidBridge.checkUpdateNow !== 'function') { toast('這版 App 還不支援，請先在總覽按「更新」'); return; }
      bridgeCall('checkUpdateNow'); toast('檢查中…有新版會自動套用或在總覽出現「更新」');
    });
    $('#openListener').addEventListener('click', () => bridgeCall('openListenerSettings'));
    $('#openBattery').addEventListener('click', () => bridgeCall('openBatterySettings'));
  }
  $('#keywords').addEventListener('change', (e) => {
    const kw = e.target.value.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    db.keywords = kw.length ? kw : DEFAULT_KEYWORDS.slice();
    save(); syncKeywords(); toast('關鍵字已儲存：' + db.keywords.join('、'));
  });
  $('#importLine').addEventListener('click', () => $('#lineFile').click());
  $('#importInv').addEventListener('click', () => $('#invFile').click());
  $('#testMsg').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (!v) { $('#testOut').textContent = ''; return; }
    const r = Parse.parseBankMessage(v, ymd(new Date()));
    const label = { tx: '✅ 會自動記帳', review: '⚠️ 會放進「待確認」', ignore: '— 會忽略（不是交易）' }[r.status];
    $('#testOut').innerHTML = `${label}<br>${r.type ? (r.type === 'expense' ? '支出' : '收入') : '收支不明'} · ${r.amount ? money(r.amount) : '金額不明'}`
      + `${r.cat ? ' · ' + esc(catOf(r.cat).name) : ''}${r.merchant ? ' · ' + esc(r.merchant) : ''} · ${r.date}${r.reason ? '<br>原因：' + esc(r.reason) : ''}`;
  });
  $('#budget').addEventListener('change', (e) => {
    db.budget = Math.max(0, Number(e.target.value) || 0); save(); toast('預算已儲存');
  });
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const c = catOf(b.dataset.del);
    const used = db.tx.filter((t) => t.cat === c.id).length;
    if (db.cats.filter((x) => x.type === c.type).length <= 1) return toast('每種類型至少要保留一個分類');
    if (!confirm(used ? `「${c.name}」有 ${used} 筆紀錄，刪除後這些紀錄會顯示為「未分類」。確定刪除？` : `刪除分類「${c.name}」？`)) return;
    db.cats = db.cats.filter((x) => x.id !== c.id); save(); renderSettings();
  }));
  $('#addCat').addEventListener('click', () => {
    const name = $('#newName').value.trim();
    if (!name) return toast('請輸入分類名稱');
    db.cats.push({ id: 'c' + uid(), name, icon: $('#newIcon').value.trim() || '🏷️', type: $('#newType').value });
    save(); renderSettings(); toast(`已新增「${name}」`);
  });
  document.querySelectorAll('[data-delrule]').forEach((b) => b.addEventListener('click', () => {
    db.rules = db.rules.filter((r) => r.id !== b.dataset.delrule); save(); renderSettings(); toast('已刪除規則');
  }));
  $('#addRule').addEventListener('click', () => {
    const kws = $('#ruleKw').value.split(/[,，、]+/).map((x) => x.trim()).filter(Boolean);
    if (!kws.length) return toast('請輸入關鍵字');
    db.rules.unshift({ id: uid(), kws, cat: $('#ruleCatSel').value });
    const n = applyRules(); save(); renderSettings();
    toast(`已新增規則${n ? `，重新分類 ${n} 筆` : ''}`);
  });
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#backup').addEventListener('click', () => download(`記帳備份-${ymd(new Date())}.json`, JSON.stringify(db, null, 1), 'application/json'));
  $('#restore').addEventListener('click', () => $('#importFile').click());
  $('#wipe').addEventListener('click', () => {
    if (!confirm('確定要清除全部記帳紀錄？此動作無法復原，建議先備份。')) return;
    if (!confirm('再確認一次：真的全部清除？')) return;
    db = { ...fresh(), keywords: db.keywords }; save(); renderSettings(); toast('已清除');
  });
}

function download(name, text, type) {
  if (isAndroid()) { toast(bridgeCall('saveFile', name, text) || '儲存失敗'); return; } // WebView 不支援 blob 下載，改由 App 存到「下載」資料夾
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv() {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['日期', '類型', '分類', '金額', '店名／備註', '自訂類別']].concat(
    db.tx.slice().sort((a, b) => (a.date + a.ts).localeCompare(b.date + b.ts))
      .map((t) => [t.date, t.type === 'expense' ? '支出' : '收入', catOf(t.cat).name, t.amount, t.note || '', t.memo || '']));
  // 開頭加 BOM，Excel 才不會把中文顯示成亂碼
  download(`記帳明細-${ymd(new Date())}.csv`, '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.tx) || !Array.isArray(d.cats)) throw new Error('格式不符');
    const valid = d.tx.every((t) => t && t.id && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && Number.isFinite(t.amount) && (t.type === 'expense' || t.type === 'income'));
    if (!valid) throw new Error('紀錄內容有誤');
    if (!confirm(`備份檔有 ${d.tx.length} 筆紀錄，還原會取代目前的 ${db.tx.length} 筆。確定？`)) return;
    db = { ...fresh(), ...d }; save(); render(); toast('還原完成');
  } catch (err) {
    toast('還原失敗：' + err.message);
  }
});

// ---------- 新增／編輯表單 ----------
let form = null;
function openSheet(tx, inboxMsg) {
  form = tx
    ? { ...tx, amount: String(tx.amount), note: tx.note || '' }
    : { id: null, type: 'expense', amount: '', cat: null, date: ymd(new Date()), note: '' };
  if (inboxMsg) {
    Object.assign(form, {
      inboxId: inboxMsg.id, src: 'line', key: inboxMsg.key,
      type: inboxMsg.type || 'expense', amount: inboxMsg.amount ? String(inboxMsg.amount) : '',
      cat: inboxMsg.cat || null, date: inboxMsg.date, note: inboxMsg.merchant || inboxMsg.sender || '',
    });
  }
  const del = $('#sheetDelete');
  del.hidden = !tx && !inboxMsg;
  del.textContent = inboxMsg ? '忽略' : '刪除';
  const raw = $('#rawText');
  const rawSrc = inboxMsg ? inboxMsg : tx && tx.raw ? { reason: '', text: tx.raw } : null;
  raw.hidden = !rawSrc;
  if (rawSrc) raw.innerHTML = (rawSrc.reason ? `<b>${esc(rawSrc.reason)}</b>` : '') + esc(rawSrc.text);
  $('#dateInput').value = form.date;
  $('#noteInput').value = form.note;
  $('#memoInput').value = form.memo || '';
  // 用過的自訂類別（最近的在前，最多 8 個）→ 點一下就填入
  const used = [];
  for (const t of db.tx.slice().sort(byNewest)) if (t.memo && !used.includes(t.memo) && used.push(t.memo) >= 8) break;
  $('#memoChips').innerHTML = used.map((m) => `<button type="button" class="chip" data-memo="${esc(m)}">🔖 ${esc(m.length > 12 ? m.slice(0, 12) + '…' : m)}</button>`).join('');
  // 改自動紀錄的分類時，可以順便教 App：以後這家店都歸這類
  const learnKw = (form.note || '').split(/[：:]/)[0].trim();
  $('#learnRow').hidden = !(tx && tx.src && learnKw && form.type === 'expense');
  $('#learnKw').textContent = learnKw;
  $('#learnChk').checked = false;
  syncSheet();
  $('#sheetBg').hidden = false;
}
function openInbox(id) {
  const m = db.inbox.find((x) => x.id === id);
  if (m) openSheet(null, m);
}
function closeSheet() {
  $('#sheetBg').hidden = true; form = null;
  if (updatePending) window.__updateReady();
}
function syncSheet() {
  document.querySelectorAll('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === form.type));
  const cats = db.cats.filter((c) => c.type === form.type);
  if (!cats.some((c) => c.id === form.cat)) form.cat = cats[0] && cats[0].id;
  $('#catGrid').innerHTML = cats.map((c) =>
    `<button data-cat="${c.id}" class="${c.id === form.cat ? 'on' : ''}"><span>${c.icon}</span>${esc(c.name)}</button>`).join('');
  const disp = $('#amountDisp');
  disp.textContent = form.amount ? Number(form.amount.replace(/\.$/, '')).toLocaleString('zh-TW') + (form.amount.endsWith('.') ? '.' : '') : '0';
  disp.className = 'amount ' + (form.type === 'expense' ? 'exp' : 'inc');
}
$('#fab').addEventListener('click', () => openSheet(null));
$('#sheetCancel').addEventListener('click', closeSheet);
$('#sheetBg').addEventListener('click', (e) => { if (e.target.id === 'sheetBg') closeSheet(); });
$('#typeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  form.type = b.dataset.type; syncSheet();
});
$('#catGrid').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  form.cat = b.dataset.cat; form.catTouched = true; syncSheet();
});
$('#dateInput').addEventListener('change', (e) => { form.date = e.target.value; });
$('#noteInput').addEventListener('input', (e) => {
  form.note = e.target.value;
  // 輸入的店名符合分類規則 → 自動切分類（使用者自己點過分類就不動）
  const c = !form.catTouched && form.type === 'expense' && ruleCat(form.note);
  if (c && c !== form.cat) { form.cat = c; syncSheet(); }
});
$('#memoInput').addEventListener('input', (e) => { form.memo = e.target.value; });
$('#memoChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-memo]'); if (!b) return;
  form.memo = b.dataset.memo; $('#memoInput').value = form.memo;
});
$('#sheetDelete').addEventListener('click', () => {
  if (form.inboxId) {
    db.inbox = db.inbox.filter((m) => m.id !== form.inboxId); save(); closeSheet(); render(); toast('已忽略，不會記帳');
    return;
  }
  if (!confirm('刪除這筆紀錄？')) return;
  db.tx = db.tx.filter((t) => t.id !== form.id); save(); closeSheet(); render(); toast('已刪除');
});
$('#keypad').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.k || b.textContent;
  let a = form.amount;
  if (k === 'save') return saveForm();
  if (k === 'back') a = a.slice(0, -1);
  else if (k === 'clear') a = '';
  else if (k === '.') { if (!a.includes('.')) a = (a || '0') + '.'; }
  else {
    const dec = a.split('.')[1];
    if (dec !== undefined && dec.length + k.length > 2) return; // 最多兩位小數
    if (a.replace('.', '').length >= 9) return;                 // 上限約一億
    a = a === '0' ? k.replace(/^0+/, '') || '0' : a + k;
    if (a.startsWith('00')) a = '0';
  }
  form.amount = a; syncSheet();
});
function saveForm() {
  const amount = Number(form.amount);
  if (!(amount > 0)) return toast('請輸入金額');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return toast('請選擇日期');
  const { inboxId, catTouched, ...base } = form;
  const rec = { ...base, id: form.id || uid(), amount: Math.round(amount * 100) / 100, note: form.note.trim(), memo: (form.memo || '').trim(), ts: form.ts || new Date().toISOString(), catAuto: false };
  if (!rec.memo) delete rec.memo;
  if (inboxId) {
    const m = db.inbox.find((x) => x.id === inboxId);
    if (m) rec.raw = m.text;
    db.inbox = db.inbox.filter((x) => x.id !== inboxId);
  }
  const i = db.tx.findIndex((t) => t.id === rec.id);
  if (i >= 0) db.tx[i] = rec; else db.tx.push(rec);
  let learned = 0;
  if (!$('#learnRow').hidden && $('#learnChk').checked) {
    const kw = $('#learnKw').textContent;
    db.rules = db.rules.filter((r) => !(r.kws.length === 1 && r.kws[0] === kw));
    db.rules.unshift({ id: uid(), kws: [kw], cat: rec.cat });
    learned = applyRules() + 1;
  }
  save();
  const isNew = i < 0;
  closeSheet();
  render();
  toast(isNew ? `已記下 ${catOf(rec.cat).name} ${money(rec.amount)}` : learned ? `已更新，以後「${$('#learnKw').textContent}」都歸到 ${catOf(rec.cat).name}` : '已更新');
}

// 實體鍵盤也能輸入（電腦上測試用）
document.addEventListener('keydown', (e) => {
  if (!form || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const map = { Backspace: 'back', Enter: 'save', Escape: 'esc' };
  const k = map[e.key] || (/^[0-9.]$/.test(e.key) ? e.key : null);
  if (!k) return;
  if (k === 'esc') return closeSheet();
  const btn = [...document.querySelectorAll('#keypad button')].find((b) => (b.dataset.k || b.textContent) === k);
  if (btn) btn.click();
});

// ---------- 自訂分類規則：店名／通知內容含關鍵字 → 指定分類（設定頁可增刪） ----------
// 2026-10-23 使用者指定的 7 條，第一次載入時建立（含對應的新分類）
const USER_RULES_V1 = [
  { kws: ['立功'], name: '華碩中餐', icon: '🍛' },
  { kws: ['加油', '中油', '台塑石油', '全國加油'], name: '汽車加油', icon: '⛽' },
  { kws: ['統一超商', '7-ELEVEN', '7-11'], name: '7-11', icon: '🏪' },
  { kws: ['停車'], name: '停車', icon: '🅿️' },
  { kws: ['優食', 'Uber Eats', 'UberEats'], name: 'Uber點餐', icon: '🛵' },
  { kws: ['咖啡色商行'], name: '彼得咖啡廳', icon: '☕' },
  { kws: ['全家', 'FamilyMart'], name: '全家', icon: '🏬' },
];
function ensureCat(name, icon) {
  let c = db.cats.find((x) => x.name === name && x.type === 'expense');
  if (!c) { c = { id: 'c' + uid(), name, icon, type: 'expense' }; db.cats.push(c); }
  return c.id;
}
function seedRules() {
  if (db.rulesSeed === 1) return false;
  for (const r of USER_RULES_V1) db.rules.push({ id: uid(), kws: r.kws, cat: ensureCat(r.name, r.icon) });
  db.rulesSeed = 1;
  return true;
}
// 規則依順序比對，第一條符合的勝出（「以後都歸這類」學到的規則放最前面）
function ruleCat(text) {
  const t = String(text || '').toLowerCase();
  const r = db.rules.find((x) => db.cats.some((c) => c.id === x.cat) && x.kws.some((k) => k && t.includes(k.toLowerCase())));
  return r ? r.cat : null;
}
// 套用到既有的自動紀錄（使用者手動改過分類的不動）
function applyRules() {
  let n = 0;
  for (const t of db.tx) {
    if (!t.src || t.catAuto === false || t.type !== 'expense') continue;
    const c = ruleCat(`${t.note || ''} ${t.raw || ''}`);
    if (c && c !== t.cat) { t.cat = c; n++; }
  }
  return n;
}

// ---------- 自動記帳引擎 ----------
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
function markSeen(key) {
  db.seen.push(key);
  if (db.seen.length > 5000) db.seen = db.seen.slice(-4000);
}

// 加一筆自動紀錄。同一筆消費常常「銀行刷卡通知」和「載具發票」各來一次：
// 金額相同、日期差 3 天內、來源不同 → 合併成一筆（保留發票的店名與品項），不重複計算。
function addAuto(rec) {
  if (rec.inv && db.tx.some((t) => t.inv === rec.inv)) return 'dup';
  if (rec.type === 'expense') {
    const twin = db.tx.find((t) => t.type === 'expense' && t.src && t.src !== rec.src && !t.merged
      && Math.abs(t.amount - rec.amount) < 0.01 && dayDiff(t.date, rec.date) <= 3);
    if (twin) {
      const inv = rec.src === 'invoice' ? rec : twin;
      const bank = rec.src === 'invoice' ? twin : rec;
      twin.merged = true;
      twin.inv = inv.inv;
      twin.date = bank.date; // 銀行通知的日期是實際刷卡日
      twin.note = inv.note || bank.note;
      if (twin.catAuto !== false) twin.cat = inv.cat !== 'other' ? inv.cat : bank.cat;
      twin.raw = [bank.raw, inv.raw].filter(Boolean).join('\n—\n');
      const rc = ruleCat(`${twin.note} ${twin.raw}`);
      if (rc && twin.catAuto !== false) twin.cat = rc;
      return 'merged';
    }
  }
  db.tx.push({ id: uid(), ts: new Date().toISOString(), catAuto: true, ...rec });
  return 'added';
}

// LINE 卡片訊息的通知只有「您有一筆刷卡消費通知」（沒金額，放待確認）；
// 30 分鐘內同一家銀行的 App 推播／簡訊帶著金額進來並記帳後，這筆沒金額的待確認就多餘了 → 刪掉
function dropPlaceholders(m) {
  const bank = db.keywords.find((k) => (m.sender + m.text).includes(k));
  if (!bank) return;
  const at = Date.parse(`${m.date}T${m.time}`);
  db.inbox = db.inbox.filter((x) => !(x.amount == null && (x.sender + x.text).includes(bank)
    && Math.abs(Date.parse(`${x.date}T${x.time}`) - at) <= 30 * 60000));
}

// msgs: [{ date:'YYYY-MM-DD', time:'HH:MM', sender, text }]
function processMessages(msgs) {
  const n = { added: 0, merged: 0, review: 0, ignored: 0, dup: 0 };
  for (const m of msgs) {
    const key = Parse.msgKey(m.date, m.time, m.text);
    if (db.seen.includes(key)) { n.dup++; continue; }
    markSeen(key);
    const r = Parse.parseBankMessage(m.text, m.date);
    // 使用者要求：金額不明（LINE 卡片摘要）、疑似廣告的一律不顯示，只留在診斷紀錄
    if (r.status !== 'ignore' && r.weak) {
      r.status = 'ignore';
      r.reason = r.amount == null ? '沒有金額（LINE 卡片訊息只有摘要），不記帳' : r.reason;
    }
    // 診斷紀錄：保留最近 50 則收到的原文與解讀結果（設定頁可看）
    db.log.unshift({ at: `${m.date} ${m.time}`, sender: m.sender, text: m.text.slice(0, 500), status: r.status, amount: r.amount, reason: r.reason });
    if (db.log.length > 50) db.log.length = 50;
    if (r.status === 'ignore') { n.ignored++; continue; }
    if (r.status === 'review') {
      db.inbox.push({ id: uid(), key, date: r.date, time: m.time, sender: m.sender, text: m.text, type: r.type, amount: r.amount, cat: (r.type === 'expense' && ruleCat(`${r.merchant} ${m.text}`)) || r.cat, merchant: r.merchant, reason: r.reason });
      n.review++;
      continue;
    }
    dropPlaceholders(m);
    const res = addAuto({ src: 'line', key, type: r.type, amount: r.amount, cat: (r.type === 'expense' && ruleCat(`${r.merchant} ${m.text}`)) || r.cat, date: r.date, note: (r.merchant || m.sender).replace(/股份有限公司|有限公司/g, ''), raw: m.text });
    n[res === 'merged' ? 'merged' : 'added']++;
  }
  save();
  return n;
}

function importInvoices(list) {
  const n = { added: 0, merged: 0, dup: 0, void: 0 };
  for (const v of list) {
    if (v.void) { n.void++; continue; }
    const items = v.items.map((x) => x.name).join('、');
    const note = [v.seller.replace(/股份有限公司|有限公司/g, ''), items].filter(Boolean).join('：').slice(0, 60);
    const res = addAuto({
      src: 'invoice', inv: v.inv, type: 'expense', amount: v.amount, date: v.date, note,
      cat: ruleCat(v.seller + ' ' + items) || Parse.guessCat(v.seller + ' ' + items, 'expense'),
      raw: `發票 ${v.inv}｜${v.seller}｜${v.amount} 元${items ? '｜' + items : ''}`,
    });
    n[res]++;
  }
  save();
  return n;
}

function summary(n) {
  const parts = [];
  if (n.added) parts.push(`新增 ${n.added} 筆`);
  if (n.merged) parts.push(`合併 ${n.merged} 筆（發票＋刷卡同一筆）`);
  if (n.review) parts.push(`${n.review} 筆待確認`);
  if (n.dup) parts.push(`${n.dup} 筆之前已匯入`);
  if (n.void) parts.push(`${n.void} 張作廢發票略過`);
  if (n.ignored) parts.push(`${n.ignored} 則非交易訊息略過`);
  return parts.join('，') || '沒有可匯入的資料';
}

function importLineText(text) {
  const msgs = Parse.parseLineExport(text, db.keywords);
  if (!msgs.length) {
    toast(/\[LINE\]/.test(text) ? `聊天記錄裡找不到含「${db.keywords.join('、')}」的訊息` : '看不懂這個檔案，請用 LINE「傳送聊天記錄」產生的文字檔');
    return;
  }
  const n = processMessages(msgs);
  render();
  alert('LINE 聊天記錄匯入完成：\n' + summary(n));
}
$('#lineFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) importLineText(await f.text());
});
$('#invFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const buf = await f.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) { try { text = new TextDecoder('big5').decode(buf); } catch (err) {} } // 舊版平台匯出可能是 Big5
  const list = Parse.parseInvoiceCsv(text);
  if (!list.length) { toast('看不懂這個檔案，請用財政部平台匯出的載具消費明細'); return; }
  const n = importInvoices(list);
  render();
  alert(`載具發票匯入完成（共 ${list.length} 張）：\n` + summary(n));
});

// ---------- Android App 橋接（只有在 Android App 內才有 window.AndroidBridge） ----------
function isAndroid() { return typeof window.AndroidBridge === 'object' && window.AndroidBridge !== null; }
function bridgeCall(name, ...args) {
  try { return isAndroid() && typeof AndroidBridge[name] === 'function' ? AndroidBridge[name](...args) : null; } catch (e) { return null; }
}
function syncKeywords() { bridgeCall('setKeywords', JSON.stringify(db.keywords)); }

// App 在背景收到的通知先存在 Android 端，畫面打開時拿過來處理
function pullNative() {
  if (!isAndroid()) return;
  let list = [];
  try { list = JSON.parse(bridgeCall('getPending') || '[]'); } catch (e) {}
  if (list.length) {
    const msgs = list.map((x) => {
      const d = new Date(Number(x.time));
      return { date: ymd(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, sender: x.title || '', text: x.text || '' };
    });
    const n = processMessages(msgs);
    bridgeCall('ack', JSON.stringify(list.map((x) => x.id)));
    if (n.added || n.merged || n.review) toast('自動記帳：' + summary({ ...n, ignored: 0, dup: 0 }));
    if (!form) render();
  }
  const shared = bridgeCall('takeSharedText');
  if (shared) {
    if (/^表頭=|發票號碼/.test(shared.slice(0, 500))) {
      const inv = Parse.parseInvoiceCsv(shared);
      const n = importInvoices(inv); render(); alert(`載具發票匯入完成（共 ${inv.length} 張）：\n` + summary(n));
    } else importLineText(shared);
  }
}
window.__nativePush = pullNative;
window.__nativeToast = (msg) => toast(msg);

// ---------- 自動更新（Android App） ----------
// 新版畫面已在背景下載好：沒在輸入就馬上重新整理；正在輸入就等關掉面板再換
let updatePending = false;
window.__updateReady = () => {
  if (form) { updatePending = true; return; }
  try { sessionStorage.setItem('justUpdated', '1'); } catch (e) {}
  location.reload();
};
// Android 主程式有新版（需要使用者按一次確認）
let nativeUpdate = false;
window.__nativeUpdate = () => { nativeUpdate = true; if (!form) render(); };
function updateBannerHtml() {
  if (!nativeUpdate) return '';
  return `<div class="card"><h3>🆕 App 有新版本</h3>
    <div class="hint">按「更新」後系統會跳出安裝確認，記帳資料會保留。</div>
    <button class="btn" id="doUpdate" style="margin-top:10px">更新</button></div>`;
}
// Android 返回鍵：先關掉面板，沒有面板才離開 App
window.__onBack = () => {
  if (form) { closeSheet(); return true; }
  if (tab !== 'home') { document.querySelector('.tabs [data-tab=home]').click(); return true; }
  return false;
};

if (seedRules() | applyRules()) save();
render();

if (isAndroid()) {
  bridgeCall('bootOk'); // 告訴 App：這個版本的畫面能正常啟動（自動更新的安全網）
  try { if (sessionStorage.getItem('justUpdated')) { sessionStorage.removeItem('justUpdated'); toast('已自動更新到最新版'); } } catch (e) {}
  syncKeywords();
  pullNative();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pullNative(); render(); } });
} else if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // 離線可用：Service Worker 只管 /expense/ 範圍，不會影響同網域的其他頁面。（Android App 內檔案本來就在手機裡，不需要）
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
}
