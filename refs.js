// Pengambil teks referensi: transkrip YouTube atau artikel web. Tanpa dependensi (Node 18+).
const dns = require('dns').promises, net = require('net');
const ALLOW_LOCAL = !!process.env.ALLOW_LOCAL_REFS, MAXW = 20000, TO = 20000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const isPrivate = ip => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || (x.startsWith('::ffff:') && isPrivate(x.slice(7)));
};
// fetch yang menolak alamat jaringan lokal (STB adalah router), termasuk lewat pengalihan
async function safeFetch(url, opts = {}, hops = 0) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Hanya link http atau https');
  if (!ALLOW_LOCAL) {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error('Alamat ditolak (jaringan lokal)');
  }
  const r = await fetch(u, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(TO) });
  const loc = r.headers.get('location');
  if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
    if (hops >= 4) throw new Error('Terlalu banyak pengalihan');
    return safeFetch(new URL(loc, u).href, opts, hops + 1);
  }
  return r;
}
const dec1 = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const dec = s => dec1(dec1(s));

function ytId(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return (x.pathname.slice(1).split('/')[0] || '').match(/^[\w-]{11}$/) ? x.pathname.slice(1).split('/')[0] : null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      const v = x.searchParams.get('v'); if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = x.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/); return m ? m[1] : null;
    }
  } catch {}
  return null;
}
function parseCaptions(x) {
  const parts = [], re = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g; let m;
  while ((m = re.exec(x))) parts.push(dec(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
  return parts.filter(Boolean).join(' ');
}
const pickTrack = tracks => tracks.slice().sort((a, b) => sc(b) - sc(a))[0];
const sc = t => ((t.languageCode || '').startsWith('id') ? 4 : (t.languageCode || '').startsWith('en') ? 2 : 0) + (t.kind === 'asr' ? 0 : 1);

async function ytTranscript(id) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST', signal: AbortSignal.timeout(TO),
    headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip', 'accept-language': 'id,en;q=0.8' },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'id' } }, videoId: id })
  });
  const j = await r.json().catch(() => ({}));
  const ps = j.playabilityStatus;
  if (ps && ps.status && ps.status !== 'OK') throw new Error('Video tidak bisa diakses: ' + (ps.reason || ps.status));
  const tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('Video ini tidak punya teks atau transkrip yang bisa diambil');
  const t = pickTrack(tracks);
  const cr = await fetch(t.baseUrl, { headers: { 'accept-language': 'id,en;q=0.8', 'user-agent': UA }, signal: AbortSignal.timeout(TO) });
  const text = parseCaptions(await cr.text());
  if (!text) throw new Error('Transkrip kosong atau diblokir YouTube');
  return { title: j.videoDetails?.title || id, text };
}
async function webText(url) {
  const r = await safeFetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'id,en;q=0.8' } });
  if (!r.ok) throw new Error('Halaman membalas HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (!/html|text/.test(ct)) throw new Error('Bukan halaman teks (' + ct.split(';')[0] + ')');
  let h = (await r.text()).slice(0, 3e6);
  const title = dec((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim() || new URL(url).hostname;
  h = h.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const a = h.match(/<article\b[\s\S]*?<\/article>/i) || h.match(/<main\b[\s\S]*?<\/main>/i); if (a) h = a[0];
  const text = dec(h.replace(/<(br|\/p|\/div|\/h\d|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  if (text.split(/\s+/).length < 100) throw new Error('Isi halaman tidak terbaca (mungkin berbayar atau dimuat lewat JavaScript)');
  return { title, text };
}
async function fetchRef(url) {
  const id = ytId(url), kind = id ? 'youtube' : 'web';
  try {
    const r = id ? await ytTranscript(id) : await webText(url);
    const w = r.text.split(/\s+/).filter(Boolean), truncated = w.length > MAXW;
    return { url, kind, ok: true, title: r.title, words: Math.min(w.length, MAXW), text: truncated ? w.slice(0, MAXW).join(' ') : r.text, truncated };
  } catch (e) { return { url, kind, ok: false, error: e.cause?.code ? e.message + ' (' + e.cause.code + ')' : e.message }; }
}
module.exports = { fetchRef, ytId, parseCaptions, pickTrack, isPrivate };
