// 雙掛牌一致性自動檢查（貼到瀏覽器 Console 執行，或用 Browser 工具 javascript_exec）
//
// 用途：同一家公司在美股與台股，除「股價」與連帶的「本益比」外，
//       所有選單的卡片標題、小標題與內容都必須一致。
//       此檢查用來在「交付前」自己發現差異，而不是等使用者回報。
//
// 用法（兩步，中間會重新載入頁面）：
//   1. 在美股模式搜尋該公司美股代碼(如 TSM)，等載入完成 → 執行 AUDIT.capture('us')
//   2. 切台股搜尋對應代碼(如 2330)，等載入完成    → 執行 AUDIT.compare()
//
// 已知「可以不同」的項目（會自動忽略）：股價、本益比倍數、區間位置百分比。

window.AUDIT = {
  GROUPS: {2:'關鍵財務指標',3:'護城河與彼得林區',4:'股價估值評估',5:'法說會未來前景',
           6:'財經新聞',7:'AI技術分析',8:'投資總結',9:'產品與服務',11:'版主選股準則'},

  // 把「合理可不同」的數字抹掉，只比結構與文字
  _norm(s){
    return String(s||'')
      .replace(/(NT\$|\$)\s*[\d,]+(\.\d+)?/g, '<價格>')
      .replace(/\d+(\.\d+)?\s*x/g, '<倍>')
      .replace(/\d+(\.\d+)?\s*%\s*位置/g, '<位置>')
      .replace(/\s+/g, ' ').trim();
  },

  _snap(){
    const out = {};
    for (const n of Object.keys(this.GROUPS)) {
      showGroup(+n);
      const els = [...document.querySelectorAll('#results .card, #results .co-head')]
                    .filter(c => c.style.display !== 'none');
      out[n] = els.map(c => {
        if (c.classList.contains('co-head')) return '[公司股價區]';
        const heads = [...c.querySelectorAll('.ct')].map(x => x.textContent.trim()).join(' >> ');
        const labels = [...c.querySelectorAll('.vl')].map(x => x.textContent.trim()).join(' / ');
        return this._norm(heads + (labels ? ' ||標籤|| ' + labels : ''));
      });
    }
    return out;
  },

  capture(market){
    const snap = this._snap();
    localStorage.setItem('__AUDIT_' + market, JSON.stringify(snap));
    return `已記錄 ${market}：` + Object.keys(snap).map(k => this.GROUPS[k] + '(' + snap[k].length + '卡)').join('、');
  },

  compare(){
    const us = JSON.parse(localStorage.getItem('__AUDIT_us') || '{}');
    const tw = this._snap();
    localStorage.setItem('__AUDIT_tw', JSON.stringify(tw));
    const diff = [];
    for (const n of Object.keys(this.GROUPS)) {
      const a = (us[n] || []).join(' | '), b = (tw[n] || []).join(' | ');
      if (a !== b) diff.push(`❌ ${this.GROUPS[n]}\n   美股：${a}\n   台股：${b}`);
    }
    return diff.length ? diff.join('\n\n') : '✅ 全部選單的卡片、小標題與欄位標籤都一致';
  },

  // 清掉雙掛牌共用的 AI 快取，做乾淨測試用
  clearCache(){
    Object.keys(localStorage).filter(k => /^(gem_|indep_|comp_|__AUDIT_)/.test(k))
      .forEach(k => localStorage.removeItem(k));
    return '已清除 AI 共用快取與稽核暫存';
  }
};
