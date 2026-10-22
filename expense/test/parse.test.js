// 執行：node expense/test/parse.test.js
const P = require('../parse.js');
const assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('✓', name); };
const B = '2026-10-21';

t('信用卡消費（在…消費）', () => {
  const r = P.parseBankMessage('【台北富邦】您的信用卡末四碼1234於10/21 14:05在全聯福利中心消費新臺幣256元，如有疑問請洽客服。', B);
  assert.deepStrictEqual([r.status, r.type, r.amount, r.merchant, r.cat, r.date], ['tx', 'expense', 256, '全聯福利中心', 'daily', B]);
});
t('轉出 → 待確認，且不把餘額當金額', () => {
  const r = P.parseBankMessage('親愛的客戶您好，您的帳戶*****1234於2026/10/20 09:30轉出新臺幣5,000元，帳戶餘額新臺幣12,345元。', B);
  assert.deepStrictEqual([r.status, r.type, r.amount, r.date], ['review', 'expense', 5000, '2026-10-20']);
});
t('餘額寫在金額前面', () => {
  const r = P.parseBankMessage('可用餘額 20,000 元；您的帳號末四碼5678於10/20 12:30 ATM提款 3,000 元', B);
  assert.deepStrictEqual([r.status, r.type, r.amount], ['tx', 'expense', 3000]);
});
t('薪資轉入 → 收入／薪水', () => {
  const r = P.parseBankMessage('您的帳戶於10/05 薪資轉入新臺幣45,000元', B);
  assert.deepStrictEqual([r.status, r.type, r.amount, r.cat, r.date], ['tx', 'income', 45000, 'salary', '2026-10-05']);
});
t('繳信用卡費 → 待確認（避免重複）', () => {
  const r = P.parseBankMessage('您的帳戶自動扣繳信用卡款新臺幣12,000元', B);
  assert.strictEqual(r.status, 'review'); assert.match(r.reason, /信用卡費/);
});
t('退刷 → 收入', () => {
  const r = P.parseBankMessage('您的信用卡於蝦皮購物退刷NT$399', B);
  assert.deepStrictEqual([r.status, r.type, r.amount], ['tx', 'income', 399]);
});
t('驗證碼、廣告 → 忽略', () => {
  assert.strictEqual(P.parseBankMessage('您的交易驗證碼為123456，請勿告訴他人', B).status, 'ignore');
  assert.strictEqual(P.parseBankMessage('刷富邦卡享最高5%回饋，滿3000元再送300元，立即登錄！', B).status, 'ignore');
  assert.strictEqual(P.parseBankMessage('歡迎加入華南銀行好友', B).status, 'ignore');
});
t('外幣 → 待確認', () => {
  const r = P.parseBankMessage('您的信用卡於10/21在AMAZON消費USD 12.50元', B);
  assert.strictEqual(r.status, 'review'); assert.match(r.reason, /外幣/);
});
t('全形數字與「商店：」欄位', () => {
  const r = P.parseBankMessage('交易通知\n交易金額：ＮＴ$１,２３０\n商店：麥當勞台北店\n交易類型：刷卡消費', B);
  assert.deepStrictEqual([r.status, r.amount, r.merchant, r.cat], ['tx', 1230, '麥當勞台北店', 'food']);
});
t('跨年：1 月收到 12/31 的交易', () => {
  const r = P.parseBankMessage('您的信用卡於12/31在全家消費新臺幣50元', '2027-01-01');
  assert.strictEqual(r.date, '2026-12-31');
});
t('LINE 匯出檔', () => {
  const txt = '﻿[LINE] 與台北富邦銀行的聊天記錄\n儲存日期：2026/10/22 14:00\n\n2026/10/21（二）\n上午09:15\t台北富邦銀行\t您的信用卡於10/21在全家消費新臺幣85元\n下午02:05\t台北富邦銀行\t"交易通知\n金額：NT$1,230\n商店：麥當勞"\n2026/10/22（三）\n13:00\t王小明\t晚上吃什麼\n';
  const msgs = P.parseLineExport(txt, ['富邦', '華南']);
  assert.strictEqual(msgs.length, 3); // 對話標題含「富邦」→ 該聊天室訊息全收（官方帳號聊天室只有銀行在講話）
  assert.deepStrictEqual([msgs[0].date, msgs[0].time], ['2026-10-21', '09:15']);
  assert.strictEqual(msgs[1].time, '14:05');
  assert.strictEqual(msgs[1].text, '交易通知\n金額：NT$1,230\n商店：麥當勞');
  const other = P.parseLineExport(txt.replace('[LINE] 與台北富邦銀行的聊天記錄', '[LINE] 與朋友的聊天記錄'), ['富邦']);
  assert.strictEqual(other.length, 2); // 非銀行聊天室只收寄件人含關鍵字的
});
t('載具明細（| 格式，含作廢）', () => {
  const txt = '表頭=M|載具自訂名稱|發票日期|發票號碼|發票金額|發票狀態|折讓|賣方統一編號|賣方名稱|賣方地址|買方統編\n明細=D|發票號碼|小計|品項名稱\nM|手機條碼|20261021|AB12345678|120|開立|0|22555003|統一超商股份有限公司台北門市|台北市|\nD|AB12345678|35|鮮奶\nD|AB12345678|85|御飯糰\nM|手機條碼|1151020|CD87654321|500|作廢|0|1|某店|x|\n';
  const r = P.parseInvoiceCsv(txt);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual([r[0].inv, r[0].date, r[0].amount, r[0].items.length, r[0].void], ['AB12345678', '2026-10-21', 120, 2, false]);
  assert.deepStrictEqual([r[1].date, r[1].void], ['2026-10-20', true]);
});
t('載具明細（一般 CSV，一張發票多列品項）', () => {
  const txt = '載具名稱,發票日期,發票號碼,發票金額,賣方名稱,品項名稱,小計\n手機條碼,2026/10/19,EF-11112222,"1,050",全聯福利中心,衛生紙,199\n手機條碼,2026/10/19,EF-11112222,"1,050",全聯福利中心,洗衣精,851\n';
  const r = P.parseInvoiceCsv(txt);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].inv, r[0].amount, r[0].items.length, r[0].seller], ['EF11112222', 1050, 2, '全聯福利中心']);
  assert.strictEqual(P.guessCat(r[0].seller, 'expense'), 'daily');
});
t('店名前面的日期要去掉', () => {
  assert.strictEqual(P.parseBankMessage('您的信用卡於10/21在星巴克消費新臺幣150元', B).merchant, '星巴克');
  assert.strictEqual(P.parseBankMessage('您的信用卡末四碼1234於10/19在全聯福利中心消費新臺幣1,050元', B).merchant, '全聯福利中心');
});
t('沒寫「消費」但有「商店：」欄位 → 支出', () => {
  const r = P.parseBankMessage('交易通知\n金額：NT$1,230\n商店：麥當勞', B);
  assert.deepStrictEqual([r.status, r.type, r.cat], ['tx', 'expense', 'food']);
});
t('真實格式：華南信用卡刷卡卡片（2026-10-22 使用者截圖）', () => {
  const txt = '遇信用卡詐騙事件應立即通知本行停掛卡片、通報165並向警方報案以阻斷損失擴大。\n謹慎理財 信用至上\n💳刷卡金額： NT$ 1,812 元\n👉交易時間：2026/10/22  10:51\n👉卡號末四碼：9111\n👉商店名稱：中華電信股份有限公司\n※外幣消費金額以授權時間約當新臺幣金額計算，商店名稱僅供參考，實際以帳單為準\n嗶仔好康報報';
  const r = P.parseBankMessage(txt, '2026-10-22');
  assert.deepStrictEqual([r.status, r.type, r.amount, r.merchant, r.cat, r.date], ['tx', 'expense', 1812, '中華電信股份有限公司', 'home', '2026-10-22']);
});
t('真實格式：富邦存款入帳卡片 → 待確認（可能是自己帳戶互轉）', () => {
  const txt = '存款入帳\nNT$2,985\n入帳時間\n2026/10/22 13:48\n帳號末四碼\n0436\n交易摘要\nCD轉收\n查看交易明細';
  const r = P.parseBankMessage(txt, '2026-10-22');
  assert.deepStrictEqual([r.status, r.type, r.amount, r.date], ['review', 'income', 2985, '2026-10-22']);
});
t('卡片訊息通知只有摘要、沒金額 → 待確認（不漏掉）', () => {
  const a = P.parseBankMessage('台北富邦銀行：您有一筆存款入帳通知', '2026-10-22');
  assert.deepStrictEqual([a.status, a.type, a.amount], ['review', 'income', null]);
  const b = P.parseBankMessage('華南銀行信用卡刷卡通知', '2026-10-22');
  assert.deepStrictEqual([b.status, b.type], ['review', 'expense']);
});
console.log(`\n全部 ${n} 項通過`);
