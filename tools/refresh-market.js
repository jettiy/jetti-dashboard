// Refresh the market data the dashboards load.
// It runs on GitHub, in the repository's refresh workflow, twice a day and whenever the admin page asks — so that no PC
// needs to be on — and can still be run by hand on this PC. Three files come out of a run on this PC:
//   · beside the mockups: everything in the clear, for the operator's own browser, as it always was;
//   · in the site folder: the market tiles and 코스피's closes, for anyone with the hosted page's address;
//   · in the site folder too: the quotes and closes of the held instruments, sealed with the member's code, because
//     which instruments the operator holds is itself what members pay to see.
// On GitHub only the last two are written, into the root of the checked-out repository.
// Which instruments are held: on this PC, whatever the admin page last wrote into the site folder (its list of them),
// so that a position added there is followed from the next run on; on GitHub, the sealed record itself, opened with the
// member key the workflow holds as a secret — and until there is a record, the six of 2026-11-24 stand in.
// Two sources: 한국투자증권's Open API gives 코스피, 나스닥, the held instruments it lists and the won per dollar, exact
// to the unit each is quoted in; FMP gives 항셍, 비트코인, WTI, 금, the instruments in markets the broker does not
// answer for, and stands in for anything the broker did not give — and, for a New York name once its session has closed,
// the regular session's close, because the broker's last price may by then be an after-hours print (kis-market.js).
// The keys are read at run time and never printed: on this PC from the local key file, on GitHub from the environment,
// where the workflow has them as secrets.
// The HTML files are not touched, so whatever was changed in them survives.
// usage: node refresh-market.js        (takes no arguments; the project folder is the one this script sits in)
const fs = require('fs');
const path = require('path');
const { collect, compact, publicOf, heldOf, CURVE_FROM } = require('./market-build.js');
const { collectKIS, applyKIS } = require('./kis-market.js');
const { seal, sealWith, keyIn, envelopeOf, openWith } = require('./seal.js');
const { feedOf } = require('./feeds.js');

// On GitHub the member key comes from the environment; its presence is what tells the run where it is
const ON_GITHUB = !!process.env.JETTI_MEMBER_KEY;
const ROOT = path.join(__dirname, '..');
// in the repository the site's files sit at its root; on this PC in the site folder
const SITE = ON_GITHUB ? ROOT : path.join(ROOT, 'site');
const RECORD_FILE = path.join(SITE, 'position-dashboard-record-v3.js');
// the admin page's list of what is held, for this PC alone
const LIST = path.join(SITE, '.instruments.json');
const OUT = path.join(ROOT, 'proposals', 'position-dashboard-data-v3.js');
const SITE_DATA = path.join(SITE, 'position-dashboard-data-v3.js'), SITE_HELD = path.join(SITE, 'position-dashboard-held-v3.js');
const LOG = path.join(ROOT, 'logs', 'refresh.jsonl');
const STAND_INS = 'the six of 2026-11-24';

// The held instruments, or null when there is no list, so that the six stand in: the list must not be empty, or a bad
// file would quietly leave the dashboard without prices
async function heldList() {
  if (ON_GITHUB) {
    // what is held is in the record members get; it opens with the key the workflow holds, and no other
    let text = '';
    try { text = fs.readFileSync(RECORD_FILE, 'utf8'); } catch (e) { return null; }
    const record = await openWith(envelopeOf(text), keyIn(process.env.JETTI_MEMBER_KEY));
    const items = (record.positions || []).map(({ code, cls, mkt }) => ({ code, cls, mkt }));
    return items.length ? items : null;
  }
  try { const l = JSON.parse(fs.readFileSync(LIST, 'utf8')); return l && Array.isArray(l.items) && l.items.length ? l.items : null; } catch (e) { return null; }
}
// written beside the target first, then moved into place, so a page never loads a half-written file
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); }

(async () => {
  const held = await heldList();
  const m = await collect({ held });
  // the broker's figures are the better ones where it has them; without them the page keeps the FMP figures it always had
  let kis = null, kisError = '';
  try { kis = await collectKIS({ from: CURVE_FROM, feeds: m.feeds, quotes: m.quotes, closes: m.closes }); } catch (e) { kisError = e.message; }
  const used = kis ? applyKIS(m, kis) : { fromKIS: [], notFromKIS: ['all'], fx: 'FMP' };
  const by = { KIS: used.fromKIS, FMP: ['hsi', 'btc', 'wti', 'gold'], missed: used.notFromKIS.length ? used.notFromKIS : undefined, fx: used.fx };
  const c = { ...compact(m), by };

  if (!ON_GITHUB) write(OUT, '// Market data for the dashboard mockups, fetched at ' + m.fetchedAt + ' (UTC) from Financial Modeling Prep,\n'
    + '// with 코스피 · 나스닥 · the held instruments and the exchange rate from 한국투자증권 Open API where it answered.\n'
    + '// Written by tools/refresh-market.js. Replace this file to refresh the page; the HTML files are not touched.\n'
    + 'window.FMP=' + JSON.stringify(c) + ';\n');
  write(SITE_DATA, '// Market data for the hosted dashboard, fetched at ' + m.fetchedAt + ' (UTC): the market tiles and 코스피\'s closes.\n'
    + '// The prices of the held instruments are in position-dashboard-held-v3.js, sealed with the member\'s code.\n'
    + '// Written by tools/refresh-market.js.\n'
    + 'window.FMP=' + JSON.stringify(publicOf(c)) + ';\n');
  // sealed with the member key: a file on this PC, where the admin page leaves it; a secret on GitHub. On this PC nothing
  // is written before there is one, as there is nothing to show members anyway; on GitHub a key that seals nothing
  // stops the run, rather than leave the prices as they were
  const sealed = ON_GITHUB ? await sealWith(heldOf(c, Date.now()), process.env.JETTI_MEMBER_KEY) : await seal(heldOf(c, Date.now()));
  if (ON_GITHUB && !sealed) throw new Error('the member key the workflow holds sealed nothing');
  if (sealed) write(SITE_HELD, '// Prices of the held instruments for the hosted dashboard, sealed with the member\'s code at ' + new Date(sealed.ts).toISOString() + ' (UTC).\n'
    + '// Written by tools/refresh-market.js; it opens only with the code, as position-dashboard-record-v3.js does.\n'
    + 'window.JETTI_HELD=' + JSON.stringify(sealed) + ';\n');

  const last = (id) => m.candles[id].rows[m.candles[id].rows.length - 1];
  const priceOf = (f) => (m.quotes[f.symbol] ? `${f.symbol} ${m.quotes[f.symbol].price} (전일 ${m.quotes[f.symbol].prevClose})` : null);
  const out = {
    at: new Date().toISOString(), fetchedAt: m.fetchedAt,
    heldFrom: held ? (ON_GITHUB ? 'the sealed record' : 'the admin page\'s list') : STAND_INS, heldCount: m.feeds.length,
    // positions on the list that neither source is known to have (futures, say): they keep the price entered for them
    unlisted: (held || []).filter((i) => !feedOf(i)).map((i) => i.code),
    kospi: `${last('kospi').date} ${m.quotes['^KS11'].price}`, hsi: `${last('hsi').date} ${m.quotes['^HSI'].price}`, nasdaq: `${last('nasdaq').date} ${m.quotes['^IXIC'].price}`,
    held: Object.fromEntries(m.feeds.map((f) => [f.key || f.code, f.symbol && m.quotes[f.symbol] ? priceOf(f) : 'no price'])),
    notFollowed: m.feeds.filter((f) => !f.symbol || !m.quotes[f.symbol]).map((f) => f.key || f.code),
    usdkrw: m.quotes.USDKRW.price, sources: by, kisError: kisError || undefined,
    kisWhy: kis && Object.keys(kis.why || {}).length ? kis.why : undefined,
    site: { data: fs.statSync(SITE_DATA).size, held: sealed ? 'sealed' : 'not sealed' },
  };
  // one line per run on this PC, for the once-a-day check to read; on GitHub the line is the run's own
  if (!ON_GITHUB) { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify(out) + '\n'); }
  console.log(JSON.stringify({ where: ON_GITHUB ? 'GitHub' : 'this PC', ...out }));
})().catch((e) => { console.error(e.message); process.exit(1); });
