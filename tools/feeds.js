// How each instrument the operator holds is found at the two sources. The admin page writes the list of what is held
// (code, class and market as it keeps them); from one line of it this says under which key the pages look its prices
// up — which is the symbol FMP knows it by — and where the broker lists it. The six held on 2026-11-24 stand in as the
// list until the admin page has written one.
const BUILTIN = [
  { code: 'BABA', cls: 'ov', mkt: '미국' }, { code: '233740', cls: 'etf', mkt: '코스피' },
  { code: 'TQQQ', cls: 'ov', mkt: '미국' }, { code: 'ANT', cls: 'ov', mkt: '미국' },
  { code: 'NTES', cls: 'ov', mkt: '미국' }, { code: 'APP', cls: 'ov', mkt: '미국' }
];
// The broker's exchange codes, tried in order until one answers. It takes Tokyo (TSE) with this key; for Hong Kong,
// Shanghai and Shenzhen it accepts a code but returns no figure (checked 2026-11-25), so those come from FMP alone.
const BROKER = { US: ['NAS', 'NYS', 'AMS'], JP: ['TSE'] };
// hours from UTC, to name the day a quote belongs to: Seoul and Tokyo 9, Hong Kong and China 8, New York 5 west
const HOURS = { KR: 9, US: -5, JP: 9, HK: 8, CN: 8 };
const KOREA = ['코스피', '코스닥', 'KRX', '국내'];
const pad = (n, l) => String(n).padStart(l, '0');
const SHANGHAI = (code) => /^[69]/.test(code);

// one held line → how to find it, or null when neither source is known to have it:
//   kind    the market it trades in
//   key     what the pages look its prices up by (null until the exchange is settled by an answer)
//   symbols the FMP symbols to ask for, the likeliest first
//   markets the broker's Korean market codes to ask for ('J' KRX, 'Q' KOSDAQ), or exchanges for an overseas one
function feedOf(item) {
  const code = String((item && item.code) || '').trim().toUpperCase(), cls = (item && item.cls) || '', mkt = String((item && item.mkt) || '').trim();
  if (!/^[A-Z0-9]{1,10}$/.test(code)) return null;
  const ticker = /^[A-Z][A-Z0-9]{0,9}$/.test(code), digits6 = /^\d{6}$/.test(code);
  if (KOREA.includes(mkt) || (!mkt && digits6 && (cls === 'kr' || cls === 'etf'))) {
    // the exchange the record names is asked first; the other one, in case the record names it wrongly, after it
    const first = mkt === '코스닥' ? 'KQ' : mkt === '코스피' ? 'KS' : null, order = first === 'KQ' ? ['KQ', 'KS'] : ['KS', 'KQ'];
    return { kind: 'KR', code, key: first ? `${code}.${first}` : null, symbols: order.map((x) => `${code}.${x}`), markets: order.map((x) => (x === 'KQ' ? 'Q' : 'J')) };
  }
  if (mkt === '미국' || (!mkt && ticker)) return { kind: 'US', code, key: code, symbols: [code], exchanges: BROKER.US };
  if (mkt === '일본') { const c = pad(code, 4); return { kind: 'JP', code: c, key: `${c}.T`, symbols: [`${c}.T`], exchanges: BROKER.JP }; }
  if (mkt === '홍콩') { const c = pad(code, 4); return { kind: 'HK', code: c, key: `${c}.HK`, symbols: [`${c}.HK`] }; }
  if (mkt === '중국') { const s = `${code}.${SHANGHAI(code) ? 'SH' : 'SZ'}`; return { kind: 'CN', code, key: s, symbols: [s] }; }
  return null;
}
// every held line that can be found, each once by key
function feedsOf(list) {
  const out = [], seen = new Set();
  for (const item of Array.isArray(list) && list.length ? list : BUILTIN) {
    const f = feedOf(item); if (!f || seen.has(f.key || f.code)) continue;
    seen.add(f.key || f.code); out.push(f);
  }
  return out;
}
const offsetOf = (kind) => HOURS[kind] || 0;

module.exports = { BUILTIN, feedOf, feedsOf, offsetOf };
