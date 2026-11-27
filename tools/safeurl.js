// URL gate shared by the scripts that fetch from the web: http(s) only, a host on the caller's allowlist,
// and a host that resolves to public addresses only (no localhost, loopback, private or reserved ranges).
const dns = require('dns').promises;
const net = require('net');

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

// Resolves to the href to request, or throws a reason. `allow` is the list of hosts permitted; `protocols` defaults to https only.
async function checkUrl(text, allow, protocols = ['https:']) {
  let u;
  try { u = new URL(text); } catch (e) { throw new Error('not a URL'); }
  if (!protocols.includes(u.protocol)) throw new Error(`only ${protocols.join(' and ')} are allowed`);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('localhost is refused');
  if (net.isIPv6(host.replace(/^\[|\]$/g, '')) === 0 && net.isIP(host) && !isPublicIp(host)) throw new Error('private or reserved address is refused');
  if (!allow.includes(host)) throw new Error('host is not on the allowlist: ' + host);
  const addrs = await dns.lookup(host.replace(/^\[|\]$/g, ''), { all: true });
  if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) throw new Error('host resolves to a private or reserved address');
  if (u.username || u.password) throw new Error('credentials in the url are refused');
  return u.href;
}

module.exports = { checkUrl, isPublicIp };
