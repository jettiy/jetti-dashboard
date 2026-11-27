// Seal a payload with the member key the admin page left on this PC, in the form the hosted page opens with the
// member's code. The page arrives at the same key from the code and the salt through PBKDF2 and opens with AES-GCM; the
// refresh, which runs with no one at the keyboard, takes the key itself from the key file. The file and the key are read
// at run time and never printed.
// usage: node seal.js key "<member code>"       write a new key file for a code (what the admin page does in the browser)
//        node seal.js restore "<member code>"   put back a lost key file, under the salt the record on this PC already
//                                               names, so that the record and the held prices keep opening as they do
//        node seal.js open "<member code>"      open the two sealed files in the site folder, to see that the code works
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// the project folder is the one this script sits in (…\trader\tools), so the whole folder can be moved as it is
const SITE = path.join(__dirname, '..', 'site');
const KEY_FILE = path.join(SITE, '.member-key');
const RECORD = path.join(SITE, 'position-dashboard-record-v3.js'), HELD = path.join(SITE, 'position-dashboard-held-v3.js');
const ITERATIONS = 210000;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } };

// the key a code and a salt amount to; extractable only where it is to be written to the key file
async function derive(code, salt, usages, extractable = false) {
  const base = await crypto.subtle.importKey('raw', Buffer.from(code, 'utf8'), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, extractable, usages);
}

// a sealed file as text: the envelope between the equals sign and the semicolon
function envelopeOf(text) {
  const m = text.match(/=\{[\s\S]*\}(?=;\s*$)/);
  if (!m) throw new Error('no envelope in the file');
  return JSON.parse(m[0].slice(1));
}
// the key a sealed file is under is named by the salt in its envelope; null when there is no envelope in the text
const saltIn = (text) => { try { return envelopeOf(text).salt || null; } catch (e) { return null; } };

// a key file as text: the one on this PC, or one a test made; null when it is not one
function keyIn(text) {
  try { const k = JSON.parse(text); return k && k.v === 1 && k.key && k.salt ? k : null; } catch (e) { return null; }
}
// written beside the target first, then moved into place, so that nothing reads a half-written file
function writeKey(text) {
  fs.mkdirSync(SITE, { recursive: true });
  fs.writeFileSync(KEY_FILE + '.tmp', text);
  fs.renameSync(KEY_FILE + '.tmp', KEY_FILE);
  return { ok: true, written: KEY_FILE };
}
// the key made from a code and a salt, as a key file's text: the salt and the key itself, so that a later run can seal
// without the code
async function keyText(code, salt = crypto.randomBytes(16)) {
  const key = await crypto.subtle.exportKey('raw', await derive(code, salt, ['encrypt'], true));
  return JSON.stringify({ v: 1, n: ITERATIONS, salt: b64u(salt), key: b64u(Buffer.from(key)), at: new Date().toISOString() });
}
// a new key file for a code: a new salt with it. What the admin page does when the code is first saved or changed
const makeKey = async (code) => writeKey(await keyText(code));
// the key file put back for a code under the salt the record on this PC names. The key comes from the code and that
// salt alone, so a lost key file is remade as it was, and the record and the held prices keep opening with the code
async function restoreKey(code) {
  const e = envelopeOf(fs.readFileSync(RECORD, 'utf8'));
  const out = writeKey(await keyText(code, unb64u(e.salt)));
  // it is the key the record was sealed with when what it seals opens with the code, and the held prices agree
  const probe = await seal({ ok: true });
  out.checks = { opensWithTheCode: !!(probe && (await openEnvelope(probe, code)).ok), heldUnderTheSameKey: saltIn(readText(HELD)) === e.salt };
  return out;
}

// the payload under a key file's key, as a sealed envelope
async function sealUnder(obj, k) {
  const key = await crypto.subtle.importKey('raw', unb64u(k.key), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.randomBytes(12);
  const ct = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(obj), 'utf8')));
  return { v: 1, n: k.n || ITERATIONS, salt: k.salt, ts: obj.ts || Date.now(), iv: b64u(iv), ct: b64u(ct) };
}
// the payload as a sealed envelope, or null when no key file is on this PC
const seal = (obj) => { const k = keyIn(readText(KEY_FILE)); return k ? sealUnder(obj, k) : null; };
// the same under a key file given as text, so that a test never needs a key file in the site folder
const sealWith = (obj, text) => { const k = keyIn(text); return k ? sealUnder(obj, k) : null; };
// the salt the key file on this PC names, which is the key the record and the held prices are to be under; null without one
const keySalt = () => { const k = keyIn(readText(KEY_FILE)); return k ? k.salt : null; };

// what a sealed envelope holds, for a code; throws when the code is not the one it was sealed with
async function openEnvelope(e, code) {
  const key = await derive(code, unb64u(e.salt), ['decrypt']);
  const pt = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(e.iv) }, key, unb64u(e.ct)));
  return JSON.parse(pt.toString('utf8'));
}
const open = (file, code) => openEnvelope(envelopeOf(fs.readFileSync(file, 'utf8')), code);
// what a sealed envelope holds for the key named in a key file's text: the refresh on GitHub holds one as a secret and
// has no code; throws when the key is not the one it was sealed with
const openWith = async (e, k) => {
  if (!k || !k.key) throw new Error('no member key to open it with');
  const key = await crypto.subtle.importKey('raw', unb64u(k.key), 'AES-GCM', false, ['decrypt']);
  const pt = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(e.iv) }, key, unb64u(e.ct)));
  return JSON.parse(pt.toString('utf8'));
};

module.exports = { seal, sealWith, open, openEnvelope, openWith, makeKey, restoreKey, keyText, keySalt, saltIn, keyIn, envelopeOf, KEY_FILE };

if (require.main === module) (async () => {
  const [cmd, code] = process.argv.slice(2);
  if (!code) throw new Error('usage: node seal.js key|restore|open "<member code>"');
  if (cmd === 'key') { console.log(JSON.stringify(await makeKey(code))); return; }
  if (cmd === 'restore') { console.log(JSON.stringify(await restoreKey(code))); return; }
  if (cmd === 'open') {
    const out = {};
    for (const [name, file] of [['record', RECORD], ['held', HELD]]) {
      if (!fs.existsSync(file)) { out[name] = 'not on disk'; continue; }
      const o = await open(file, code);
      out[name] = name === 'record' ? { ts: o.ts, positions: (o.positions || []).length, memo: !!(o.memo && o.memo.title) } : { ts: o.ts, quotes: Object.keys(o.quote || {}), series: Object.keys(o.closes || {}) };
    }
    console.log(JSON.stringify(out)); return;
  }
  throw new Error('usage: node seal.js key|restore|open "<member code>"');
})().catch((e) => { console.error(e.message); process.exit(1); });
