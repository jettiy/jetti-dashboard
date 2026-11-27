// 한국투자증권 Open API: market data only. The figures the dashboards show for Korea and for the held instruments,
// exact to the unit the exchange quotes in: 코스피 and 나스닥 levels with daily candles, the price and closes of each held
// instrument the broker lists (Korean stocks and ETFs, and those in New York and Tokyo), and the won per dollar the
// broker applies. Nothing here reads an account.
// The app key and secret are read from the local key file at run time and never printed; the access token stays in
// memory for the length of one run. Only https requests to the broker's Open API host, which must resolve to public
// addresses, are sent.
// usage: node kis-market.js check     what this key gives right now for the six held on 2026-11-24, and what failed
const { readSecrets, call, token } = require('./kis.js');
const { offsetOf } = require('./feeds.js');

const KEY_FILE = process.env.KIS_KEY_FILE || 'C:\\Users\\USER\\Desktop\\KEY.txt';
// REST route and transaction id of each call, as the broker's own Postman collection has them
const CALLS = {
  krPrice: { rel: '/uapi/domestic-stock/v1/quotations/inquire-price', tr: 'FHKST01010100' },
  krDaily: { rel: '/uapi/domestic-stock/v1/quotations/inquire-daily-price', tr: 'FHKST01010400' },
  krIndexDaily: { rel: '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice', tr: 'FHKUP03500100' },
  osPrice: { rel: '/uapi/overseas-price/v1/quotations/price', tr: 'HHDFS00000300' },
  osPriceDetail: { rel: '/uapi/overseas-price/v1/quotations/price-detail', tr: 'HHDFS76200200' },
  osDaily: { rel: '/uapi/overseas-price/v1/quotations/dailyprice', tr: 'HHDFS76240000' },
  osChartDaily: { rel: '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', tr: 'FHKST03030100' },
};
// the two indices, by the short name the pages key them with
const INDICES = { KOSPI: ['krIndexDaily', { fid_cond_mrkt_div_code: 'U', fid_input_iscd: '0001' }], NASDAQ: ['osChartDaily', { FID_COND_MRKT_DIV_CODE: 'N', FID_INPUT_ISCD: 'COMP' }] };
const SYMBOL = { KOSPI: '^KS11', NASDAQ: '^IXIC' };
const BARS = 30, PAGES = 6;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// one run's session: the key file's secrets and the headers every market-data call carries
async function open() {
  const secrets = readSecrets(KEY_FILE), bearer = await token(secrets);
  if (!bearer) throw new Error('the access token was not issued');
  return { secrets, headers: { authorization: `Bearer ${bearer}`, appkey: secrets.key, appsecret: secrets.secret, custtype: 'P' } };
}

// Calls go out one to a beat: the broker counts them per second and answers a burst with "초당 거래건수를 초과하였습니다".
const BEAT = 450;

// one market-data call; the answer comes back with its HTTP status and, when it is JSON, the broker's envelope.
// A call the broker refused for coming too fast is asked again, later, up to three times.
async function get(ctx, name, params, tryNo = 0) {
  const { rel, tr } = CALLS[name];
  const res = await call(ctx.secrets, rel + '?' + new URLSearchParams(params).toString(), { headers: { ...ctx.headers, tr_id: tr } });
  const d = res.data;
  const message = d && (d.msg1 || d.message);
  if (d && !(d.rt_cd === '0' || d.rt_code === '0') && /초과/.test(message || '') && tryNo < 3) { await pause(1200 * (tryNo + 1)); return get(ctx, name, params, tryNo + 1); }
  return { status: res.status, ok: !!(d && (d.rt_cd === '0' || d.rt_code === '0')), message, data: d, raw: d ? null : res.raw };
}

// The broker now and then answers an overseas call with "정상처리" and nothing in it. Ask again, a little later, up to
// three times, and keep the first answer that holds what was asked for.
async function filled(ctx, name, params, has) {
  let r = null;
  for (let tryNo = 0; tryNo < 3; tryNo++) {
    if (tryNo) await pause(BEAT);
    r = await get(ctx, name, params);
    if (!r.ok || has(r)) break;
  }
  return r;
}

// the broker sends figures as strings and leaves the ones it has no answer for empty
const NUM = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : NaN; return Number.isFinite(n) ? n : null; };
const DAY = (ymd) => (typeof ymd === 'string' && /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null);
const pad = (n) => String(n).padStart(2, '0');
const older = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const ymd = (iso) => iso.replace(/-/g, '');
// the day before, in the broker's eight digits
function dayBefore(iso) { const t = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(4, 2) - 1, +iso.slice(6, 8) - 1)); return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`; }

// When a session opens and closes, in seconds: Seoul trades 9 to 15:30 and Tokyo 9 to 15, nine hours ahead of UTC;
// Hong Kong and China 9:30 to 16:00, eight ahead; New York 9:30 to 16:00, five hours behind UTC, four while the United
// States keeps daylight time (second Sunday of March to the first of November)
function session(market, date) {
  const [y, m, d] = date.split('-').map(Number);
  const nth = (month, weekday, n) => { let c = 0; for (let day = 1; day <= 31; day++) { if (new Date(Date.UTC(y, month, day)).getUTCDay() === weekday && ++c === n) return day; } return 0; };
  const east = offsetOf(market), west = market === 'US';
  const daylight = west && date >= `${y}-03-${pad(nth(2, 0, 2))}` && date < `${y}-11-${pad(nth(10, 0, 1))}`;
  // the session's opening and closing moments in seconds: New York's clock runs behind UTC, the Asian ones ahead of it
  const at = (h, min) => Math.round((Date.UTC(y, m - 1, d, h, min) + (west ? (daylight ? 4 : 5) : -east) * 3600e3) / 1000);
  const late = market === 'US' || market === 'HK' ? [9, 30, 16, 0] : market === 'KR' ? [9, 0, 15, 30] : [9, 0, 15, 0];
  return { open: at(late[0], late[1]), close: at(late[2], late[3]) };
}
// When a figure was fixed: the session's close, or now while that session runs (`now` in milliseconds)
function stamp(market, date, now) {
  const { open, close } = session(market, date), t = now / 1000;
  return t >= open && t < close ? Math.round(t) : close;
}
// Until a session has opened, its figures are not the session's: the broker already files its row with the previous
// close as the previous close (so the latest move would read as zero), and before New York's open it reports the thin
// pre-market trades as the last price. Until then the last completed session's move stands in.
function lastTraded(market, bars, price, prev, now) {
  const last = bars[bars.length - 1], before = bars[bars.length - 2], earlier = bars[bars.length - 3];
  if (last && before && earlier && now / 1000 < session(market, last.date).open) return { bar: before, price: before.c, prev: earlier.c };
  return { bar: last, price, prev };
}

// Korea's composite index: the latest level against the previous close, and daily candles
async function koreaIndex(ctx, code, from) {
  const r = await get(ctx, 'krIndexDaily', { fid_cond_mrkt_div_code: 'U', fid_input_iscd: code, fid_input_date_1: ymd(from), fid_input_date_2: ymd(ctx.today), fid_period_div_code: 'D' });
  const head = (r.data && r.data.output1) || {}, list = (r.data && r.data.output2) || [];
  const bars = list.map((x) => ({ date: DAY(x.stck_bsop_date), o: NUM(x.bstp_nmix_oprc), h: NUM(x.bstp_nmix_hgpr), l: NUM(x.bstp_nmix_lwpr), c: NUM(x.bstp_nmix_prpr) })).filter((b) => b.date && b.c != null).sort(older);
  const price = NUM(head.bstp_nmix_prpr), prev = NUM(head.prdy_nmix);
  if (!r.ok || price == null || prev == null || !bars.length) return { failed: r.message || 'empty answer' };
  return { item: { market: 'KR', symbol: SYMBOL.KOSPI, date: bars[bars.length - 1].date, price, prev, open: NUM(head.bstp_nmix_oprc), high: NUM(head.bstp_nmix_hgpr), low: NUM(head.bstp_nmix_lwpr), bars, closes: Object.fromEntries(bars.map((b) => [b.date, b.c])) } };
}

// an overseas index by the broker's code: the latest level against the previous close, and daily candles
async function overseasIndex(ctx, code, from) {
  const r = await get(ctx, 'osChartDaily', { FID_COND_MRKT_DIV_CODE: 'N', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd(from), FID_INPUT_DATE_2: ymd(ctx.today), FID_PERIOD_DIV_CODE: 'D' });
  const head = (r.data && r.data.output1) || {}, list = (r.data && r.data.output2) || [];
  const bars = list.map((x) => ({ date: DAY(x.stck_bsop_date), o: NUM(x.ovrs_nmix_oprc), h: NUM(x.ovrs_nmix_hgpr), l: NUM(x.ovrs_nmix_lwpr), c: NUM(x.ovrs_nmix_prpr) })).filter((b) => b.date && b.c != null).sort(older);
  const price = NUM(head.ovrs_nmix_prpr), prev = NUM(head.ovrs_nmix_prdy_clpr);
  if (!r.ok || price == null || !(prev > 0) || !(price > 0) || !bars.length) return { failed: r.message || 'no figure for this code' };
  return { item: { market: 'US', symbol: SYMBOL.NASDAQ, date: bars[bars.length - 1].date, price, prev, open: NUM(head.ovrs_prod_oprc), high: NUM(head.ovrs_prod_hgpr), low: NUM(head.ovrs_prod_lwpr), bars, closes: Object.fromEntries(bars.map((b) => [b.date, b.c])) } };
}

// A Korean stock or ETF: the latest price against the previous close, and daily closes from `from` on, thirty rows to a
// page. Which exchange lists it is settled by the first of the feed's markets that answers, and names the key.
async function koreaPrice(ctx, f, from) {
  let o = null, market = null;
  for (const mk of f.markets) {
    await pause(BEAT);
    const q = await get(ctx, 'krPrice', { fid_cond_mrkt_div_code: mk, fid_input_iscd: f.code });
    const out = (q.data && (q.data.output || q.data.output1)) || {};
    if (q.ok && NUM(out.stck_prpr) != null) { o = out; market = mk; break; }
  }
  const price = NUM(o && o.stck_prpr), step = o && NUM(o.prdy_vrss) != null ? NUM(o.prdy_vrss) * ({ 1: 1, 2: 1, 4: -1, 5: -1 }[o.prdy_vrss_sign] || 0) : null;
  const prev = NUM(o && o.prdy_clpr) ?? NUM(o && o.stck_sdpr) ?? (price != null && step != null ? price - step : null);
  const symbol = `${f.code}.${market === 'Q' ? 'KQ' : 'KS'}`;
  const bars = [];
  let until = ymd(ctx.today);
  for (let page = 0; page < PAGES && market; page++) {
    await pause(BEAT);
    const r = await get(ctx, 'krDaily', { fid_cond_mrkt_div_code: market, fid_input_iscd: f.code, fid_period_div_code: 'D', fid_org_adj_prc: '0', fid_input_date_1: ymd(from), fid_input_date_2: until });
    const list = Array.isArray(r.data && r.data.output1) ? r.data.output1 : Array.isArray(r.data && r.data.output) ? r.data.output : [];
    const got = list.map((x) => ({ date: DAY(x.stck_bsop_date), o: NUM(x.stck_oprc), h: NUM(x.stck_hgpr), l: NUM(x.stck_lwpr), c: NUM(x.stck_clpr) })).filter((b) => b.date && b.c != null);
    bars.unshift(...got);
    // done once the pages reach back to `from`, or the broker has nothing older
    if (!got.length || got[got.length - 1].date <= from || list.length < 30) break;
    until = dayBefore(got[got.length - 1].date);
  }
  bars.sort(older);
  if (price == null || prev == null || !bars.length) return { failed: 'no quote on either Korean exchange' };
  const t = lastTraded('KR', bars, price, prev, ctx.now);
  return { item: { market: 'KR', symbol, date: t.bar.date, price: t.price, prev: t.prev, open: NUM(o.stck_oprc), high: NUM(o.stck_hgpr), low: NUM(o.stck_lwpr), bars, closes: Object.fromEntries(bars.map((b) => [b.date, b.c])) } };
}

// An overseas stock: the latest price against the previous close, and a hundred daily candles. The exchanges the feed
// names are tried in turn; an exchange that does not list it answers with every field empty.
// After New York's bell the broker's last price may be an after-hours print, and its day's candle may follow it: on the
// half-day of 2026-11-27, three hours and a half after the close, 넷이즈 read 104.61 against the 106.85 close and its
// candle had that print for the low. So for a New York name the provider's end-of-day close stands over the broker's
// candle for every day the provider has one (they agree to the cent on an ordinary day), and once the session has closed
// its price is that close — or the provider's quote while that is stamped with the session's day, which keeps to the
// regular session. The broker's last stands in only when the provider has nothing of that day.
async function overseasStock(ctx, f) {
  const quoteOf = (r) => (r.data && r.data.output) || {};
  const has = (r) => { const p = NUM(quoteOf(r).last), b = NUM(quoteOf(r).base); return p != null && b != null && b > 0; };
  let q = null, excd = null;
  for (const ex of f.exchanges) {
    await pause(BEAT);
    q = await filled(ctx, 'osPrice', { AUTH: '', EXCD: ex, SYMB: f.code }, has);
    if (q.ok && has(q)) { excd = ex; break; }
  }
  const o = quoteOf(q);
  await pause(BEAT);
  const dailyOf = (r) => ((r.data && r.data.output2) || []).map((x) => ({ date: DAY(x.xymd), o: NUM(x.open), h: NUM(x.high), l: NUM(x.low), c: NUM(x.clos) })).filter((b) => b.date && b.c != null).sort(older);
  const r = await filled(ctx, 'osDaily', { AUTH: '', EXCD: excd || f.exchanges[0], SYMB: f.code, GUBN: '0', BYMD: '', MODP: '0' }, (x) => dailyOf(x).length > 0);
  const bars = dailyOf(r);
  // the running or last session is the last candle; the quote gives its latest price, and the broker's previous close
  const last = bars[bars.length - 1], before = bars[bars.length - 2];
  const us = f.kind === 'US', eod = us && ctx.closes && ctx.closes[f.symbol] ? ctx.closes[f.symbol] : {};
  for (const b of bars) if (eod[b.date] > 0) b.c = eod[b.date];
  const broker = NUM(o.last), fq = ctx.quotes && ctx.quotes[f.symbol];
  // a quote counts for the last candle's session only when its own time falls on that day in New York
  const stamped = us && fq && fq.price > 0 && fq.ts && stampDay(fq.ts, offsetOf('US')) === (last && last.date) ? fq.price : null;
  const closed = us && last && ctx.now / 1000 >= session('US', last.date).close;
  const price = closed ? (eod[last.date] > 0 ? eod[last.date] : stamped ?? broker ?? last.c) : broker ?? (last ? last.c : null);
  const prev = NUM(o.base) ?? (before ? before.c : null);
  if (price == null || prev == null || !(prev > 0) || !bars.length) return { failed: `no quote on ${f.exchanges.join('/')}`, why: { price, prev, bars: bars.length, dailyOk: r.ok, dailyRows: (r.data && Array.isArray(r.data.output2) ? r.data.output2.length : -1) } };
  if (last) last.c = price;
  const t = lastTraded(f.kind === 'US' ? 'US' : f.kind, bars, price, prev, ctx.now);
  // `regular`: the price is the provider's regular-session close, so the provider's opening price and range go with it
  return { item: { market: f.kind === 'US' ? 'US' : f.kind, symbol: f.key, date: t.bar.date, price: t.price, prev: t.prev, open: t.bar.o, high: t.bar.h, low: t.bar.l, bars, closes: Object.fromEntries(bars.map((b) => [b.date, b.c])), regular: closed && price !== broker } };
}
// the calendar day a moment falls on, in an offset from UTC
const stampDay = (ts, offsetHours) => new Date(ts * 1000 + offsetHours * 3600e3).toISOString().slice(0, 10);

// Everything in one run.
//   feeds:  the held instruments as market-build.js found them (each with the symbol its prices are keyed by); those
//           the broker is not known to list — in Hong Kong or on the Chinese mainland — are passed over here.
//   from:   the first day closes are wanted from (the return curve's start)
//   quotes, closes: what the provider already gave (market-build.js's `m.quotes` and `m.closes`), which a New York
//           name's regular-session close is taken from once its session has closed
// Items that fail are named in `failed`; the rest come back whatever the others did.
async function collectKIS({ feeds = [], from = '2026-10-20', now = new Date(), quotes = {}, closes = {} } = {}) {
  const ctx = await open();
  // ranges end a day ahead of the Korean date, so a run in the small hours never cuts the day off
  ctx.today = new Date(now.getTime() + 15 * 3600e3).toISOString().slice(0, 10);
  ctx.now = now.getTime();
  ctx.quotes = quotes; ctx.closes = closes;
  const out = { fetchedAt: now.toISOString(), fx: null, items: {}, failed: {}, why: {} };
  // `byItem`: a held instrument is filed under the symbol the broker settled its exchange to, not under the key guessed before
  const put = async (key, fn, byItem) => { try { const r = await fn(); if (r.item) out.items[byItem ? r.item.symbol : key] = r.item; else { out.failed[key] = r.failed || 'empty answer'; if (r.why) out.why[key] = r.why; } } catch (e) { out.failed[key] = e.message; } await pause(BEAT); };
  const barsFrom = new Date(now.getTime() - 80 * 86400e3).toISOString().slice(0, 10);
  for (const [key, [name, params]] of Object.entries(INDICES)) await put(key, async () => name === 'krIndexDaily' ? koreaIndex(ctx, params.fid_input_iscd, barsFrom) : overseasIndex(ctx, params.FID_INPUT_ISCD, barsFrom));
  for (const f of feeds) {
    // what the broker is not known to list — in Hong Kong or on the Chinese mainland — is left to FMP
    if (f.kind === 'KR') await put(f.key || f.code, () => koreaPrice(ctx, f, from), true);
    else if (f.exchanges && f.key) await put(f.key, () => overseasStock(ctx, f));
  }
  // the won per dollar the broker applies to overseas holdings today
  try { await pause(BEAT); const r = await get(ctx, 'osPriceDetail', { AUTH: '', EXCD: 'NAS', SYMB: 'TQQQ' }); const rate = NUM(r.data && r.data.output && r.data.output.t_rate); if (rate > 0) out.fx = rate; else out.failed.FX = r.message || 'no rate'; } catch (e) { out.failed.FX = e.message; }
  return out;
}

// Fill the FMP collection with what the broker gave: quotes, the closes the curve needs, the running day's prices, the
// candles of the two tiles the broker covers, and the exchange rate. What the broker did not give stays as FMP had it.
// Returns which names came from where.
function applyKIS(m, kis) {
  const TILE = { KOSPI: 'kospi', NASDAQ: 'nasdaq' };
  const R = (n, d) => (typeof n === 'number' ? +n.toFixed(d) : n);
  const now = Date.parse(kis.fetchedAt), fromKIS = [];
  for (const [key, item] of Object.entries(kis.items)) {
    const s = item.symbol;
    // an instrument the provider did not know gets a quote of its own here, under the key the broker settled
    const q = m.quotes[s] || (m.quotes[s] = { name: '', price: 0, change: 0, changePct: 0, open: 0, prevClose: 0, dayLow: 0, dayHigh: 0, ts: null });
    const chg = item.price - item.prev;
    // when the close came from the provider, its own opening price and range stay with it: the broker's day may hold after-hours prints
    Object.assign(q, { price: R(item.price, 4), prevClose: R(item.prev, 4), change: R(chg, 4), changePct: R(chg / item.prev * 100, 3), ...(item.regular ? {} : { open: R(item.open, 4), dayHigh: R(item.high, 4), dayLow: R(item.low, 4) }), ts: stamp(item.market, item.date, now), source: 'KIS' });
    m.closes[key] = { ...(m.closes[key] || {}), ...item.closes };
    m.live[key] = { day: item.date, price: item.price };
    if (TILE[key] && item.bars.length >= BARS) { m.candles[TILE[key]].rows = item.bars; m.candles[TILE[key]].liveDay = item.date; }
    fromKIS.push(key);
  }
  if (kis.fx) m.quotes.USDKRW.price = kis.fx;
  return { fromKIS, notFromKIS: Object.keys(kis.failed), fx: kis.fx ? 'KIS' : 'FMP' };
}

if (require.main === module) (async () => {
  if (process.argv[2] === 'check') {
    const { feedsOf } = require('./feeds.js');
    const kis = await collectKIS({ feeds: feedsOf(undefined) });
    for (const [key, i] of Object.entries(kis.items)) console.log(JSON.stringify({ key, symbol: i.symbol, date: i.date, price: i.price, prev: i.prev, pct: +((i.price / i.prev - 1) * 100).toFixed(2), bars: i.bars.length, firstBar: i.bars[0].date, closes: Object.keys(i.closes).length }));
    console.log(JSON.stringify({ fx: kis.fx, failed: kis.failed, why: kis.why }));
    return;
  }
  console.log('usage: node kis-market.js check');
})().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { collectKIS, applyKIS, stamp };
