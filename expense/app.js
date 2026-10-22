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
let db = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (Array.isArray(d.tx) && Array.isArray(d.cats)) return { budget: 0, ...d };
    }
  } catch (e) {}
  return { tx: [], cats: DEFAULT_CATS.slice(), budget: 0 };
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
  return `<button class="tx" data-id="${t.id}">
    <span class="ico">${c.icon}</span>
    <span class="mid"><div class="name">${esc(c.name)}</div>${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}</span>
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
  $('#view').innerHTML = `
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
}

function renderList() {
  const q = query.trim().toLowerCase();
  const list = monthTx(curMonth).filter((t) => !q || (catOf(t.cat).name + ' ' + (t.note || '')).toLowerCase().includes(q)).sort(byNewest);
  const groups = {};
  list.forEach((t) => (groups[t.date] = groups[t.date] || []).push(t));
  const html = Object.keys(groups).map((d) => {
    const g = groups[d];
    return `<div class="day-head"><span>${dayLabel(d)}</span><span>支出 ${money(sum(g, 'expense'))}${sum(g, 'income') ? ` · 收入 ${money(sum(g, 'income'))}` : ''}</span></div>
      <div class="card">${g.map(txRow).join('')}</div>`;
  }).join('');
  $('#view').innerHTML = `<input class="search" id="search" type="search" placeholder="搜尋分類或備註" value="${esc(query)}">
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
  $('#view').innerHTML = `
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
    <div class="card"><h3>資料（只存在這支手機，換手機前請先備份）</h3>
      <div class="set-row"><span>匯出 Excel 可開的 CSV</span><button class="btn" id="exportCsv">匯出</button></div>
      <div class="set-row"><span>備份全部資料（JSON）</span><button class="btn" id="backup">備份</button></div>
      <div class="set-row"><span>從備份檔還原</span><button class="btn" id="restore">還原</button></div>
      <div class="set-row"><span>共 ${db.tx.length} 筆紀錄</span><button class="btn danger" id="wipe">全部清除</button></div>
    </div>
    <p class="hint" style="text-align:center">隨手記帳 · 免費、離線可用、不蒐集任何資料</p>`;

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
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#backup').addEventListener('click', () => download(`記帳備份-${ymd(new Date())}.json`, JSON.stringify(db, null, 1), 'application/json'));
  $('#restore').addEventListener('click', () => $('#importFile').click());
  $('#wipe').addEventListener('click', () => {
    if (!confirm('確定要清除全部記帳紀錄？此動作無法復原，建議先備份。')) return;
    if (!confirm('再確認一次：真的全部清除？')) return;
    db = { tx: [], cats: DEFAULT_CATS.slice(), budget: 0 }; save(); renderSettings(); toast('已清除');
  });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv() {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['日期', '類型', '分類', '金額', '備註']].concat(
    db.tx.slice().sort((a, b) => (a.date + a.ts).localeCompare(b.date + b.ts))
      .map((t) => [t.date, t.type === 'expense' ? '支出' : '收入', catOf(t.cat).name, t.amount, t.note || '']));
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
    db = { budget: 0, ...d }; save(); render(); toast('還原完成');
  } catch (err) {
    toast('還原失敗：' + err.message);
  }
});

// ---------- 新增／編輯表單 ----------
let form = null;
function openSheet(tx) {
  form = tx
    ? { id: tx.id, type: tx.type, amount: String(tx.amount), cat: tx.cat, date: tx.date, note: tx.note || '', ts: tx.ts }
    : { id: null, type: 'expense', amount: '', cat: null, date: ymd(new Date()), note: '' };
  $('#sheetDelete').hidden = !tx;
  $('#dateInput').value = form.date;
  $('#noteInput').value = form.note;
  syncSheet();
  $('#sheetBg').hidden = false;
}
function closeSheet() { $('#sheetBg').hidden = true; form = null; }
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
  form.cat = b.dataset.cat; syncSheet();
});
$('#dateInput').addEventListener('change', (e) => { form.date = e.target.value; });
$('#noteInput').addEventListener('input', (e) => { form.note = e.target.value; });
$('#sheetDelete').addEventListener('click', () => {
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
  const rec = { id: form.id || uid(), type: form.type, amount: Math.round(amount * 100) / 100, cat: form.cat, date: form.date, note: form.note.trim(), ts: form.ts || new Date().toISOString() };
  const i = db.tx.findIndex((t) => t.id === rec.id);
  if (i >= 0) db.tx[i] = rec; else db.tx.push(rec);
  save();
  const isNew = i < 0;
  closeSheet();
  render();
  toast(isNew ? `已記下 ${catOf(rec.cat).name} ${money(rec.amount)}` : '已更新');
}

// 實體鍵盤也能輸入（電腦上測試用）
document.addEventListener('keydown', (e) => {
  if (!form || e.target.tagName === 'INPUT') return;
  const map = { Backspace: 'back', Enter: 'save', Escape: 'esc' };
  const k = map[e.key] || (/^[0-9.]$/.test(e.key) ? e.key : null);
  if (!k) return;
  if (k === 'esc') return closeSheet();
  const btn = [...document.querySelectorAll('#keypad button')].find((b) => (b.dataset.k || b.textContent) === k);
  if (btn) btn.click();
});

render();

// 離線可用：Service Worker 只管 /expense/ 範圍，不會影響同網域的其他頁面。
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
}
