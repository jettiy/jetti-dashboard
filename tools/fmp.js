// Fetch market data from Financial Modeling Prep (FMP) for the dashboard mockups.
// The key is read from a local file at run time and is never printed, logged or written anywhere.
// Only https requests to the FMP host, which must resolve to a public address, are sent.
// usage: node fmp.js probe
//        node fmp.js get "<path?query>" <out.json> [maxItemsToShow]
//        node fmp.js find <list-path> <search words...>   (names in a list endpoint that match all words)
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const HOST = 'financialmodelingprep.com';
const ORIGIN = `https://${HOST}`;
const KEY_FILE = process.env.FMP_KEY_FILE || 'C:\\Users\\USER\\Desktop\\KEY.txt';
const V4MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

function isPublicIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return false;
    if (/^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return false;
    const mapped = low.match(V4MAPPED);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  if (!net.isIPv4(ip)) return false;
  const o = ip.split('.').map(Number);
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return false;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
  if (o[0] === 192 && o[1] === 168) return false;
  if (o[0] >= 224) return false;
  return true;
}

// The key comes from the environment where a workflow holds it as a secret, and on this PC from the local key file.
function readKey(file) {
  if (process.env.FMP_API_KEY) {
    const fromEnv = process.env.FMP_API_KEY.trim();
    if (!/^[A-Za-z0-9]{16,80}$/.test(fromEnv)) throw new Error('the FMP key in the environment has an unexpected shape');
    return fromEnv;
  }
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).find((s) => /^FMP KEY\b/i.test(s));
  if (!line) throw new Error('the file has no line that starts with "FMP KEY"');
  const key = line.split(/\s+/).pop();
  if (!/^[A-Za-z0-9]{16,80}$/.test(key)) throw new Error('the FMP key on that line has an unexpected shape');
  return key;
}

// a relative path on the FMP host only: no scheme, no other host, no fragments.
// A leading slash is optional: a Git Bash shell rewrites arguments that start with one into Windows paths.
function buildUrl(key, rel) {
  const relPath = rel.startsWith('/') ? rel : '/' + rel;
  if (/^[a-z]+:/i.test(relPath) || relPath.startsWith('//')) throw new Error('only a path on the FMP host is allowed');
  const u = new URL(relPath, ORIGIN);
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST) throw new Error('refused: not the FMP host over https');
  u.searchParams.set('apikey', key);
  return u;
}

async function send(key, rel) {
  const u = buildUrl(key, rel);
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) throw new Error('refused: the host resolves to a private or reserved address');
  const r = await fetch(u.href, { headers: { Accept: 'application/json', 'User-Agent': 'dashboard-mockup-data/1.0' }, redirect: 'error' });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  return { status: r.status, type: r.headers.get('content-type') || '', bytes: text.length, body, raw: body ? null : text.slice(0, 160) };
}

// one line per response: shape and the identifying fields of the first items, never the request
function describe(res, show = 2) {
  if (!res.body) return `HTTP ${res.status} ${res.type.split(';')[0]} ${res.bytes}B not json: ${res.raw}`;
  const b = res.body;
  if (Array.isArray(b)) {
    const head = b.slice(0, show).map((x) => (x && typeof x === 'object' ? pick(x) : JSON.stringify(x)));
    return `HTTP ${res.status} array ${b.length} | keys: ${b[0] && typeof b[0] === 'object' ? Object.keys(b[0]).slice(0, 16).join(',') : '-'} | ${head.join(' ; ')}`;
  }
  return `HTTP ${res.status} object keys: ${Object.keys(b).slice(0, 14).join(',')} | ${JSON.stringify(b).slice(0, 220)}`;
}
const pick = (x) => ['symbol', 'name', 'price', 'changesPercentage', 'change', 'dateTime', 'timestamp', 'exchange', 'currency', 'error', 'Error Message', 'message'].filter((k) => k in x).map((k) => `${k}=${JSON.stringify(x[k])}`).join(' ');

const PROBES2 = [
  ['stable batch-quote six', '/stable/batch-quote?symbols=%5EIXIC,%5EKS11,%5EHSTECH,BTCUSD,CLUSD,GCUSD'],
  ['stable quote ^IXIC', '/stable/quote?symbol=%5EIXIC'],
  ['stable full-quote ^IXIC', '/stable/full-quote?symbol=%5EIXIC'],
  ['stable quote GCUSD,CLUSD', '/stable/quote?symbol=GCUSD,CLUSD'],
  ['stable commodities-quote', '/stable/commodities-quote?symbol=GCUSD'],
  ['stable commodities-list', '/stable/commodities-list'],
  ['stable commodity-list', '/stable/commodity-list'],
  ['stable cryptocurrency-list', '/stable/cryptocurrency-list'],
  ['stable cryptocurrency-quote', '/stable/cryptocurrency-quote?symbol=BTCUSD'],
  ['stable intraday-chart 5min BTCUSD', '/stable/intraday-chart?symbol=BTCUSD&interval=5min'],
  ['stable historical-chart path 5min', '/stable/historical-chart/5min/BTCUSD'],
  ['stable light-chart candles 5min', '/stable/light-chart/japanese-candlestick?symbol=BTCUSD&interval=5min'],
  ['stable light-chart 1hour ^IXIC', '/stable/light-chart/japanese-candlestick?symbol=%5EIXIC&interval=1hour'],
  ['stable light-chart 15min CLUSD', '/stable/light-chart/japanese-candlestick?symbol=CLUSD&interval=15min'],
  ['stable index-chart daily ^KS11', '/stable/index-chart?symbol=%5EKS11&interval=1day&from=2026-11-01&to=2026-11-24'],
  ['stable historical-price-update BTC', '/stable/historical-price-update?symbol=BTCUSD&interval=5min'],
  ['stable forex-quote USDKRW', '/stable/forex-quote?symbol=USDKRW'],
  ['stable fx-quote USDKRW', '/stable/fx-quote?symbol=USDKRW'],
  ['stable stock-quote BABA', '/stable/stock-quote?symbol=BABA'],
  ['stable stock-quote batch', '/stable/batch-quote?symbols=BABA,TQQQ,NTES,APP,ANT'],
];
const PROBES1 = [
  ['v3 quote US names', '/api/v3/quote/BABA,TQQQ,NTES,APP'],
  ['v3 quote crypto+commodities', '/api/v3/quote/BTCUSD,GCUSD,CLUSD,BZUSD,NGUSD'],
  ['v3 quote ^NDX ^GSPC', '/api/v3/quote/%5ENDX,%5EGSPC'],
  ['v3 quote world ^KS11 ^HSI ^HSTECH', '/api/v3/quote/%5EKS11,%5EHSI,%5EHSTECH'],
  ['v3 quote list "Index"', '/api/v3/quote/Index'],
  ['v3 quotes index', '/api/v3/quotes/index'],
  ['stable batch-quote', '/stable/batch-quote?symbols=%5ENDX,BTCUSD,GCUSD,CLUSD,BABA'],
  ['stable index-quote ^NDX', '/stable/index-quote?symbol=%5ENDX'],
  ['stable commodity-quote GCUSD', '/stable/commodity-quote?symbol=GCUSD'],
  ['stable crypto-quote BTCUSD', '/stable/crypto-quote?symbol=BTCUSD'],
  ['stable index-list', '/stable/index-list'],
  ['stable commodity-list', '/stable/commodity-list'],
  ['stable crypto-list', '/stable/crypto-list'],
  ['v3 chart 5min BTCUSD', '/api/v3/historical-chart/5min/BTCUSD'],
  ['v3 chart 5min GCUSD', '/api/v3/historical-chart/5min/GCUSD'],
  ['v3 chart 5min CLUSD', '/api/v3/historical-chart/5min/CLUSD'],
  ['v3 chart 5min ^NDX', '/api/v3/historical-chart/5min/%5ENDX'],
  ['v3 chart 5min ^KS11', '/api/v3/historical-chart/5min/%5EKS11'],
  ['v3 chart 1hour ^NDX', '/api/v3/historical-chart/1hour/%5ENDX'],
  ['stable chart 5min BTCUSD', '/stable/historical-chart?interval=5min&symbol=BTCUSD'],
  ['stable chart 1hour ^NDX', '/stable/historical-chart?interval=1hour&symbol=%5ENDX'],
  ['v3 daily ^KS11 (curve benchmark)', '/api/v3/historical-price-full/%5EKS11?serietype=line'],
  ['v3 daily ^NDX', '/api/v3/historical-price-full/%5ENDX?serietype=line'],
];
const PROBES3 = [
  ['chart 5-min AAPL', 'stable/historical-chart/5-min?symbol=AAPL'],
  ['chart 5-min BTCUSD', 'stable/historical-chart/5-min?symbol=BTCUSD'],
  ['chart 5-min ^IXIC', 'stable/historical-chart/5-min?symbol=%5EIXIC'],
  ['chart 5-min ^KS11', 'stable/historical-chart/5-min?symbol=%5EKS11'],
  ['chart 5-min GCUSD', 'stable/historical-chart/5-min?symbol=GCUSD'],
  ['chart 5-min CLUSD', 'stable/historical-chart/5-min?symbol=CLUSD'],
  ['chart 1-hour ^KS11', 'stable/historical-chart/1-hour?symbol=%5EKS11'],
  ['chart path form 5-min/AAPL', 'stable/historical-chart/5-min/AAPL'],
  ['chart 1-day ^KS11 range', 'stable/historical-chart/1-day?symbol=%5EKS11&from=2026-11-01&to=2026-11-24'],
  ['chart 1-day ^IXIC range', 'stable/historical-chart/1-day?symbol=%5EIXIC&from=2026-11-01&to=2026-11-24'],
  ['chart 1-day BABA range', 'stable/historical-chart/1-day?symbol=BABA&from=2026-11-01&to=2026-11-24'],
  ['chart 1-day USDKRW', 'stable/historical-chart/1-day?symbol=USDKRW&from=2026-11-17&to=2026-11-24'],
  ['batch USDKRW, HSTECH', 'stable/batch-quote?symbols=USDKRW,%5EHSTECH'],
  ['eod full ^IXIC', 'stable/historical-price-eod/full?symbol=%5EIXIC'],
  ['eod full BABA', 'stable/historical-price-eod/full?symbol=BABA'],
  ['eod full GCUSD', 'stable/historical-price-eod/full?symbol=GCUSD'],
  ['eod full BTCUSD', 'stable/historical-price-eod/full?symbol=BTCUSD'],
  ['eod full USDKRW', 'stable/historical-price-eod/full?symbol=USDKRW'],
  ['eod full 233740.KS', 'stable/historical-price-eod/full?symbol=233740.KS'],
];
const PROBES = { 1: PROBES1, 2: PROBES2, 3: PROBES3 }[process.env.FMP_PROBE_SET || '1'];

module.exports = { send, readKey, KEY_FILE };

if (require.main === module) (async () => {
  const key = readKey(KEY_FILE);
  if (cmd === 'probe') {
    for (const [name, rel] of PROBES) {
      try { console.log(`${name.padEnd(38)} ${describe(await send(key, rel))}`); } catch (e) { console.log(`${name.padEnd(38)} FAILED ${e.message}`); }
      await new Promise((r) => setTimeout(r, 350));
    }
    return;
  }
  if (cmd === 'get') {
    const res = await send(key, a);
    if (!res.body || res.status !== 200) { console.log(describe(res)); process.exit(2); }
    fs.mkdirSync(path.dirname(path.resolve(b)), { recursive: true });
    // the saved file holds data only: no request url, no key
    fs.writeFileSync(b, JSON.stringify({ source: 'Financial Modeling Prep', path: a.split('?')[0], fetchedAt: new Date().toISOString(), data: res.body }, null, 1));
    console.log(`saved ${b} ${describe(res, +(c || 2))}`);
    return;
  }
  if (cmd === 'find') {
    const res = await send(key, a);
    const words = [b, c].filter(Boolean).map((w) => w.toLowerCase());
    const hits = (Array.isArray(res.body) ? res.body : []).filter((x) => x && words.every((w) => JSON.stringify(x).toLowerCase().includes(w))).slice(0, 25);
    console.log(`${res.status} of ${Array.isArray(res.body) ? res.body.length : 'non-array'}: ` + hits.map((x) => JSON.stringify(pick(x))).join(' ; '));
    return;
  }
  console.log('usage: node fmp.js probe | get "<path?query>" <out.json> | find <list-path> <words...>');
})().catch((e) => { console.error(e.message); process.exit(1); });