// 한국투자증권 Open API: issue an access token, and read the account's balances once the account number is on file.
// Other scripts take readSecrets, call and token from here (kis-market.js reads market data with them).
// The app key, the secret and the account number are read from a local file at run time and are never printed, logged
// or written anywhere. Only https requests to the broker's Open API host, which must resolve to public addresses, are sent.
// usage: node kis.js token
//        node kis.js balance [out.json]
const fs = require('fs');
const path = require('path');
const { checkUrl } = require('./safeurl');

const HOST = 'openapi.koreainvestment.com';
const ORIGIN = `https://${HOST}:9443`;
const KEY_FILE = process.env.KIS_KEY_FILE || 'C:\\Users\\USER\\Desktop\\KEY.txt';
const ACCOUNT_PRODUCT = '01'; // 계좌상품코드: 01 for a standard brokerage account

// The key and the secret come from the environment where a workflow holds them as secrets, and on this PC from the local key file.
function readSecrets(file) {
  if (process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
    const key = process.env.KIS_APP_KEY.trim(), secret = process.env.KIS_APP_SECRET.trim();
    if (!/^[A-Za-z0-9]{20,40}$/.test(key) || secret.length < 40) throw new Error('the broker key or secret in the environment has an unexpected shape');
    return { key, secret, account: '' };
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim());
  const one = (label) => { const l = lines.find((s) => s.startsWith(label)); return l ? l.slice(label.length).replace(/^[\s:]+/, '') : ''; };
  const key = one('한투 KIS APP KEY'), secret = one('한투 KIS APP SECRET');
  if (!/^[A-Za-z0-9]{20,40}$/.test(key)) throw new Error('the file has no usable "한투 KIS APP KEY" line');
  if (secret.length < 40) throw new Error('the file has no usable "한투 KIS APP SECRET" line');
  // the account line is optional and holds digits only
  const account = one('한투 KIS 계좌번호').replace(/\D/g, '');
  return { key, secret, account: account.length === 8 ? account : '' };
}

async function call(secrets, rel, { body, form, headers } = {}) {
  const href = await checkUrl(ORIGIN + rel, [HOST]);
  const hasBody = body || form;
  const r = await fetch(href, { method: hasBody ? 'POST' : 'GET', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=UTF-8', ...(body ? { appkey: secrets.key, appsecret: secrets.secret } : {}), ...(headers || {}) }, body: body ? JSON.stringify({ ...body, appkey: secrets.key, secretkey: secrets.secret }) : form ? new URLSearchParams({ ...form, appkey: secrets.key, appsecret: secrets.secret }).toString() : undefined, redirect: 'error' });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: r.status, type: r.headers.get('content-type') || '', server: r.headers.get('server') || '', data, raw: data ? null : text.slice(0, 200) };
}

async function token(secrets, { log = false } = {}) {
  // the access token comes from a form post to /oauth2/token; /oauth2/Approval only issues the WebSocket key
  const res = await call(secrets, '/oauth2/token', { form: { grant_type: 'client_credentials' } });
  const bearer = res.data && res.data.access_token;
  if (res.status !== 200 || !bearer) {
    // say what the broker answered, leaving out anything that could serve as a credential
    if (log) { const said = Object.fromEntries(Object.entries(res.data || {}).filter(([k]) => !/token|key|secret/i.test(k))); console.log(JSON.stringify({ ok: false, status: res.status, type: res.type, server: res.server, said, body: res.raw })); }
    return null;
  }
  // the token itself stays in memory: only its type, length and expiry are reported, and only to the command line
  if (log) console.log(JSON.stringify({ ok: true, status: res.status, tokenType: res.data.token_type, tokenLength: bearer.length, expiresIn: res.data.expires_in, expiresAt: res.data.access_token_token_expired }));
  return bearer;
}

// the part of a response that carries data, whatever the broker named it
const rows = (d) => [].concat(d.output || [], d.output1 || [], d.output2 || []).filter((x) => x && typeof x === 'object');
const BASE = { CANO: '', ACNT_PRDT_CD: ACCOUNT_PRODUCT };

async function balance(secrets, outFile) {
  if (!secrets.account) { console.log(JSON.stringify({ ok: false, error: 'no account number on file: add a line "한투 KIS 계좌번호 : 12345678"' })); return; }
  const bearer = await token(secrets);
  if (!bearer) return;
  const auth = { authorization: `Bearer ${bearer}`, custtype: 'P' };
  const q = (o) => Object.entries({ ...BASE, ...o, CANO: secrets.account }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const out = { fetchedAt: new Date().toISOString(), domestic: null, overseas: {} };
  // domestic stocks and ETFs
  const kr = await call(secrets, '/uapi/domestic-stock/v1/trading/inquire-balance?' + q({ AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_PD_YN: 'N', INCL_DVSN: '', TRF_DVSN: '01', CNTG_YN: 'N' }), { headers: { ...auth, tr_id: 'TTTC8434R' } });
  out.domestic = { status: kr.status, success: kr.data && kr.data.rt_code === '0', message: kr.data && kr.data.msg1, holdings: rows(kr.data).map((x) => ({ code: x.pdno, name: x.prdt_name, qty: +(x.hldg_qty || 0), avg: +(x.pchs_avg_pric || 0), price: +(x.prpr || 0), evalAmt: +(x.evlu_amt || 0), pnl: +(x.evlu_pfls_amt || 0) })), cash: kr.data && kr.data.output2 && kr.data.output2[0] ? { dncaTotAmt: +(kr.data.output2[0].dnca_tot_amt || 0), totEvluAmt: +(kr.data.output2[0].tot_evlu_amt || 0) } : null };
  // overseas stocks, one request per exchange and currency
  for (const [excg, ccy] of [['NASDA', 'USD'], ['NYSE', 'USD'], ['AMEX', 'USD'], ['SEHK', 'HKD'], ['SHAA', 'CNY'], ['SZAA', 'CNY']]) {
    const os = await call(secrets, '/uapi/overseas-stock/v1/trading/inquire-balance?' + q({ OVRS_EXCG_CD: excg, TR_CRCY_CD: ccy, CTX_KEY_FK200: '', CTX_KEY_NK200: '' }), { headers: { ...auth, tr_id: 'TTTS3012R' } });
    out.overseas[excg] = { status: os.status, success: os.data && os.data.rt_code === '0', message: os.data && os.data.msg1, holdings: rows(os.data).map((x) => ({ code: x.ovrs_pdno, name: x.ovrs_item_name, qty: +(x.hold_qty || 0), avg: +(x.avg_prvs || 0), price: +(x.ovrs_now_pric || 0), evalAmt: +(x.ovrs_stck_evlu_amt || 0), pnl: +(x.frcr_evlu_pfls_amt || 0), ccy: x.tr_crcy_cd })) };
    await new Promise((r) => setTimeout(r, 400));
  }
  const n = Object.values(out.overseas).reduce((a, x) => a + x.holdings.length, 0) + out.domestic.holdings.length;
  console.log(JSON.stringify({ ok: true, domestic: { status: out.domestic.status, success: out.domestic.success, message: out.domestic.message, holdings: out.domestic.holdings.length, cash: out.domestic.cash }, overseas: Object.fromEntries(Object.entries(out.overseas).map(([k, v]) => [k, `${v.status} ${v.success} ${v.holdings.length}건 ${v.message || ''}`])), total: n }));
  if (outFile && n) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(out, null, 1)); console.log('saved ' + outFile); }
}

module.exports = { readSecrets, call, token };

if (require.main === module) (async () => {
  const [cmd, outFile] = process.argv.slice(2);
  const secrets = readSecrets(KEY_FILE);
  if (cmd === 'token') { await token(secrets, { log: true }); return; }
  if (cmd === 'balance') { await balance(secrets, outFile); return; }
  console.log('usage: node kis.js token | balance [out.json]');
})().catch((e) => { console.error(e.message); process.exit(1); });
