const fs = require('fs');
const src = fs.readFileSync('C:/Users/Amber Lin/weicheng claude/股票/stock_analyzer.html', 'utf8');

function extractObj(varName) {
  const startMarker = `const ${varName} = {`;
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('not found ' + varName);
  let i = start + startMarker.length - 1; // at '{'
  let depth = 0;
  let inTemplate = false;
  let inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i-1];
    if (inTemplate) {
      if (ch === '`' && prev !== '\\') inTemplate = false;
      continue;
    }
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const objSrc = src.slice(start + startMarker.length - 1, i);
  return objSrc;
}

const callSrc = extractObj('IR_CALL_SUMMARY');
const prodSrc = extractObj('IR_PRODUCTS_SUMMARY');

const callObj = new Function('return ' + callSrc)();
const prodObj = new Function('return ' + prodSrc)();

console.log('IR_CALL_SUMMARY keys:', Object.keys(callObj).length);
console.log('IR_PRODUCTS_SUMMARY keys:', Object.keys(prodObj).length);

for (const c of ['5525','5531','5533','5534','5538']) {
  console.log(c, 'call:', !!callObj[c], 'products:', !!prodObj[c]);
}
