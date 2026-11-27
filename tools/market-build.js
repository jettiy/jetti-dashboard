// Collect the market data the dashboards show, from FMP through fmp.js: live quotes, the last 40 daily candles of each
// market asset, and the daily closes the return curve needs — for the market assets and for every instrument held
// (see feeds.js for how a held instrument is found). Holds data only: no key, no request urls.
// usage: node market-build.js <out.json> [fromDate=2026-10-01]     (the six held on 2026-11-24 stand in for the list)
// refresh-market.js requires it and writes the compact form the pages load.
const fs = require('fs');
const path = require('path');
const { send, readKey, KEY_FILE } = require('./fmp.js');
const { feedsOf, offsetOf } = require('./feeds.js');

const MARKET = { kospi: '^KS11', nasdaq: '^IXIC', btc: 'BTCUSD', hsi: '^HSI', wti: 'CLUSD', gold: 'GCUSD' };
// the curve's benchmark and the rate the won amounts are shown in
const CURVE = { KOSPI: '^KS11', USDKRW: 'USDKRW' };
// the first day the return curve's closing prices are collected from
const CURVE_FROM = '2026-10-20';
const CANDLE_DAYS = 40;
// market hours, used only to name the day a quote belongs to: Seoul 9, Hong Kong 8, New York and Chicago −5, crypto 0
const OFFSET = { '^KS11': 9, '^HSI': 8, '^IXIC': -5, GCUSD: -5, CLUSD: -5, BTCUSD: 0, USDKRW: 0 };
const R = (n, d) => (typeof n === 'number' ? +n.toFixed(d) : n);

// daily candles since `from`. With `mayMiss` an instrument the provider has no history for comes back as nothing.
async function daily(key, symbol, from, mayMiss) {
  try {
    const res = await send(key, `stable/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}`);
    if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`daily ${symbol}: HTTP ${res.status}`);
    const rows = res.body.filter((r) => r && r.date).map((r) => ({ date: r.date.slice(0, 10), o: R(r.open, 4), h: R(r.high, 4), l: R(r.low, 4), c: R(r.close, 4) }));
    // "from" is honoured on some plans only, so cut here as well
    return rows.filter((r) => r.date >= from).sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch (e) { if (mayMiss) return []; throw e; }
}
const closesOf = (rows) => Object.fromEntries(rows.map((r) => [r.date, r.c]));

// the calendar day a quote was stamped, in the market's own offset from UTC
function stampDay(ts, offsetHours) {
  return new Date(ts * 1000 + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

//   held: the instruments held, as the admin page lists them ({code, cls, mkt}); the six of 2026-11-24 when omitted.
//   The collection comes back with `feeds`: each held instrument with the symbol its prices were found under, for the
//   broker's figures to be applied to (kis-market.js).
async function collect({ held } = {}) {
  const key = readKey(KEY_FILE);
  const feeds = feedsOf(held);
  const base = [...new Set([...Object.values(MARKET), ...Object.values(CURVE)])];
  const want = [...new Set(feeds.flatMap((f) => f.symbols))];
  const quotes = {};
  // four places at most, to shake off floating-point dust: a price keeps every decimal it is quoted in
  const take = (list) => { for (const q of Array.isArray(list) ? list : []) quotes[q.symbol] = { name: q.name, price: R(q.price, 4), change: R(q.change, 4), changePct: R(q.changePercentage, 4), open: R(q.open, 4), prevClose: R(q.previousClose, 4), dayLow: R(q.dayLow, 4), dayHigh: R(q.dayHigh, 4), ts: q.timestamp ? Math.round(+q.timestamp) : null }; };
  // the tiles and the benchmark must all answer. The held instruments are asked about beside them: the provider leaves
  // out what it does not know, and the broker may still have that
  for (const symbols of [base, want]) {
    const res = await send(key, 'stable/batch-quote?symbols=' + symbols.map(encodeURIComponent).join(','));
    if (res.status === 200 && Array.isArray(res.body)) take(res.body);
  }
  const missing = base.filter((s) => !quotes[s]);
  if (missing.length) throw new Error('no quote for: ' + missing.join(', '));
  // the key of each held instrument: the one its record settles, or the first symbol the provider answers for
  for (const f of feeds) f.symbol = f.key || f.symbols.find((s) => quotes[s]) || null;

  const candles = {};
  for (const [id, symbol] of Object.entries(MARKET)) {
    const rows = (await daily(key, symbol, '2026-10-01')).slice(-CANDLE_DAYS);
    const q = quotes[symbol], liveDay = q.ts ? stampDay(q.ts, OFFSET[symbol]) : null, last = rows[rows.length - 1];
    // the running session is merged into today's bar, or starts a new one after the last close on file
    if (liveDay && last) {
      if (last.date === liveDay) { last.c = q.price; last.h = Math.max(last.h, q.dayHigh || last.h); last.l = Math.min(last.l, q.dayLow || last.l); }
      else if (liveDay > last.date) rows.push({ date: liveDay, o: q.open || q.prevClose, h: q.dayHigh || q.price, l: q.dayLow || q.price, c: q.price });
    }
    candles[id] = { symbol, name: q.name, liveDay, rows };
  }

  const closes = {}, live = {};
  for (const [id, symbol] of Object.entries(CURVE)) {
    closes[id] = closesOf((await daily(key, symbol, CURVE_FROM)).filter((r) => r.date >= CURVE_FROM));
    // the running day's price, for the point being drawn right now
    live[id] = { day: quotes[symbol].ts ? stampDay(quotes[symbol].ts, OFFSET[symbol]) : null, price: quotes[symbol].price };
  }
  for (const f of feeds) {
    if (!f.symbol) continue;
    const q = quotes[f.symbol];
    closes[f.symbol] = closesOf((await daily(key, f.symbol, CURVE_FROM, true)).filter((r) => r.date >= CURVE_FROM));
    live[f.symbol] = { day: q.ts ? stampDay(q.ts, offsetOf(f.kind)) : null, price: q.price };
  }
  return { source: 'Financial Modeling Prep', fetchedAt: new Date().toISOString(), quotes, candles, closes, live, feeds };
}

// the shape the pages load: thirty candles per asset, closing prices, the running day's prices, the quotes the pages key by short name
function compact(m, bars = 30) {
  const ID = { '^KS11': 'KOSPI' };
  const market = {};
  for (const [id, c] of Object.entries(m.candles)) {
    const q = m.quotes[c.symbol], hasPrev = q.prevClose > 0;
    // change is worked out from the previous close: the provider's own percentage does not always agree with its figures
    market[id] = { symbol: c.symbol, name: q.name, price: R(q.price, 3), chg: R(hasPrev ? q.price - q.prevClose : q.change, 3), pct: R(hasPrev ? (q.price / q.prevClose - 1) * 100 : q.changePct, 3), prev: R(q.prevClose, 3), ts: q.ts, bars: c.rows.slice(-bars).map((b) => [b.date, R(b.o, 3), R(b.h, 3), R(b.l, 3), R(b.c, 3)]) };
  }
  const closes = {};
  for (const [id, series] of Object.entries(m.closes)) closes[id] = Object.fromEntries(Object.entries(series).map(([d, c]) => [d, R(c, 4)]));
  const live = Object.fromEntries(Object.entries(m.live).map(([id, l]) => [id, { d: l.day, p: R(l.price, 4) }]));
  const quote = Object.fromEntries(Object.entries(m.quotes).map(([s, q]) => [ID[s] || s, { p: R(q.price, 4), prev: R(q.prevClose, 4) }]));
  return { fetchedAt: m.fetchedAt, fx: R(m.quotes.USDKRW.price, 2), market, closes, live, quote };
}

// The hosted site keeps two files out of this. Anyone with the address may see the first: the market tiles and 코스피's
// closes. The second holds what would tell which instruments the operator holds — their quotes, closes and running prices —
// and goes out only sealed with the member's code (see refresh-market.js).
function publicOf(c) {
  return { fetchedAt: c.fetchedAt, fx: c.fx, market: c.market, closes: { KOSPI: c.closes.KOSPI }, live: { KOSPI: c.live.KOSPI }, by: c.by };
}
const NOT_HELD = ['KOSPI', 'USDKRW', 'NASDAQ'];
function heldOf(c, now = Date.now()) {
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !NOT_HELD.includes(k)));
  return { ts: now, quote: pick(c.quote), closes: pick(c.closes), live: pick(c.live) };
}

module.exports = { collect, compact, publicOf, heldOf, MARKET, CURVE, CURVE_FROM };

if (require.main === module) (async () => {
  const [out, fromArg] = process.argv.slice(2);
  const data = await collect({ held: undefined });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(JSON.stringify({ out, bytes: fs.statSync(out).size, fetchedAt: data.fetchedAt }));
})().catch((e) => { console.error(e.message); process.exit(1); });
