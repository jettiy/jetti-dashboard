// Temporary: does the broker answer a request made from GitHub's servers with this key? Prints statuses and figures only;
// the key and the secret come from the environment and the token stays in memory.
const { readSecrets, call, token } = require('./kis.js');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const s = readSecrets(process.env.KIS_KEY_FILE || 'C:\\Users\\USER\\Desktop\\KEY.txt');
  const out = { at: new Date().toISOString() };
  const bearer = await token(s);
  out.token = !!bearer;
  if (!bearer) { console.log(JSON.stringify(out)); process.exit(1); }
  const headers = { authorization: `Bearer ${bearer}`, appkey: s.key, appsecret: s.secret, custtype: 'P' };
  const get = async (rel, tr, params) => { const r = await call(s, rel + '?' + new URLSearchParams(params).toString(), { headers: { ...headers, tr_id: tr } }); const d = r.data || {}; return { status: r.status, ok: d.rt_cd === '0' || d.rt_code === '0', msg: d.msg1 || d.message, d }; };
  const kospi = await get('/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice', 'FHKUP03500100', { fid_cond_mrkt_div_code: 'U', fid_input_iscd: '0001', fid_input_date_1: '20261120', fid_input_date_2: '20261129', fid_period_div_code: 'D' });
  out.kospi = { status: kospi.status, ok: kospi.ok, msg: kospi.msg, rows: (kospi.d.output2 || []).slice(0, 2).map((x) => `${x.stck_bsop_date} ${x.bstp_nmix_prpr}`) };
  await pause(500);
  const baba = await get('/uapi/overseas-price/v1/quotations/price', 'HHDFS00000300', { AUTH: '', EXCD: 'NYS', SYMB: 'BABA' });
  out.baba = { status: baba.status, ok: baba.ok, msg: baba.msg, last: baba.d.output && baba.d.output.last, base: baba.d.output && baba.d.output.base };
  await pause(500);
  const kodex = await get('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', { fid_cond_mrkt_div_code: 'J', fid_input_iscd: '233740' });
  out.kodex = { status: kodex.status, ok: kodex.ok, msg: kodex.msg, price: kodex.d.output && kodex.d.output.stck_prpr };
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e.message); process.exit(1); });
