// 隨手記帳 —— 自動記帳的解析核心（純函式，不碰畫面與儲存，Node 也能直接跑測試）。
// 原則：看得懂才自動記；金額或收支方向不確定一律回傳 review（放進「待確認」），絕不亂猜。
(function (root) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');

  // 全形數字／符號轉半形，方便比對
  function norm(s) {
    return String(s || '')
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/＄/g, '$')
      .replace(/ /g, ' ');
  }

  // ---------- 分類猜測（依商家／品名關鍵字） ----------
  const CAT_RULES = [
    ['drink', /50嵐|清心|可不可|迷客夏|CoCo|都可|大苑子|茶湯會|珍煮丹|萬波|麻古|龜記|五桐號|得正|鮮茶|手搖|奶茶|紅茶|綠茶|拿鐵|咖啡|星巴克|STARBUCKS|路易莎|LOUISA|cama|伯朗/i],
    ['food', /麥當勞|McDonald|肯德基|KFC|摩斯|MOS|漢堡王|頂呱呱|必勝客|達美樂|拿坡里|Uber ?Eats|foodpanda|熊貓|餐|飯|麵|食|早午?餐|便當|壽司|火鍋|鍋|燒肉|牛排|小吃|滷味|炸雞|飯糰|吐司|三明治|麵包|烘焙|7-?ELEVEN|統一超商|全家|FamilyMart|萊爾富|Hi-?Life|OK超商|OKmart/i],
    ['traffic', /加油|中油|台塑石油|全國加油|捷運|台鐵|臺鐵|高鐵|客運|悠遊卡|一卡通|iPASS|Uber|計程車|台灣大車隊|LINE ?TAXI|停車|eTag|遠通電收|GoShare|WeMo|iRent|YouBike|機車|汽車/i],
    ['home', /台電|臺電|電費|水費|自來水|瓦斯|天然氣|中華電信|台灣大哥大|遠傳|亞太電信|台灣之星|房租|管理費|IKEA|特力屋|HOLA|宜得利|NITORI/i],
    ['medical', /藥局|藥妝|藥|診所|醫院|牙醫|醫|健保|大樹|杏一|丁丁/],
    ['fun', /Netflix|Spotify|KKBOX|YouTube|Disney|Apple\.com|iTunes|Google Play|Steam|PlayStation|Nintendo|威秀|影城|秀泰|國賓|KTV|錢櫃|好樂迪|遊戲/i],
    ['study', /書局|誠品|金石堂|博客來|三民|書店|課程|補習|Hahow|Udemy|Coursera|學費/i],
    ['daily', /全聯|家樂福|Carrefour|好市多|Costco|大潤發|美廉社|屈臣氏|Watsons|康是美|寶雅|POYA|小北百貨|日藥本舖|松本清|衛生紙|洗衣|清潔/i],
    ['shop', /momo|富邦媒|蝦皮|Shopee|PChome|網家|酷澎|Coupang|Yahoo|樂天|百貨|新光三越|SOGO|遠東|微風|Uniqlo|ZARA|H&M|三井|Outlet|燦坤|全國電子|順發|大同|Apple|小米/i],
  ];
  function guessCat(text, type) {
    const t = norm(text);
    if (type === 'income') {
      if (/薪|薪資|薪轉|薪水/.test(t)) return 'salary';
      if (/獎金|年終|紅利/.test(t)) return 'bonus';
      if (/利息|股息|股利|配息|基金|證券/.test(t)) return 'invest';
      return 'other_in';
    }
    for (const [cat, re] of CAT_RULES) if (re.test(t)) return cat;
    return 'other';
  }

  // ---------- 銀行 LINE 訊息 ----------
  const NUM = '([0-9][0-9,]*(?:\\.\\d{1,2})?)';
  const AMOUNT_RES = [
    new RegExp('(?:NT\\$|NTD|TWD|新[臺台]幣|[臺台]幣)\\s*[:：]?\\s*' + NUM),
    new RegExp('(?:交易|消費|轉帳|轉出|轉入|提款|存入|扣款|入帳|刷卡)?金額\\s*(?:[:：為])?\\s*(?:NT\\$|新[臺台]幣|[臺台]幣)?\\s*' + NUM),
    new RegExp(NUM + '\\s*元'),
    new RegExp('\\$\\s*' + NUM),
  ];
  function findAmount(t) {
    // 先拿掉「餘額／可用額度」等不是交易金額的片段，避免把餘額當成花費
    const s = t.replace(/(?:帳戶|可用|目前|剩餘|活存)?(?:餘額|額度)\s*(?:[:：為])?\s*(?:NT\$|新[臺台]幣|[臺台]幣)?\s*-?[0-9][0-9,]*(?:\.\d+)?\s*元?/g, ' ');
    for (const re of AMOUNT_RES) {
      const m = s.match(re);
      if (m) {
        const v = Number(m[1].replace(/,/g, ''));
        if (v > 0 && v < 1e9) return v;
      }
    }
    return null;
  }

  const MERCHANT_RES = [
    /(?:消費商店|交易商店|特約商店|商店名稱|商店|特店|商家|消費地點|收款人|收款帳戶名稱|交易對象|轉入戶名|戶名|摘要|說明|備註)\s*[:：]\s*([^\n，,。；;]+)/,
    /於\s*([^\s，,。；;]{2,24}?)\s*(?:消費|刷卡|交易|扣款)/,
    /在\s*([^\s，,。；;]{2,24}?)\s*(?:消費|刷卡)/,
  ];
  function findMerchant(t) {
    for (const re of MERCHANT_RES) {
      const m = t.match(re);
      if (m) {
        const v = m[1].trim()
          .replace(/^[\d\/.\-:：\s]+/, '').replace(/^在/, '') // 「於10/21在星巴克消費」→ 星巴克
          .replace(/(?:NT\$|新[臺台]幣|[臺台]幣)?\s*[0-9][0-9,]*(?:\.\d+)?\s*元?$/, '').trim();
        if (v && !/^[0-9*xX\-\s]+$/.test(v)) return v.slice(0, 30);
      }
    }
    return '';
  }

  // 訊息裡若有交易日期（例如「10/21 14:05」），以它為準；否則用收到訊息的日期
  function findDate(t, baseDate) {
    const m = t.match(/(?:(\d{2,4})[\/.\-年])?(\d{1,2})[\/.\-月](\d{1,2})日?(?:\s*\d{1,2}:\d{2})?/);
    if (!m) return baseDate;
    const mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return baseDate;
    const [by] = baseDate.split('-').map(Number);
    let y = m[1] ? Number(m[1]) : by;
    if (m[1] && y < 1000) y += 1911; // 民國年
    let s = `${y}-${pad(mo)}-${pad(d)}`;
    if (!m[1] && s > baseDate) s = `${y - 1}-${pad(mo)}-${pad(d)}`; // 跨年：1 月收到 12/31 的交易
    const diff = (Date.parse(baseDate) - Date.parse(s)) / 864e5;
    return diff >= 0 && diff <= 40 ? s : baseDate;
  }

  // 回傳 { status: 'tx' | 'review' | 'ignore', type, amount, merchant, cat, date, reason }
  function parseBankMessage(text, baseDate) {
    const t = norm(text);
    const amount = findAmount(t);
    const merchant = findMerchant(t);
    const date = baseDate ? findDate(t, baseDate) : undefined;
    // 真正的交易通知一定帶個人資訊（卡號／帳號末四碼、交易時間…）；沒有的多半是廣告裡剛好出現「刷卡」「NT$」
    const personal = /(您的|您於|帳戶|帳號|卡號|末四碼|末4碼|尾號|交易時間|入帳時間|消費時間|授權|交易通知|交易提醒|消費通知|入帳通知|卡友您|非您的消費|非本人|消費提醒|即時消費|您(?:於)?\s*\d{2,4}\s*年|您(?:於)?\s*\d{1,2}\s*[\/月]\s*\d{1,2}|刷卡\s*(?:NT\$|新?[臺台]幣)?\s*[0-9][0-9,]*\s*元)/.test(t);
    const r = (status, type, reason) => {
      if (status === 'tx' && !personal) { status = 'review'; reason = '看不到卡號／帳號或交易時間，可能是廣告或活動訊息'; }
      return {
        status, type: type || null, amount, merchant, date, reason: reason || '',
        cat: type ? guessCat(merchant + ' ' + t, type) : null,
        weak: amount == null || !personal, // 歷史匯入時，這種不確定又沒用的直接略過，不塞爆待確認
      };
    };

    if (/驗證碼|OTP|一次性密碼|動態密碼/i.test(t)) return r('ignore', null, '驗證碼訊息');
    if (/(活動|優惠|抽獎|好禮|登錄|限時|專屬|加碼|最高回饋|享\d+%)/.test(t) && !/(您的|您於|帳戶|帳號|卡號|末四碼|末4碼|尾號|交易成功|已扣款|已入帳)/.test(t)) {
      return r('ignore', null, '廣告／活動訊息');
    }
    if (amount == null) {
      // 銀行的卡片訊息（Flex）在通知裡常只剩一句摘要、沒有金額 → 放待確認讓使用者補金額，不要漏掉
      if (/(消費|刷卡|扣款|轉帳|轉出|轉入|入帳|存入|存款|提款|交易通知|交易提醒|授權)/.test(t)) {
        const type = /消費|刷卡|扣款|扣帳|轉出|提款|授權/.test(t) ? 'expense' : /入帳|存入|存款|轉入|退款|退刷/.test(t) ? 'income' : null;
        return r('review', type, '通知裡沒有金額（銀行卡片訊息只顯示摘要），請打開 LINE 看金額後填入');
      }
      return r('ignore', null, '不是交易訊息');
    }
    if (/USD|JPY|EUR|CNY|KRW|HKD|美元|美金|日圓|日幣|歐元|人民幣|韓元|港幣|外幣/i.test(t) && !/(NT\$|新[臺台]幣|[臺台]幣)/.test(t)) {
      return r('review', 'expense', '外幣交易，金額需換算成台幣');
    }
    if (/(?:繳|扣|付)\S{0,4}(?:信用)?卡(?:費|款)|信用卡(?:款|帳單|費)|卡費/.test(t)) {
      return r('review', 'expense', '可能是繳信用卡費：若刷卡消費已逐筆記帳，再記一次會重複');
    }
    if (/退款|退刷|退貨|沖正|取消交易|撤銷/.test(t)) return r('tx', 'income', '');
    if (/薪資|薪轉|薪水/.test(t)) return r('tx', 'income', '');
    if (/利息|股息|股利|配息/.test(t)) return r('tx', 'income', '');
    if (/消費|刷卡|簽帳|扣款|提款|提領|付款|支付|繳費|扣繳|購買/.test(t)) return r('tx', 'expense', '');
    if (merchant && /(?:商店|特店|商家|消費地點)\s*[:：]/.test(t)) return r('tx', 'expense', ''); // 有「商店：」欄位就是消費
    if (/轉出|匯出|轉帳支出/.test(t)) return r('review', 'expense', '轉帳：若是轉到自己的其他帳戶請按「忽略」');
    if (/轉入|匯入|存入|入帳|轉帳存入/.test(t)) return r('review', 'income', '轉入：若是自己帳戶互轉請按「忽略」');
    return r('review', null, '看不出是支出還是收入');
  }

  // ---------- LINE「傳送聊天記錄」匯出的文字檔 ----------
  // 格式（各版本略有差異）：
  //   [LINE] 與台北富邦銀行的聊天記錄
  //   2026/10/21（二）
  //   14:05\t台北富邦銀行\t訊息內容（多行時用雙引號包住）
  function parseLineExport(txt, keywords) {
    const lines = String(txt || '').replace(/^﻿/, '').split(/\r?\n/);
    const kw = (keywords || []).filter(Boolean);
    const hit = (s) => kw.some((k) => String(s || '').includes(k));
    let chatTitle = '';
    let date = null;
    const out = [];
    let cur = null;
    const flush = () => {
      if (!cur) return;
      let tx = cur.text.trim();
      if (tx.length > 1 && tx.startsWith('"') && tx.endsWith('"')) tx = tx.slice(1, -1).replace(/""/g, '"');
      cur.text = tx;
      if (tx && (hit(cur.sender) || (hit(chatTitle) && cur.sender))) out.push(cur);
      cur = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/​/g, '');
      const title = line.match(/^\[LINE\]\s*(?:與(.+?)的聊天記錄|Chat history with (.+)|(.+?)的聊天記錄)/);
      if (title) { chatTitle = title[1] || title[2] || title[3] || ''; continue; }
      const dm = line.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?:\s*[（(][^）)]*[）)]|\s+\S+)?\s*$/);
      if (dm && !line.includes('\t')) {
        flush();
        date = `${dm[1]}-${pad(dm[2])}-${pad(dm[3])}`;
        continue;
      }
      const mm = line.match(/^(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\t([^\t]*)(?:\t(.*))?$/i);
      if (mm && date) {
        flush();
        let h = Number(mm[2]);
        const ap = (mm[1] || mm[4] || '').toUpperCase();
        if ((ap === '下午' || ap === 'PM') && h < 12) h += 12;
        if ((ap === '上午' || ap === 'AM') && h === 12) h = 0;
        cur = { date, time: `${pad(h)}:${mm[3]}`, sender: mm[5].trim(), text: mm[6] || '' };
        continue;
      }
      if (/^儲存日期[:：]/.test(line)) continue;
      if (cur) cur.text += '\n' + line; // 多行訊息的後續行
    }
    flush();
    return out;
  }

  // ---------- 財政部電子發票平台「載具消費明細」匯出檔 ----------
  // 常見格式（以 | 分隔）：
  //   表頭=M|載具自訂名稱|發票日期|發票號碼|發票金額|發票狀態|折讓|賣方統一編號|賣方名稱|...
  //   明細=D|發票號碼|小計|品項名稱
  //   M|手機條碼|20261021|AB12345678|120|開立|...
  //   D|AB12345678|35|鮮奶
  // 也接受一般 CSV（第一列是欄位名稱，含「發票號碼」）。
  const INV_RE = /^[A-Z]{2}-?\d{8}$/;
  function normInvDate(s) {
    s = String(s || '').trim();
    let m;
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if ((m = s.match(/^(\d{3})(\d{2})(\d{2})$/))) return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
    if ((m = s.match(/^(\d{2,4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/))) {
      let y = Number(m[1]); if (y < 1000) y += 1911;
      return `${y}-${pad(m[2])}-${pad(m[3])}`;
    }
    return null;
  }
  function splitRow(line) {
    if (line.includes('|')) return line.split('|').map((x) => x.trim());
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  function parseInvoiceCsv(txt) {
    const lines = String(txt || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    let mCols = null, dCols = null;
    const invs = new Map();
    const idx = (cols, re) => (cols ? cols.findIndex((c) => re.test(c)) : -1);
    for (const line of lines) {
      let m;
      if ((m = line.match(/^表頭\s*=\s*(.*)$/))) { mCols = splitRow(m[1]); continue; }
      if ((m = line.match(/^明細\s*=\s*(.*)$/))) { dCols = splitRow(m[1]); continue; }
      const f = splitRow(line);
      if (!mCols && f.some((c) => /發票號碼/.test(c))) { mCols = f; continue; } // 一般 CSV 的欄位列
      const isD = f[0] === 'D';
      if (isD) {
        const iInv = dCols ? idx(dCols, /發票號碼/) : 1;
        const iAmt = dCols ? idx(dCols, /小計|金額/) : 2;
        const iName = dCols ? idx(dCols, /品項|品名/) : 3;
        const inv = (f[iInv] || '').replace('-', '');
        if (invs.has(inv) && f[iName]) invs.get(inv).items.push({ name: f[iName], amount: Number(f[iAmt]) || 0 });
        continue;
      }
      // M 列（或一般 CSV 的資料列）
      let iInv = idx(mCols, /發票號碼/);
      if (iInv < 0) iInv = f.findIndex((c) => INV_RE.test(c));
      const inv = (f[iInv] || '').replace('-', '');
      if (!INV_RE.test(inv)) continue;
      let iDate = idx(mCols, /日期/);
      if (iDate < 0) iDate = f.findIndex((c) => normInvDate(c) && !INV_RE.test(c));
      const iAmt = idx(mCols, /發票金額|總金額|消費金額|^金額$/);
      const iSeller = idx(mCols, /賣方名稱|店名|商店名稱|商家/);
      const iStatus = idx(mCols, /狀態/);
      const iItem = idx(mCols, /品項|品名/);
      const iSub = idx(mCols, /小計/);
      const date = normInvDate(f[iDate]);
      const amount = Number(String(f[iAmt] != null ? f[iAmt] : '').replace(/,/g, ''));
      if (!date || !(amount > 0)) continue;
      if (!invs.has(inv)) {
        invs.set(inv, {
          inv, date, amount,
          seller: iSeller >= 0 ? f[iSeller] : '',
          void: iStatus >= 0 && /作廢|註銷|退回/.test(f[iStatus] || ''),
          items: [],
        });
      }
      if (iItem >= 0 && f[iItem]) invs.get(inv).items.push({ name: f[iItem], amount: Number(f[iSub]) || 0 });
    }
    return [...invs.values()];
  }

  const msgKey = (date, time, text) => `${date} ${time}|${norm(text).replace(/\s+/g, '')}`;

  const API = { norm, guessCat, findAmount, findMerchant, parseBankMessage, parseLineExport, parseInvoiceCsv, normInvDate, msgKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Parse = API;
})(this);
