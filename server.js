// Script VO Agent: server tanpa dependensi (Node 18+). API key hanya ada di server.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawn } = require('child_process');
const zlib = require('zlib');
const refs = require('./refs');
const clipperLib = require('./clipper-lib');
let tts;
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch {}
const E = process.env, PORT = E.PORT || 3000, MAXT = +E.MAX_TOKENS || 8000, LIMIT = 10 * 60 * 1000;
// gemini-2.5-flash DIPENSIUNKAN Google utk user baru ("This model
// models/gemini-2.5-flash is no longer available to new users") — semua
// panggilan Direct Gemini gagal walau key valid. Default + pin lama di
// .env dipetakan ke penerusnya gemini-3.8-flash (saran error Google).
const GEMINI_MODEL = !E.GEMINI_MODEL || E.GEMINI_MODEL === 'gemini-2.5-flash' ? 'gemini-3.8-flash' : E.GEMINI_MODEL;
const M = { gemini: GEMINI_MODEL, claude: E.CLAUDE_MODEL || 'claude-sonnet-4-6', openai: E.OPENAI_MODEL || 'gpt-4o' };
const KEY = { gemini: 'GEMINI_API_KEY', claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const R = (E.ROUTER_URL || '').replace(/\/+$/, '').replace(/\/v1$/, '');
const rh = () => { const h = {}; if (E.ROUTER_API_KEY) h.authorization = 'Bearer ' + E.ROUTER_API_KEY; if (E.CF_ACCESS_CLIENT_ID) { h['CF-Access-Client-Id'] = E.CF_ACCESS_CLIENT_ID; h['CF-Access-Client-Secret'] = E.CF_ACCESS_CLIENT_SECRET || ''; } return h; };
// 9router KEDUA (PC, di mesin yang sama dengan dashboard): ROUTER_URL_PC
// (misal http://127.0.0.1:20128). Portnya sama dengan Pi (20128) tidak
// masalah — mesinnya beda (Pi = 100.108.196.121:20128, PC = 127.0.0.1:20128).
// DEFAULT http://127.0.0.1:20128 bila env kosong (fix brief Dzaky 21 Okt):
// 9router PC memang jalan di mesin yang sama dengan dashboard, jadi jalur
// PC tidak boleh mati hanya karena variabelnya belum ditulis di .env.
// Nilai .env tetap menang. Normalisasi: slash + "/v1" di ujung dibuang,
// "localhost" diganti 127.0.0.1 (9router PC hanya dengar di IPv4 —
// "localhost" bisa resolve ke ::1 dan gagal). Key: ROUTER_API_KEY_PC,
// bila kosong pakai ROUTER_API_KEY yang sama.
const RPC = ((E.ROUTER_URL_PC || '').trim() || 'http://127.0.0.1:20128').replace(/\/+$/, '').replace(/\/v1$/, '').replace(/:\/\/localhost(?=[:/]|$)/i, '://127.0.0.1');
const rhPc = () => { const h = {}; const key = E.ROUTER_API_KEY_PC || E.ROUTER_API_KEY; if (key) h.authorization = 'Bearer ' + key; if (E.CF_ACCESS_CLIENT_ID) { h['CF-Access-Client-Id'] = E.CF_ACCESS_CLIENT_ID; h['CF-Access-Client-Secret'] = E.CF_ACCESS_CLIENT_SECRET || ''; } return h; };
// Key API benar-benar terisi (bukan kosong / hanya spasi / sampah terlalu
// pendek). Health lama pakai `!!E[KEY]` -> key berisi spasi / placeholder
// 1-2 karakter ikut "ok:true" (false positive — mis. ChatGPT "✓ aktif"
// padahal key belum pernah diisi). Batas 8 karakter: tidak ada key provider
// sungguhan yang lebih pendek (Gemini ~39, OpenAI 51, Anthropic ~100,
// ElevenLabs 32, Groq 56).
const hasKey = v => typeof v === 'string' && v.trim().length >= 8;
// Router yang dipilih: 'pi' (default; nilai lama 'router' = Pi, untuk
// kompatibilitas) atau 'pc'. Pemilihan MANUAL via dropdown — tanpa auto-failover.
const routerWhich = v => (v === 'router-pc' || v === 'pc') ? 'pc' : 'pi';
const routerBase = which => (which === 'pc' ? RPC : R);
const routerHeaders = which => (which === 'pc' ? rhPc() : rh());
// Probe keterjangkauan 9router (Pi / PC). Health lama hanya cek URL ter-set
// -> Pi mati tetap "ok:true" (false positive — chip Koneksi AI benar
// "tidak terjangkau", tapi health bilang ok). Probe ringan GET /v1/models
// (timeout 3 dtk, header auth sama seperti /api/models): respons HTTP apa
// pun (termasuk 401 = router hidup, key salah) = ok:true; error jaringan /
// timeout = ok:false + reason. URL tidak di-set -> not-configured.
async function probeRouter(which) {
  const base = routerBase(which);
  if (!base) return { ok: false, reason: 'not-configured' };
  let host = base;
  try { host = new URL(base).host; } catch {}
  try {
    const r = await fetch(base + '/v1/models', { headers: routerHeaders(which), signal: AbortSignal.timeout(3000) });
    try { await r.text(); } catch {}
    return { ok: true, host, url: base };
  } catch (e) {
    const reason = /abort|timeout/i.test((e && e.name || '') + ' ' + (e && e.message || '')) ? 'timeout' : 'unreachable';
    const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
    return { ok: false, reason: code ? reason + ':' + code : reason, host, url: base };
  }
}
/* Sesi login via cookie (pengganti HTTP Basic agar bisa pakai halaman login custom).
   Token: exp.user.randomHex.hmac — stateless, HMAC-SHA256, sesi hangus saat server restart.
   Username dibake ke token agar state per akun tersimpan di server (bisa dibuka HP & PC). */
const SESS_MAX = 30 * 24 * 3600; // 30 hari
// Kunci penanda-tangan session DISIMPAN ke file (.sess-secret) — sebelumnya
// di-generate acak tiap start (crypto.randomBytes), sehingga abis restart
// semua session lama jadi tidak valid → user kelihatan logout (jadi 'default')
// → Clipper nunjukin proyek kosong (proyek tersimpan di akun aslinya, misal
// 'Dzaky', bukan 'default'). Dengan kunci persisten, session tetap valid abis restart.
let SESS_SEC;
try {
  const secFile = path.join(__dirname, '.sess-secret');
  if (fs.existsSync(secFile)) SESS_SEC = Buffer.from(fs.readFileSync(secFile, 'utf8').trim(), 'hex');
  if (!SESS_SEC || SESS_SEC.length !== 32) throw new Error('secret tidak valid');
} catch {
  SESS_SEC = crypto.randomBytes(32);
  try { fs.writeFileSync(path.join(__dirname, '.sess-secret'), SESS_SEC.toString('hex'), { mode: 0o600 }); } catch {}
}
const USER_RE = /^[a-z0-9_-]{1,32}$/;
const normUser = u => USER_RE.test(String(u || '').toLowerCase()) ? String(u).toLowerCase() : 'default';
const sessSign = (exp, u, rnd) => crypto.createHmac('sha256', SESS_SEC).update(exp + '.' + u + '.' + rnd).digest('hex');
const sessIssue = (user) => { const exp = Math.floor(Date.now() / 1000) + SESS_MAX, rnd = crypto.randomBytes(16).toString('hex'), u = normUser(user); return exp + '.' + u + '.' + rnd + '.' + sessSign(exp, u, rnd); };
const sessValid = t => {
  if (!/^\d+\.[a-z0-9_-]{1,32}\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(t || '')) return false;
  const [exp, u, rnd, sig] = t.split('.');
  if (+exp < Date.now() / 1000) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sessSign(exp, u, rnd), 'hex')); } catch { return false; }
};
const sessOf = req => { const m = /(?:^|;\s*)sva_session=([^;]+)/.exec(req.headers.cookie || ''); return m && sessValid(m[1]) ? m[1] : null; };
const sessUser = req => { const t = sessOf(req); if (!t) return 'default'; const u = t.split('.')[1]; return USER_RE.test(u) ? u : 'default'; };
/* Akun per pengguna: username -> {salt, hash, email, created}. Password di-hash scrypt.
   DASH_PASSWORD tetap berfungsi sebagai password master (bisa masuk ke akun mana pun, untuk pemulihan). */
const usersFile = () => path.join(__dirname, 'users.json');
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(usersFile(), 'utf8')); } catch { return {}; } };
const saveUsers = u => { try { fs.writeFileSync(usersFile(), JSON.stringify(u, null, 2)); } catch {} };
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const verifyPw = (pw, rec) => {
  if (!rec || !rec.salt || !rec.hash) return false;
  try { const h = Buffer.from(hashPw(pw, rec.salt), 'hex'), s = Buffer.from(rec.hash, 'hex'); return h.length === s.length && crypto.timingSafeEqual(h, s); }
  catch { return false; }
};
const pwOk = pw => { const a = Buffer.from(String(pw || '')), b = Buffer.from(E.DASH_PASSWORD || ''); return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b); };
const authed = req => !E.DASH_PASSWORD || !!sessOf(req);
const sessCookie = (tok, max) => `sva_session=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${max}`;
const fail = (msg, kind, status) => { const x = new Error(msg); x.kind = kind; if (status) x.status = status; return x; };
const post = async (url, headers, body, signal) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(j.error?.message || j.error || 'HTTP ' + r.status, '', r.status);
  return j;
};
// Bersihkan blok thinking/reasoning model (<thinking>, <think>, <analysis>, <reasoning>) yang bocor ke output.
// Tanpa mengubah prompt — langsung buang dari teks hasil.
// Juga bersihkan jejak pencarian/tool-call model (<search>, <tool_call>, dll.) + kalimat pembuka
// "I'll search for..." yang mengiringinya — model kadang menuliskannya sebagai teks di awal hasil.
const cleanThink = t => {
  let s = String(t || '')
    .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<(?:analysis|reasoning)>[\s\S]*?(?:<\/(?:analysis|reasoning)>|$)/gi, '');
  let hadSearch = false;
  s = s.replace(/<search\b[^>]*>[\s\S]*?(?:<\/search>|$)/gi, () => { hadSearch = true; return ''; });
  s = s.replace(/<(tool_call|function_call|invoke|action|tool_use|tool|functions?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '');
  if (hadSearch) {
    let prev;
    do { prev = s; s = s.replace(/^\s*(?:I'll search for.*|Let me search for.*|I will search for.*|Searching for.*|I need to search for.*|Saya akan mencari.*|Mencari .*)\n?/i, ''); } while (s !== prev);
  }
  return s.trim();
};
// Provider AI custom (ditambah dari dashboard via tombol + di Koneksi AI).
// Disimpan di custom-providers.json (nama, baseUrl, model) + key di .env (CUSTOM_<SLUG>_API_KEY).
// Format OpenAI-compatible: POST <baseUrl>/v1/chat/completions dengan Bearer key.
const CUSTOM_FILE = path.join(__dirname, 'custom-providers.json');
let CUSTOM = {};
try { const arr = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); if (Array.isArray(arr)) arr.forEach(c => { if (c && c.slug && c.name) CUSTOM[c.slug] = c; }); } catch {}
const customCall = async (slug, msgs, job) => {
  const c = CUSTOM[slug]; if (!c) throw fail('Provider custom tidak ditemukan: ' + slug, 'input');
  const key = E[c.envVar || ('CUSTOM_' + slug.toUpperCase() + '_API_KEY')];
  if (!key) throw fail('API key ' + (c.envVar || ('CUSTOM_' + slug.toUpperCase() + '_API_KEY')) + ' belum diisi di .env.', 'input');
  const base = String(c.baseUrl || '').replace(/\/$/, '');
  const j = await post(base + '/v1/chat/completions', { authorization: 'Bearer ' + key },
    { model: c.model || 'gpt-3.5-turbo', messages: msgs }, job.ctrl.signal);
  const fr = j.choices?.[0]?.finish_reason; if (fr) { job.finish = fr; job.truncated = !NORMAL.test(fr); }
  return cleanThink(j.choices?.[0]?.message?.content || '');
};
// Mode langsung (tanpa 9router). msgs = [{role:'user'|'assistant', content}]
const call = {
  async gemini(msgs, job) {
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${M.gemini}:generateContent`, { 'x-goog-api-key': E[KEY.gemini] },
      { contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), tools: [{ google_search: {} }] }, job.ctrl.signal);
    const fr = j.candidates?.[0]?.finishReason; if (fr) { job.finish = fr; job.truncated = !NORMAL.test(fr); }
    return cleanThink((j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join(''));
  },
  async claude(msgs, job) {
    const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': E[KEY.claude], 'anthropic-version': '2023-06-01' },
      { model: M.claude, max_tokens: MAXT, messages: msgs }, job.ctrl.signal);
    if (j.stop_reason) { job.finish = j.stop_reason; job.truncated = !NORMAL.test(j.stop_reason); }
    return cleanThink((j.content || []).map(x => x.text || '').join(''));
  },
  async openai(msgs, job) {
    const j = await post('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + E[KEY.openai] },
      { model: M.openai, messages: msgs }, job.ctrl.signal);
    const fr = j.choices?.[0]?.finish_reason; if (fr) { job.finish = fr; job.truncated = !NORMAL.test(fr); }
    return cleanThink(j.choices?.[0]?.message?.content || '');
  }
};
// Daftarkan provider custom ke call/KEY/M (biar dispatch call[provider] + cek KEY langsung jalan).
for (const [slug, c] of Object.entries(CUSTOM)) {
  const envVar = c.envVar || ('CUSTOM_' + slug.toUpperCase() + '_API_KEY');
  c.envVar = envVar;
  KEY['custom:' + slug] = envVar;
  M['custom:' + slug] = c.model || 'gpt-3.5-turbo';
  call['custom:' + slug] = (msgs, job) => customCall(slug, msgs, job);
}
// ===== Koneksi AI per-user (permintaan Dzaky 23 Okt) =====
// Akun 'dzaky' = ADMIN: semua koneksi server (9router, Groq, Direct bawaan,
// custom global) seperti biasa. Akun LAIN: kosongan — Koneksi AI hanya berisi
// provider yang mereka tambahkan sendiri (nama + base URL + API key + model,
// tersimpan per akun di user-providers.json, key tidak pernah ke browser);
// tanpa itu fitur AI tidak jalan dan transkrip jatuh ke Whisper lokal.
const ADMIN_USER = 'dzaky';
const isAdminUser = (u) => String(u || '').toLowerCase() === ADMIN_USER;
const USER_PROVIDERS_FILE = path.join(__dirname, 'user-providers.json');
let USER_PROVIDERS = {};
try { const j = JSON.parse(fs.readFileSync(USER_PROVIDERS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) USER_PROVIDERS = j; } catch {}
const saveUserProviders = () => { try { fs.writeFileSync(USER_PROVIDERS_FILE, JSON.stringify(USER_PROVIDERS, null, 2)); } catch {} };
const userCustom = (u) => (USER_PROVIDERS[String(u || '').toLowerCase()] || {});
// API TTS pribadi per user (ElevenLabs) — file terpisah user-tts-keys.json:
// { [userLower]: { elevenlabs: '<key>' } }. Key tidak pernah ke browser.
const USER_TTS_FILE = path.join(__dirname, 'user-tts-keys.json');
let USER_TTS_KEYS = {};
try { const j = JSON.parse(fs.readFileSync(USER_TTS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) USER_TTS_KEYS = j; } catch {}
const saveUserTtsKeys = () => { try { fs.writeFileSync(USER_TTS_FILE, JSON.stringify(USER_TTS_KEYS, null, 2)); } catch {} };
const userTtsKey = (u) => (USER_TTS_KEYS[String(u || '').toLowerCase()] || {}).elevenlabs || '';
const userTtsJobs = new Map(), userTtsAudios = new Map();
function userTtsChunk(text, limit) {
  const parts = []; let cur = '';
  for (const piece of String(text || '').split(/(?<=[.!?…])\s+|\n+/)) {
    const t = piece.trim(); if (!t) continue;
    if ((cur + ' ' + t).trim().length > limit && cur) { parts.push(cur.trim()); cur = t; }
    else cur = (cur + ' ' + t).trim();
    while (cur.length > limit) { parts.push(cur.slice(0, limit)); cur = cur.slice(limit); }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [''];
}
async function userTtsSynth(job, b, apiKey) {
  const ELEVEN = E.ELEVEN_BASE || 'https://api.elevenlabs.io';
  const chunks = userTtsChunk(b.text, 4000);
  job.total = chunks.length; job.done = 0;
  const bufs = [];
  const speed = Math.min(1.2, Math.max(0.7, +b.speed || 1));
  for (let i = 0; i < chunks.length; i++) {
    if (job.stopped) throw new Error('Dibatalkan oleh pengguna');
    const r = await fetch(ELEVEN + '/v1/text-to-speech/' + encodeURIComponent(String(b.voice || '')), {
      method: 'POST', headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: chunks[i], model_id: E.TTS_ELEVEN_MODEL || 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75, speed } }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); let m = 'HTTP ' + r.status; try { const j = JSON.parse(t); m = (j.detail && (j.detail.message || j.detail.status)) || m; } catch {} throw new Error('ElevenLabs: ' + m); }
    bufs.push(Buffer.from(await r.arrayBuffer()));
    job.done = i + 1;
  }
  const buf = Buffer.concat(bufs);
  userTtsAudios.set(job.id, { buf, ts: Date.now(), format: 'mp3' });
  while (userTtsAudios.size > 4) userTtsAudios.delete(userTtsAudios.keys().next().value);
  job.status = 'done'; job.bytes = buf.length; job.format = 'mp3';
}
const userCustomCall = async (u, slug, msgs, job) => {
  const c = userCustom(u)[slug]; if (!c) throw fail('Provider custom tidak ditemukan: ' + slug, 'input');
  if (!c.apiKey) throw fail('API key ' + (c.name || slug) + ' belum diisi.', 'input');
  const base = String(c.baseUrl || '').replace(/\/$/, '');
  const j = await post(base + '/v1/chat/completions', { authorization: 'Bearer ' + c.apiKey },
    { model: c.model || 'gpt-3.5-turbo', messages: msgs }, job.ctrl.signal);
  const fr = j.choices?.[0]?.finish_reason; if (fr) { job.finish = fr; job.truncated = !NORMAL.test(fr); }
  return cleanThink(j.choices?.[0]?.message?.content || '');
};
// Alasan berhenti yang berarti selesai normal; selain itu (length, max_tokens, MAX_TOKENS, dll) = terpotong
const NORMAL = /^(?:finish_reason_)?(stop|end_turn|stop_sequence|eos|completed?|natural)$/i;
const abortErr = (e, job) => e.name === 'AbortError' ? (job.stopped ? fail('Dihentikan oleh pengguna', 'stopped') : fail('Waktu habis menunggu AI (10 menit)', 'timeout')) : null;
// Mode 9router: streaming, hasil sebagian disimpan di job.partial.
// `which`: 'pi' (default) atau 'pc' — router yang dipakai (dipilih manual).
async function viaRouterOnce(model, msgs, job, which) {
  const w = routerWhich(which), lbl = w === 'pc' ? '9router PC' : '9router Pi';
  const base = routerBase(w);
  const hdrs = routerHeaders(w);
  let r;
  try {
    r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...hdrs }, signal: job.ctrl.signal,
      body: JSON.stringify({ model, max_tokens: MAXT, stream: true, messages: msgs }) });
  } catch (e) { throw abortErr(e, job) || fail('Tidak bisa menjangkau ' + lbl + ': ' + (e.cause?.code || e.cause?.message || e.message), 'network'); }
  const ct = r.headers.get('content-type') || '';
  const snip = t => t.replace(/\s+/g, ' ').slice(0, 200);
  if (!r.ok) { const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {} throw fail(j.error?.message || j.error || 'HTTP ' + r.status + ': ' + snip(t), '', r.status); }
  if (!ct.includes('text/event-stream')) {
    const t = await r.text(); let j;
    try { j = JSON.parse(t); } catch { throw fail('9router membalas bukan JSON (status ' + r.status + ', ' + (ct || 'tanpa content-type') + '): ' + snip(t), 'html'); }
    if (j.error) throw fail(j.error.message || String(j.error), '', +j.error.code || r.status);
    const out = j.choices?.[0]?.message?.content || '';
    job.chars = out.length; job.partial = out;
    const fr = j.choices?.[0]?.finish_reason; if (fr) { job.finish = fr; job.truncated = !NORMAL.test(fr); }
    if (!out.trim()) throw fail('Model membalas kosong', 'empty');
    return cleanThink(out);
  }
  let out = '', buf = ''; const dec = new TextDecoder();
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (d === '[DONE]') { job.sawDone = true; continue; }
        let o; try { o = JSON.parse(d); } catch { continue; }
        if (o.error) throw fail(o.error.message || JSON.stringify(o.error), '', +o.error.code || +o.error.status || 0);
        const c0 = o.choices?.[0];
        out += c0?.delta?.content || '';
        if (c0?.finish_reason) job.finish = c0.finish_reason;
        job.chars = out.length; job.partial = out;
      }
    }
  } catch (e) {
    const a = abortErr(e, job); if (a) throw a;
    if (e.kind !== undefined) throw e;
    throw fail('Koneksi ke ' + lbl + ' terputus saat menulis: ' + (e.cause?.code || e.message), 'cut');
  }
  if (!out.trim()) throw fail('Model membalas kosong', 'empty');
  // selesai normal hanya jika ada alasan berhenti normal, atau [DONE] tanpa alasan apa pun; stream putus mendadak = terpotong
  job.truncated = job.finish ? !NORMAL.test(job.finish) : !job.sawDone;
  return cleanThink(out);
}
// Pembungkus viaRouterOnce: SATU kali percobaan ulang otomatis untuk
// koneksi basi 9router (brief Dzaky 21 Okt). Respons 9router memakai
// Keep-Alive timeout=5 detik; di Node 18 socket yang sudah ditutup server
// bisa dipakai ulang -> ECONNRESET / UND_ERR_SOCKET / "other side closed"
// / EPIPE acak, padahal routernya sehat. Ulangi dari koneksi segar HANYA
// bila: errornya cocok pola basi, job belum diabort user, dan belum ada
// hasil sebagian (job.partial kosong) — perilaku "lanjutkan yang
// terpotong" tidak berubah.
async function viaRouter(model, msgs, job, which) {
  const staleErr = e => /ECONNRESET|UND_ERR_SOCKET|EPIPE|other side closed/i.test(String((e && e.message) || e || '') + ' ' + String((e && e.cause && e.cause.code) || (e && e.code) || ''));
  for (let att = 0; ; att++) {
    try { return await viaRouterOnce(model, msgs, job, which); }
    catch (e) {
      if (att > 0 || job.ctrl.signal.aborted || (job.partial || '').trim() || !staleErr(e)) throw e;
    }
  }
}
// Pekerjaan berjalan di latar; browser polling (aman dari batas 100 detik Cloudflare)
const jobs = new Map();
const forgotHits = new Map(); // ip -> [timestamp] — maks 5 permintaan/jam per IP (lupa password)
setInterval(() => { for (const [k, v] of jobs) if (Date.now() - v.ts > 60 * 60 * 1000) jobs.delete(k); }, 60 * 1000).unref();
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
tts = require('./tts')({ E, R, rh, send });
/* ===== Auto Clipper: analisis link YouTube -> kandidat klip -> render 9:16 =====
   Semua endpoint di balik auth yang sama (berada setelah cek authed di atas).
   Alur: analyze (download + transkrip + AI) -> pilih kandidat -> render (ffmpeg) -> download.
   Video sumber + file temp auto-dihapus setelah klip pertama di-download; tombol Hapus Semua
   membersihkan seluruh folder kerja user. Folder kerja: CLIPPER_WORK_DIR (default /opt/docker/clipper-work). */
/* ===== Notifikasi Telegram (Auto Clipper saja) =====
   Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (lihat .env.example).
   Kalau salah satu kosong -> notif NONAKTIF total (diam, tanpa error,
   pipeline jalan normal). TELEGRAM_API_BASE hanya untuk tes (mock lokal);
   default api.telegram.org.
   Fire-and-forget: sendTelegram tidak pernah throw dan tidak pernah block
   pipeline — semua error ditangkap, dicatat satu baris console saja.
   Plain text (tanpa parse_mode) supaya judul berkarakter <>& aman. */
const TELEGRAM_BOT_TOKEN = (E.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (E.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_API_BASE = (E.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const TELEGRAM_ENABLED = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
async function sendTelegram(text) {
  if (!TELEGRAM_ENABLED) return;
  try {
    const r = await fetch(TELEGRAM_API_BASE + '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: String(text).slice(0, 4096) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.log('[telegram] gagal kirim (HTTP ' + r.status + ')');
  } catch (e) {
    console.log('[telegram] gagal kirim: ' + (e && e.message ? e.message : String(e)).slice(0, 200));
  }
}
// Satu-satunya pintu notif Clipper (biar jelas: hanya job Clipper yang notif).
const clipNotify = (job, text) => { if (job) sendTelegram(text); };
const clipFmtDur = s => { s = Math.max(0, Math.round(+s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const clipTrunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; };
// Nama file cache video POLOS. Kuncinya index + mode + [start, end] kandidat
// (centidetik, integer — stabil & aman di nama file). SEBELUMNYA hanya
// index + mode, sehingga kandidat baru 30 detik memakai cache polos dari
// run lama yang 15 detik (file klip 15 detik padahal metadata 30 detik).
// Cache lama (tanpa start_end) tidak terpakai lagi — dibiarkan saja, tidak dihapus.
const clipPlainFileName = (index, modeKey, start, end) => {
  const cs = v => Math.max(0, Math.round((Number.isFinite(+v) ? +v : 0) * 100));
  return 'clip_' + index + '_plain_' + modeKey + '_' + cs(start) + '_' + cs(end) + '.mp4';
};
function clipNotifyFail(job) {
  if (!job || job.cancelled) return;
  let reason = clipTrunc(job.error || 'Tidak diketahui', 120).replace(/\.+$/, '');
  if (!reason) reason = 'Tidak diketahui';
  sendTelegram('❌ Gagal: ' + reason + '.');
}
function clipRenderDoneText(job, done, opts) {
  const raw = opts && opts.raw ? ' (RAW)' : '';
  let text = '🎬 Video sudah jadi!' + raw + ' ' + done.length + ' klip:';
  for (const r of done) {
    const cand = (job.candidates || []).find(c => c.index === r.index);
    const line = '\n• Klip ' + (r.index + 1) + ' — dari ' + clipFmtDur(cand ? cand.start : 0) + ' — ' + clipTrunc(r.title || (cand && cand.title) || '(tanpa judul)', 60);
    if ((text + line).length > 3500) { text += '\n…'; break; }
    text += line;
  }
  return text;
}
/* ===== Transkrip via Groq (Auto Clipper, opsional) =====
   Env: GROQ_API_KEY (lihat .env.example). Kalau kosong -> opsi Groq NONAKTIF,
   server fallback ke Whisper lokal. GROQ_API_BASE hanya untuk tes (mock lokal);
   default api.groq.com.
   Groq = API OpenAI-compatible (whisper-large-v3-turbo, GPU cloud) — jauh lebih
   cepat dari whisper-cli CPU lokal (video 57 menit ~1-2 menit vs ~104 menit).
   Batas Groq: file audio maks 25MB -> kompres ke mp3 48kbps mono + split per
   ~10 menit bila masih >24MB. Gagal (jaringan/429/401/respons invalid) ->
   fallback ke Whisper lokal; job TIDAK gagal hanya karena Groq bermasalah.
   Selalu kompres/split dulu — JANGAN kirim WAV mentah (110MB untuk 57 menit). */
const GROQ_API_KEY = (E.GROQ_API_KEY || '').trim();
const GROQ_API_BASE = (E.GROQ_API_BASE || 'https://api.groq.com').replace(/\/+$/, '');
const GROQ_ENABLED = !!GROQ_API_KEY;
// === AI B-ROLL (upload manual — Pexels DIBATALKAN) ===
// Pexels menghentikan penerbitan API key baru ("New API key issuance is
// currently paused") sehingga user tidak bisa dapat PEXELS_API_KEY. Sumber
// B-roll diganti UPLOAD MANUAL: user upload file video B-roll sendiri
// (endpoint /api/clipper/broll/upload), server simpan + sisipkan.
// B-roll OFF bila file belum di-upload — klip tetap render tanpa B-roll.
const GROQ_MODEL = 'whisper-large-v3-turbo';
const GROQ_MAX_BYTES = 24 * 1024 * 1024; // 24MB — di bawah batas 25MB Groq
const GROQ_CHUNK_SEC = 600; // 10 menit per chunk
const GROQ_REQ_TIMEOUT = 5 * 60 * 1000; // 5 menit per request
// Rencana chunk (murni, bisa dites tanpa ffmpeg/jaringan): durasi <= 0 atau
// file utuh muat -> 1 chunk utuh (dur 0 = tanpa -t, seluruh file).
// Kalau tidak muat -> potong per GROQ_CHUNK_SEC detik.
function clipGroqChunkPlan(duration, wholeSize) {
  const dur = Math.max(0, +duration || 0);
  if (!(dur > 0) || wholeSize <= GROQ_MAX_BYTES) return [{ start: 0, dur }];
  const out = [];
  for (let s = 0; s < dur; s += GROQ_CHUNK_SEC) out.push({ start: s, dur: Math.min(GROQ_CHUNK_SEC, dur - s) });
  return out;
}
// Parser respons Groq verbose_json (murni): segments + offset chunk -> segmen
// Clipper {start, end, text, words}. Bila respons membawa `words` (word
// timestamps dari `timestamp_granularities[]=word`), tiap kata dilampirkan ke
// segmen yang menaunginya (toleransi 0,05 dtk) -> karaoke memakai timestamp
// ASLI (bukan bagi-rata). Tanpa words -> words: [] (bagi-rata seperti lokal).
function clipGroqParseSegments(data, offset) {
  const off = Math.max(0, +offset || 0);
  if (!data || !Array.isArray(data.segments)) return [];
  const rawWords = Array.isArray(data.words) ? data.words : [];
  const words = rawWords.map(w => ({
    text: String(w.word || w.text || '').trim(),
    start: Math.round(((+w.start || 0) + off) * 100) / 100,
    end: Math.round(((+w.end || 0) + off) * 100) / 100,
  })).filter(w => w.text && w.end > w.start);
  const out = [];
  for (const s of data.segments) {
    const start = Math.round(((+s.start || 0) + off) * 100) / 100;
    const end = Math.round(((+s.end || 0) + off) * 100) / 100;
    const text = String(s.text || '').trim();
    if (text && end > start) {
      const segWords = words.filter(w => w.start >= start - 0.05 && w.end <= end + 0.05);
      out.push({ start, end, text, words: segWords });
    }
  }
  return out;
}
// Kompres audio ke mp3 48kbps mono 16kHz (biar muat batas 25MB Groq).
async function clipGroqCompress(input, start, dur, outPath, job) {
  const args = [];
  if (start > 0) args.push('-ss', String(start));
  if (dur > 0) args.push('-t', String(dur));
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3', '-y', outPath);
  const p = await clipRun('ffmpeg', args, { timeout: 180000, signal: job && job.abortCtrl ? job.abortCtrl.signal : undefined });
  if (p.code !== 0) throw new Error('ffmpeg kompres Groq gagal: ' + (p.stderr || '').replace(/\s+/g, ' ').slice(-200));
  if (!fs.existsSync(outPath)) throw new Error('ffmpeg kompres Groq: file tidak terbentuk');
}
// Bahasa transkrip yang dipaksa ('id'/'en') atau null = auto-detect.
// Dipakai Groq (param `language`) + Whisper lokal (`-l`). Tanpa nilai / 'auto'
// -> perilaku lama (auto-detect — bisa jadi Inggris bila Whisper salah tebak).
function clipTranscriptLang(job) { const l = job && job.transcriptLang; return (l === 'id' || l === 'en') ? l : null; }
// Normalisasi bahasa transkrip dari Groq/Whisper ('Indonesian'/'indonesian'/
// 'id'/'in' -> 'id'; 'English'/'english'/'en' -> 'en'; lain -> null).
function clipNormTranscriptLang(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'id' || s === 'in' || s === 'indonesian' || s === 'indonesia' || s === 'bahasa indonesia') return 'id';
  if (s === 'en' || s === 'english' || s === 'inggris') return 'en';
  return null;
}
// Satu request transkrip ke Groq (multipart). Throw bila HTTP != 2xx / respons invalid.
// Word timestamps: minta `timestamp_granularities[]` = word + segment (karaoke
// akurat, bukan bagi-rata). Bila API menolak granularity (400 / error menyebut
// granularity) -> ulangi sekali TANPA granularity (jangan gagalkan transkrip).
async function clipGroqTranscribeFile(mp3Path, job) {
  const buf = fs.readFileSync(mp3Path);
  const buildForm = (withGranularity) => {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'verbose_json');
    // Bahasa transkrip dipaksa (id/en) — tanpa param = auto-detect (perilaku lama).
    const lang = clipTranscriptLang(job);
    if (lang) form.append('language', lang);
    if (withGranularity) {
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
    }
    return form;
  };
  // Timeout + Stop digabung manual (AbortSignal.any butuh Node 20.3+; Pi jalan Node 18).
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error('Groq timeout')), GROQ_REQ_TIMEOUT);
  const sig = job && job.abortCtrl ? job.abortCtrl.signal : null;
  const onAbort = () => ctrl.abort(new Error('Dibatalkan oleh pengguna'));
  if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener('abort', onAbort, { once: true }); }
  let r;
  try {
    r = await fetch(GROQ_API_BASE + '/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_API_KEY }, body: buildForm(true), signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      // API menolak granularity -> retry sekali tanpa granularity.
      if (/granular/i.test(txt) || /timestamp_granularities/i.test(txt)) {
        r = await fetch(GROQ_API_BASE + '/openai/v1/audio/transcriptions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_API_KEY }, body: buildForm(false), signal: ctrl.signal,
        });
        if (!r.ok) {
          const txt2 = await r.text().catch(() => '');
          throw new Error('Groq HTTP ' + r.status + (txt2 ? ': ' + txt2.replace(/\s+/g, ' ').slice(0, 200) : ''));
        }
      } else {
        throw new Error('Groq HTTP ' + r.status + (txt ? ': ' + txt.replace(/\s+/g, ' ').slice(0, 200) : ''));
      }
    }
  } finally { clearTimeout(to); if (sig) sig.removeEventListener('abort', onAbort); }
  let data;
  try { data = await r.json(); } catch { throw new Error('Groq: respons bukan JSON'); }
  if (!data || !Array.isArray(data.segments)) throw new Error('Groq: respons tanpa segments');
  return data;
}
// Transkrip full via Groq: kompres utuh -> bila >24MB split per 10 menit ->
// transkrip per chunk -> gabung segmen dengan offset waktu yang benar.
// Throw bila Groq gagal (pemanggil fallback ke Whisper lokal) / dibatalkan.
async function clipTranscribeGroq(file, job) {
  if (!GROQ_ENABLED) throw new Error('Groq belum di-set (GROQ_API_KEY kosong)');
  const dur = (job && job.duration > 0) ? job.duration : await clipProbeDuration(file);
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-'));
  try {
    const whole = path.join(td, 'whole.mp3');
    await clipGroqCompress(file, 0, dur, whole, job);
    const wholeSize = fs.statSync(whole).size;
    const plan = clipGroqChunkPlan(dur, wholeSize);
    const segments = []; let language = '';
    for (let i = 0; i < plan.length; i++) {
      if (job && job.cancelled) throw new Error('Dibatalkan oleh pengguna');
      let mp3;
      if (plan.length === 1 && plan[0].start === 0) {
        mp3 = whole;
      } else {
        mp3 = path.join(td, 'chunk' + i + '.mp3');
        await clipGroqCompress(file, plan[i].start, plan[i].dur, mp3, job);
      }
      const data = await clipGroqTranscribeFile(mp3, job);
      if (!language && data.language) language = data.language;
      segments.push(...clipGroqParseSegments(data, plan[i].start));
    }
    if (!segments.some(s => s.words && s.words.length)) clipLog(job, 'Groq tanpa word timestamps — pakai bagi-rata.');
    return { segments, language };
  } finally {
    try { fs.rmSync(td, { recursive: true, force: true }); } catch {}
  }
}
const CLIPPER_DIR = E.CLIPPER_WORK_DIR || '/opt/docker/clipper-work';
const clipperJobs = new Map();
setInterval(() => { for (const [k, v] of clipperJobs) if (Date.now() - v.ts > 24 * 3600 * 1000) clipperJobs.delete(k); }, 60 * 1000).unref();
const clipUserDir = user => path.join(CLIPPER_DIR, encodeURIComponent(user));
// Folder font untuk filter subtitles (libass). Harus berisi file Montserrat —
// kalau tidak, libass fallback ke DejaVu dan subtitle tidak seperti Klipaja.
// Cari folder PERTAMA yang benar-benar berisi file Montserrat (bukan sekadar
// ada): public/fonts (repo, hanya DejaVu/Liberation) -> ../fonts (PC:
// D:\hermes-vo\fonts) -> %WINDIR%\Fonts (Windows, Montserrat ter-install) ->
// ~/.fonts (Pi: /root/.fonts). Kalau tidak ada yang berisi Montserrat,
// kembalikan public/fonts (perilaku lama).
// `cands` opsional untuk tes (suntikkan folder sementara berisi Montserrat palsu).
const clipFontsDir = (cands) => {
  const list = Array.isArray(cands) ? cands : [path.join(__dirname, 'public', 'fonts'), path.join(__dirname, '..', 'fonts')];
  if (!Array.isArray(cands)) {
    try { if (process.env.WINDIR) list.push(path.join(process.env.WINDIR, 'Fonts')); } catch {}
    try { list.push(path.join(os.homedir(), '.fonts')); } catch {}
  }
  for (const d of list) {
    try {
      if (d && fs.existsSync(d) && fs.readdirSync(d).some(f => /^Montserrat[-_].*\.ttf$/i.test(f) || /^Montserrat\.ttf$/i.test(f))) return d;
    } catch {}
  }
  return path.join(__dirname, 'public', 'fonts');
};
const clipFontFile = (italic, bold, fontName) => {
  // Font judul: DejaVu Sans (default) atau Liberation Sans (hanya ada file BoldItalic).
  // Selalu dari public/fonts repo (DejaVu/Liberation ada di sana), bukan dari
  // clipFontsDir() yang bisa menunjuk ke folder sistem tanpa file-file ini.
  // (fontFile saat ini tidak dipakai render — judul/CTA lewat .ass — tapi
  // tetap kembalikan path yang valid bila suatu saat dipakai.)
  const repoFonts = path.join(__dirname, 'public', 'fonts');
  if (fontName === 'Liberation Sans') return path.join(repoFonts, 'LiberationSans-BoldItalic.ttf');
  return path.join(repoFonts, italic ? 'LiberationSans-BoldItalic.ttf' : (bold === false ? 'DejaVuSans.ttf' : 'DejaVuSans-Bold.ttf'));
};
// Path file B-roll ter-upload untuk satu klip: clipper-work/broll/<jobId>-<idx>.mp4
// (+ sidecar .json berisi nama asli + ukuran + waktu upload, untuk UI).
function clipBrollPath(jobId, clipIdx) {
  return path.join(CLIPPER_DIR, 'broll', String(jobId) + '-' + String(clipIdx) + '.mp4');
}
// Path file Musik Latar ter-upload untuk satu klip:
// clipper-work/music/<jobId>-<idx>.<ext> (+ sidecar .json). Ekstensi = sesuai
// upload (mp3/m4a/wav/ogg/flac/aac) — cari file yang ada; kalau belum ada,
// kembalikan path default .mp3 (untuk upload pertama).
function clipMusicPath(jobId, clipIdx) {
  const dir = path.join(CLIPPER_DIR, 'music');
  const base = String(jobId) + '-' + String(clipIdx);
  for (const ext of ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']) {
    const p = path.join(dir, base + '.' + ext);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, base + '.mp3');
}
// (clipProbeDuration sudah ada di bawah — dipakai hitung loop B-roll;
// return 0 bila gagal, caller pakai fallback loop 1000.)
// Parse body multipart/form-data (satu field file). Return
// {field, filename, contentType, data: Buffer} atau null (tidak ketemu /
// bukan multipart). Dipakai endpoint upload B-roll (tanpa dependensi multer).
// Batas ukuran dicek caller SELAMA baca body (sebelum parse penuh).
function clipParseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(contentType || ''));
  const boundary = (m && (m[1] || m[2] || '').trim());
  if (!boundary || !Buffer.isBuffer(body)) return null;
  const delim = Buffer.from('--' + boundary);
  let start = body.indexOf(delim);
  while (start !== -1) {
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = body.slice(start + delim.length, headEnd).toString('utf8');
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    let next = body.indexOf(delim, headEnd + 4);
    if (next === -1) break;
    // Akhir part = \r\n sebelum delimiter berikutnya.
    let dataEnd = next;
    if (body[next - 2] === 13 && body[next - 1] === 10) dataEnd = next - 2;
    const data = body.slice(headEnd + 4, dataEnd);
    if (fileM) {
      const ctM = /content-type:\s*([^\r\n]+)/i.exec(head);
      return { field: nameM ? nameM[1] : '', filename: fileM[1], contentType: (ctM ? ctM[1].trim() : ''), data };
    }
    start = next;
  }
  return null;
}
// Jam log = WAKTU LOKAL SERVER (bukan UTC). Di PC live (WIB) log tampil
// sesuai jam PC; di VM (UTC) tampil sesuai jam VM. Dulu pakai toISOString
// (UTC) sehingga di PC log ketinggalan 7 jam dari jam server.
const clipLogTime = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
const clipLog = (job, msg) => { job.log.push({ t: clipLogTime(), msg: String(msg).slice(0, 500) }); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); clipSaveJob(job); };
// Persistensi proyek Clipper (seperti /api/state Agent Script): tiap job punya
// folder sendiri + job.json, jadi refresh browser / restart server / ganti device
// (akun sama) tidak menghilangkan proyek — hanya hapus manual yang menghapus.
function clipSaveJob(job) {
  try {
    if (!job || !job.dir) return;
    fs.mkdirSync(job.dir, { recursive: true });
    const data = { id: job.id, user: job.user, ts: job.ts, status: job.status, phase: job.phase,
      progress: job.progress, error: job.error, log: job.log, candidates: job.candidates,
      renders: job.renders, cues: job.cues, videoTitle: job.videoTitle, duration: job.duration,
      dir: job.dir, source: job.source, sourceReady: job.sourceReady, sourceUrl: job.sourceUrl,
      metaDesc: job.metaDesc, metaUploader: job.metaUploader, speakers: job.speakers, sourceCleaned: job.sourceCleaned,
      downloadPct: job.downloadPct, transcribeVia: job.transcribeVia, transcriptLang: job.transcriptLang };
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(data));
  } catch {}
}
function clipRestoreJobs() {
  try {
    if (!fs.existsSync(CLIPPER_DIR)) return;
    for (const userDir of fs.readdirSync(CLIPPER_DIR, { withFileTypes: true })) {
      if (!userDir.isDirectory()) continue;
      const userPath = path.join(CLIPPER_DIR, userDir.name);
      for (const jobDir of fs.readdirSync(userPath, { withFileTypes: true })) {
        if (!jobDir.isDirectory()) continue;
        const file = path.join(userPath, jobDir.name, 'job.json');
        if (!fs.existsSync(file)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!data || !data.id || clipperJobs.has(data.id)) continue;
          const job = { ...data, cancelled: false, abortCtrl: new AbortController(), aiCtrl: null };
          // Proses yang sedang jalan saat server mati tidak bisa dilanjutkan —
          // tandai error, video tetap tersimpan kalau sudah tersimpan.
          if (job.status === 'running' || job.status === 'rendering') {
            job.status = 'error'; job.error = 'Server restart saat proses jalan — klik Analisis lagi (video tetap tersimpan kalau sudah tersimpan).';
            job.log.push({ t: clipLogTime(), msg: 'Server restart — proses terputus.' });
          }
          // Source hilang dari disk (dihapus manual) -> jangan klaim tersimpan.
          if (job.sourceReady && (!job.source || !fs.existsSync(job.source))) { job.sourceReady = false; job.source = null; }
          clipperJobs.set(job.id, job);
        } catch {}
      }
    }
  } catch {}
}
const clipRun = (cmd, args, opts) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { ...(opts || {}), shell: false });
  // Cap stdout: default 400KB, tapi -J yt-dlp bisa >600KB (banyak format) -> kalau
  // dipotong dari depan, JSON.parse gagal dan durasi "tidak terbaca". Panggil -J
  // dengan maxOut besar (5MB) supaya JSON-nya utuh.
  const maxOut = (opts && opts.maxOut) || 400000;
  let err = '', out = '';
  child.stdout.on('data', d => { out += d.toString(); if (out.length > maxOut) out = out.slice(-maxOut); if (opts && opts.onStdout) opts.onStdout(d.toString()); });
  child.stderr.on('data', d => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); if (opts && opts.onStderr) opts.onStderr(d.toString()); });
  child.on('error', reject);
  const to = opts && opts.timeout ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(fail('Proses ' + cmd + ' terlalu lama', 'timeout')); }, opts.timeout) : null;
  // Abort via signal (tombol Stop): bunuh proses anak + tolak dengan AbortError.
  const onAbort = () => { try { child.kill('SIGKILL'); } catch {} const e = new Error('Dibatalkan oleh pengguna'); e.name = 'AbortError'; reject(e); };
  if (opts && opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  child.on('close', code => { if (to) clearTimeout(to); if (opts && opts.signal) opts.signal.removeEventListener('abort', onAbort); resolve({ code, stdout: out, stderr: err }); });
});
const clipRm = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const clipPublic = job => ({
  id: job.id, status: job.status, phase: job.phase, progress: job.progress, downloadPct: job.downloadPct || 0, error: job.error || null,
  sourceReady: !!job.sourceReady, transcribeVia: job.transcribeVia || 'local',
  sourceHeight: job.sourceHeight || 0, sourceUrl: job.sourceUrl || null,
  videoTitle: job.videoTitle, metaUploader: job.metaUploader || '', duration: job.duration, log: job.log, candidates: job.candidates,
  cues: job.cues || [],
  renders: job.renders.map(r => ({ index: r.index, title: r.title, status: r.status, size: r.size || 0, plainSize: r.plainSize || 0, raw: !!r.raw, thumb: !!r.thumb, autoThumb: !!r.autoThumb, cover: !!r.cover || fs.existsSync(path.join(job.dir, 'cover_' + r.index + '.jpg')), error: r.error || null, hash: r.hash || null, assFile: r.assFile || null })), // cover: file di disk = sumber kebenaran (flag rec.cover bisa hilang saat render ulang membuat record baru)
});
// Tahap 1 — Input YouTube: ambil info (-J) + download video ke server, lalu tandai
// sourceReady. Dipanggil endpoint /api/clipper/input. Video cuma disimpan sekali;
// analisis (tahap 2) memakai file ini tanpa download ulang.
// Cookies YouTube (yt-dlp): YouTube kini minta login untuk sebagian video
// (bot-check / video butuh auth) -> yt-dlp tanpa cookies gagal "Sign in to
// confirm you're not a bot". Kalau file cookies ada (export dari browser yang
// login YouTube, format Netscape cookies.txt), yt-dlp pakai itu.
// Path: .env YT_COOKIES_FILE, default /opt/hermes-vo/cookies.txt. File ini
// TIDAK boleh di-push GitHub / ditempel chat (isi session login YouTube).
// Dicek per pemanggilan (file baru langsung kepakai tanpa restart).
function clipYtCookies() {
  const f = String(E.YT_COOKIES_FILE || '/opt/hermes-vo/cookies.txt').trim();
  try { return f && fs.existsSync(f) ? ['--cookies', f] : []; } catch { return []; }
}
// Rantai fallback klien yt-dlp Clipper (info + download + heatmap).
// YouTube kini minta PO token (Proof of Origin) untuk klien web — cookies
// saja tidak cukup — sehingga klien web gagal "The page needs to be reloaded"
// walau cookies.txt lengkap + masih berlaku. Klien iOS
// (player_client=ios) TIDAK butuh PO token dan umumnya mengembalikan format
// HD (720p; 1080p untuk video non-DRM tertentu seperti podcast).
// Urutan percobaan info (maks 6):
//   1-2. web (retry 1x) — format terbaik bila lolos bot-check
//   3. iOS (cookies) — tanpa PO token, peluang HD paling besar
//   4. Android (cookies)
//   5. iOS TANPA cookies (cookies basi / akun tidak cocok justru ditolak
//      YouTube padahal videonya PUBLIK — tanpa cookies malah jalan)
//   6. Android TANPA cookies (jaring terakhir, sering hanya 360p).
// Download memakai 5 percobaan (tanpa web retry — loop luar sudah retry 1x
// download ulang). Tiap percobaan timeout 120 detik (info) / 30 menit
// (download). Gagal semua -> error JELAS (cookies basi), bukan
// "Proses yt-dlp terlalu lama" saja.
const CLIP_YT_INFO_ATTEMPTS = [
  { client: 'web', label: 'web', cookies: true },
  { client: 'web', label: 'web (ulangi)', cookies: true },
  { client: 'ios', label: 'iOS (cookies)', cookies: true },
  { client: 'android', label: 'Android (cookies)', cookies: true },
  { client: 'ios', label: 'iOS (tanpa cookies)', cookies: false },
  { client: 'android', label: 'Android (tanpa cookies)', cookies: false },
];
const CLIP_YT_DL_ATTEMPTS = [
  { client: 'web', label: 'web', cookies: true },
  { client: 'ios', label: 'iOS (cookies)', cookies: true },
  { client: 'android', label: 'Android (cookies)', cookies: true },
  { client: 'ios', label: 'iOS (tanpa cookies)', cookies: false },
  { client: 'android', label: 'Android (tanpa cookies)', cookies: false },
];
// Argumen yt-dlp untuk satu percobaan: extractor-args per klien +
// cookies bila percobaan memakai cookies. Murni (bisa dites).
function clipYtClientArgs(a) {
  return {
    extra: a.client === 'web' ? [] : ['--extractor-args', 'youtube:player_client=' + a.client],
    cookies: a.cookies ? clipYtCookies() : [],
  };
}
// Rencana percobaan: salinan attempts dengan cookies ter-resolve di
// `resolvedCookies` (array argumen `--cookies <file>` / [] bila tidak ada
// file cookies / percobaan tanpa cookies).
function clipYtPlan(attempts) {
  return attempts.map(a => ({ ...a, resolvedCookies: a.cookies ? clipYtCookies() : [] }));
}
// Fetch info YouTube (yt-dlp -J) dengan fallback klien + retry (lihat
// CLIP_YT_INFO_ATTEMPTS). Setiap percobaan di-log: nama klien + cookies /
// tanpa cookies + hasil. Sukses -> log label + format maks dari -J.
async function clipFetchYoutubeInfo(job, url) {
  let lastErr = '';
  for (const a of clipYtPlan(CLIP_YT_INFO_ATTEMPTS)) {
    if (job.cancelled) return null;
    if (a.label === 'web') clipLog(job, 'Info YouTube (web)…');
    else clipLog(job, 'Info YouTube (' + a.label + ') — coba lagi…');
    const { extra } = clipYtClientArgs(a);
    const cookies = a.resolvedCookies || [];
    let info;
    try {
      info = await clipRun('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', ...extra, ...cookies, url], { timeout: 120000, maxOut: 5000000, signal: job.abortCtrl.signal });
    } catch (e) {
      if (job.cancelled || e.name === 'AbortError') throw e;
      lastErr = (e.message || 'timeout').replace(/\s+/g, ' ').slice(-300);
      clipLog(job, 'Info YouTube (' + a.label + ') gagal: ' + lastErr);
      continue;
    }
    if (info.code === 0) {
      let maxH = 0;
      try { const m = JSON.parse(info.stdout || ''); for (const f of (m.formats || [])) maxH = Math.max(maxH, +f.height || 0); } catch {}
      clipLog(job, 'Info berhasil (' + a.label + ')' + (maxH ? ' — format maks ' + maxH + 'p.' : '.'));
      return info;
    }
    lastErr = (info.stderr || '').replace(/\s+/g, ' ').slice(-300);
    clipLog(job, 'Info YouTube (' + a.label + ') gagal: ' + lastErr);
  }
  throw fail('YouTube lambat / cookies basi — refresh cookies.txt di PC lalu Coba Lagi. (yt-dlp info: ' + lastErr + ')', 'yt-dlp');
}
async function clipInputYoutube(job, url) {
  const dir = job.dir;
  try {
    job.phase = 'info'; clipLog(job, 'Mengambil info video…');
    const info = await clipFetchYoutubeInfo(job, url);
    if (job.cancelled) return;
    if (!info || info.code !== 0) throw fail('YouTube lambat / cookies basi — refresh cookies.txt di PC lalu Coba Lagi.', 'yt-dlp');
    let meta = {};
    try { meta = JSON.parse(info.stdout || ''); } catch {}
    job.videoTitle = meta.title || 'Video YouTube';
    job.duration = +meta.duration || 0;
    job.metaDesc = String(meta.description || '');
    job.metaUploader = String(meta.uploader || '');
    if (!(job.duration > 0)) throw fail('Durasi video tidak terbaca (video live / belum tayang?).', 'input');
    job.phase = 'download'; job.downloadPct = 0; clipLog(job, 'Mengunduh video (maks 720p)…');
    const src = path.join(dir, 'source.mp4');
    // Progress download yt-dlp: baca baris "[download] 45.2%" dari stdout/stderr, petakan ke bar 10-40% + log berkala tiap 25%.
    let dlLogPct = -1;
    const onDl = s => { const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(s); if (m) { job.downloadPct = +m[1]; job.progress = 10 + job.downloadPct * 0.3; const q = Math.floor(job.downloadPct / 25) * 25; if (q > dlLogPct && q > 0) { dlLogPct = q; clipLog(job, 'Mengunduh… ' + q + '%'); } } };
    // Download bisa terpotong diam-diam (file tersimpan tapi durasinya lebih pendek
    // dari info video — misal cuma 900 detik dari video yang lebih panjang).
    // Verifikasi durasi file hasil download; kalau terpotong, download ulang sekali;
    // kalau masih terpotong, gagalkan dengan pesan jelas (jangan tandai ready).
    let savedDur = 0;
    let dlClient = ''; // label klien yt-dlp yang berhasil download (untuk log resolusi)
    for (let dlTry = 0; dlTry < 2; dlTry++) {
      // Rantai fallback klien download (lihat CLIP_YT_DL_ATTEMPTS):
      // web -> iOS (cookies) -> Android (cookies) -> iOS tanpa cookies ->
      // Android tanpa cookies. Setiap percobaan di-log (klien + cookies +
      // hasil). dlArgsBase TANPA cookies; cookies ditambahkan per percobaan.
      // Percobaan berikutnya jalan pada kegagalan apa pun (bukan hanya
      // reload/auth) — klien lain sering lolos walau klien sebelumnya gagal
      // karena alasan berbeda (mis. format tidak tersedia di klien itu).
      const dlArgsBase = ['--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '3', '--concurrent-fragments', '4',
        '--max-filesize', '2000M',
        // YouTube kini hanya sediakan stream video+audio terpisah (DASH) untuk kebanyakan video:
        // 'best' (format gabungan) sering tidak ada -> pakai bv+ba (gabung via ffmpeg) + remux ke mp4.
        // Utamakan H.264 (avc1): ffmpeg minimal di server kadang tidak punya decoder
        // VP9/AV1 ("Error while decoding stream ... Function not implemented"), tapi
        // H.264 hampir selalu bisa di-decode. Urutan: DASH H.264 dulu, lalu H.264
        // gabungan (itag 22/18, selalu bisa di-decode), BARU DASH format lain (VP9/AV1).
        // Jangan sampai DASH VP9/AV1 dipilih padahal ada H.264 gabungan yang bisa di-decode.
        // Cap 1080p (bukan 720p): crop Podcast dari sumber 1080p jauh lebih
        // tajam (tidak di-upscale 1,78x seperti dari 720p). Output tetap 720x1280.
        '-f', 'bv[height<=1080][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][ext=mp4][vcodec^=avc1]/bv[height<=1080][ext=mp4]+ba[ext=m4a]/bv[height<=1080]+ba/b[height<=1080]',
        '--remux-video', 'mp4',
        '-o', src, url];
      const dlOpts = { timeout: 30 * 60 * 1000, onStdout: onDl, onStderr: onDl, signal: job.abortCtrl.signal };
      // Timeout clipRun = reject (bukan code != 0) — tangkap jadi hasil gagal
      // supaya retry download jalan (bukan langsung throw "terlalu lama").
      const runDl = async (args) => { try { return await clipRun('yt-dlp', args, dlOpts); } catch (e) { if (job.cancelled || e.name === 'AbortError') throw e; return { code: -1, stdout: '', stderr: e.message || 'timeout' }; } };
      let dl = null; dlClient = '';
      for (const a of clipYtPlan(CLIP_YT_DL_ATTEMPTS)) {
        if (job.cancelled) return;
        const { extra } = clipYtClientArgs(a);
        if (dl !== null) clipLog(job, 'Download (' + a.label + ') — coba lagi…');
        dl = await runDl([...extra, ...dlArgsBase, ...(a.resolvedCookies || [])]);
        if (dl.code === 0) { dlClient = a.label; break; }
        clipLog(job, 'Download (' + a.label + ') gagal: ' + (dl.stderr || '').replace(/\s+/g, ' ').slice(-300));
      }
      if (job.cancelled) return;
      // Gagal setelah semua fallback dalam percobaan ini -> retry 1x
      // (download ulang proyek yang SAMA, tanpa buat proyek baru); bila
      // percobaan ke-2 juga gagal -> error JELAS (cookies basi).
      if (dl.code !== 0 || !fs.existsSync(src)) {
        const dlErr = (dl.stderr || '').replace(/\s+/g, ' ').slice(-300);
        clipLog(job, 'Download gagal (percobaan ' + (dlTry + 1) + '/2): ' + dlErr);
        if (dlTry === 0) { try { fs.unlinkSync(src); } catch {} continue; }
        throw fail('YouTube lambat / cookies basi — refresh cookies.txt di PC lalu Coba Lagi. (download: ' + dlErr + ')', 'download');
      }
      savedDur = await clipProbeDuration(src);
      if (savedDur >= job.duration * 0.95) break;
      clipLog(job, 'Video terpotong (tersimpan ' + Math.round(savedDur) + ' detik dari ' + Math.round(job.duration) + ' detik)' + (dlTry === 0 ? ', mencoba download ulang…' : '.'));
      try { fs.unlinkSync(src); } catch {}
    }
    if (savedDur < job.duration * 0.95) throw fail('Video terpotong: tersimpan ' + Math.round(savedDur) + ' detik dari ' + Math.round(job.duration) + ' detik. Klik 🔄 Coba Lagi.', 'download');
    // Durasi FILE (ffprobe) jadi acuan — kalau info -J ternyata lebih pendek dari
    // file aslinya, analisis harus mencakup seluruh file, bukan cuma durasi -J.
    if (savedDur > 0) job.duration = savedDur;
    // Warning dini: kalau codec sumber bukan H.264, ffmpeg minimal mungkin tidak
    // bisa decode (render akan gagal "Error while decoding stream").
    const srcCodec = await clipProbeCodec(src);
    if (srcCodec && srcCodec !== 'h264') clipLog(job, 'Perhatian: video sumber codec ' + srcCodec.toUpperCase() + ' (bukan H.264) — ffmpeg server mungkin tidak bisa decode. Jika render gagal, coba video lain / install ffmpeg yang lebih lengkap.');
    // Peringatan resolusi rendah: sumber <720p (biasanya cookies YouTube basi
    // -> bot-check -> hanya 360p) = hasil tidak HD. Bukan error — download
    // tetap jalan, tapi user diberitahu cara memperbaikinya (refresh cookies).
    job.sourceHeight = await clipProbeHeight(src);
    if (dlClient && job.sourceHeight > 0) clipLog(job, 'Download berhasil (klien ' + dlClient + ') — sumber ' + job.sourceHeight + 'p.');
    const lowRes = clipLowResWarning(job.sourceHeight);
    if (lowRes) clipLog(job, 'Perhatian: ' + lowRes);
    if (job.cancelled) return;
    const sizeMB = (fs.statSync(src).size / 1048576).toFixed(1);
    job.source = src; job.sourceReady = true;
    job.phase = 'input-done'; job.progress = 100; job.status = 'ready';
    clipLog(job, 'Video tersimpan di server (' + sizeMB + ' MB, durasi ' + Math.round(job.duration) + ' detik). Klik Analisis AI untuk mulai.');
    clipNotify(job, '✅ Video sudah ada di server (durasi ' + clipFmtDur(job.duration) + ') — lanjut transkrip…');
  } catch (e) {
    // Dihentikan via tombol Stop: endpoint stop sudah set status/error/log — jangan timpa.
    if (!job.cancelled) { job.status = 'error'; job.error = e.message || String(e); clipLog(job, 'Gagal: ' + job.error); clipNotifyFail(job); }
  }
}

// CPU (cross-platform, untuk /api/clipper/sysinfo): selisih 2 sampel
// os.cpus() (~100ms). os.loadavg() TIDAK bisa dipakai — di Windows selalu
// [0,0,0]. Cache 1 detik (poll cepat tidak menumpuk sampel).
let clipCpuCache = { at: 0, value: null, prev: null };
async function clipCpuPercent() {
  const now = Date.now();
  if (clipCpuCache.value !== null && now - clipCpuCache.at < 1000) return clipCpuCache.value;
  const sample = () => { let idle = 0, total = 0; for (const c of (os.cpus() || [])) { const t = c.times || {}; idle += t.idle || 0; total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0); } return { idle, total }; };
  const s1 = clipCpuCache.prev || sample();
  await new Promise(r => setTimeout(r, 100));
  const s2 = sample();
  const idleD = s2.idle - s1.idle, totalD = s2.total - s1.total;
  const v = totalD > 0 ? Math.round((1 - idleD / totalD) * 100) : 0;
  clipCpuCache = { at: Date.now(), value: Math.min(100, Math.max(0, v)), prev: s2 };
  return clipCpuCache.value;
}
// Ada stream audio? (ffprobe) — dipakai Tahap 2: filter hook (asplit/concat
// a=1) + sensor (volume [0:a]/[outa]) mereferensikan stream audio; bila
// video polos TANPA audio, ffmpeg gagal "Invalid argument" (matches no
// streams). Probe ini biar hook audio + sensor dimatikan SEBELUM render
// (bukan setelah gagal). Gagal probe -> anggap ADA audio (perilaku lama +
// retry fallback di clipRender yang menangani error tanpa audio).
async function clipProbeHasAudio(file) {
  try {
    const r = await clipRun('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { timeout: 30000 });
    return (r.stdout || '').trim().length > 0;
  } catch { return true; }
}
// Durasi file video upload via ffprobe (fallback: parse ffmpeg -i).
async function clipProbeDuration(file) {
  try {
    const p = await clipRun('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 60000 });
    const d = parseFloat((p.stdout || '').trim());
    if (d > 0) return d;
  } catch {}
  try {
    const p = await clipRun('ffmpeg', ['-i', file], { timeout: 60000 });
    const m = /Duration:\s*(\d+):(\d{2}):(\d{2})[.,](\d+)/.exec(p.stderr || '');
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
  } catch {}
  return 0;
}
// Thumbnail otomatis (gaya Klipaja: wajah TERANG + kartu judul + subtitle,
// diambil dari video FINAL — bukan frame pertama sumber yang bisa gelap).
// Pilih frame TERANG dari 3 kandidat (1,5 dtk / 30% / 50% durasi klip):
// tiap kandidat diekstrak 1 frame JPG, diukur kecerahannya via signalstats
// (YAVG), yang paling terang dipakai. videoFile = file Final / polos
// (offset 0) atau sumber (offset = cand.start). Return path thumb atau null.
// Gagal (video tidak ada / ffmpeg error) -> null (pemanggil tidak boleh
// gagalkan render hanya karena thumbnail).
// outName: nama file thumb (default clip_<idx>_thumb.jpg). Model Klipaja:
// editor = RAW + overlay HTML, jadi poster kartu Detail/editor HARUS dari
// RAW (tanpa teks ter-bake) -> outName 'clip_<idx>_thumb_raw.jpg'.
// thumb.jpg tetap Final-based setelah Tahap 2 (dipakai Library).
async function clipMakeThumb(job, sel, videoFile, offset, clipLen, outName) {
  const outPath = path.join(job.dir, outName || ('clip_' + sel.index + '_thumb.jpg'));
  try {
    if (!videoFile || !fs.existsSync(videoFile)) return null;
    const len = clipLen > 0 ? clipLen : (await clipProbeDuration(videoFile)) || 0;
    if (len <= 0) return null;
    const cands = [...new Set([1.5, len * 0.3, len * 0.5].map(t => Math.min(Math.max(0.1, t), Math.max(0.1, len - 0.1))))];
    let best = null;
    for (const t of cands) {
      const tmp = path.join(os.tmpdir(), 'clipthumb-' + job.id + '-' + sel.index + '-' + Math.round(t * 100) + '.jpg');
      try {
        const ex = await clipRun('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(offset + t), '-i', videoFile, '-frames:v', '1', '-q:v', '3', '-y', tmp], { timeout: 60000 });
        if (ex.code !== 0 || !fs.existsSync(tmp)) continue;
        // Kecerahan via ffprobe + signalstats (frame tags lavfi.signalstats.YAVG):
        // ffmpeg 8.x TIDAK lagi menulis YAVG ke log (signalstats hanya menempel
        // metadata frame) — parsing log stderr SELALU gagal (YAVG=0 untuk semua
        // kandidat -> frame pertama yang menang, bisa gelap). ffprobe membaca
        // tag-nya langsung. Path di-escape via ffmpegFilterPath (movie=...).
        const st = await clipRun('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', 'movie=' + clipperLib.ffmpegFilterPath(tmp) + ',signalstats', '-show_entries', 'frame_tags=lavfi.signalstats.YAVG', '-of', 'default=noprint_wrappers=1'], { timeout: 60000 });
        const m = /YAVG=([\d.]+)/.exec(st.stdout || '');
        const yavg = m ? parseFloat(m[1]) : 0;
        if (!best || yavg > best.yavg) {
          if (best) { try { fs.unlinkSync(best.file); } catch {} }
          best = { file: tmp, yavg };
        } else { try { fs.unlinkSync(tmp); } catch {} }
      } catch { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} }
    }
    if (!best) return null;
    try { fs.copyFileSync(best.file, outPath); } catch { return null; }
    try { fs.unlinkSync(best.file); } catch {}
    return outPath;
  } catch { return null; }
}
// Poster COVER per klip (Fase 2 — gaya ClipperStudio Smart Cover): frame
// dari video POLOS di detik pilihan user (cand.coverAt) + teks cover besar
// (clipperLib.buildCoverAss) dibakar via libass -> cover_<idx>.jpg di job.dir.
// Gagal -> null (tidak pernah menggagalkan render).
async function clipMakeCover(job, cand) {
  try {
    const rec = (job.renders || []).find(r => r.index === cand.index);
    const plain = rec && rec.plainFile ? path.join(job.dir, path.basename(rec.plainFile)) : null;
    const finalF = path.join(job.dir, 'clip_' + cand.index + '.mp4');
    const src = plain && fs.existsSync(plain) ? plain : (fs.existsSync(finalF) ? finalF : null);
    if (!src) return null;
    const len = Math.max(0.2, (cand.end || 0) - (cand.start || 0));
    let at = Math.min(Math.max(0, len - 0.1), Math.max(0, Number.isFinite(+cand.coverAt) ? +cand.coverAt : Math.min(2, len * 0.3)));
    // Frame TERBAIK (gaya Smart Cover ClipperStudio): bila user tidak
    // memilih frame sendiri dan ada track wajah, pakai detik dengan wajah
    // TERBESAR (sedang ngomong dapat bonus) — bukan asal detik awal, biar
    // poster tidak kena frame gelap / sisipan grafis tanpa orang.
    if (!Number.isFinite(+cand.coverAt)) {
      try {
        const tfb = path.join(job.dir, 'clip_' + cand.index + '_facetrack.json');
        if (fs.existsSync(tfb)) {
          const tdb = JSON.parse(fs.readFileSync(tfb, 'utf8'));
          let bt = null, bs = -1;
          for (const smp of tdb.track || []) {
            if (!smp || !Array.isArray(smp.faces) || !smp.faces.length) continue;
            const area = Math.max.apply(null, smp.faces.map(f => (+f.w || 0) * (+f.h || 0)));
            const sc = area * (smp.speaking ? 1.15 : 1);
            if (sc > bs) { bs = sc; bt = +smp.t || 0; }
          }
          if (bt !== null && Number.isFinite(bt)) at = Math.min(Math.max(0, len - 0.1), Math.max(0, bt));
        }
      } catch {}
    }
    const text = String(cand.coverText || cand.title || '').trim();
    if (!text) return null;
    const tmpFrame = path.join(os.tmpdir(), 'clipcover-' + job.id + '-' + cand.index + '.jpg');
    const assFile = path.join(job.dir, 'cover_' + cand.index + '.ass');
    // Posisi kotak cover (keputusan Dzaky 23 Okt): gaya Kartu di BAWAH,
    // tengah kotak mengikuti posisi subtitle klip (cand.subYPercent,
    // bawaan 65%) — bukan lagi zona atas/bawah dari posisi wajah.
    const yPctCover = Number.isFinite(+cand.subYPercent) ? Math.min(88, Math.max(12, +cand.subYPercent)) : 65;
    fs.writeFileSync(assFile, clipperLib.buildCoverAss(text, { yPercent: yPctCover }));
    const ex = await clipRun('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '3', '-y', tmpFrame], { timeout: 60000 });
    if (ex.code !== 0 || !fs.existsSync(tmpFrame)) return null;
    const out = path.join(job.dir, 'cover_' + cand.index + '.jpg');
    const vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,ass='" + clipperLib.ffmpegFilterPath(assFile) + "':fontsdir='" + clipperLib.ffmpegFilterPath(clipFontsDir()) + "'";
    const ex2 = await clipRun('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', tmpFrame, '-vf', vf, '-frames:v', '1', '-q:v', '3', '-y', out], { timeout: 60000 });
    try { fs.unlinkSync(tmpFrame); } catch {}
    if (ex2.code !== 0 || !fs.existsSync(out)) return null;
    if (rec) { rec.cover = true; clipSaveJob(job); }
    return out;
  } catch { return null; }
}
// Transkrip otomatis (Whisper, lokal) via whisper-transcribe.py — dipakai saat
// Analisis dan tidak ada transkrip YouTube. Hasilnya jadi auto-caption kayak
// CapCut (subtitle di render) + dipakai analisis AI. Gagal -> throw, pemanggil
// lanjut analisis metadata (jangan gagalkan analisis).
// Argumen whisper-transcribe.py (dipakai clipWhisperTranscribe, diekspor buat tes):
// file + --model + --language bila bahasa dipaksa (id/en); Auto = tanpa -l.
function clipWhisperArgs(file, job) {
  const model = process.env.WHISPER_MODEL || 'tiny';
  const a = [path.join(__dirname, 'whisper-transcribe.py'), file, '--model', model];
  const lang = clipTranscriptLang(job);
  if (lang) a.push('--language', lang);
  return a;
}
async function clipWhisperTranscribe(file, job) {
  const p = await clipRun('python3', clipWhisperArgs(file, job), { timeout: 120 * 60 * 1000, signal: job && job.abortCtrl ? job.abortCtrl.signal : undefined });
  if (p.code !== 0) throw new Error('whisper-transcribe gagal: ' + (p.stderr || '').replace(/\s+/g, ' ').slice(-300));
  let out = {};
  try { out = JSON.parse(p.stdout || ''); } catch { throw new Error('whisper-transcribe: output bukan JSON'); }
  return { segments: Array.isArray(out.segments) ? out.segments : [], language: out.language || '' };
}
// Mode sumber transkrip dari setting Transkrip user: 'groq' | 'local' | 'auto'.
// 'groq' = Groq Whisper saja (gagal -> throw, pemanggil fallback ke caption
// YouTube — JANGAN paksa Whisper lokal). 'local' = Whisper lokal saja
// (gagal -> throw, JANGAN paksa Groq). 'auto' (nilai lain / kosong) = Groq
// dulu (bila key ada), lalu Whisper lokal, lalu throw (pemanggil fallback
// ke caption YouTube).
function clipNormTranscribeVia(v) {
  return v === 'groq' ? 'groq' : v === 'local' ? 'local' : v === 'device' ? 'device' : 'auto';
}
// Transkrip otomatis (STT bertimestamp per kata — mekanisme Flufclip: percaya
// timestamp kata STT apa adanya, tanpa offset). Mode dari setting Transkrip:
// 'groq' = Groq saja; 'local' = Whisper lokal saja; 'auto' = Groq dulu,
// lalu Whisper lokal. Gagal total -> throw, pemanggil fallback ke caption
// YouTube (jangan gagalkan analisis).
// Filter bilingual ID+EN (prinsip: utamakan Indonesia).
// Whisper/Groq kadang code-switching: segmen yang sama muncul dua kali
// (sekali ID, sekali EN). Filter ini membuang segmen EN hanya bila ia
// DUPLIKAT — overlap >=50% durasi dengan segmen ID. Konten EN yang unik
// (tidak overlap) DIPERTAHANKAN. Safety: bila hasil kosong, kembalikan asli.
function clipFilterMixedLang(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  if (segs.length < 2) return segs;
  // Stopword ID vs EN (klasifikasi cepat per segmen).
  const ID_WORDS = new Set('yang dan di ke dari untuk dengan pada adalah ini itu sebagai tidak ada oleh karena saat juga akan bisa harus dapat mereka kita kamu saya dia beliau anda kami kalian nya lah kah pun tak jangan sudah telah sedang lagi pula agar supaya jika kalau ketika dimana mana siapa apa bagaimana mengapa berapa banyak sedikit sangat lebih kurang sekali saja hanya cuma memang justru malah bahkan tapi namun sedangkan sementara itu ini bahwa atau'.split(' '));
  const EN_WORDS = new Set('the and to of a in is that it was for on are as with his they i at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over new sound take only little work know place year live me back give most very after thing our just name good sentence man think say great where help through much before line right too mean old any same tell boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should indonesia would'.split(' '));
  const classify = (text) => {
    const words = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    let id = 0, en = 0;
    for (const w of words) { if (ID_WORDS.has(w)) id++; else if (EN_WORDS.has(w)) en++; }
    if (id === 0 && en === 0) return 'unknown';
    return id >= en ? 'id' : 'en';
  };
  const withLang = segs.map(s => ({ ...s, _lang: classify(s.text) }));
  const idSegs = withLang.filter(s => s._lang === 'id');
  if (!idSegs.length) return segs; // tidak ada ID — jangan buang apa-apa.
  const overlapRatio = (a, b) => {
    const s = Math.max(+a.start || 0, +b.start || 0);
    const e = Math.min(+a.end || 0, +b.end || 0);
    if (e <= s) return 0;
    const durA = (+a.end || 0) - (+a.start || 0);
    if (durA <= 0) return 0;
    return (e - s) / durA;
  };
  const filtered = withLang.filter(s => {
    if (s._lang !== 'en') return true; // ID + unknown selalu dipertahankan.
    // EN: buang hanya bila duplikat (>=50% overlap dengan segmen ID).
    return !idSegs.some(idS => overlapRatio(s, idS) >= 0.5);
  });
  // Safety: jangan sampai transkrip kosong.
  if (!filtered.length) return segs;
  return filtered.map(({ _lang, ...rest }) => rest);
}
async function clipTranscribeAuto(file, job, transcribeVia) {
  let mode = clipNormTranscribeVia(transcribeVia);
  if (!isAdminUser(job && job.user) && (mode === 'groq' || mode === 'auto')) {
    mode = 'local';
    clipLog(job, 'Akun non-admin: transkrip memakai Whisper lokal (Groq cloud khusus akun admin).');
  }
  if (mode === 'device') {
    // Whisper di PERANGKAT user (browser): cues diunggah duluan oleh klien
    // lewat /api/clipper/cues (source 'device'). Di sini tinggal pakai.
    if (job && job.transcriptSource === 'device' && Array.isArray(job.cues) && job.cues.length) {
      clipLog(job, 'Memakai transkrip dari perangkat user (' + job.cues.length + ' cue).');
      return { segments: job.cues.map(c => ({ start: c.start, end: c.end, text: c.text, words: c.words })), language: clipTranscriptLang(job) || '', source: 'device' };
    }
    throw new Error('Transkrip perangkat belum diterima — browser user harus mentranskrip dulu (pilihan Transkrip: Perangkat saya, lalu klik Analisis).');
  }
  // Filter bilingual: bila bahasa dipaksa 'id', buang duplikat EN (utamakan ID).
  const maybeFilter = (res) => {
    if (clipTranscriptLang(job) === 'id' && res && Array.isArray(res.segments)) {
      const before = res.segments.length;
      res.segments = clipFilterMixedLang(res.segments);
      if (res.segments.length !== before) clipLog(job, 'Filter bilingual: ' + (before - res.segments.length) + ' segmen EN duplikat dibuang (ID dipertahankan).');
    }
    return res;
  };
  const tryGroq = async () => {
    if (!GROQ_ENABLED) throw new Error('Groq belum di-set (GROQ_API_KEY kosong)');
    clipLog(job, 'Menjalankan transkrip otomatis (Groq cloud, cepat)…');
    const g = await clipTranscribeGroq(file, job);
    if (!g.segments.length) throw new Error('Groq tidak menghasilkan teks');
    clipLog(job, 'Transkrip otomatis (Groq) selesai: ' + g.segments.length + ' segmen' + (g.language ? ' (bahasa: ' + g.language + ')' : '') + '.');
    return maybeFilter({ segments: g.segments, language: g.language, source: 'groq' });
  };
  const tryWhisper = async () => {
    clipLog(job, 'Menjalankan transkrip otomatis (Whisper, lokal, bisa beberapa menit)…');
    const w = await clipWhisperTranscribe(file, job);
    if (!w.segments.length) throw new Error('Whisper tidak menghasilkan teks');
    clipLog(job, 'Transkrip otomatis (Whisper) selesai: ' + w.segments.length + ' segmen' + (w.language ? ' (bahasa: ' + w.language + ')' : '') + '.');
    return maybeFilter({ segments: w.segments, language: w.language, source: 'whisper' });
  };
  if (mode === 'groq') {
    try { return await tryGroq(); }
    catch (e) {
      if (job.cancelled) throw e;
      clipLog(job, 'Groq gagal (' + clipTrunc(e.message || String(e), 200) + ').');
      throw e;
    }
  }
  if (mode === 'local') {
    try { return await tryWhisper(); }
    catch (e) {
      if (job.cancelled) throw e;
      clipLog(job, 'Whisper lokal gagal (' + clipTrunc(e.message || String(e), 200) + ').');
      throw e;
    }
  }
  // auto: Groq dulu (bila key ada), lalu Whisper lokal.
  try { return await tryGroq(); }
  catch (e) {
    if (job.cancelled) throw e;
    clipLog(job, 'Groq gagal (' + clipTrunc(e.message || String(e), 200) + ') — fallback ke Whisper lokal…');
  }
  return await tryWhisper();
}
// Codec video sumber (buat warning dini kalau bukan H.264 — ffmpeg minimal
// mungkin tidak bisa decode VP9/AV1, dan render akan gagal di decode).
async function clipProbeCodec(file) {
  try {
    const p = await clipRun('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 60000 });
    return (p.stdout || '').trim().toLowerCase();
  } catch {}
  return '';
}
// Tinggi (resolusi vertikal) video sumber — buat warning dini kalau <720p.
// Format yt-dlp sudah cap 1080p, tapi cookies YouTube yang basi bisa bikin
// klien web kena bot-check sehingga YouTube hanya menawarkan 360p. Output
// tetap 720x1280 (koordinat .ass Klipaja), jadi sumber 360p = hasil buram
// (upscale). Peringatan menyuruh refresh cookies + Buat Klip ulang.
async function clipProbeHeight(file) {
  try {
    const p = await clipRun('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 60000 });
    const h = parseInt((p.stdout || '').trim(), 10);
    if (Number.isFinite(h) && h > 0) return h;
  } catch {}
  return 0;
}
// Peringatan sumber rendah (murni, untuk tes): <720p -> string peringatan,
// >=720p / tidak terbaca (0) -> null. Bukan error — download tetap jalan.
function clipLowResWarning(h) {
  if (Number.isFinite(+h) && +h > 0 && +h < 720) return 'Sumber cuma ' + Math.round(+h) + 'p — hasil tidak akan HD; refresh cookies YouTube (ekspor ulang dari browser yang login) lalu Buat Klip ulang.';
  return null;
}

// Tahap 1b — Input file upload: file sudah disimpan endpoint ke job.source.
// Di sini cuma validasi + baca durasi + set judul. Dipanggil endpoint /api/clipper/upload.
async function clipInputUpload(job, filename) {
  try {
    if (job.cancelled) return;
    job.phase = 'upload'; clipLog(job, 'Memeriksa file upload…');
    if (!job.source || !fs.existsSync(job.source)) throw fail('File upload tidak ditemukan.', 'input');
    const d = await clipProbeDuration(job.source);
    if (!(d > 0)) throw fail('File bukan video yang bisa dibaca (durasi tidak terbaca).', 'input');
    job.duration = d;
    job.videoTitle = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Video upload';
    job.metaDesc = ''; job.metaUploader = 'Upload';
    job.sourceReady = true;
    const sizeMB = (fs.statSync(job.source).size / 1048576).toFixed(1);
    job.phase = 'input-done'; job.progress = 100; job.status = 'ready';
    clipLog(job, 'Video tersimpan di server (' + sizeMB + ' MB, durasi ' + Math.round(job.duration) + ' detik). Klik Analisis AI untuk mulai.');
    clipNotify(job, '✅ Video sudah ada di server (durasi ' + clipFmtDur(job.duration) + ') — lanjut transkrip…');
  } catch (e) {
    if (!job.cancelled) { job.status = 'error'; job.error = e.message || String(e); clipLog(job, 'Gagal: ' + job.error); clipNotifyFail(job); }
    try { if (job.source) fs.unlinkSync(job.source); } catch {}
    job.source = null; job.sourceReady = false;
  }
}

// Mode Tanpa AI: cari kandidat dari volume audio (nol token AI sama sekali).
// Caranya: sampling jendela merata di sepanjang video, ukur max_volume tiap jendela
// (ffmpeg volumedetect), pilih jendela paling keras. Kalau ada transkrip, jendela
// yang transkripnya ramai (tanda seru / kata kunci heboh) dapat boost.
async function clipHeuristicCandidates(job, targetDur, count) {
  const dur = job.duration;
  const winCount = Math.max(1, Math.min(20, Math.floor(dur / targetDur) || 1));
  const step = dur / winCount;
  const windows = [];
  for (let i = 0; i < winCount; i++) {
    const start = i * step;
    const end = Math.min(dur, start + targetDur);
    if (end - start < 5) continue;
    windows.push({ start, end });
  }
  const scored = [];
  for (const w of windows) {
    if (job.cancelled) return [];
    let maxVol = -60, meanVol = -60;
    try {
      const p = await clipRun('ffmpeg', ['-ss', String(w.start), '-t', String(w.end - w.start), '-i', job.source, '-af', 'volumedetect', '-vn', '-sn', '-dn', '-f', 'null', '-'], { timeout: 120000 });
      const m = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(p.stderr || '');
      if (m) maxVol = +m[1];
      const m2 = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(p.stderr || '');
      if (m2) meanVol = +m2[1];
    } catch {}
    let boost = 0; let sampleText = '';
    if (job.cues && job.cues.length) {
      const inWin = job.cues.filter(c => c.start >= w.start && c.start < w.end);
      for (const c of inWin) {
        const t = c.text || '';
        if (/!/.test(t)) boost += 1;
        if (/\b(wow|gila|astaga|luar biasa|hebat|parah|ngakak|ketawa|tawa|seru|mantap|edan|anjir|anjay|buset|waduh|wkwk)\b/i.test(t)) boost += 2;
        if (/[A-Z]{4,}/.test(t)) boost += 1;
        if (!sampleText) sampleText = t;
      }
      boost = Math.min(6, boost);
    }
    scored.push({ ...w, maxVol, meanVol, boost, sampleText });
  }
  scored.sort((a, b) => (b.maxVol + b.boost) - (a.maxVol + a.boost));
  // Skor RELATIF terhadap jendela terkeras (mean volume tertinggi = 100,
  // turun 5 poin per dB, min 55). Skala absolut lama (100 + maxVol*1.5)
  // jenuh di 100 untuk audio yang peak-nya 0 dBFS — makanya semua klip
  // tampil 10,0/10. Mean volume tetap menyebar walau peak-nya sama.
  const bestMean = scored.length ? Math.max.apply(null, scored.map(w => w.meanVol)) : -60;
  return scored.slice(0, count).map((w, i) => {
    const title = w.sampleText ? clipperLib.cleanTitle(w.sampleText, 60) : 'Momen paling keras ' + (i + 1);
    const score = Math.max(55, Math.min(100, Math.round(100 + (w.meanVol - bestMean) * 5)));
    return { start: Math.round(w.start), end: Math.round(w.end), title,
      score, reason: 'Volume max ' + w.maxVol.toFixed(1) + ' dB' + (w.boost > 0 ? ' + transkrip ramai' : '') + ' (deteksi suara, tanpa AI).' };
  });
}

// Instruksi AI per proyek (job.aiNote, maks 500): disisipkan ke SEMUA prompt
// analisis (segmen + metadata). Murni (bisa dites): aiNote terisi -> baris
// "Instruksi tambahan dari user..."; kosong -> '' (prompt tetap jalan).
function clipAiNoteText(aiNote) {
  const t = String(aiNote || '').trim();
  return t ? '\nInstruksi tambahan dari user (WAJIB dipatuhi, di atas aturan lain kecuali format JSON): ' + t.slice(0, 500) + '\n' : '';
}
// ===== Most Replayed / Heatmap YouTube (sumber momen, tanpa AI) =====
// YouTube menyimpan data Most Replayed di info JSON (-J) field `heatmap`:
// [{start_time, end_time, value}] (value 0..1 = intensitas replay).
// Diambil dari yt-dlp -J (pola yang sama seperti download: web dulu, lalu
// Android bila kena auth/reload). Di-cache di job.heatmap agar Analisis ulang
// tidak fetch lagi. `infoJson` opsional (untuk tes: suntikkan JSON -J palsu).
async function clipFetchHeatmap(job, infoJson) {
  if (Array.isArray(job.heatmap) && job.heatmap.length) return job.heatmap;
  let meta = null;
  if (infoJson && typeof infoJson === 'object') {
    meta = infoJson;
  } else {
    if (!job.sourceUrl) return null;
    // Heatmap memakai rantai klien yang sama (web -> iOS -> Android,
    // semua dengan cookies): klien web bisa gagal PO token walau cookies
    // lengkap, sementara iOS tidak butuh PO token.
    const ytAuthRetry = /needs to be reloaded|Sign in to confirm|not a bot|PO token|player response/i;
    let info = null;
    for (const a of [{ client: 'web', label: 'web' }, { client: 'ios', label: 'iOS' }, { client: 'android', label: 'Android' }]) {
      const { extra } = clipYtClientArgs(a);
      info = await clipRun('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', ...extra, ...clipYtCookies(), job.sourceUrl], { timeout: 120000, maxOut: 5000000, signal: job.abortCtrl ? job.abortCtrl.signal : undefined });
      if (info.code === 0 || job.cancelled || !ytAuthRetry.test(info.stderr || '')) break;
    }
    if (info.code !== 0) return null;
    try { meta = JSON.parse(info.stdout || ''); } catch { return null; }
  }
  const hm = Array.isArray(meta.heatmap) ? meta.heatmap.filter(h => h && Number.isFinite(+h.start_time) && Number.isFinite(+h.end_time) && Number.isFinite(+h.value) && +h.end_time > +h.start_time) : [];
  if (hm.length) { job.heatmap = hm; return hm; }
  return null;
}
// Kandidat dari heatmap (murni, bisa dites): puncak tertinggi dulu, tiap puncak
// jadi jendela targetDur yang DIPUSATKAN pada puncak (padding targetDur/2 di
// tiap sisi, >= 3 detik untuk targetDur >= 6). Tolak jendela yang tumpang
// tindih > 50% dengan yang sudah diterima (aturan yang sama seperti filter
// overlap kandidat). Judul dari transkrip segmen itu (seperti kandidat lain).
function clipHeatmapCandidates(job, heatmap, targetDur, count) {
  const dur = +job.duration || 0;
  if (!(dur > 0) || !Array.isArray(heatmap) || !heatmap.length) return [];
  const peaks = [...heatmap].sort((a, b) => (+b.value || 0) - (+a.value || 0));
  const picked = [];
  for (const p of peaks) {
    if (picked.length >= count) break;
    const center = ((+p.start_time || 0) + (+p.end_time || 0)) / 2;
    const start = Math.min(Math.max(0, center - targetDur / 2), Math.max(0, dur - targetDur));
    const end = Math.min(dur, start + targetDur);
    if (end - start < 5) continue;
    // Tolak bila tumpang tindih > 50% dengan jendela yang sudah diterima.
    let overlap = false;
    for (const w of picked) {
      const ov = Math.min(end, w.end) - Math.max(start, w.start);
      if (ov > 0.5 * Math.min(end - start, w.end - w.start)) { overlap = true; break; }
    }
    if (overlap) continue;
    let sampleText = '';
    if (job.cues && job.cues.length) {
      const inWin = job.cues.filter(c => c.start >= start && c.start < end);
      if (inWin.length) sampleText = inWin[0].text || '';
    }
    picked.push({
      start: Math.round(start), end: Math.round(end),
      title: sampleText ? clipperLib.cleanTitle(sampleText, 60) : 'Most Replayed ' + (picked.length + 1),
      score: Math.max(50, Math.min(100, Math.round((+p.value || 0) * 100))),
      reason: 'Most Replayed (heatmap YouTube, nilai ' + (+p.value || 0).toFixed(2) + ').',
    });
  }
  return picked;
}
// Heatmap -> kandidat; tanpa heatmap -> fallback ke Paling Keras (deteksi
// suara) + log. Return {candidates, usedFallback}. Dipakai clipAnalyzeSaved.
async function clipHeatmapOrFallback(job, heatmap, targetDur, count) {
  if (heatmap && heatmap.length) {
    const cand = clipHeatmapCandidates(job, heatmap, targetDur, count);
    if (cand.length) return { candidates: cand, usedFallback: false };
  }
  clipLog(job, 'Heatmap tidak tersedia — pakai momen paling keras.');
  const cand = await clipHeuristicCandidates(job, targetDur, count);
  return { candidates: cand, usedFallback: true };
}
// Parse caption XML YouTube menjadi cue [{start, end, text}].
// Dua bentuk yang ditangani:
//   - TTML: <tt><body><div><p begin="00:00:00.080" end="00:00:05.160">teks</p>
//   - Legacy srv1: <transcript><text start="0.08" dur="5.08">teks</text>
// srv1/TTML dipakai sebagai sumber utama caption (web VTT menghilangkan
// interval pertama [0,08–2,96]: ~3 detik pertama video tanpa subtitle).
// begin/end/dur mentah dari XML dikembalikan apa adanya (rolling window);
// de-window + chunking di clipper-lib.js yang mengubahnya jadi interval
// atomik. Bila XML bukan srv1/TTML yang dikenali -> [] (caller fallback
// ke VTT). Cue duplikat (start+teks sama) dibuang.
function clipParseSrv1(xml) {
  const cues = [];
  if (!xml) return cues;
  const text = String(xml);
  const decode = s => String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { const c = parseInt(n, 10); return Number.isFinite(c) ? String.fromCharCode(c) : ''; });
  const clean = s => decode(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ').trim();
  // Waktu: HH:MM:SS.mmm | MM:SS.mmm | detik ("5.08", "5.08s") | ms ("5080ms").
  const toSec = v => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / Math.pow(10, m[4].length);
    m = s.match(/^(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (m) return (+m[1]) * 60 + (+m[2]) + (+m[3]) / Math.pow(10, m[3].length);
    m = s.match(/^([\d.]+)\s*ms$/i);
    if (m) return (+m[1]) / 1000;
    m = s.match(/^([\d.]+)\s*s?$/);
    if (m) return +m[1];
    return null;
  };
  const seen = new Set();
  const push = (start, end, raw) => {
    if (start == null || end == null || !(end > start)) return;
    const t = clean(raw);
    if (!t) return;
    const key = start.toFixed(2) + '|' + t;
    if (seen.has(key)) return;
    seen.add(key);
    cues.push({ start, end, text: t });
  };
  // Atribut begin/end/dur dari tag pembuka (<p ...> atau <text ...>).
  const attrs = tag => {
    const out = {};
    for (const name of ['begin', 'end', 'dur', 'start']) {
      const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i'));
      if (m) out[name] = m[1];
    }
    return out;
  };
  const bodyOf = (tag, closeName) => {
    const close = text.indexOf(closeName, tag.index);
    if (close < 0) return null;
    return text.slice(tag.index + tag[0].length, close);
  };
  // TTML: <p begin end|dur>...</p>
  let m;
  const pRe = /<p\b[^>]*>/gi;
  while ((m = pRe.exec(text)) !== null) {
    const a = attrs(m[0]);
    const start = toSec(a.begin);
    let end = toSec(a.end);
    if (end == null && a.dur != null && start != null) end = start + (toSec(a.dur) || 0);
    const body = bodyOf(m, '</p>');
    if (body == null) continue;
    push(start, end, body);
  }
  if (cues.length) { cues.sort((a, b) => a.start - b.start); return cues; }
  // Legacy srv1: <text start dur|end>...</text>
  const tRe = /<text\b[^>]*>/gi;
  while ((m = tRe.exec(text)) !== null) {
    const a = attrs(m[0]);
    const start = toSec(a.start);
    let end = toSec(a.end);
    if (end == null && a.dur != null && start != null) end = start + (toSec(a.dur) || 0);
    const body = bodyOf(m, '</text>');
    if (body == null) continue;
    push(start, end, body);
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}
// Caption YouTube: SATU track sesuai Bahasa Transkrip — jangan pernah
// gabungkan dua track (itu akar transkrip ganda bilingual: 40 cue = 20
// pasang timestamp identik EN+ID). Urutan: id -> [id.*, en.*]; en ->
// [en.*, id.*]; auto -> [id.*, en.*] (id dulu, perilaku lama). Bila track
// bahasa yang dipilih tidak ada -> fallback ke track yang ada + log jelas.
// Format: srv1 (TTML/XML) SEBAGAI SUMBER UTAMA — web VTT menghilangkan
// interval pertama [0,08–2,96] (~3 detik pertama tanpa subtitle); VTT
// hanya fallback bila srv1 tidak tersedia. Return { cues (di-tag lang),
// lang: 'id'|'en'|null, usedFallback, format: 'srv1'|'VTT'|null }.
async function clipFetchYoutubeCaptions(job, dir) {
  const forced = clipTranscriptLang(job);
  const order = forced === 'en' ? ['en.*', 'id.*'] : ['id.*', 'en.*'];
  // Bersihkan file caption lama (sub.*) — jangan sampai file stale dari
  // analisis sebelumnya ikut terbaca sebagai hasil percobaan ini.
  const cleanSubs = () => { try { for (const f of fs.readdirSync(dir)) if (/^sub\./i.test(f)) fs.unlinkSync(path.join(dir, f)); } catch {} };
  cleanSubs();
  for (let i = 0; i < order.length; i++) {
    const subLang = order[i];
    const trackLang = subLang.startsWith('id') ? 'id' : 'en';
    for (const fmt of ['srv1', 'vtt']) {
      try {
        cleanSubs();
        const args = ['--skip-download', '--no-playlist', '--no-warnings', '--write-subs', '--write-auto-subs', ...clipYtCookies(),
          '--sub-langs', subLang];
        if (fmt === 'srv1') args.push('--sub-format', 'srv1');
        else args.push('--sub-format', 'vtt/best', '--convert-subs', 'vtt');
        args.push('--socket-timeout', '30', '-o', path.join(dir, 'sub.%(ext)s'), job.sourceUrl);
        const sub = await clipRun('yt-dlp', args,
          { timeout: 150000, signal: job && job.abortCtrl ? job.abortCtrl.signal : undefined });
        if (sub.code !== 0) continue;
        const files = fs.readdirSync(dir).filter(f => fmt === 'srv1' ? /^sub\..*\.srv1$/i.test(f) : /^sub\..*\.vtt$/i.test(f));
        if (!files.length) continue;
        const cues = [];
        for (const f of files) {
          try {
            const raw = fs.readFileSync(path.join(dir, f), 'utf8');
            const parsed = fmt === 'srv1' ? clipParseSrv1(raw) : clipperLib.parseVtt(raw);
            for (const c of parsed) cues.push({ ...c, lang: trackLang });
          } catch {}
        }
        cues.sort((a, b) => a.start - b.start);
        // Buang duplikat PERSIS (start+end+teks sama) — `id.*` mengunduh
        // 2 file (id-orig + id) dengan isi identik. Dedupe bilingual
        // (timestamp sama, teks beda) tetap diurus dedupeTranscriptCues
        // di clipFetchTranscript.
        {
          const seen = new Set();
          const uniq = [];
          for (const c of cues) {
            const k = (+c.start).toFixed(3) + '|' + (+c.end).toFixed(3) + '|' + c.text;
            if (seen.has(k)) continue;
            seen.add(k);
            uniq.push(c);
          }
          cues.length = 0;
          cues.push(...uniq);
        }
        if (!cues.length) continue;
        if (i > 0) clipLog(job, trackLang === 'en'
          ? 'Caption Indonesia tidak ada — pakai caption Inggris.'
          : 'Caption Inggris tidak ada — pakai caption Indonesia.');
        return { cues, lang: trackLang, usedFallback: i > 0, format: fmt === 'srv1' ? 'srv1' : 'VTT' };
      } catch { /* format berikutnya */ }
    }
  }
  return { cues: [], lang: null, usedFallback: false, format: null };
}
// Ambil transkrip untuk analisis — KOMBINASI UX Klipaja + mesin Flufclip:
// STT (bertimestamp per kata) sebagai SUMBER UTAMA, caption YouTube sebagai
// FALLBACK. Urutan: (1) transkrip STT tersimpan dari Analisis sebelumnya
// (bila sumbernya cocok dengan mode STT saat ini — jangan transkrip ulang
// Whisper yang lambat saat Analisis ulang setelah AI gagal; bila setting
// berubah, STT jalan lagi); (2) STT sesuai setting Transkrip (Groq / Lokal /
// Auto = Groq lalu Lokal) — timestamp per kata STT dipakai apa adanya untuk
// timing subtitle (mekanisme Flufclip: tanpa offset); (3) bila STT gagal /
// kosong -> caption YouTube (srv1 dulu, lalu VTT). Dedupe pertahanan + log
// sumber/bahasa/jumlah SETELAH dedupe. Return { cues, source, langLabel }.
async function clipFetchTranscript(job, dir) {
  let cues = [];
  let source = '';
  let langLabel = 'Otomatis';
  let capFormat = '';
  const mode = clipNormTranscribeVia(job.transcribeVia);
  // (1) Transkrip STT tersimpan — pakai lagi bila sumbernya cocok dengan mode
  // saat ini (Groq tersimpan -> mode groq/auto; Whisper tersimpan -> mode
  // local/auto). Transkrip caption YouTube tersimpan TIDAK dipakai ulang di
  // sini (transcriptSource tidak diset untuk caption) — STT jalan dulu.
  const savedOk = job.cues && job.cues.length &&
    ((mode === 'groq' && job.transcriptSource === 'groq') ||
     (mode === 'local' && job.transcriptSource === 'whisper') ||
     (mode === 'device' && job.transcriptSource === 'device') ||
     (mode === 'auto' && (job.transcriptSource === 'groq' || job.transcriptSource === 'whisper')));
  if (savedOk) {
    cues = job.cues;
    source = job.transcriptSource === 'groq' ? 'Groq' : job.transcriptSource === 'device' ? 'Perangkat kamu' : 'Whisper';
    const forced = clipTranscriptLang(job);
    langLabel = forced === 'en' ? 'Inggris' : forced === 'id' ? 'Indonesia' : 'Otomatis';
    clipLog(job, 'Memakai transkrip tersimpan (' + source + ', ' + cues.length + ' cue) — tidak transkrip ulang.');
  } else {
    // (2) STT sebagai sumber UTAMA (timestamp per kata).
    try {
      const t = await clipTranscribeAuto(path.join(dir, 'source.mp4'), job, mode);
      if (t.segments.length) {
        // Kata per kata ikut disimpan (dari token STT) — dipakai subtitle
        // karaoke + Koreksi Kata. Cue tanpa words = bagi rata.
        const autoLang = clipNormTranscriptLang(t.language) || clipTranscriptLang(job);
        cues = t.segments.map(s => clipperLib.normalizeCueWords({ start: s.start, end: s.end, text: s.text, words: s.words, lang: autoLang || undefined }));
        // Diagnosis sinkronisasi: bila STT tidak memberi timestamp PER KATA,
        // subtitle pakai bagi-rata per segmen (sinkronisasi hanya perkiraan).
        // Catat eksplisit di log biar kelihatan sumber ketidakpresisiannya.
        if (!t.segments.some(s => Array.isArray(s.words) && s.words.length)) clipLog(job, 'Transkrip tanpa timestamp per kata — subtitle pakai bagi-rata (sinkronisasi perkiraan, tidak presisi).');
        job.transcriptSource = t.source;
        source = t.source === 'groq' ? 'Groq' : t.source === 'device' ? 'Perangkat kamu' : 'Whisper';
        langLabel = autoLang === 'en' ? 'Inggris' : autoLang === 'id' ? 'Indonesia' : 'Otomatis';
      }
    } catch (e) {
      // STT gagal total (Groq + Whisper lokal / sesuai mode) — jangan gagalkan
      // analisis, lanjut fallback caption YouTube.
      if (job.cancelled) return { cues: [], source: '', langLabel: 'Otomatis' };
      clipLog(job, 'STT gagal (' + clipTrunc(e.message || String(e), 200) + ') — pakai caption YouTube.');
    }
    // (3) Fallback: caption YouTube (satu track sesuai Bahasa Transkrip,
    // srv1 dulu lalu VTT) bila STT gagal / kosong.
    if (!cues.length && job.sourceUrl) {
      const cap = await clipFetchYoutubeCaptions(job, dir);
      if (cap.cues.length) {
        cues = cap.cues;
        source = 'YouTube';
        langLabel = cap.lang === 'en' ? 'Inggris' : 'Indonesia';
        capFormat = cap.format || '';
      }
    }
  }
  if (job.cancelled) return { cues: [], source: '', langLabel: 'Otomatis' };
  // Dedupe pertahanan: buang cue duplikat bertimestamp identik (transkrip
  // ganda bilingual) — berlaku untuk semua jalur (YouTube/Groq/Whisper).
  cues = clipperLib.dedupeTranscriptCues(cues.map(c => clipperLib.normalizeCueWords(c)), clipTranscriptLang(job));
  // Log menyebut sumber + bahasa + FORMAT caption (srv1/VTT) + jumlah SETELAH
  // dedupe — format penting untuk diagnosis (srv1 menutupi L1, VTT tidak).
  const fmtSuffix = source === 'YouTube' && capFormat ? ', ' + capFormat : '';
  clipLog(job, cues.length ? ('Transkrip ' + (source || 'YouTube') + ' (' + langLabel + fmtSuffix + '): ' + cues.length + ' cue.') : 'Transkrip tidak tersedia — analisis dari judul + metadata saja.');
  return { cues, source, langLabel };
}
// Tahap 2 — Analisis: pakai video yang SUDAH tersimpan (tanpa download ulang).
// Transkrip diambil lagi tiap analisis (cepat, bukan video), lalu AI cari kandidat.
// Dipanggil endpoint /api/clipper/analyze.
// Render ulang = TAMBAH klip, bukan ganti (permintaan Dzaky 20 Okt): analisis
// ulang (mis. dengan setting Pengaturan Proyek berbeda) MENAMBAH kandidat
// baru di bawah kandidat lama — indeks baru melanjutkan indeks tertinggi yang
// ada — supaya hasil tiap setting bisa dibandingkan berdampingan ("setting A
// hasilnya gini, setting B hasilnya gitu"). Render lama TIDAK dihapus.
// Tiap kandidat baru dicap `batch` {n, mode, dur, quality, hookPreset}
// untuk label perbandingan di kartu klip.
function clipAppendCandidates(job, newCands, batchInfo) {
  const existing = Array.isArray(job.candidates) ? job.candidates : [];
  const base = existing.length ? Math.max.apply(null, existing.map(c => +c.index || 0)) + 1 : 0;
  const batchN = existing.reduce((m, c) => Math.max(m, (c.batch && +c.batch.n) || 0), 0) + 1;
  const batch = Object.assign({ n: batchN }, batchInfo || {});
  const stamped = (newCands || []).map((c, i) => Object.assign({}, c, { index: base + i, batch }));
  if (job.titleDurDefault) for (const c of stamped) c.titleDur = job.titleDurDefault; // Smart Hook: durasi judul bawaan proyek
  for (const c of stamped) { // Default gaya render dari sumber (Dzaky 23 Okt): judul gaya Kartu (hookPreset proyek) posisi atas 5%, subtitle Monospace posisi 65% — hanya bila kandidat belum membawa nilainya sendiri.
    if (c.subPreset === undefined) c.subPreset = 'monospace';
    if (c.subYPercent === undefined) c.subYPercent = 65;
    if (c.titleYPercent === undefined) c.titleYPercent = 5;
  }
  job.candidates = existing.concat(stamped);
  return stamped;
}
async function clipAnalyzeSaved(job, targetDur, count, provider, model, route) {
  const dir = job.dir;
  try {
    job.phase = 'transcript'; job.progress = 0; clipLog(job, 'Mencari transkrip/caption…');
    const { cues } = await clipFetchTranscript(job, dir);
    job.cues = cues;
    if (job.cancelled) return;
    if (cues.length) clipNotify(job, '📝 Transkrip selesai (' + cues.length + ' segmen) — lanjut analisis…');
    else clipNotify(job, 'Transkrip tidak tersedia — analisis dari metadata.');
    job.phase = 'ai';
    // Tanpa AI: deteksi suara saja (nol token). Transkrip (kalau ada) dipakai buat
    // boost + judul, tapi tidak ada panggilan API AI sama sekali.
    // Momen Most Replayed (heatmap YouTube): tanpa AI, tanpa deteksi suara.
    // Tanpa heatmap -> fallback ke Paling Keras (clipHeatmapOrFallback).
    if (job.moment === 'heatmap') {
      const hm = await clipFetchHeatmap(job);
      const { candidates, usedFallback } = await clipHeatmapOrFallback(job, hm, targetDur, count);
      const final = clipperLib.sanitizeCandidates(candidates, job.duration, targetDur);
      const newCands = clipAppendCandidates(job, final.length ? final : fallbackCandidates(job.duration, targetDur, count), { mode: job.mode, dur: targetDur, quality: job.quality, hookPreset: job.hookPreset });
      if (job.hookPreset) for (const c of newCands) c.hookPreset = job.hookPreset; // Kartu Buat Klip → default semua kandidat baru
      if (!newCands.length) throw new Error('Tidak bisa membuat kandidat klip dari video ini.');
      job.status = 'done'; job.progress = 100;
      clipLog(job, 'Analisis selesai: ' + newCands.length + ' kandidat baru (' + (usedFallback ? 'Paling Keras — heatmap tidak tersedia' : 'Most Replayed') + ') — total ' + job.candidates.length + ' klip.');
      if (job.autoRender && newCands.length) { clipLog(job, 'Render otomatis ' + newCands.length + ' klip baru (Final — judul hook + subtitle)…'); setImmediate(() => clipRender(job, newCands.map(c => ({ index: c.index, title: c.title })), { subtitle: true })); }
      return;
    }
    // Momen Paling Keras (deteksi suara, tanpa AI) — dipakai bila Jalur AI =
    // "Tanpa AI" (route 'none') ATAU Momen = "Paling Keras" (mengalahkan route).
    if (route === 'none' || job.moment === 'loudest') {
      clipLog(job, 'Mencari momen paling keras (deteksi suara, tanpa AI — nol token)…');
      let cand = await clipHeuristicCandidates(job, targetDur, count);
      if (job.cancelled) return;
      cand = clipperLib.sanitizeCandidates(cand, job.duration, targetDur, count);
      if (!cand.length) { cand = clipperLib.fallbackCandidates(job.duration, targetDur, count); clipLog(job, 'Deteksi suara tidak menemukan kandidat — memakai pembagian merata.'); }
      const newCands = clipAppendCandidates(job, cand.map(c => ({ ...c, hookPreset: job.hookPreset || c.hookPreset || 'kartu' })), { mode: job.mode, dur: targetDur, quality: job.quality, hookPreset: job.hookPreset });
      job.phase = 'done'; job.progress = 100; job.status = 'done';
      clipLog(job, 'Analisis selesai: ' + newCands.length + ' kandidat klip baru (tanpa AI) — total ' + job.candidates.length + ' klip.');
      clipNotify(job, '🎯 Analisis selesai: ' + newCands.length + ' kandidat klip baru (total ' + job.candidates.length + ').');
    // Auto-render (server-side): analisis selesai -> render semua kandidat BARU otomatis.
    // Tahan reload / tutup halaman (frontend tidak perlu trigger render lagi).
    // Status langsung 'rendering' (clipRender set status di awal, sinkron) jadi
    // poll() frontend tidak berhenti di 'done' lalu kehilangan render.
    if (job.autoRender && !job.cancelled && newCands.length) {
      job.autoRender = false;
      clipLog(job, 'Analisis selesai — render otomatis klip baru (Final — judul hook + subtitle) dimulai…');
      const selected = newCands.map(c => ({ index: c.index, title: c.title }));
      clipRender(job, selected, { hookEnabled: true, subtitle: true }).catch(() => {});
    }
      return;
    }
    clipLog(job, 'AI menganalisis momen terbaik…');
    const chunks = cues.length ? clipperLib.chunkTranscript(cues, 8, 5000) : [];
    const useRouter = route === 'router' || route === 'router-pi' || route === 'router-pc' ? true : route === 'direct' ? false : !!R;
    const rWhich = routerWhich(route);
    const clipAdmin = isAdminUser(job.user);
    if (clipAdmin) {
      if (useRouter && rWhich === 'pc' && !RPC) throw fail('ROUTER_URL_PC belum diisi di .env untuk jalur 9router PC.', 'input');
      if (useRouter && !model) throw fail('Pilih model/combo 9router untuk analisis di pengaturan AI Auto Clipper.', 'input');
      if (!useRouter && !call[provider]) throw fail('Provider Direct tidak dikenal.', 'input');
      if (!useRouter && !E[KEY[provider]]) throw fail(KEY[provider] + ' belum diisi di .env.', 'input');
    }
    let allCand = [];
    const jobs = [];
    // Model cadangan kalau model 9router yang dipilih ternyata sudah EOL (410 Gone)
    // padahal masih tampil di daftar model — sudah terbukti jalan sebelumnya.
    const CLIP_FALLBACK_MODEL = 'gemini/gemini-3.8-flash';
    let aiModel = model;
    // Rotasi jalur AI (permintaan Dzaky 21 Okt): jalur pilihan gagal (balas
    // kosong, error, putus) -> pindah otomatis: model cadangan di router yang
    // sama -> router satunya (PC <-> Pi) -> Direct yang ada key-nya. Jalur yang
    // berhasil dipakai terus untuk sisa segmen (clipAiState.idx), supaya
    // kegagalan yang sama tidak berulang di tiap segmen.
    const clipAttempts = [];
    const attRouter = (which, mdl) => clipAttempts.push({ kind: 'router', which, model: mdl, label: '9router ' + (which === 'pc' ? 'PC' : 'Pi') + ' · ' + mdl });
    const attDirect = p => { if (call[p] && E[KEY[p]]) clipAttempts.push({ kind: 'direct', provider: p, label: 'Direct ' + p.replace('custom:', '') }); };
    const DIRECT_ROT = ['custom:ollama', 'openai', 'gemini', 'custom:deepsek', 'claude'];
    if (useRouter) {
      attRouter(rWhich, aiModel);
      if (aiModel !== CLIP_FALLBACK_MODEL) attRouter(rWhich, CLIP_FALLBACK_MODEL);
      const other = rWhich === 'pc' ? 'pi' : 'pc';
      if (routerBase(other)) attRouter(other, CLIP_FALLBACK_MODEL);
      for (const p of DIRECT_ROT) attDirect(p);
      for (const p of Object.keys(call)) if (p.startsWith('custom:') && !DIRECT_ROT.includes(p)) attDirect(p);
    } else {
      clipAttempts.push({ kind: 'direct', provider, label: 'Direct ' + String(provider).replace('custom:', '') });
      if (routerBase('pi')) attRouter('pi', CLIP_FALLBACK_MODEL);
      if (routerBase('pc')) attRouter('pc', CLIP_FALLBACK_MODEL);
      for (const p of DIRECT_ROT) if (p !== provider) attDirect(p);
      for (const p of Object.keys(call)) if (p.startsWith('custom:') && !DIRECT_ROT.includes(p) && p !== provider) attDirect(p);
    }
    if (!clipAdmin) {
      const own = userCustom(job.user);
      for (const slug of Object.keys(own)) {
        if (!clipAttempts.some(a => a.provider === 'custom:' + slug)) clipAttempts.push({ kind: 'direct', provider: 'custom:' + slug, label: 'Direct ' + slug });
      }
      for (let i = clipAttempts.length - 1; i >= 0; i--) {
        const a = clipAttempts[i];
        if (a.kind !== 'direct' || !String(a.provider || '').startsWith('custom:') || !own[String(a.provider).slice(7)]) clipAttempts.splice(i, 1);
      }
      if (!clipAttempts.length) throw fail('Akunmu belum punya koneksi AI. Tambahkan API key / base URL kamu di menu Koneksi AI dulu (tombol + Tambah AI), lalu analisis lagi.', 'input');
    }
    const clipAiState = { idx: 0 };
    // Instruksi AI per proyek (dari Pengaturan Proyek, opsional): disisipkan ke
    // SEMUA prompt analisis (segmen + metadata) — misal "fokus ke momen lucu".
    const aiNoteTxt = clipAiNoteText(job.aiNote);
    if (chunks.length) {
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const prompt = 'Kamu analis konten video. Cari momen paling "wah" untuk klip Shorts/Reels.\n'
          + 'Video: "' + job.videoTitle + '" (durasi ' + Math.round(job.duration) + ' detik).\n'
          + 'Transkrip segmen [' + ch.start.toFixed(0) + 's - ' + ch.end.toFixed(0) + 's]:\n' + ch.text.slice(0, 12000) + '\n\n'
          + 'Tugas: cari ' + (job.countAll ? 'SEMUA' : count) + ' momen paling wah (mengejutkan, lucu, emosional, kontroversial, atau bikin penasaran) untuk klip durasi sekitar ' + targetDur + ' detik.\n'          + 'ATURAN UNIT UTUH (WAJIB, permintaan pemilik channel): tiap kandidat harus SATU KESATUAN UTUH, bukan potongan menggantung. (1) Ada PERTANYAAN di momen itu (host bertanya, tamu ditanya, dst): start dari pertanyaan itu mulai diajukan, end SETELAH jawabannya selesai diucapkan — JANGAN berhenti di tengah jawaban. (2) Momen PENJELASAN / cerita: ambil sampai penjelasannya TUNTAS (ada kesimpulan / kalimat penutupnya), jangan kepotong di tengah penjelasan. (3) Keutuhan LEBIH penting daripada pas durasi: end boleh lebih panjang (dalam batas aturan durasi di bawah) demi menyelesaikan jawaban/penjelasan. (4) Prioritaskan momen tanya-jawab yang lengkap, penjelasan yang tuntas, dan momen berisi kata-kata bagus / quotable di atas momen sesaat yang menggantung. Ambil SEMUA momen yang memenuhi kriteria di segmen ini sampai jumlah yang diminta.\n'

          + 'Balas HANYA JSON array (tanpa markdown, tanpa penjelasan): [{"start":detik,"end":detik,"title":"Judul hook singkat maks 60 karakter","score":0-100,"reason":"satu kalimat","hook":[{"start":detik,"end":detik,"text":"TEKS 2-5 KATA"}],"caption":"1-2 kalimat caption siap posting tanpa hashtag","hashtags":["#tag1","#tag2"],"hookDur":"full"}]\n'
          + 'Caption + hashtag per kandidat (gaya Klipaja): caption 1-2 kalimat siap posting (tanpa hashtag, maks 200 karakter, nyambung sama momen klip itu), hashtags 3-5 hashtag relevan (diawali #).\n'
        + 'hookDur: "full" bila judul hook-nya layak tampil SEPANJANG klip (momen padat/klip pendek), "short" bila cukup tampil sebentar di awal.\n'
          + 'Hook multi-hook (WAJIB, gaya Hook V2): untuk TIAP kandidat, pilih 2–3 potongan pendek (0,5–2 detik) dari momen paling mencolok/kontroversial/emosional DI DALAM kandidat itu (start/end hook HARUS di dalam start/end kandidat), diurutkan dari paling kuat ke paling lemah, masing-masing dengan teks on-screen singkat 2–5 kata (huruf besar).\n'
          + aiNoteTxt
          + 'Aturan: start/end angka detik (start >= ' + Math.floor(ch.start) + ', end <= ' + Math.ceil(ch.end) + '), end-start ' + targetDur + ' detik (boleh 10 s/d ' + (targetDur + 30) + '), jangan tumpang tindih berat antar kandidat.';
        jobs.push({ prompt, tag: 'segmen ' + (i + 1) + '/' + chunks.length });
      }
    } else {
      const desc = String(job.metaDesc || '').replace(/\s+/g, ' ').slice(0, 1500);
      jobs.push({ tag: 'metadata', prompt: 'Kamu analis konten video. Transkrip TIDAK tersedia.\n'
        + 'Video: "' + job.videoTitle + '" oleh ' + (job.metaUploader || '-') + ' (durasi ' + Math.round(job.duration) + ' detik).\n'
        + (desc ? 'Deskripsi: ' + desc + '\n' : '')
        + 'Tugas: bagi video menjadi ' + count + ' kandidat klip durasi sekitar ' + targetDur + ' detik yang tersebar merata (awal, tengah, akhir), karena momen spesifik tidak bisa diketahui tanpa transkrip.\n'
        + 'Balas HANYA JSON array (tanpa markdown, tanpa penjelasan): [{"start":detik,"end":detik,"title":"Judul hook singkat maks 60 karakter","score":0-100,"reason":"satu kalimat","hook":[{"start":detik,"end":detik,"text":"TEKS 2-5 KATA"}],"caption":"1-2 kalimat caption siap posting tanpa hashtag","hashtags":["#tag1","#tag2"],"hookDur":"full"}]\n'
        + 'Caption + hashtag per kandidat (gaya Klipaja): caption 1-2 kalimat siap posting (tanpa hashtag, maks 200 karakter), hashtags 3-5 hashtag relevan (diawali #).\n'
        + 'hookDur: "full" bila judul hook-nya layak tampil SEPANJANG klip (momen padat/klip pendek), "short" bila cukup tampil sebentar di awal.\n'
        + 'Hook multi-hook: untuk TIAP kandidat, isi 2–3 potongan pendek (0,5–2 detik) DI DALAM kandidat itu (start/end hook HARUS di dalam start/end kandidat, tersebar di awal/tengah/akhir kandidat), masing-masing dengan teks on-screen singkat 2–5 kata (huruf besar).\n'
        + aiNoteTxt
        + 'Aturan: start/end angka detik dalam 0 s/d ' + Math.round(job.duration) + ', end-start ' + targetDur + ' detik (boleh 10 s/d ' + (targetDur + 30) + '), jangan tumpang tindih berat.' });
    }
    for (const j of jobs) {
      const msgs = [{ role: 'user', content: j.prompt }];
      let out = '';
      let lastErr = null, lastAtt = null;
      for (let k = clipAiState.idx; k < clipAttempts.length; k++) {
        if (job.cancelled) return;
        const att = clipAttempts[k];
        const aiJob = { ctrl: new AbortController(), chars: 0, partial: '', finish: '', truncated: false };
        job.aiCtrl = aiJob.ctrl;
        const timer = setTimeout(() => aiJob.ctrl.abort(), 10 * 60 * 1000);
        try {
          out = att.kind === 'router' ? await viaRouter(att.model, msgs, aiJob, att.which)
            : (clipAdmin ? await call[att.provider](msgs, aiJob) : await userCustomCall(job.user, String(att.provider).replace(/^custom:/, ''), msgs, aiJob));
          if (!String(out || '').trim()) throw fail('Model membalas kosong', 'empty');
          clipAiState.idx = k;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e; lastAtt = att;
          const nxt = clipAttempts[k + 1];
          if (nxt && !job.cancelled) clipLog(job, 'Jalur ' + att.label + ' gagal (' + (e.message || e) + ') — pindah ke ' + nxt.label + '…');
        } finally { clearTimeout(timer); job.aiCtrl = null; }
      }
      if (lastErr) {
        // Biar jelas sumber gagalnya: error via 9router diawali "9router: "
        // (bukan kode Clipper). Kalau pakai Direct, pesannya dari provider itu.
        if (lastAtt && lastAtt.kind === 'router' && lastErr.message && !/^9router:/.test(lastErr.message)) lastErr.message = '9router: ' + lastErr.message;
        throw lastErr;
      }
      if (job.cancelled) return;
      clipLog(job, 'AI selesai: ' + j.tag + '.');
      const cleaned = String(out || '').replace(/```(?:json)?/gi, '').trim();
      const a = cleaned.indexOf('['), b = cleaned.lastIndexOf(']');
      if (a >= 0 && b > a) {
        try {
          const parsed = JSON.parse(cleaned.slice(a, b + 1));
          if (Array.isArray(parsed)) allCand.push(...parsed);
        } catch {}
      }
    }
    let cand = clipperLib.sanitizeCandidates(allCand, job.duration, targetDur, count);
    if (!cand.length) { cand = clipperLib.fallbackCandidates(job.duration, targetDur, count); clipLog(job, 'AI tidak mengembalikan kandidat valid — memakai pembagian merata.'); }
    const newCands = clipAppendCandidates(job, cand.map(c => ({ ...c, hookPreset: job.hookPreset || c.hookPreset || 'kartu' })), { mode: job.mode, dur: targetDur, quality: job.quality, hookPreset: job.hookPreset });
    if (job.cancelled) return;
    job.phase = 'done'; job.progress = 100; job.status = 'done';
    clipLog(job, 'Analisis selesai: ' + newCands.length + ' kandidat klip baru — total ' + job.candidates.length + ' klip.');
    clipNotify(job, '🎯 Analisis selesai: ' + newCands.length + ' kandidat klip baru (total ' + job.candidates.length + ').');
    // Auto-render (server-side): analisis selesai -> render kandidat BARU otomatis.
    // Tahan reload / tutup halaman (frontend tidak perlu trigger render lagi).
    // Status langsung 'rendering' (clipRender set status di awal, sinkron) jadi
    // poll() frontend tidak berhenti di 'done' lalu kehilangan render.
    if (job.autoRender && !job.cancelled && newCands.length) {
      job.autoRender = false;
      clipLog(job, 'Analisis selesai — render otomatis klip baru (Final — judul hook + subtitle) dimulai…');
      const selected = newCands.map(c => ({ index: c.index, title: c.title }));
      clipRender(job, selected, { hookEnabled: true, subtitle: true }).catch(() => {});
    }
  } catch (e) {
    if (!job.cancelled) {
      if (job.candidates && job.candidates.length && job.sourceReady) {
        job.status = 'done';
        clipLog(job, 'Analisis ulang gagal (' + (e.message || String(e)).slice(0, 120) + ') \u2014 hasil analisis sebelumnya tetap dipakai.');
      } else { job.status = 'error'; job.error = e.message || String(e); clipLog(job, 'Gagal: ' + job.error); clipNotifyFail(job); }
    }
  }
}

// Ambil baris error ffmpeg yang penting (bukan dump info file input yang panjang).
// Cari baris "Unknown encoder", "No such filter", "Unrecognized option", "Error ..."
// — kalau ketemu, pakai baris itu; kalau tidak, pakai 300 karakter terakhir.
function clipFfmpegError(stderr) {
  const s = (stderr || '').replace(/\r/g, '');
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  const key = lines.find(l => /Unknown encoder|No such filter|Unrecognized option|Error (initializing|opening|while)|Invalid argument|not found|Permission denied|No such file/i.test(l));
  if (key) {
    // Error decode (decoder codec sumber tidak ada di ffmpeg server) — kasih hint
    // langkah berikutnya, karena retry encoder/filter tidak akan menolong.
    if (/decoding stream|Function not implemented/i.test(key)) return key.slice(0, 300) + ' — ffmpeg server tidak bisa decode video sumber (decoder codec ini tidak ada). Coba Simpan ulang video (sudah diutamakan H.264) atau install ffmpeg yang lebih lengkap.';
    return key.slice(0, 300);
  }
  return s.replace(/\s+/g, ' ').slice(-300);
}

// Face tracking otomatis (Podcast): jalankan face_track.py per klip, cache JSON.
// Kalau gagal (tidak ada OpenCV / model / timeout) -> null (fallback ke fokus statis).
// Dua jalur (pilih lewat .env):
// - Docker (Pi): FACE_TRACK_IMAGE=facetrack -> `docker run --rm -v <dir>:<dir> <image> ...`
//   (Pi pakai musl → pip/opkg tidak bisa install OpenCV; Docker image glibc bisa.)
//   Build: docker build -t facetrack -f Dockerfile.facetrack .
// - Native (PC): FACE_TRACK_PYTHON di .env (misal /opt/docker/venv/bin/python) atau 'python3'
//   (PC pakai glibc → `pip install opencv-python-headless` langsung dapat wheel).
// Jalankan face_track.py via runner (Docker dulu bila dikonfigurasi, lalu
// Python native). Return { ok: true, runner, attempted: [nama…] } bila spawn
// berhasil (file track ditulis — validasi isi dilakukan caller), atau
// { ok: false, attempted, error } bila semua runner gagal. Tiap runner yang
// gagal di-log + lanjut ke runner berikutnya (Docker gagal BUKAN langsung
// menyerah ke fokus statis — native dicoba dulu).
async function clipRunFaceTrackRunner(job, ftArgs, dockerImage, logPrefix, timeoutMs) {
  const script = path.join(__dirname, 'face_track.py');
  const runners = [];
  if (dockerImage) {
    const mounts = [...new Set([job.dir, path.dirname(job.source)])];
    const dArgs = ['run', '--rm'];
    for (const m of mounts) dArgs.push('-v', m + ':' + m);
    dArgs.push(dockerImage, ...ftArgs);
    runners.push({ name: 'docker', cmd: 'docker', args: dArgs });
  }
  runners.push({ name: 'native', cmd: E.FACE_TRACK_PYTHON || 'python3', args: [script, ...ftArgs] });
  let lastErr = null;
  for (let i = 0; i < runners.length; i++) {
    const r = runners[i];
    try {
      // clipRun RESOLVE dengan {code} walau proses gagal (exit != 0) — hanya
      // spawn error (ENOENT) yang reject. Jadi exit code HARUS dicek di sini,
      // kalau tidak proses gagal (mis. Python error / file tidak ditulis)
      // dianggap sukses dan JSON.parse track gagal di caller.
      // Timeout per runner 90 dtk (dulu 180): jalan normal ~25 dtk/klip 60 dtk;
      // 180 dtk bikin 1 klip gagal ngabisin 3 menit sebelum fallback fokus
      // statis (kejadian live 20 Okt: klip 3 timeout persis 180 dtk).
      const out = await clipRun(r.cmd, r.args, { timeout: timeoutMs || 90000 });
      if (out && out.code !== 0) throw new Error('exit ' + out.code + (out.stderr ? ': ' + String(out.stderr).trim().split('\n').slice(-1)[0] : ''));
      return { ok: true, runner: r.name, attempted: runners.slice(0, i + 1).map(x => x.name) };
    }
    catch (e) {
      lastErr = e;
      const next = runners[i + 1];
      clipLog(job, logPrefix + ' (' + r.name + ') gagal (' + (e.message || e).toString().slice(0, 120) + ')' + (next ? ' — coba Python native…' : ''));
    }
  }
  return { ok: false, attempted: runners.map(x => x.name), error: lastErr };
}
async function clipFaceTrack(job, sel, cand) {
  const trackFile = path.join(job.dir, 'clip_' + sel.index + '_facetrack.json');
  try {
    if (fs.existsSync(trackFile) && fs.statSync(trackFile).size > 0) {
      const d = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
      if (Array.isArray(d.track) && d.track.length >= 2 && (+d.v || 1) >= 3) return d.track; // v<3 = track dari kode tracker lama -> hitung ulang
    }
  } catch {}
  const script = path.join(__dirname, 'face_track.py');
  if (!fs.existsSync(script)) return null;
  const dockerImage = E.FACE_TRACK_IMAGE || (E.FACE_TRACK_DOCKER === '1' ? 'facetrack' : null);
  try {
    clipLog(job, 'Face tracking klip ' + sel.index + ' (deteksi wajah + suara)…');
    const ftArgs = ['--input', job.source, '--start', String(cand.start), '--end', String(cand.end), '--out', trackFile, '--fps', '2', '--ema', '0.3', '--deadzone', '30']; // EMA 0.3 = glide lebih lambat/halus (lag ~1,5 dtk) demi crop tidak goyang; hysteresis SpeakerLock di face_track.py mencegah flip-flop antar pembicara; deadzone 30px = gerakan kecil tidak menggerakkan crop (anti-jitter)
    const res = await clipRunFaceTrackRunner(job, ftArgs, dockerImage, 'Face tracking');
    if (!res.ok) { clipLog(job, 'Face tracking gagal (' + res.attempted.join(' + ') + ') — pakai fokus statis.'); return null; }
    const d = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    if (Array.isArray(d.track) && d.track.length >= 2) {
      clipLog(job, 'Face tracking selesai (' + d.track.length + ' titik, ' + d.track.filter(s => s.speaking).length + ' titik ngomong).');
      return d.track;
    }
  } catch (e) {
    clipLog(job, 'Face tracking gagal (' + (e.message || e).toString().slice(0, 120) + ') — pakai fokus statis.');
  }
  return null;
}

// Scan kehadiran wajah RINGAN (fallback bila tracking penuh gagal/timeout —
// permintaan Dzaky 23 Okt): face_track.py --presence mencatat ada/tidaknya
// wajah per detik. Hasil -> segmen campuran (clipPresenceSegs): bagian ada
// muka di-crop 9:16 full muka (track sintetis), sisanya Landscape. Cache
// clip_<i>_presence.json. null bila scan gagal / file tidak kebaca.
async function clipFacePresence(job, sel, cand) {
  const file = path.join(job.dir, 'clip_' + sel.index + '_presence.json');
  const toSegs = (d) => (d && Array.isArray(d.samples) && d.samples.length >= 2)
    ? clipperLib.clipPresenceSegs(d.samples, cand.end - cand.start, d.width || 0, d.cropW || 0) : null;
  try { if (fs.existsSync(file) && fs.statSync(file).size > 0) { const r = toSegs(JSON.parse(fs.readFileSync(file, 'utf8'))); if (r) return r; } } catch {}
  const script = path.join(__dirname, 'face_track.py');
  if (!fs.existsSync(script)) return null;
  const dockerImage = E.FACE_TRACK_IMAGE || (E.FACE_TRACK_DOCKER === '1' ? 'facetrack' : null);
  try {
    clipLog(job, 'Scan wajah ringan klip ' + (sel.index + 1) + ' (fallback tracking gagal)…');
    const args = ['--input', job.source, '--start', String(cand.start), '--end', String(cand.end), '--out', file, '--fps', '1', '--presence'];
    const res = await clipRunFaceTrackRunner(job, args, dockerImage, 'Scan wajah', 120000);
    if (!res.ok) { clipLog(job, 'Scan wajah gagal (' + res.attempted.join(' + ') + ').'); return null; }
    return toSegs(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) { clipLog(job, 'Scan wajah gagal (' + (e.message || e).toString().slice(0, 120) + ').'); return null; }
}

// Face tracking SPLIT (2 pembicara atas-bawah): jalankan face_track.py --split
// per klip, cache clip_<idx>_facetrack_split.json. Return
// {left: [{t, x}], right: [{t, x}]} (x = pusat wajah, koordinat sumber) atau
// null bila gagal / tidak ada titik valid. null -> buildFfmpegArgs memakai
// fallback belah dua tetap (log "Split fallback: belah dua tetap").
async function clipFaceTrackSplit(job, sel, cand) {
  const trackFile = path.join(job.dir, 'clip_' + sel.index + '_facetrack_split.json');
  const parseSplit = (d) => {
    if (!d || !Array.isArray(d.track)) return null;
    const left = [], right = [];
    for (const p of d.track) {
      if (!p || !Number.isFinite(+p.t) || !Number.isFinite(+p.leftX) || !Number.isFinite(+p.rightX)) continue;
      left.push({ t: +p.t, x: +p.leftX });
      right.push({ t: +p.t, x: +p.rightX });
    }
    if (left.length >= 2 && right.length >= 2) return { left, right };
    return null;
  };
  try {
    if (fs.existsSync(trackFile) && fs.statSync(trackFile).size > 0) {
      const d = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
      const cached = parseSplit(d);
      if (cached) return cached;
    }
  } catch {}
  const script = path.join(__dirname, 'face_track.py');
  if (!fs.existsSync(script)) return null;
  const dockerImage = E.FACE_TRACK_IMAGE || (E.FACE_TRACK_DOCKER === '1' ? 'facetrack' : null);
  try {
    clipLog(job, 'Face tracking Split klip ' + sel.index + ' (2 panel, kiri + kanan)…');
    const ftArgs = ['--input', job.source, '--start', String(cand.start), '--end', String(cand.end), '--out', trackFile, '--fps', '2', '--ema', '0.3', '--deadzone', '30', '--split'];
    const res = await clipRunFaceTrackRunner(job, ftArgs, dockerImage, 'Face tracking Split');
    if (!res.ok) { clipLog(job, 'Split fallback: belah dua tetap (face tracking Split gagal: ' + res.attempted.join(' + ') + ').'); return null; }
    const d = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    const parsed = parseSplit(d);
    if (parsed) {
      clipLog(job, 'Face tracking Split selesai (' + parsed.left.length + ' titik per panel).');
      return parsed;
    }
    clipLog(job, 'Split fallback: belah dua tetap (face_track --split tidak menghasilkan 2 track valid).');
  } catch (e) {
    clipLog(job, 'Split fallback: belah dua tetap (face tracking Split gagal: ' + (e.message || e).toString().slice(0, 120) + ').');
  }
  return null;
}

// Hook multi-hook: validasi + ubah waktu absolut (sumber) -> relatif ke
// awal klip. Dipakai render (clipRender) + endpoint ASS pratinjau hook.
function clipHookRel(cand, rawHook) {
  const out = [];
  for (const h of Array.isArray(rawHook) ? rawHook : []) {
    if (!h || typeof h !== 'object') continue;
    const hs = +h.start - cand.start, he = +h.end - cand.start;
    if (!Number.isFinite(hs) || !Number.isFinite(he) || he - hs < 0.5 || he - hs > 2.5) continue;
    if (hs < 0 || he > cand.end - cand.start) continue;
    out.push({ start: Math.round(hs * 100) / 100, end: Math.round(he * 100) / 100, text: clipperLib.cleanTitle(h.text, 30) });
    if (out.length >= 3) break;
  }
  return out;
}

async function clipRender(job, selected, opts) {
  if (opts.podcast) clipLog(job, 'Mode Podcast aktif — crop penuh ke 9:16 (tanpa bar hitam/blur), fokus ' + Math.round((opts.focus == null ? 0.5 : opts.focus) * 100) + '%.');
  job.status = 'rendering'; job.phase = 'render'; job.progress = 0;
  const total = selected.length;
  let done = 0;
  for (const sel of selected) {
    if (job.cancelled) return;
    const cand = job.candidates.find(c => c.index === sel.index);
    if (!cand) { job.renders.push({ index: sel.index, title: sel.title || '', status: 'error', error: 'Kandidat tidak ditemukan' }); done++; continue; }
    const title = clipperLib.cleanTitle(sel.title, 120) || cand.title || ('Klip ' + (sel.index + 1)); // judul TIDAK PERNAH kosong
    const titleText = String(sel.hookText || cand.hookText || '').trim() || title; // Teks Hook (panel Cover): teks judul yang tampil di video; kosong = judul klip
    // Geser Momen (Detail: tombol ⏪ Geser −5 dtk / ⏩ Geser +5 dtk): sel.start /
    // sel.end (hanya dikirim bila user menggeser — render biasa tidak mengirim,
    // jadi kandidat lama tidak tertimpa nilai basi) menimpa cand.start/cand.end.
    // Clamp [0, durasi sumber], end > start, DURASI TETAP (frontend menggeser
    // jendela sejauh yang bisa, bukan memendekkan klip). Disimpan ke job.json
    // lewat clipSaveJob (clipLog di bawah). Cue ABSOLUT ikut bergeser otomatis
    // (buildAss memfilter cue di [start, end] — tidak perlu ubah cue).
    if (Number.isFinite(+sel.start) && Number.isFinite(+sel.end)) {
      const dur = job.duration || 0;
      let ns = Math.max(0, +sel.start), ne = +sel.end;
      if (dur > 0) ne = Math.min(dur, ne);
      if (ne > ns) { cand.start = Math.round(ns * 100) / 100; cand.end = Math.round(ne * 100) / 100; }
    }
    // Kualitas Render (Detail / Pengaturan): sel.quality > cand.quality >
    // opts.quality > job.quality > '720p'. Disimpan ke kandidat bila dikirim.
    if (sel.quality === '720p' || sel.quality === '1080p') cand.quality = sel.quality;
    const quality = ['720p', '1080p'].includes(sel.quality) ? sel.quality : (cand.quality === '1080p' ? '1080p' : (opts.quality === '1080p' ? '1080p' : (job.quality === '1080p' ? '1080p' : '720p')));
    const outW = quality === '1080p' ? 1080 : 720, outH = quality === '1080p' ? 1920 : 1280;
    // Toggle per-klip dari Detail (Pakai Judul / CTA / Subtitle): sel > flag
    // tersimpan di kandidat > global (judul default ON, Sub ikut global).
    // (2026-10-20: CTA dihapus — showCta tidak disimpan lagi.)
    if (sel.showTitle !== undefined) cand.showTitle = !!sel.showTitle;
    if (sel.showSub !== undefined) cand.showSub = !!sel.showSub;
    if (sel.subSet !== undefined) cand.subSet = !!sel.subSet; // toggle subtitle disentuh user (persist biar OFF yang disengaja tetap OFF)
    if (sel.mode !== undefined && ['podcast', 'auto', 'landscape', 'split', 'crop11', 'gameplay'].includes(String(sel.mode))) cand.mode = String(sel.mode); // Layout per-klip (Detail tab Video) — persist biar render ulang konsisten
    // Preset Gaya Subtitle / Judul Hook (Detail): sel > tersimpan di kandidat >
    // default. Disimpan ke kandidat biar render ulang / render dari Hasil Klip
    // tetap pakai preset yang dipilih (tidak reset ke Default).
    // DEFAULT judul = 'kartu' (Kartu Klipaja: kartu putih + teks hitam
    // Montserrat, atas ~56%) — bukan 'tanpa' (judul tanpa gaya: Anton putih,
    // tanpa kartu, mudah terlihat "aneh" dan menimpa subtitle).
    if (sel.subPreset !== undefined) cand.subPreset = String(sel.subPreset || 'default');
    if (sel.hookPreset !== undefined) cand.hookPreset = String(sel.hookPreset || 'kartu');
    // Font per-klip (Edit): hanya family di CLIP_FONT_FAMILIES (validasi di lib).
    if (sel.subFont !== undefined) cand.subFont = clipperLib.clipFontOk(String(sel.subFont || '')) || undefined;
    if (sel.titleFont !== undefined) cand.titleFont = clipperLib.clipFontOk(String(sel.titleFont || '')) || undefined;
    const subPreset = sel.subPreset !== undefined ? String(sel.subPreset || 'default') : (cand.subPreset || 'default');
    const hookPreset = sel.hookPreset !== undefined ? String(sel.hookPreset || 'kartu') : (cand.hookPreset || job.hookPreset || 'kartu');
    // Durasi judul (Detail): sel > tersimpan di kandidat > default (4 detik).
    if (sel.titleDur !== undefined && ['default', 'full', 'manual', '5s', 'auto'].includes(String(sel.titleDur))) cand.titleDur = String(sel.titleDur);
    if (sel.titleDurSec !== undefined && Number.isFinite(+sel.titleDurSec)) cand.titleDurSec = Math.min(120, Math.max(0.5, +sel.titleDurSec));
    // Cover per-klip (Fase 2): teks cover + detik frame pilihan user.
    if (sel.coverText !== undefined) cand.coverText = String(sel.coverText || '').slice(0, 90);
    if (sel.coverAt !== undefined && Number.isFinite(+sel.coverAt)) cand.coverAt = Math.max(0, +sel.coverAt);
    const titleDur = sel.titleDur !== undefined ? String(sel.titleDur) : (cand.titleDur || 'default');
    const titleDurSec = sel.titleDurSec !== undefined ? +sel.titleDurSec : (cand.titleDurSec || 4);
    // Posisi/ukuran judul & subtitle per-klip (Detail, slider persen Klipaja)
    // + warna teks/kartu judul per-klip: sel > tersimpan di kandidat >
    // default. Disimpan ke kandidat biar render ulang tetap pakai setting
    // Detail (tidak reset ke global).
    const hexOr = (v, d) => /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v : d;
    if (sel.titleYPercent !== undefined && Number.isFinite(+sel.titleYPercent)) cand.titleYPercent = Math.min(100, Math.max(0, +sel.titleYPercent));
    if (sel.titleSizePercent !== undefined && Number.isFinite(+sel.titleSizePercent)) cand.titleSizePercent = Math.min(200, Math.max(50, +sel.titleSizePercent));
    if (sel.titleColor1 !== undefined) cand.titleColor1 = hexOr(sel.titleColor1, '#FFFFFF');
    if (sel.titleCardColor !== undefined) cand.titleCardColor = hexOr(sel.titleCardColor, '#FFFFFF');
    if (sel.subYPercent !== undefined && Number.isFinite(+sel.subYPercent)) cand.subYPercent = Math.min(100, Math.max(0, +sel.subYPercent));
    if (sel.subSizePercent !== undefined && Number.isFinite(+sel.subSizePercent)) cand.subSizePercent = Math.min(200, Math.max(50, +sel.subSizePercent));
    const titleYPercent = sel.titleYPercent !== undefined ? +sel.titleYPercent : (cand.titleYPercent !== undefined ? +cand.titleYPercent : 56); // default 56 (Klipaja: atas kartu ~54%)
    const titleSizePercent = sel.titleSizePercent !== undefined ? +sel.titleSizePercent : (cand.titleSizePercent !== undefined ? +cand.titleSizePercent : undefined);
    // Warna teks judul: per-klip (picker Detail) > preset > global (global
    // cuma dipakai kalau preset 'tanpa' — preset lain punya warna sendiri).
    const titleColor1 = sel.titleColor1 !== undefined ? hexOr(sel.titleColor1, undefined)
      : (cand.titleColor1 !== undefined ? cand.titleColor1 : (hookPreset === 'tanpa' ? opts.fontColor : undefined));
    const titleCardColor = sel.titleCardColor !== undefined ? hexOr(sel.titleCardColor, undefined)
      : (cand.titleCardColor !== undefined ? cand.titleCardColor : undefined);
    const subYPercent = sel.subYPercent !== undefined ? +sel.subYPercent : (cand.subYPercent !== undefined ? +cand.subYPercent : 70); // default 70 (Klipaja: atas blok subtitle ~67%)
    const subSizePercent = sel.subSizePercent !== undefined ? +sel.subSizePercent : (cand.subSizePercent !== undefined ? +cand.subSizePercent : undefined);
    const showTitle = sel.showTitle !== undefined ? !!sel.showTitle : (cand.showTitle !== undefined ? !!cand.showTitle : true);
    const showSub = sel.showSub !== undefined ? !!sel.showSub : (cand.showSub !== undefined ? !!cand.showSub : !!opts.subtitle);
    // B-roll per-klip (Detail, tab Video): sel > tersimpan di kandidat >
    // off. Disimpan ke kandidat biar Save ulang konsisten (clipLog di bawah
    // memanggil clipSaveJob, jadi field ini ikut tersimpan ke job.json).
    if (sel.broll && typeof sel.broll === 'object') {
      if (sel.broll.enabled !== undefined) cand.brollEnabled = !!sel.broll.enabled;
      if (Number.isFinite(+sel.broll.count)) cand.brollCount = Math.min(5, Math.max(0, Math.floor(+sel.broll.count)));
      if (Number.isFinite(+sel.broll.start)) cand.brollStart = Math.max(0, +sel.broll.start);
      if (Number.isFinite(+sel.broll.dur)) cand.brollDur = Math.min(60, Math.max(0.5, +sel.broll.dur));
    }
    const brollEnabled = sel.broll && typeof sel.broll === 'object' && sel.broll.enabled !== undefined ? !!sel.broll.enabled : !!cand.brollEnabled;
    const brollStart = sel.broll && typeof sel.broll === 'object' && Number.isFinite(+sel.broll.start) ? +sel.broll.start : (cand.brollStart !== undefined ? +cand.brollStart : undefined);
    const brollDur = sel.broll && typeof sel.broll === 'object' && Number.isFinite(+sel.broll.dur) ? +sel.broll.dur : (cand.brollDur !== undefined ? +cand.brollDur : undefined);
    // Setting per-preset (Edit, tab Subtitle/Judul/Video): sel > kandidat >
    // default. Disimpan ke kandidat biar render ulang konsisten.
    // Kertas: font Tegas/Ketik + 3 warna (teks/kertas/stabilo).
    if (sel.kertasFont === 'ketik' || sel.kertasFont === 'tegas') cand.kertasFont = sel.kertasFont;
    if (sel.kertasTextColor !== undefined) cand.kertasTextColor = hexOr(sel.kertasTextColor, '#1A1A1A');
    if (sel.kertasPaperColor !== undefined) cand.kertasPaperColor = hexOr(sel.kertasPaperColor, '#FFF8DC');
    if (sel.kertasHighlightColor !== undefined) cand.kertasHighlightColor = hexOr(sel.kertasHighlightColor, '#FFFF00');
    // Pill: warna pill (default biru).
    if (sel.pillColor !== undefined) cand.pillColor = hexOr(sel.pillColor, '#2563EB');
    // Kinetik: warna teks + warna kata besar.
    if (sel.kinetikTextColor !== undefined) cand.kinetikTextColor = hexOr(sel.kinetikTextColor, '#FFFFFF');
    if (sel.kinetikBigColor !== undefined) cand.kinetikBigColor = hexOr(sel.kinetikBigColor, '#FFFFFF');
    // Toggle Animasi judul (Edit, hanya preset beranimasi): sel > kandidat.
    if (sel.titleAnim !== undefined) cand.titleAnim = !!sel.titleAnim;
    const kertasFont = sel.kertasFont !== undefined ? sel.kertasFont : (cand.kertasFont || 'tegas');
    const kertasTextColor = sel.kertasTextColor !== undefined ? hexOr(sel.kertasTextColor, '#1A1A1A') : (cand.kertasTextColor || '#1A1A1A');
    const kertasPaperColor = sel.kertasPaperColor !== undefined ? hexOr(sel.kertasPaperColor, '#FFF8DC') : (cand.kertasPaperColor || '#FFF8DC');
    const kertasHighlightColor = sel.kertasHighlightColor !== undefined ? hexOr(sel.kertasHighlightColor, '#FFFF00') : (cand.kertasHighlightColor || '#FFFF00');
    const pillColor = sel.pillColor !== undefined ? hexOr(sel.pillColor, '#2563EB') : (cand.pillColor || '#2563EB');
    const kinetikTextColor = sel.kinetikTextColor !== undefined ? hexOr(sel.kinetikTextColor, '#FFFFFF') : (cand.kinetikTextColor || '#FFFFFF');
    const kinetikBigColor = sel.kinetikBigColor !== undefined ? hexOr(sel.kinetikBigColor, '#FFFFFF') : (cand.kinetikBigColor || '#FFFFFF');
    const titleAnim = sel.titleAnim !== undefined ? !!sel.titleAnim : (cand.titleAnim !== undefined ? !!cand.titleAnim : true);
    // Watermark (Edit, tab Video): sel > kandidat > off. Teks dibersihkan
    // (maks 60 karakter, satu baris), posisi bl/br/tl/tr.
    if (sel.watermark && typeof sel.watermark === 'object') {
      if (sel.watermark.enabled !== undefined) cand.watermarkEnabled = !!sel.watermark.enabled;
      if (typeof sel.watermark.text === 'string') cand.watermarkText = String(sel.watermark.text).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (['bl', 'br', 'tl', 'tr'].includes(sel.watermark.pos)) cand.watermarkPos = sel.watermark.pos;
    }
    const watermark = {
      enabled: sel.watermark && typeof sel.watermark === 'object' && sel.watermark.enabled !== undefined ? !!sel.watermark.enabled : !!cand.watermarkEnabled,
      text: sel.watermark && typeof sel.watermark === 'object' && typeof sel.watermark.text === 'string' ? String(sel.watermark.text).replace(/\s+/g, ' ').trim().slice(0, 60) : (cand.watermarkText || ''),
      pos: sel.watermark && typeof sel.watermark === 'object' && ['bl', 'br', 'tl', 'tr'].includes(sel.watermark.pos) ? sel.watermark.pos : (cand.watermarkPos || 'bl'),
    };
    // Musik Latar (Edit, tab Video): sel > kandidat > off. File di
    // clipper-work/music/<jobId>-<idx>.* (upload terpisah), volume 0-1.
    if (sel.music && typeof sel.music === 'object') {
      if (sel.music.enabled !== undefined) cand.musicEnabled = !!sel.music.enabled;
      if (Number.isFinite(+sel.music.volume)) cand.musicVolume = Math.min(1, Math.max(0, +sel.music.volume));
    }
    const musicEnabled = sel.music && typeof sel.music === 'object' && sel.music.enabled !== undefined ? !!sel.music.enabled : !!cand.musicEnabled;
    const musicVolume = sel.music && typeof sel.music === 'object' && Number.isFinite(+sel.music.volume) ? Math.min(1, Math.max(0, +sel.music.volume)) : (cand.musicVolume !== undefined ? +cand.musicVolume : 0.2);
    // Hook multi-hook (gaya Hook V2): potongan pendek dari dalam kandidat ini,
    // disambung di depan klip utama. Frontend kirim sel.hook kalau toggle hook
    // ON; kalau tidak, pakai hook AI di kandidat (kalau ada). Waktu absolut
    // (sumber) -> relatif ke awal klip (cand.start) untuk buildAss + ffmpeg.
    // Kontrak hook (22 Okt ronde-2): sel.hook === false ATAU cand.hookOn
    // === false = hook DIMATIKAN buat klip ini (dulu: [] dari halaman jatuh
    // ke fallback cand.hook -> centang proyek tidak berfungsi). Array =
    // pakai apa adanya (kosong = tidak ada hook); undefined = fallback
    // hook AI kandidat.
    if (sel.hookOn !== undefined) cand.hookOn = !!sel.hookOn;
    let hookRel = [];
    if (opts.hookEnabled !== false && sel.hook !== false && cand.hookOn !== false) {
      hookRel = clipHookRel(cand, Array.isArray(sel.hook) ? sel.hook : (cand.hook || []));
    }
    // Sensor kata (Koreksi Kata): kata yang di-sensor di rentang klip ini ->
    // rentang bisu (waktu RELATIF output = relatif klip + hookTotal, karena
    // klip utama mulai setelah hook di timeline hasil render).
    const hookTotal = hookRel.reduce((a, h) => a + (h.end - h.start), 0);
    let sensorRel = [];
    for (const cu of job.cues || []) {
      for (const w of clipperLib.cueWords(cu)) {
        if (!w.sensor) continue;
        if (w.end <= cand.start || w.start >= cand.end) continue;
        sensorRel.push({ start: Math.round((Math.max(0, w.start - cand.start) + hookTotal) * 100) / 100, end: Math.round((Math.min(cand.end, w.end) - cand.start + hookTotal) * 100) / 100 });
        if (sensorRel.length >= 20) break;
      }
      if (sensorRel.length >= 20) break;
    }
    // waktu ABSOLUT (sumber) -> relatif ke awal klip. Validasi: di dalam klip, pos 0-1.
    // Disimpan ke job.speakers (per kandidat) biar render ulang tidak perlu tandain lagi.
    let speakersRel = [];
    const speakersSent = Array.isArray(sel.speakers);
    if (speakersSent) {
      const clipLen = cand.end - cand.start;
      for (const sp of sel.speakers) {
        if (!sp || typeof sp !== 'object') continue;
        const ss = +sp.start - cand.start, se = +sp.end - cand.start, pos = +sp.pos;
        if (!Number.isFinite(ss) || !Number.isFinite(se) || !Number.isFinite(pos)) continue;
        if (ss < 0 || se > clipLen || se - ss < 0.5) continue;
        speakersRel.push({ start: Math.round(ss * 100) / 100, end: Math.round(se * 100) / 100, pos: Math.min(1, Math.max(0, pos)) });
        if (speakersRel.length >= 20) break;
      }
    }
    if (!job.speakers) job.speakers = {};
    if (speakersSent) { job.speakers[sel.index] = speakersRel; clipSaveJob(job); } // kirim (termasuk []) = pakai itu, kosong = matikan
    else if (job.speakers[sel.index]) speakersRel = job.speakers[sel.index]; // tidak kirim = pakai tandaan lama
    const outFile = path.join(job.dir, 'clip_' + sel.index + '.mp4');
    // Mode efektif klip ini: Layout per-klip (Detail, cand.mode) > mode
    // request (Pengaturan Proyek) > mode job (dari Analisis). Semua flag
    // diturunkan ULANG dari mode efektif di tiap klip — satu panggilan
    // render dengan mode beda per klip tidak bocor antar-klip.
    const effMode = cand.mode && ['podcast', 'auto', 'landscape', 'split', 'crop11', 'gameplay'].includes(cand.mode) ? cand.mode : (opts.mode != null ? opts.mode : (job.mode || null));
    opts.podcast = effMode === 'podcast' || effMode === 'auto';
    // Mode Split (2 pembicara atas-bawah): bukan Podcast (crop tunggal) —
    // panel kiri/kanan dihitung dari splitTrack (bukan faceTrack).
    opts.split = effMode === 'split';
    // Mode Crop 1:1 (kotak tengah, fill di atas-bawah) + Gameplay (game atas +
    // facecam bawah): bukan Podcast — crop-nya dihitung di buildFfmpegArgs.
    opts.crop11 = effMode === 'crop11';
    opts.gameplay = effMode === 'gameplay';
    if (opts.split && done === 0) clipLog(job, 'Mode Split aktif — 2 pembicara atas-bawah (panel kiri atas, panel kanan bawah), subtitle di sambungan.');
    if (opts.crop11 && done === 0) clipLog(job, 'Mode Crop 1:1 aktif — kotak tengah, fill ' + (opts.bg || job.bg || 'blur') + ' di atas-bawah.');
    if (opts.gameplay && done === 0) clipLog(job, 'Mode Gameplay aktif — game atas (2/3) + facecam bawah (1/3), subtitle di sambungan.');
    if (opts.bg == null && job.bg) opts.bg = job.bg;
    if (opts.focus == null && Number.isFinite(job.focus)) opts.focus = job.focus;
    const bg = ['black', 'white'].includes(opts.bg) ? opts.bg : 'blur';
    // Face tracking (Podcast + Gameplay + checkbox ON): hitung dulu — nama file
    // polos beda kalau pakai tracking (_ft) vs fokus statis, biar cache tidak ketuker.
    let faceTrack = null;
    if ((opts.podcast || opts.gameplay) && opts.faceTrack !== false) faceTrack = await clipFaceTrack(job, sel, cand);
    else if ((opts.podcast || opts.gameplay) && done === 0) clipLog(job, 'Face tracking NONAKTIF (centang \u{1F3AF} Auto face tracking di Pengaturan Proyek mati) \u2014 crop pakai fokus statis.');
    // Auto pintar (Fase 3, permintaan Dzaky): mode Auto + 2 wajah besar
    // berdampingan di banyak sampel -> JANGAN crop 1 orang; pakai Landscape
    // (muat utuh + background blur) biar dua-duanya kelihatan.
    if ((effMode === 'auto' || effMode === 'podcast') && faceTrack) { // Auto + Podcast (pilihan Dzaky 23 Okt)
      try {
        const tf = path.join(job.dir, 'clip_' + sel.index + '_facetrack.json');
        const td = JSON.parse(fs.readFileSync(tf, 'utf8'));
        const duo = clipperLib.clipDuoInfo(td.track || faceTrack, td.width || 0);
        if (duo.duo) {
          clipLog(job, '✨ Kamera 2 orang klip ' + (sel.index + 1) + ': 2 wajah berdampingan di ' + Math.round(duo.ratio * 100) + '% frame — pakai Landscape (background blur), bukan crop 1 orang.');
          faceTrack = null; opts.podcast = false;
        }
      } catch {}
    }
    // Gerbang kualitas tracking (tuning 23 Okt, permintaan Dzaky): bila
    // tracking DIMINTA tapi hasilnya jelek (tracker gagal total, atau wajah
    // jarang benar-benar di dalam jendela crop — crop meleset ke meja /
    // tempat kosong), klip ini dirender LANDSCAPE (background blur) saja.
    // Berlaku mode Podcast + Auto (mode FT). Face tracking MATI (centang
    // off) tidak kena gerbang — tetap fokus statis seperti pilihan user.
    // Framing per-bagian (Dzaky 23 Okt): JANGAN lagi satu klip penuh
    // Landscape cuma karena tracking jelek/gagal. Yang benar: bagian yang
    // ADA mukanya = crop 9:16 full muka; bagian TANPA muka (>= 1,5 dtk) =
    // Landscape. mixFaceSegs = daftar segmen muka (detik relatif klip);
    // buildFfmpegArgs mencampur dua rantai (portrait di segmen muka,
    // Landscape di luar itu). Urutan keputusan:
    //  - track gagal/timeout -> scan kehadiran ringan (--presence); muka
    //    cukup sering (>= 15%) -> track sintetis + campuran; tidak -> Landscape penuh.
    //  - track ada tapi crop sering kosong (gerbang lama) -> campuran dari
    //    kehadiran track bila muka >= 15%; tidak -> Landscape penuh.
    //  - track sehat -> campuran hanya bila ada celah tanpa wajah.
    let mixFaceSegs = null;
    if ((opts.podcast || opts.gameplay) && opts.faceTrack !== false) { // Podcast + Auto (duo Auto sudah diputus di blok Auto pintar)
      let bad = false, why = '';
      let td = null;
      try { td = JSON.parse(fs.readFileSync(path.join(job.dir, 'clip_' + sel.index + '_facetrack.json'), 'utf8')); } catch {}
      if (!faceTrack) { bad = true; why = 'tracker gagal / tidak ada track'; }
      else if (td) {
        const q = clipperLib.clipTrackQuality(td.track || faceTrack, td.cropW || 0);
        if (q.bearing >= 4 && q.faceIn < 0.5) { bad = true; why = 'wajah di dalam frame cuma ' + Math.round(q.faceIn * 100) + '%'; }
      }
      if (opts.podcast && !faceTrack) {
        const scanned = await clipFacePresence(job, sel, cand);
        if (scanned && scanned.faceRatio >= 0.15 && scanned.track && scanned.faceSegs.length) {
          faceTrack = scanned.track; mixFaceSegs = scanned.faceSegs;
          clipLog(job, '🛟 Tracking gagal — scan wajah ringan: muka terdeteksi di ' + Math.round(scanned.faceRatio * 100) + '% klip. Bagian ada muka = full frame 9:16, sisanya Landscape.');
        } else {
          clipLog(job, '🛟 Tracking wajah kurang bagus klip ' + (sel.index + 1) + ' (' + why + ') — pakai Landscape (background blur) biar aman.');
          opts.podcast = false;
        }
      } else if (opts.podcast && bad) {
        const pres = (td && Array.isArray(td.track)) ? clipperLib.clipPresenceSegs(td.track.map(p => ({ t: p.t, face: Array.isArray(p.faces) && p.faces.length > 0 })), cand.end - cand.start, td.width || 0, td.cropW || 0) : null;
        if (pres && pres.faceRatio >= 0.15 && pres.faceSegs.length) {
          mixFaceSegs = pres.faceSegs;
          clipLog(job, '🎞️ Klip ' + (sel.index + 1) + ': ' + why + ' — framing per-bagian: ada muka = full frame 9:16, tanpa muka = Landscape.');
        } else {
          clipLog(job, '🛟 Tracking wajah kurang bagus klip ' + (sel.index + 1) + ' (' + why + ') — pakai Landscape (background blur) biar aman.');
          faceTrack = null; opts.podcast = false;
        }
      } else if (opts.podcast && td && Array.isArray(td.track)) {
        const pres2 = clipperLib.clipPresenceSegs(td.track.map(p => ({ t: p.t, face: Array.isArray(p.faces) && p.faces.length > 0 })), cand.end - cand.start, td.width || 0, td.cropW || 0);
        const covered = pres2.faceSegs.reduce((a, x) => a + (x.end - x.start), 0);
        if (pres2.faceSegs.length && covered < (cand.end - cand.start) - 0.05) {
          mixFaceSegs = pres2.faceSegs;
          clipLog(job, '🎞️ Klip ' + (sel.index + 1) + ': sebagian klip tidak ada wajah — bagian itu pakai Landscape, bagian ada muka tetap full frame.');
        }
      } else if (bad && opts.gameplay) {
        // Gameplay: perilaku lama (tanpa track -> facecam fokus statis).
      }
    }
    // Face tracking Split (checkbox ON): 2 track (kiri + kanan) per klip.
    // Gagal / tidak ada 2 wajah -> null -> fallback belah dua tetap.
    let splitTrack = null;
    if (opts.split && opts.faceTrack !== false) splitTrack = await clipFaceTrackSplit(job, sel, cand);
    // Video POLOS (tanpa judul/subtitle) — cache. Nama file menyertakan mode/bg
    // + [start, end] kandidat, agar ganti bg (blur<->hitam) ATAU kandidat
    // dengan start/end berbeda (misal 30 detik vs run lama 15 detik) membuat
    // file polos baru (tidak pakai cache yang salah).
    // Mode Split masuk kunci cache ('split' / 'split_ft') agar tidak bentrok
    // dengan cache Podcast/Landscape. Mode Crop 1:1 / Gameplay juga masuk
    // kunci ('crop11' / 'gameplay' / 'gameplay_ft'). Kualitas 1080p masuk
    // kunci ('_q1080') — 720p TIDAK (kunci lama tetap kepakai, cache lama
    // tidak hangus).
    const modeKey = opts.split ? (splitTrack ? 'split_ft' : 'split') : (opts.podcast ? (faceTrack ? 'podcast_ft' : 'podcast') : (opts.crop11 ? 'crop11' : (opts.gameplay ? (faceTrack ? 'gameplay_ft' : 'gameplay') : bg)));
    const plainFile = path.join(job.dir, clipPlainFileName(sel.index, modeKey + (mixFaceSegs ? '_mix' : '') + (quality === '1080p' ? '_q1080' : ''), cand.start, cand.end));
    const rec = { index: sel.index, title, status: 'running', size: 0, plainSize: 0, plainFile: path.basename(plainFile) };
    // Render ulang klip yang sama (misal judul diedit dari hasil render) MENGGANTIKAN
    // entri lama, bukan menambah duplikat — biar hasil render tidak tampil dobel.
    job.renders = job.renders.filter(r => r.index !== sel.index);
    job.renders.push(rec);
    clipLog(job, 'Render klip ' + (done + 1) + '/' + total + ': ' + title);
    try {
      let srtPath = null;
      // .ass dibikin kalau ada judul / CTA / subtitle — judul + CTA juga dibakar
      // lewat .ass (bukan drawtext), jadi .ass harus ada meskipun subtitle OFF
      // atau tidak ada cue (kalau tidak, judul ikut hilang).
      // (2026-10-20: CTA dihapus — hasOverlay hanya judul.)
      const hasOverlay = (showTitle && !!title.trim());
      // Helper bangun .ass (dengan / tanpa hook) — kalau render hook gagal
      // (misal klip polos tanpa audio -> concat a=1 gagal), .ass di-rebuild
      // tanpa hook lalu render diulang tanpa hook (fallback, bukan gagal total).
      const buildAssFile = (useHook) => {
        if (!hasOverlay && !(showSub && job.cues && job.cues.length)) return null;
        const ass = clipperLib.buildAss(job.cues, cand.start, cand.end, {
          size: opts.subSize, marginV: opts.subMarginV, color: opts.subColor, bold: opts.subBold, font: opts.subFont,
        }, {
          title: titleText, titleColor1, titleColor2: opts.titleColor2,
          titleSize: opts.titleSize, titleY: opts.titleY, titleBold: opts.titleBold, titleFont: opts.titleFont, titleItalic: !!opts.italic,
          titleYPercent, titleSizePercent, titleCardColor, // posisi/ukuran/warna kartu judul per-klip (Detail)
          subYPercent, subSizePercent, // posisi/ukuran subtitle per-klip (Detail)
          outW, outH, // resolusi output (Kualitas Render: 720p / 1080p) — .ass diskala
          // Split: subtitle di SAMBUNGAN (y=OH/2) bila user tidak set manual.
          // Gameplay: subtitle di SAMBUNGAN (y=gameplayTopH, batas game/facecam
          // — genap, sama dengan panel di ffmpeg).
          // Judul (Kartu) tetap di atas (56%) seperti biasa.
          subCenterY: (opts.split && sel.subYPercent === undefined && cand.subYPercent === undefined) ? Math.round(outH / 2)
            : (opts.gameplay && sel.subYPercent === undefined && cand.subYPercent === undefined) ? clipperLib.gameplayTopH(outH) : undefined,
          showTitle, showSub, // toggle per-klip (Detail) — buildAss hormati (judul/subtitle tidak dibakar kalau off)
          subPreset, hookPreset, // preset Gaya Subtitle / Judul Hook (Detail) — buildAss override gaya
          subFontPick: clipperLib.clipFontOk(sel.subFont || cand.subFont || '') || undefined, // font per-klip (Edit) > preset > global
          titleFontPick: clipperLib.clipFontOk(sel.titleFont || cand.titleFont || '') || undefined,
          titleDur, titleDurSec, hookDurAi: cand.hookDurAi, // durasi judul (Detail): default 4 detik / full / manual / 5s / auto (saran AI)
          // Setting per-preset (Edit): Kertas font + 3 warna, Pill warna,
          // Kinetik 2 warna, toggle Animasi judul, Watermark (tab Video).
          kertasFont, kertasTextColor, kertasPaperColor, kertasHighlightColor,
          pillColor, kinetikTextColor, kinetikBigColor,
          titleAnim, // false = judul statis (tanpa animasi masuk)
          styleOv: clipperLib.sanitizeStyleOv(sel.styleOv || cand.styleOv), // override gaya per-klip (Fase 13 Item 7-10)
          watermark: watermark.enabled && watermark.text ? { text: watermark.text, pos: watermark.pos } : null,
          cta: { enabled: false }, // CTA dihapus 2026-10-20 — tidak di-render.
          hook: useHook ? hookRel : [],
        });
        if (!ass.trim()) return null;
        const fp = path.join(job.dir, 'clip_' + sel.index + '.ass'); fs.writeFileSync(fp, ass); return fp;
      };
      srtPath = buildAssFile(hookRel.length > 0);
      const len = cand.end - cand.start;
      const runFfmpeg = a => clipRun('ffmpeg', ['-hide_banner', '-loglevel', 'info', ...a], {
        timeout: 40 * 60 * 1000, signal: job.abortCtrl.signal, // 40 mnt (Dzaky 23 Okt: Klip 12 Mongol tahap akhir 15,5 mnt — batas 20 mnt terlalu mepet)
        onStderr: s => {
          const m = /time=(\d+):(\d{2}):(\d{2})[.,](\d{2})/.exec(s);
          if (m && len > 0) {
            const el = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
            job.progress = Math.min(99, Math.round(((done + Math.min(1, el / len)) / total) * 100));
          }
        },
      });
      // Tahap 1 — video POLOS (tanpa judul/subtitle), sekali saja (cache). Kalau file
      // polos sudah ada (dari render sebelumnya), LEWATI — render ulang judul/subtitle
      // tidak perlu re-encode video lagi (hemat CPU, sesuai permintaan user).
      const plainExists = fs.existsSync(plainFile) && fs.statSync(plainFile).size > 0;
      if (!plainExists) {
        const attempt = { simple: false, bg, blur: bg === 'blur', vcodec: 'libx264', acodec: 'aac' };
        let r = null;
        for (let tryN = 0; tryN < 6 && !job.cancelled; tryN++) {
          const args = clipperLib.buildFfmpegArgs({
            start: cand.start, end: cand.end, input: job.source, output: plainFile,
            bg: attempt.bg, plainOnly: true, simple: attempt.simple, podcast: !!opts.podcast, focus: opts.focus, faceTrack, mixFaceSegs,
            split: !!opts.split, splitTrack, // Split: 2 panel atas-bawah (per klip)
            crop11: !!opts.crop11, gameplay: !!opts.gameplay, // Crop 1:1 / Gameplay (per klip)
            outW, outH, // resolusi output (Kualitas Render: 720p / 1080p)
            videoCodec: attempt.vcodec, audioCodec: attempt.acodec,
          });
          r = await runFfmpeg(args);
          if (r.code === 0) break;
          const missing = /No such filter:\s*'([^']+)'/.exec(r.stderr || '');
          if (missing && missing[1] === 'gblur' && attempt.blur) { attempt.bg = 'black'; attempt.blur = false; clipLog(job, 'ffmpeg server tanpa filter gblur — background hitam.'); continue; }
          const unkEnc = /Unknown encoder\s*'([^']+)'/.exec(r.stderr || '');
          if (unkEnc && unkEnc[1] === 'libx264' && attempt.vcodec === 'libx264') { attempt.vcodec = 'mpeg4'; attempt.simple = true; clipLog(job, 'ffmpeg server tanpa encoder libx264 — memakai mpeg4 (kualitas lebih rendah, tetap bisa di-upload ke Shorts/TikTok).'); continue; }
          if (unkEnc && unkEnc[1] === 'aac' && attempt.acodec === 'aac') { attempt.acodec = null; clipLog(job, 'ffmpeg server tanpa encoder aac — klip tanpa suara.'); continue; }
          if (!attempt.simple) { attempt.simple = true; clipLog(job, 'Argumen polos gagal, mencoba argumen sederhana…'); continue; }
          break;
        }
        if (!r || r.code !== 0 || !fs.existsSync(plainFile)) throw new Error('ffmpeg (video polos) gagal: ' + clipFfmpegError(r ? r.stderr : ''));
        clipLog(job, 'Video polos tersimpan (' + (fs.statSync(plainFile).size / 1048576).toFixed(1) + ' MB) — render ulang nanti tidak re-encode video lagi.');
      } else {
        clipLog(job, 'Memakai video polos tersimpan — tidak re-encode video (hemat CPU).');
      }
      rec.plainSize = fs.statSync(plainFile).size;
      // Thumbnail RAW (frame terang dari video POLOS, tanpa teks ter-bake)
      // — poster kartu Detail/editor (model Klipaja: editor = RAW + overlay
      // HTML, jadi poster-nya harus RAW, bukan Final yang sudah berteks).
      // Disimpan terpisah (thumb_raw.jpg) karena thumb.jpg ditimpa Tahap 2
      // dengan frame Final (dipakai Library). Dijalankan di SEMUA jalur
      // (RAW + Final) biar thumb_raw.jpg selalu segar setelah render ulang.
      try { if (await clipMakeThumb(job, sel, plainFile, 0, cand.end - cand.start, 'clip_' + sel.index + '_thumb_raw.jpg')) rec.autoThumb = true; } catch {}
      // MODE RAW (workflow baru: Hasil Klip = polos): skip Tahap 2 (overlay
      // judul/subtitle/CTA). Render selesai = video POLOS (crop + tracking,
      // tanpa teks). Final (dengan teks) baru di-render pas Save di Template.
      // Thumbnail (dari modal Template, data URL PNG) disimpan ke file.
      if (opts.raw) {
        rec.status = 'done'; rec.size = rec.plainSize; rec.raw = true;
        if (opts.thumb && typeof opts.thumb === 'string' && opts.thumb.startsWith('data:image/png')) {
          try { const b64 = opts.thumb.split(',')[1] || ''; if (b64) { fs.writeFileSync(path.join(job.dir, 'clip_' + sel.index + '_thumb.png'), Buffer.from(b64, 'base64')); rec.thumb = true; } } catch {}
        }
        // Thumbnail utama (thumb.jpg) untuk jalur RAW = thumbnail RAW
        // (sudah dibuat di atas ke thumb_raw.jpg) — salin saja, tanpa
        // ekstrak ulang. Jalur Final: thumb.jpg ditimpa Tahap 2 (Final).
        try { const rp = path.join(job.dir, 'clip_' + sel.index + '_thumb_raw.jpg'); if (fs.existsSync(rp)) fs.copyFileSync(rp, path.join(job.dir, 'clip_' + sel.index + '_thumb.jpg')); } catch {}
        clipLog(job, 'Klip ' + (done + 1) + ' selesai (RAW, polos ' + (rec.size / 1048576).toFixed(1) + ' MB — Edit di kartu klip lalu Save untuk Final).');
        done++;
        continue;
      }
      // B-roll (Final saja, bukan RAW — RAW sudah return di atas): file
      // ter-upload (clipper-work/broll/<jobId>-<idx>.mp4) disisipkan SEBELUM
      // spawn ffmpeg Tahap 2. Default: start = tengah klip, dur = 4 detik
      // (clamp ke durasi klip). File tidak ada -> B-roll OFF (log
      // peringatan, klip tetap render tanpa B-roll).
      // Loop = ceil(durasi output / durasi footage) - 1 (finite; footage
      // pendek diulang sampai nutup output, tanpa -stream_loop -1 yang
      // bikin output jalan tak hingga). outputDur = hookTotal + clipLen
      // (jaring pengaman -t agar output tidak lebih dari durasi klip).
      let brollArg = null;
      let brollOutputDur = undefined;
      if (brollEnabled) {
        const clipLen = cand.end - cand.start;
        const bs = brollStart !== undefined ? Math.min(Math.max(0, brollStart), Math.max(0, clipLen - 0.5)) : Math.max(0, (clipLen - Math.min(4, clipLen)) / 2);
        const bd = Math.min(Math.max(0.5, brollDur !== undefined ? brollDur : 4), Math.max(0.5, clipLen - bs));
        const bpath = clipBrollPath(job.id, sel.index);
        if (fs.existsSync(bpath) && fs.statSync(bpath).size > 0) {
          const outDur = hookTotal + clipLen;
          const bDur = await clipProbeDuration(bpath);
          const loop = bDur && bDur > 0 ? Math.max(0, Math.ceil(outDur / bDur) - 1) : 1000;
          brollArg = { path: bpath, start: Math.round(bs * 100) / 100, dur: Math.round(bd * 100) / 100, clipLen, loop };
          brollOutputDur = Math.round(outDur * 100) / 100;
          clipLog(job, 'B-roll: ' + path.basename(bpath) + ' (t=' + bs.toFixed(1) + 's, ' + bd.toFixed(1) + 's, loop x' + (loop + 1) + ').');
        } else clipLog(job, 'B-roll OFF: file B-roll belum di-upload (upload dulu di Detail > tab Video) — klip tetap render tanpa B-roll.');
      }
      // Musik Latar (Final saja, bukan RAW): file ter-upload
      // (clipper-work/music/<jobId>-<idx>.*) di-mix di bawah suara utama
      // (amix, volume musicVolume). File tidak ada -> Musik OFF (log
      // peringatan, klip tetap render tanpa musik). Tanpa audio utama
      // (plainHasAudio false) -> musik dilewati (buildFfmpegArgs: musik
      // hanya dicampur bila ada audio utama).
      let musicArg = null;
      if (musicEnabled) {
        const mpath = clipMusicPath(job.id, sel.index);
        if (fs.existsSync(mpath) && fs.statSync(mpath).size > 0) {
          musicArg = { path: mpath, volume: musicVolume };
          clipLog(job, 'Musik Latar: ' + path.basename(mpath) + ' (volume ' + Math.round(musicVolume * 100) + '%).');
        } else clipLog(job, 'Musik Latar OFF: file musik belum di-upload (upload dulu di Detail > tab Video) — klip tetap render tanpa musik.');
      }
      if (opts.thumb && typeof opts.thumb === 'string' && opts.thumb.startsWith('data:image/png')) {
        try { const b64 = opts.thumb.split(',')[1] || ''; if (b64) { fs.writeFileSync(path.join(job.dir, 'clip_' + sel.index + '_thumb.png'), Buffer.from(b64, 'base64')); rec.thumb = true; } } catch {}
      }
      // Tahap 2 — timpa judul + subtitle ke video polos (encode ulang saja, tanpa
      // scale/blur/crop — jauh lebih ringan CPU-nya daripada render dari source).
      // Judul + CTA + subtitle semuanya lewat file .ass + filter subtitles
      // (tidak pakai drawtext lagi, karena ffmpeg Pi tidak punya filter itu).
      // Audio di video polos: filter hook (asplit/concat a=1) + sensor (volume
      // [0:a]/[outa]) mereferensikan stream audio — bila video polos TANPA
      // audio (sumber tanpa audio), ffmpeg gagal "Invalid argument"
      // (matches no streams) dan render GAGAL TOTAL. Probe dulu: tanpa audio
      // -> hook audio + sensor dimatikan SEBELUM render (.ass dibangun ulang
      // tanpa hook biar timing subtitle tetap pas).
      let plainHasAudio = true;
      try { plainHasAudio = await clipProbeHasAudio(plainFile); } catch {}
      if (!plainHasAudio) {
        if (hookRel.length) clipLog(job, 'Video polos tanpa audio — hook audio dimatikan (klip tetap jadi, tanpa hook).');
        if (sensorRel.length) clipLog(job, 'Video polos tanpa audio — sensor kata diabaikan (tidak ada audio yang dibisukan).');
        sensorRel = [];
        srtPath = buildAssFile(false);
      }
      const attempt = { simple: false, subs: !!srtPath, vcodec: 'libx264', acodec: 'aac', hook: plainHasAudio && hookRel.length > 0 };
      let r = null;
      for (let tryN = 0; tryN < 8 && !job.cancelled; tryN++) {
        const args = clipperLib.buildFfmpegArgs({
          input: plainFile, output: outFile, overlayOnly: true,
          hook: attempt.hook ? hookRel : [],
          speakers: speakersRel,
          hasAudio: plainHasAudio, // false = input tanpa audio -> hook video-only + sensor di-skip (lib)
          sensor: sensorRel, // kata yang di-sensor -> audio dibisukan di rentang itu
          broll: brollArg, // B-roll ter-upload (Final saja) — null = tanpa B-roll
          music: musicArg, // Musik Latar ter-upload (Final saja) — null = tanpa musik
          outputDur: brollOutputDur, // jaring pengaman -t (hanya bila B-roll)
          // Resolusi output (Kualitas Render): WAJIB dikirim — tanpa ini
          // buildFfmpegArgs default 720x1280 sehingga B-roll 1080p di-scale
          // 720x1280 (hanya menutupi pojok kiri atas frame 1080x1920) dan
          // crop speaker 1080p ikut di-downscale ke 720p.
          outW, outH,
          bg: 'black', srtPath: attempt.subs ? srtPath : null,
          fontsDir: clipFontsDir(), fontFile: clipFontFile(!!opts.italic, opts.titleBold !== false, opts.titleFont),
          fontColor: opts.fontColor, titleColor2: opts.titleColor2, title, simple: attempt.simple,
          videoCodec: attempt.vcodec, audioCodec: attempt.acodec,
          titleStyle: { size: opts.titleSize, y: opts.titleY },
          subStyle: { size: opts.subSize, marginV: opts.subMarginV, color: opts.subColor, bold: opts.subBold, font: opts.subFont },
          cta: { enabled: false }, // CTA dihapus 2026-10-20 — tidak di-render.
        });
        r = await runFfmpeg(args);
        if (r.code === 0) break;
        const missing = /No such filter:\s*'([^']+)'/.exec(r.stderr || '');
        // Hook/sensor gagal karena klip polos tanpa audio (asplit/concat/volume
        // butuh stream audio) -> matikan hook + sensor, rebuild .ass tanpa
        // hook, render ulang tanpa hook/sensor. Jaring pengaman bila probe
        // audio meleset — SEBELUMNYA hanya hook yang dimatikan (kondisi
        // attempt.hook), sehingga sensor + tanpa audio (hook off) FATAL
        // "Invalid argument" tanpa retry.
        if ((attempt.hook || sensorRel.length) && /(matches no streams|Stream map.*0:a|concat.*Invalid|asplit|atrim)/i.test(r.stderr || '')) { attempt.hook = false; sensorRel = []; srtPath = buildAssFile(false); attempt.subs = !!srtPath; clipLog(job, 'Render hook/sensor gagal (klip polos tanpa audio?) — render ulang tanpa hook + sensor (klip tetap jadi).'); continue; }
        if (missing && missing[1] === 'subtitles' && attempt.subs) { attempt.subs = false; clipLog(job, 'ffmpeg server tanpa filter subtitles — judul + CTA + subtitle tidak dibakar.'); continue; }
        const unkEnc = /Unknown encoder\s*'([^']+)'/.exec(r.stderr || '');
        if (unkEnc && unkEnc[1] === 'libx264' && attempt.vcodec === 'libx264') { attempt.vcodec = 'mpeg4'; attempt.simple = true; clipLog(job, 'ffmpeg server tanpa encoder libx264 — memakai mpeg4 (kualitas lebih rendah, tetap bisa di-upload ke Shorts/TikTok).'); continue; }
        if (unkEnc && unkEnc[1] === 'aac' && attempt.acodec === 'aac') { attempt.acodec = null; clipLog(job, 'ffmpeg server tanpa encoder aac — klip tanpa suara.'); continue; }
        if (!attempt.simple) { attempt.simple = true; clipLog(job, 'ffmpeg argumen lengkap gagal, mencoba argumen sederhana…'); continue; }
        break;
      }
      if (!r || r.code !== 0 || !fs.existsSync(outFile)) throw new Error('ffmpeg gagal: ' + clipFfmpegError(r ? r.stderr : ''));
      rec.status = 'done'; rec.size = fs.statSync(outFile).size;
      // Smart Cover (Fase 3): poster otomatis tiap Final selesai (bila skill-nya ON di proyek ini).
      if (fs.existsSync(path.join(job.dir, 'cover_' + sel.index + '.jpg'))) rec.cover = true; // cover lama tetap diakui walau record render baru
      if (job.smartCover) { const cc = cand; clipMakeCover(job, cc).then(p => { if (p) clipLog(job, '🖼️ Smart Cover: poster klip ' + (sel.index + 1) + ' dibuat otomatis.'); else clipLog(job, '🖼️ Smart Cover: poster klip ' + (sel.index + 1) + ' TIDAK dibuat (sumber polos/final tidak ketemu atau ffmpeg gagal) — buat manual dari tab Cover di Edit klip.'); }).catch(() => { try { clipLog(job, '🖼️ Smart Cover: poster klip ' + (sel.index + 1) + ' gagal dibuat (error) — buat manual dari tab Cover.'); } catch {} }); }
      else clipLog(job, '🖼️ Smart Cover nonaktif di proyek ini — poster otomatis tidak dibuat (nyalakan di Pengaturan > Skill Packs).');
      // Versi render (brief F, 22 Okt): hash dari isi ASS final + mode +
      // kualitas. ASS versi ini disimpan permanen (clip_<i>_<hash>.ass) dan
      // hash masuk nama + URL unduhan -> tidak ada unduhan versi lama.
      try {
        if (srtPath && fs.existsSync(srtPath)) {
          rec.hash = crypto.createHash('sha1').update(fs.readFileSync(srtPath)).update(String(effMode || '') + '|' + String(quality || '')).digest('hex').slice(0, 10);
          const vAss = path.join(job.dir, 'clip_' + sel.index + '_' + rec.hash + '.ass');
          if (!fs.existsSync(vAss)) fs.copyFileSync(srtPath, vAss);
          rec.assFile = path.basename(vAss);
        }
      } catch {}
      // Thumbnail otomatis dari video FINAL (dengan overlay terbakar): kartu
      // menampilkan wajah terang + kartu judul + subtitle — persis Klipaja.
      // Gagal bikin thumbnail -> render tetap sukses (thumbnail bukan
      // syarat render), endpoint /api/clipper/thumb akan coba lagi on-demand.
      try { if (await clipMakeThumb(job, sel, outFile, 0, cand.end - cand.start)) rec.autoThumb = true; } catch {}
      clipLog(job, 'Klip ' + (done + 1) + ' selesai (' + (rec.size / 1048576).toFixed(1) + ' MB).');
    } catch (e) {
      rec.status = 'error';
      if (job.cancelled) { rec.error = 'Dihentikan'; }
      else { rec.error = (e.message || String(e)).slice(0, 300); clipLog(job, 'Klip ' + (done + 1) + ' gagal: ' + rec.error); }
    }
    done++;
    job.progress = Math.round((done / total) * 100);
  }
  if (!job.cancelled) { job.status = 'done'; job.phase = 'done'; job.progress = 100; clipLog(job, 'Render selesai.'); }
  if (!job.cancelled) {
    const done = (job.renders || []).filter(r => r.status === 'done');
    if (done.length) clipNotify(job, clipRenderDoneText(job, done, opts));
  }
}
// Muat ulang proyek Clipper yang tersimpan di disk (dari deploy/restart sebelumnya).
clipRestoreJobs();
// Preview ringan (lite): salinan 360p video klip buat editor di HP —
// unduhan jauh lebih kecil + mulai putar jauh lebih cepat. Dibuat
// on-demand sekali, disimpan di samping file asli; basi bila asli lebih
// baru. Gagal buat -> pemanggil tetap pakai file asli.
const clipLiteInflight = new Map();
function clipEnsureLite(srcFile) {
  const liteFile = srcFile.replace(/\.mp4$/i, '') + '_lite.mp4';
  let stale = true;
  try { stale = !fs.existsSync(liteFile) || fs.statSync(liteFile).mtimeMs < fs.statSync(srcFile).mtimeMs; } catch { stale = true; }
  if (!stale) return Promise.resolve(liteFile);
  if (clipLiteInflight.has(liteFile)) return clipLiteInflight.get(liteFile);
  const pr = new Promise((resolve) => {
    const tmp = liteFile + '.tmp.mp4';
    let ff;
    try { ff = spawn('ffmpeg', ['-y', '-i', srcFile, '-vf', 'scale=360:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', tmp], { windowsHide: true }); }
    catch { clipLiteInflight.delete(liteFile); return resolve(null); }
    let done = false;
    const fin = (ok) => { if (done) return; done = true; clipLiteInflight.delete(liteFile); try { if (ok) fs.renameSync(tmp, liteFile); else if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} resolve(ok && fs.existsSync(liteFile) ? liteFile : null); };
    ff.on('error', () => fin(false));
    ff.on('close', (code) => fin(code === 0 && fs.existsSync(tmp)));
    setTimeout(() => { try { ff.kill(); } catch {} fin(false); }, 120000);
  });
  clipLiteInflight.set(liteFile, pr);
  return pr;
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  // no-cache: browser WAJIB revalidasi HTML tiap muat — tanpa ini heuristik
  // cache browser menyajikan index.html LAMA setelah deploy (UI "nyangkut"
  // sampai refresh manual; keluhan Dzaky 20 Okt).
  const serve = (f, type) => {
    // Gzip teks (HTML 430KB -> ~125KB): di jaringan HP Dzaky yang lambat,
    // ini yang bikin halaman terasa "ngedownload" tiap dibuka.
    const gz = /^(text\/|application\/(json|javascript))/.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const st = fs.createReadStream(path.join(__dirname, 'public', f));
    st.on('open', () => res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(gz ? { 'content-encoding': 'gzip', 'vary': 'accept-encoding' } : {}) }));
    st.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end('Tidak ditemukan'); });
    return gz ? st.pipe(zlib.createGzip()).pipe(res) : st.pipe(res);
  };
  // Login & logout selalu terbuka
  if (req.method === 'POST' && p === '/api/login') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let pw = '', user = '', mode = '', email = ''; try { const j = JSON.parse(raw); pw = j.password; user = j.user; mode = j.mode; email = j.email; } catch {}
    const u2 = normUser(user);
    const users = loadUsers();
    if (mode === 'register') {
      if (users[u2]) return send(res, 409, { error: 'Nama akun sudah dipakai, pilih nama lain atau masuk.' });
      if (!pw || pw.length < 4) return send(res, 400, { error: 'Password minimal 4 karakter.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[u2] = { salt, hash: hashPw(pw, salt), email: String(email || '').trim().slice(0, 120), created: Date.now() };
      saveUsers(users);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessCookie(sessIssue(u2), SESS_MAX) });
      return res.end(JSON.stringify({ ok: true, user: u2 }));
    }
    const rec = users[u2];
    if (rec && verifyPw(pw, rec)) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessCookie(sessIssue(u2), SESS_MAX) });
      return res.end(JSON.stringify({ ok: true, user: u2 }));
    }
    if (pwOk(pw)) { // password master: masuk ke akun mana pun; akun baru dibuat otomatis
      if (!rec) { const salt = crypto.randomBytes(16).toString('hex'); users[u2] = { salt, hash: hashPw(pw, salt), email: '', created: Date.now() }; saveUsers(users); }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessCookie(sessIssue(u2), SESS_MAX) });
      return res.end(JSON.stringify({ ok: true, user: u2 }));
    }
    return send(res, 401, { error: 'Password salah' });
  }
  if (req.method === 'GET' && p === '/reset') return serve('reset.html', 'text/html; charset=utf-8');
  // Lupa password via Resend: token sekali pakai (disimpan hash SHA-256, kedaluwarsa 1 jam)
  async function sendResetEmail(to, link) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + E.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: E.RESEND_FROM || 'onboarding@resend.dev',
        to, subject: 'Reset password Script VO Agent',
        html: '<p>Kamu meminta reset password untuk akun Script VO Agent.</p>'
          + '<p><a href="' + link + '">Klik di sini untuk buat password baru</a> (berlaku 1 jam).</p>'
          + '<p>Atau salin link ini ke browser:<br>' + link + '</p>'
          + '<p>Kalau bukan kamu yang meminta, abaikan email ini.</p>',
      }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || ('Resend HTTP ' + r.status)); }
  }
  if (req.method === 'POST' && p === '/api/forgot') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let email = '', user = ''; try { const j = JSON.parse(raw); email = j.email; user = j.user; } catch {}
    const now = Date.now();
    const ip = req.socket.remoteAddress || '';
    const hits = (forgotHits.get(ip) || []).filter(t => now - t < 3600e3);
    if (hits.length >= 5) return send(res, 429, { error: 'Terlalu banyak permintaan, coba lagi nanti.' });
    hits.push(now); forgotHits.set(ip, hits);
    const users = loadUsers();
    // Alur baru: cari akun berdasarkan email pemulihan (tanpa nama akun).
    // Fallback halaman login lama (cache): cari berdasarkan nama akun, respon generik.
    let u2 = '';
    if (email) {
      const em = String(email).trim().toLowerCase();
      u2 = Object.keys(users).find(k => (users[k].email || '').trim().toLowerCase() === em) || '';
      if (!u2) return send(res, 404, { error: 'Email tidak terdaftar.' });
    } else if (user) {
      u2 = normUser(user);
      if (!users[u2] || !users[u2].email) return send(res, 200, { ok: true, message: 'Kalau nama akun dan email pemulihan cocok, link reset sudah dikirim.' });
    } else {
      return send(res, 400, { error: 'Masukkan email.' });
    }
    const rec = users[u2];
    if (!rec || !rec.email) return send(res, 404, { error: 'Email tidak terdaftar.' });
    if (!E.RESEND_API_KEY) return send(res, 500, { error: 'Layanan email belum dikonfigurasi (RESEND_API_KEY).' });
    const token = crypto.randomBytes(32).toString('hex');
    users[u2] = { ...rec, resetHash: crypto.createHash('sha256').update(token).digest('hex'), resetExp: now + 3600e3 };
    saveUsers(users);
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = req.headers.host || ('localhost:' + PORT);
    // PUBLIC_URL (mis. https://script.dzw.my.id) dipakai sebagai dasar link reset;
    // kalau tidak diisi, pakai host dari request (mis. IP Tailscale)
    const base = (E.PUBLIC_URL || '').replace(/\/+$/, '') || (proto + '://' + host);
    const link = base + '/reset?token=' + token + '&user=' + encodeURIComponent(u2);
    try { await sendResetEmail(rec.email, link); } catch (e) { console.error('[forgot] gagal kirim email:', e.message); }
    return send(res, 200, { ok: true, message: 'Link reset sudah dikirim ke email.' });
  }
  if (req.method === 'POST' && p === '/api/reset') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let user = '', token = '', pw = '';
    try { const j = JSON.parse(raw); user = j.user; token = j.token; pw = j.password; } catch {}
    const u2 = normUser(user);
    const users = loadUsers();
    const rec = users[u2];
    const hash = token ? crypto.createHash('sha256').update(String(token)).digest('hex') : '';
    if (!rec || !rec.resetHash || rec.resetHash !== hash || Date.now() > (rec.resetExp || 0))
      return send(res, 400, { error: 'Link reset tidak valid atau sudah kedaluwarsa. Minta link baru dari halaman login.' });
    if (!pw || pw.length < 4) return send(res, 400, { error: 'Password baru minimal 4 karakter.' });
    const salt = crypto.randomBytes(16).toString('hex');
    users[u2] = { ...rec, salt, hash: hashPw(pw, salt) };
    delete users[u2].resetHash; delete users[u2].resetExp;
    saveUsers(users);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/logout') { res.writeHead(302, { location: '/', 'set-cookie': sessCookie('', 0) }); return res.end(); }
  if (!authed(req)) {
    if (p === '/' || p === '/index.html' || p === '/login') return serve('login.html', 'text/html; charset=utf-8');
    return send(res, 401, { error: 'unauthorized' });
  }
  if (p === '/login') { res.writeHead(302, { location: '/' }); return res.end(); }
  // State per akun di server (naskah tetap ada saat dibuka di HP / PC lain; akun lain tidak melihatnya)
  const stateDir = () => { const d = path.join(__dirname, 'state'); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; };
  const stateFile = u => path.join(stateDir(), encodeURIComponent(u) + '.json');
  if (req.method === 'GET' && p === '/api/whoami') return send(res, 200, { user: sessUser(req) });
  if (req.method === 'GET' && p === '/api/state') {
    try { const raw = fs.readFileSync(stateFile(sessUser(req)), 'utf8'); return send(res, 200, JSON.parse(raw)); }
    catch { return send(res, 200, { empty: true }); }
  }
  // Guard anti-hilang: state kosong (browser baru login / localStorage kehapus / fetch gagal)
  // TIDAK BOLEH menimpa state berisi. + backup .bak sebelum setiap tulis (pemulihan 1 langkah).
  const stateHasContent = s => !!(s && typeof s === 'object' && (
    String(s.topik || '').trim() || String(s.brief || '').trim() ||
    Object.values(s.out || {}).some(v => String(v || '').trim()) ||
    Object.keys(s.refs || {}).length || Object.keys(s.chat || {}).some(k => String((s.chat || {})[k] || '').trim()) ||
    Object.keys(s.log || {}).some(k => String((s.log || {})[k] || '').trim()) ||
    Object.values(s.st || {}).some(v => String(v || '').trim())));
  if (req.method === 'POST' && p === '/api/state') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) break; }
    let j; try { j = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    if (!j || typeof j !== 'object') return send(res, 400, { error: 'State harus objek' });
    const f = stateFile(sessUser(req));
    let prev = null; try { prev = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (stateHasContent(prev) && !stateHasContent(j)) {
      // State lama berisi, yang baru kosong -> TOLAK nimpa (data user selamat).
      return send(res, 200, { ok: true, kept: true, reason: 'state-kosong-ditolak' });
    }
    // Pengaturan Clipper per akun (field clipperSettings) TIDAK boleh hilang
    // karena save state Script VO (frontend Script VO tidak mengirimnya) —
    // bawa dari file lama ke state baru.
    if (prev && prev.clipperSettings && typeof prev.clipperSettings === 'object') j.clipperSettings = prev.clipperSettings;
    try {
      if (prev && stateHasContent(prev)) { try { fs.writeFileSync(f + '.bak', JSON.stringify(prev)); } catch {} }
      fs.writeFileSync(f, JSON.stringify(j));
    } catch { return send(res, 500, { error: 'Gagal menyimpan state' }); }
    return send(res, 200, { ok: true });
  }
  // ===== Library (Script & Video Library): database hasil Script VO + Clipper =====
  // Disimpan di /opt/docker (partisi gede, 28GB) — bukan di root yang 96% penuh.
  // File JSON per akun: <LIBRARY_DIR>/<user>.json. Entry: {id,type,title,topic,content|jobId,words/duration,status,createdAt}.
  // Lokasi database Library (otomatis, semua platform):
  // - LIBRARY_DIR di .env (diatur via Settings) = pakai itu.
  // - Pi (Linux + /opt/docker ada = partisi gede) = /opt/docker/hermes-vo-library.
  // - Linux lain / Windows / macOS / Docker (tanpa /opt/docker) = folder 'library' di sebelah server.js.
  //   (Docker: /app/library, di-mount ke ./library di host via docker-compose.)
  const libDefault = () => (process.platform === 'linux' && fs.existsSync('/opt/docker')) ? '/opt/docker/hermes-vo-library' : path.join(__dirname, 'library');
  const libDir = () => { const d = E.LIBRARY_DIR || libDefault(); try { fs.mkdirSync(d, { recursive: true }); return d; } catch { const f = path.join(__dirname, 'library'); try { fs.mkdirSync(f, { recursive: true }); } catch {} return f; } };
  if (req.method === 'GET' && p === '/api/library-dir') {
    const dflt = libDefault();
    return send(res, 200, { dir: libDir(), defaultDir: dflt, platform: process.platform, custom: !!E.LIBRARY_DIR });
  }
  if (req.method === 'POST' && p === '/api/library-dir') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let b = {}; try { b = JSON.parse(raw); } catch {}
    const dir = String(b.dir || '').trim();
    if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { return send(res, 400, { error: 'Folder tidak bisa dibuat / tidak bisa ditulis: ' + dir }); } }
    try { setEnvVar('LIBRARY_DIR', dir); } catch { return send(res, 500, { error: 'Gagal menyimpan .env' }); }
    process.env.LIBRARY_DIR = dir; E.LIBRARY_DIR = dir;
    return send(res, 200, { ok: true, dir: dir || libDir(), note: 'Lokasi baru langsung aktif. File lama TIDAK dipindahkan otomatis — pindahkan manual folder lama ke lokasi baru kalau mau data lama ikut.' });
  }
  const libFile = u => path.join(libDir(), encodeURIComponent(u) + '.json');
  const libLoad = u => { try { const a = JSON.parse(fs.readFileSync(libFile(u), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  const libSave = (u, arr) => { try { fs.writeFileSync(libFile(u), JSON.stringify(arr)); return true; } catch { return false; } };
  const LIB_TYPES = ['long', 'short', 'riset', 'seo', 'clipper'];
  // Hapus file video milik entri Library klip (render di folder proyek +
  // Final yang diselamatkan di folder library). Proyek + sumber TIDAK disentuh.
  function libDeleteClipFiles(it) {
    if (!it || it.type !== 'clipper') return;
    if (it.jobId) { try { const job = clipperJobs && clipperJobs.get(it.jobId); const r = job && job.renders && job.renders[it.renderIdx]; if (r && r.file && fs.existsSync(r.file)) fs.unlinkSync(r.file); } catch {} }
    for (const rel of [it.finalVideo, it.finalThumb]) {
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
      try { const f = path.join(libDir(), rel); if (f.startsWith(libDir() + path.sep) && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
  // Auto-hapus Hasil klip berumur > 1 minggu (pilihan Dzaky 23 Okt — folder
  // server lega). Hanya entri type 'clipper' (Hasil Script VO tidak ikut).
  // Jalan throttled saat GET /api/library (maks 1x/jam per user).
  const libSweepAt = new Map();
  function libSweepExpired(user) {
    try {
      const now = Date.now();
      if (now - (libSweepAt.get(user) || 0) < 3600e3) return;
      libSweepAt.set(user, now);
      const arr = libLoad(user);
      const keep = []; let changed = false;
      for (const it of arr) {
        const age = now - (+it.createdAt || now);
        if (it.type === 'clipper' && age > 7 * 24 * 3600e3) { libDeleteClipFiles(it); changed = true; continue; }
        keep.push(it);
      }
      if (changed) libSave(user, keep);
    } catch {}
  }
  if (req.method === 'GET' && p === '/api/library') {
    libSweepExpired(sessUser(req));
    const items = libLoad(sessUser(req)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const counts = {}; LIB_TYPES.forEach(t => counts[t] = items.filter(x => x.type === t).length);
    return send(res, 200, { items, counts, total: items.length });
  }
  if (req.method === 'POST' && p === '/api/library') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2e6) break; }
    let b = {}; try { b = JSON.parse(raw); } catch {}
    const type = LIB_TYPES.includes(b.type) ? b.type : null;
    if (!type) return send(res, 400, { error: 'Tipe tidak valid (long/short/riset/seo/clipper)' });
    const title = String(b.title || b.topic || '').trim().slice(0, 200) || 'Tanpa judul';
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), type, title,
      topic: String(b.topic || '').slice(0, 500), content: String(b.content || '').slice(0, 500000),
      jobId: String(b.jobId || ''), renderIdx: Number(b.renderIdx) || 0,
      thumb: String(b.thumb || '').slice(0, 500), // Thumbnail kustom (URL) — card Library pakai ini
      words: Number(b.words) || 0, duration: Number(b.duration) || 0,
      replaceKey: String(b.replaceKey || ''), status: 'baru', createdAt: Date.now() };
    const arr = libLoad(sessUser(req));
    // Auto Library (Script VO): replaceKey sama (tahap + topik) -> update entry lama,
    // bukan tambah baru (re-run / lanjut / revisi tidak bikin duplikat).
    if (entry.replaceKey) {
      const ex = arr.find(x => x.replaceKey === entry.replaceKey);
      if (ex) {
        ex.title = entry.title; ex.topic = entry.topic; ex.content = entry.content; ex.words = entry.words; ex.duration = entry.duration;
        if (!libSave(sessUser(req), arr)) return send(res, 500, { error: 'Gagal menyimpan library' });
        return send(res, 200, { ok: true, entry: ex, deduped: true });
      }
    }
    // Auto Library (Clipper): klip yang sama (jobId + renderIdx) jangan duplikat —
    // re-render update entry lama (judul/durasi), bukan tambah baru.
    if (type === 'clipper' && entry.jobId) {
      const ex = arr.find(x => x.type === 'clipper' && x.jobId === entry.jobId && x.renderIdx === entry.renderIdx);
      if (ex) {
        ex.title = entry.title; ex.duration = entry.duration; ex.topic = entry.topic;
        if (entry.thumb) ex.thumb = entry.thumb; // Thumbnail baru (re-render Final) ganti yang lama
        if (!libSave(sessUser(req), arr)) return send(res, 500, { error: 'Gagal menyimpan library' });
        return send(res, 200, { ok: true, entry: ex, deduped: true });
      }
    }
    arr.unshift(entry);
    if (!libSave(sessUser(req), arr)) return send(res, 500, { error: 'Gagal menyimpan library' });
    return send(res, 200, { ok: true, entry });
  }
  if (req.method === 'PATCH' && p === '/api/library') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let b = {}; try { b = JSON.parse(raw); } catch {}
    const status = ['baru', 'dipakai', 'diupload'].includes(b.status) ? b.status : null;
    if (!b.id || !status) return send(res, 400, { error: 'id + status (baru/dipakai/diupload) wajib' });
    const arr = libLoad(sessUser(req)); const it = arr.find(x => x.id === b.id);
    if (!it) return send(res, 404, { error: 'Entry tidak ditemukan' });
    it.status = status;
    if (!libSave(sessUser(req), arr)) return send(res, 500, { error: 'Gagal menyimpan library' });
    return send(res, 200, { ok: true, entry: it });
  }
  if (req.method === 'DELETE' && p === '/api/library') {
    const id = String(u.searchParams.get('id') || '');
    const delFile = u.searchParams.get('deleteFile') === '1';
    const arr = libLoad(sessUser(req)); const ix = arr.findIndex(x => x.id === id);
    if (ix < 0) return send(res, 404, { error: 'Entry tidak ditemukan' });
    const [it] = arr.splice(ix, 1);
    // Hapus file video render Clipper juga (kalau diminta) — proyek (sumber + job) tetap ada.
    if (delFile && it.type === 'clipper' && it.jobId) {
      try { const job = clipperJobs && clipperJobs.get(it.jobId); const r = job && job.renders && job.renders[it.renderIdx]; if (r && r.file && fs.existsSync(r.file)) fs.unlinkSync(r.file); } catch {}
      // Hapus juga file Final yang diselamatkan (clipper-final/...) bila ada.
      for (const rel of [it.finalVideo, it.finalThumb]) {
        if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
        try { const f = path.join(libDir(), rel); if (f.startsWith(libDir() + path.sep) && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      }
    }
    if (!libSave(sessUser(req), arr)) return send(res, 500, { error: 'Gagal menyimpan library' });
    return send(res, 200, { ok: true });
  }
  // Bersihkan entri Clipper yang "nyangkut": proyeknya sudah dihapus (job tidak
  // ada lagi) tapi entri Library-nya ketinggalan (orphan dari sebelum fix
  // hapus-proyek-juga-hapus-Library). Script (long/short/riset/seo) tidak
  // ikut dibersihkan (tidak terikat proyek).
  if (req.method === 'POST' && p === '/api/library/cleanup') {
    const arr = libLoad(sessUser(req));
    const kept = arr.filter(x => !(x.type === 'clipper' && x.jobId && !clipperJobs.has(String(x.jobId))));
    const removed = arr.length - kept.length;
    if (removed > 0) libSave(sessUser(req), kept);
    return send(res, 200, { ok: true, removed });
  }
  // Kelola akun sendiri (setelah masuk): lihat email, ganti password, simpan email pemulihan
  if (req.method === 'GET' && p === '/api/account') {
    const rec = loadUsers()[sessUser(req)] || {};
    return send(res, 200, { user: sessUser(req), email: rec.email || '', created: rec.created || 0 });
  }
  if (req.method === 'POST' && p === '/api/account/password') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let cur = '', next = ''; try { const j = JSON.parse(raw); cur = j.current; next = j.next; } catch {}
    const u2 = sessUser(req), users = loadUsers(), rec = users[u2];
    if (!rec) return send(res, 404, { error: 'Akun tidak ditemukan' });
    if (!verifyPw(cur, rec) && !pwOk(cur)) return send(res, 401, { error: 'Password lama salah' });
    if (!next || next.length < 4) return send(res, 400, { error: 'Password baru minimal 4 karakter' });
    const salt = crypto.randomBytes(16).toString('hex');
    users[u2] = { ...rec, salt, hash: hashPw(next, salt) };
    saveUsers(users);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/account/email') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let em = ''; try { em = JSON.parse(raw).email; } catch {}
    const u2 = sessUser(req), users = loadUsers(), rec = users[u2];
    if (!rec) return send(res, 404, { error: 'Akun tidak ditemukan' });
    em = String(em || '').trim().slice(0, 120);
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return send(res, 400, { error: 'Format email tidak valid' });
    users[u2] = { ...rec, email: em };
    saveUsers(users);
    return send(res, 200, { ok: true });
  }
  // Restart service dari dashboard (tanpa SSH): balas dulu, baru jalankan restart terpisah agar tidak ikut terbunuh.
  // Mekanisme per platform (bug lama: default '/etc/init.d/hermes-vo restart'
  // gagal diam-diam di Windows/PM2 — tidak ada `sh` / path itu — sehingga
  // tombol Restart di Settings terasa "tidak berfungsi"):
  // 1) RESTART_CMD eksplisit -> pakai itu (Pi / custom).
  // 2) Di bawah PM2 (PM2_HOME / pm_id) -> process.exit(1): PM2 auto-restart
  //    (autorestart default) — mekanisme andal di Windows + Linux.
  // 3) Linux tanpa PM2 -> service init.d (perilaku lama).
  // 4) Windows tanpa PM2 -> coba `pm2 restart hermes-vo` via pm2.cmd
  //    (best-effort, server tetap jalan bila gagal — tidak pernah membunuh
  //    server tanpa mekanisme restart).
  if (req.method === 'POST' && p === '/api/restart') {
    send(res, 200, { ok: true });
    setTimeout(() => {
      try {
        if (E.RESTART_CMD) {
          const child = spawn('sh', ['-c', 'sleep 1; ' + E.RESTART_CMD], { detached: true, stdio: 'ignore' });
          child.unref();
          return;
        }
        if (process.env.PM2_HOME || process.env.pm_id !== undefined) { process.exit(1); return; }
        if (process.platform !== 'win32') {
          const child = spawn('sh', ['-c', 'sleep 1; /etc/init.d/hermes-vo restart'], { detached: true, stdio: 'ignore' });
          child.unref();
          return;
        }
        const pm2cmd = path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd');
        if (pm2cmd && fs.existsSync(pm2cmd)) {
          const child = spawn('cmd.exe', ['/c', 'timeout /t 1 /nobreak >nul & "' + pm2cmd + '" restart hermes-vo'], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          return;
        }
        process.exit(1);
      } catch { try { process.exit(1); } catch {} }
    }, 300);
    return;
  }
  // Kunci TTS pribadi (Koneksi AI, slot API TTS) — GET tidak pernah mengembalikan key.
  if (p === '/api/my-tts-key') {
    const tu = sessUser(req).toLowerCase();
    if (req.method === 'GET') return send(res, 200, { set: !!userTtsKey(tu) });
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
      let b = {}; try { b = JSON.parse(raw); } catch {}
      const key = String(b.apiKey || '').trim();
      if (/[\r\n]/.test(key) || key.length > 2000) return send(res, 400, { error: 'API key tidak valid' });
      if (!USER_TTS_KEYS[tu]) USER_TTS_KEYS[tu] = {};
      if (key) USER_TTS_KEYS[tu].elevenlabs = key; else delete USER_TTS_KEYS[tu].elevenlabs;
      saveUserTtsKeys();
      return send(res, 200, { ok: true, set: !!key });
    }
  }
  // Gerbang TTS non-admin: engine server (9router/Gemini/Google/OpenAI/ElevenLabs
  // admin) tertutup; yang terbuka hanya ElevenLabs dengan key pribadi user.
  if (p.startsWith('/api/tts') && !isAdminUser(sessUser(req))) {
    const tu = sessUser(req);
    const myKey = userTtsKey(tu);
    const adminNote = 'Khusus akun admin — akunmu memakai API TTS milikmu sendiri (ElevenLabs, slot API TTS di Koneksi AI).';
    if (req.method === 'GET' && p === '/api/tts/engines') {
      return send(res, 200, { engines: [
        { id: 'router', label: '9router (Edge TTS gratis, dll.)', ok: false, note: adminNote },
        { id: 'gemini', label: 'Google AI Studio (Gemini TTS, gratis)', ok: false, note: adminNote },
        { id: 'google', label: 'Google Cloud TTS', ok: false, note: adminNote },
        { id: 'openai', label: 'OpenAI TTS', ok: false, note: adminNote },
        { id: 'elevenlabs', label: 'ElevenLabs (API TTS milikmu)', ok: !!myKey, note: myKey ? '' : 'Sambungkan API TTS (ElevenLabs) milikmu di menu Koneksi AI — ElevenLabs ada paket gratisnya.' },
      ] });
    }
    if (req.method === 'GET' && p === '/api/tts/voices') {
      if (u.searchParams.get('engine') !== 'elevenlabs') return send(res, 400, { error: adminNote });
      if (!myKey) return send(res, 400, { error: 'Sambungkan API TTS (ElevenLabs) milikmu dulu di menu Koneksi AI.' });
      try {
        const r = await fetch((E.ELEVEN_BASE || 'https://api.elevenlabs.io') + '/v1/voices', { headers: { 'xi-api-key': myKey }, signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.detail && j.detail.message) || 'HTTP ' + r.status);
        const cap = x => x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : '';
        const catName = c => ({ premade: 'Premade', cloned: 'Kloningan', generated: 'AI', professional: 'Pro', famous: 'Famous' }[(c || '').toLowerCase()] || (c ? cap(c) : 'Suara'));
        const voices = (j.voices || []).map(v => ({ id: v.voice_id, label: (v.labels && v.labels.gender ? cap(v.labels.gender) + ' - ' : '') + v.name + ' (' + catName(v.category) + ')' })).slice(0, 200);
        return send(res, 200, { voices, pitch: false, note: 'Gratis: 10.000 karakter/bulan untuk semua voice di daftar. Kecepatan hanya 0.7x–1.2x.' });
      } catch (e) { return send(res, 502, { error: 'ElevenLabs: ' + e.message }); }
    }
    if (req.method === 'POST' && p === '/api/tts') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4e5) return send(res, 413, { error: 'Terlalu besar' }); }
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      if (String(b.engine || '') !== 'elevenlabs') return send(res, 400, { error: adminNote });
      if (!myKey) return send(res, 400, { error: 'Sambungkan API TTS (ElevenLabs) milikmu dulu di menu Koneksi AI (slot API TTS).' });
      if (!String(b.text || '').trim()) return send(res, 400, { error: 'Teks kosong' });
      if (!String(b.voice || '').trim()) return send(res, 400, { error: 'Pilih suara dulu' });
      const id = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const job = { id, status: 'running', done: 0, total: 0, ts: Date.now(), stopped: false };
      userTtsJobs.set(id, job);
      userTtsSynth(job, b, myKey).catch(e => { job.status = 'error'; job.error = job.stopped ? 'Dibatalkan oleh pengguna' : (e.message || String(e)); });
      return send(res, 200, { id });
    }
    if (req.method === 'GET' && p === '/api/tts/status') {
      const j = userTtsJobs.get(u.searchParams.get('id') || '');
      return j ? send(res, 200, { status: j.status, done: j.done, total: j.total, error: j.error || null, bytes: j.bytes || 0, format: j.format || 'mp3' }) : send(res, 404, { error: 'Proses tidak ditemukan (server mungkin restart)' });
    }
    if (req.method === 'GET' && p === '/api/tts/audio') {
      const a = userTtsAudios.get(u.searchParams.get('id') || '');
      if (!a) return send(res, 404, { error: 'Audio tidak ditemukan atau sudah kedaluwarsa' });
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': a.buf.length, 'cache-control': 'no-store' }); res.end(a.buf); return;
    }
    if (req.method === 'POST' && p === '/api/tts/stop') {
      const j = userTtsJobs.get(u.searchParams.get('id') || '');
      if (j && j.status === 'running') j.stopped = true;
      return send(res, 200, { ok: true, stopped: j ? 1 : 0 });
    }
    return send(res, 403, { error: adminNote });
  }
  if (await tts.route(req, res, u, p)) return;
  if (req.method === 'GET' && (p === '/' || p === '/index.html'))
    return serve('index.html', 'text/html; charset=utf-8');
  // Font Flufclip (Google Fonts / OFL) untuk @font-face preview: GET /fonts/<file>
  // — hanya file .ttf/.otf di public/fonts (basename guard, tanpa path traversal).
  if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/fonts/')) {
    let fname = '';
    try { fname = decodeURIComponent(p.slice('/fonts/'.length)); } catch { fname = ''; }
    if (!fname || fname !== path.basename(fname) || !/\.(ttf|otf)$/i.test(fname)) { res.writeHead(404); return res.end('Tidak ditemukan'); }
    fs.readFile(path.join(__dirname, 'public', 'fonts', fname), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Tidak ditemukan'); }
      res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=2592000', 'content-length': buf.length });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }
  // Aset vendor (JASSUB/libass-wasm) untuk preview editor: GET /vendor/<path>
  // — hanya dari public/vendor, guard traversal, tipe per ekstensi.
  // (22 Okt: rute ini belum ada -> /vendor/* selalu 404 walau file ada.)
  if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/vendor/')) {
    let rel = '';
    try { rel = decodeURIComponent(p.slice('/vendor/'.length)); } catch { rel = ''; }
    const base = path.join(__dirname, 'public', 'vendor');
    const fp = path.join(base, rel);
    const VTYPES = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
    const vtype = VTYPES[path.extname(fp).toLowerCase()];
    if (!rel || !vtype || !fp.startsWith(base + path.sep)) { res.writeHead(404); return res.end('Tidak ditemukan'); }
    // Cache keras: URL mesin berversi (?v=N di halaman) — aman disimpan
    // peramban setahun penuh. Tanpa ini, HP mengunduh ulang 2,3MB mesin
    // tiap buka editor -> start worker/wasm bisa >30 dtk di 4G (timeout).
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Tidak ditemukan'); }
      res.writeHead(200, { 'content-type': vtype, 'cache-control': 'public, max-age=31536000, immutable', 'content-length': buf.length });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/health') {
    const hUser = sessUser(req);
    if (!isAdminUser(hUser)) {
      // Non-admin: hanya provider miliknya sendiri; 9router/kunci bawaan server disembunyikan.
      const direct = {};
      for (const [slug, c] of Object.entries(userCustom(hUser))) {
        direct['custom:' + slug] = c.apiKey ? { ok: true, model: c.model || '', name: c.name, custom: true, baseUrl: c.baseUrl }
          : { ok: false, model: c.model || '', name: c.name, custom: true, baseUrl: c.baseUrl, reason: 'key belum' };
      }
      return send(res, 200, { mode: 'direct', admin: false,
        router: { ok: false, reason: 'khusus akun admin', host: '', url: '' }, routerPc: { ok: false, reason: 'khusus akun admin', host: '', url: '' },
        direct, elevenlabs: { ok: false, reason: 'khusus akun admin' }, groq: { ok: false, reason: 'khusus akun admin' }, ...direct });
    }
    const direct = Object.fromEntries(Object.keys(KEY).map(k => {
      const ok = hasKey(E[KEY[k]]);
      return [k, ok ? { ok, model: M[k] } : { ok, model: M[k], reason: 'key belum' }];
    }));
    for (const [slug, c] of Object.entries(CUSTOM)) {
      const ok = hasKey(E[c.envVar]);
      direct['custom:' + slug] = ok ? { ok, model: c.model || '', name: c.name, custom: true, baseUrl: c.baseUrl }
        : { ok, model: c.model || '', name: c.name, custom: true, baseUrl: c.baseUrl, reason: 'key belum' };
    }
    // Probe keterjangkauan (bukan hanya konfigurasi): Pi/PC mati -> ok:false.
    // Paralel agar health tidak menunggu 2x timeout bila keduanya mati.
    const [router, routerPc] = await Promise.all([probeRouter('pi'), probeRouter('pc')]);
    const elevenlabsOk = hasKey(E.ELEVENLABS_API_KEY), groqOk = hasKey(E.GROQ_API_KEY);
    return send(res, 200, { admin: true, mode: R ? 'router' : 'direct', router, routerPc, direct,
      elevenlabs: elevenlabsOk ? { ok: true } : { ok: false, reason: 'key belum' },
      groq: groqOk ? { ok: true } : { ok: false, reason: 'key belum' }, ...direct,
      // legacy fields agar dashboard lama tetap jalan:
      ...(R ? { host: router.host, url: router.url } : {}) });
  }
  // Simpan API key ke .env dari dashboard (login-protected; nilai key tidak pernah dikembalikan ke browser)
  const ENV_KEYS = { GEMINI_API_KEY: 1, ANTHROPIC_API_KEY: 1, OPENAI_API_KEY: 1, ELEVENLABS_API_KEY: 1, GROQ_API_KEY: 1, ROUTER_API_KEY: 1, ROUTER_URL: 1, ROUTER_API_KEY_PC: 1, ROUTER_URL_PC: 1, RESEND_API_KEY: 1, RESEND_FROM: 1, PUBLIC_URL: 1 };
  function setEnvVar(name, value) {
    const file = path.join(__dirname, '.env');
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch {}
    const esc = /[\s#'"\\]/.test(value) ? '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : value;
    const line = name + '=' + esc;
    let found = false;
    lines = lines.map(l => { if (new RegExp('^\\s*' + name + '\\s*=').test(l)) { found = true; return line; } return l; });
    if (!found) lines.push(line);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, file);
  }
  if (req.method === 'POST' && p === '/api/key') {
    if (!isAdminUser(sessUser(req))) return send(res, 403, { error: 'Kunci server hanya bisa diubah akun admin. Tambahkan AI kamu sendiri lewat tombol + Tambah AI di Koneksi AI.' });
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let name = '', value = '';
    try { const j = JSON.parse(raw); name = j.name; value = j.value; } catch {}
    if (!ENV_KEYS[name]) return send(res, 400, { error: 'Nama variabel tidak diizinkan' });
    value = String(value == null ? '' : value).trim();
    if (/[\r\n]/.test(value) || value.length > 2000) return send(res, 400, { error: 'Nilai tidak valid' });
    if ((name === 'ROUTER_URL' || name === 'ROUTER_URL_PC') && value && !/^https?:\/\/.+/i.test(value)) return send(res, 400, { error: 'ROUTER_URL harus diawali http:// atau https://' });
    try { setEnvVar(name, value); } catch { return send(res, 500, { error: 'Gagal menyimpan .env' }); }
    return send(res, 200, { ok: true });
  }
  // Provider AI custom (tombol + di Koneksi AI): key -> .env, definisi -> custom-providers.json.
  // Key langsung aktif (process.env di-set juga), tanpa restart.
  const saveCustom = () => { try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(Object.values(CUSTOM), null, 2)); } catch {} };
  if (req.method === 'POST' && p === '/api/custom-provider') {
    const cpUser = sessUser(req);
    if (!isAdminUser(cpUser)) {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
      let b = {}; try { b = JSON.parse(raw); } catch {}
      const name = String(b.name || '').trim().slice(0, 60);
      const apiKey = String(b.apiKey || '').trim();
      const baseUrl = String(b.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(b.model || '').trim().slice(0, 120);
      if (!name) return send(res, 400, { error: 'Nama AI wajib diisi' });
      if (/[\r\n]/.test(apiKey) || apiKey.length > 2000) return send(res, 400, { error: 'API key tidak valid' });
      if (!/^https?:\/\/.+/i.test(baseUrl)) return send(res, 400, { error: 'Base URL harus diawali http:// atau https://' });
      if (!model) return send(res, 400, { error: 'Model wajib diisi' });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom';
      if (slug === 'gemini' || slug === 'claude' || slug === 'openai') return send(res, 400, { error: 'Nama ini bentrok dengan provider bawaan' });
      const ukey = cpUser.toLowerCase();
      if (!USER_PROVIDERS[ukey]) USER_PROVIDERS[ukey] = {};
      const prev = USER_PROVIDERS[ukey][slug];
      if (!apiKey && !prev) return send(res, 400, { error: 'API key wajib diisi untuk AI baru' });
      USER_PROVIDERS[ukey][slug] = { slug, name, baseUrl, model, apiKey: apiKey || (prev && prev.apiKey) || '' };
      saveUserProviders();
      return send(res, 200, { ok: true, slug, provider: { slug, name, baseUrl, model } });
    }
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let b = {}; try { b = JSON.parse(raw); } catch {}
    const name = String(b.name || '').trim().slice(0, 60);
    const apiKey = String(b.apiKey || '').trim();
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/$/, '');
    const model = String(b.model || '').trim().slice(0, 120);
    if (!name) return send(res, 400, { error: 'Nama AI wajib diisi' });
    if (/[\r\n]/.test(apiKey) || apiKey.length > 2000) return send(res, 400, { error: 'API key tidak valid' });
    if (!/^https?:\/\/.+/i.test(baseUrl)) return send(res, 400, { error: 'Base URL harus diawali http:// atau https://' });
    if (!model) return send(res, 400, { error: 'Model wajib diisi' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom';
    if (slug === 'gemini' || slug === 'claude' || slug === 'openai') return send(res, 400, { error: 'Nama ini bentrok dengan provider bawaan' });
    // Edit mode: key kosong = jangan diubah (pakai key lama). Tambah baru: key wajib.
    if (!apiKey && !CUSTOM[slug]) return send(res, 400, { error: 'API key wajib diisi untuk AI baru' });
    const envVar = 'CUSTOM_' + slug.toUpperCase().replace(/-/g, '_') + '_API_KEY';
    if (apiKey) { try { setEnvVar(envVar, apiKey); } catch { return send(res, 500, { error: 'Gagal menyimpan .env' }); } process.env[envVar] = apiKey; } // aktif langsung, tanpa restart
    CUSTOM[slug] = { slug, name, baseUrl, model, envVar };
    KEY['custom:' + slug] = envVar; M['custom:' + slug] = model;
    call['custom:' + slug] = (msgs, job) => customCall(slug, msgs, job);
    saveCustom();
    return send(res, 200, { ok: true, slug, provider: CUSTOM[slug] });
  }
  if (req.method === 'DELETE' && p === '/api/custom-provider') {
    const slug = String(u.searchParams.get('slug') || '').trim();
    const cdUser = sessUser(req);
    if (!isAdminUser(cdUser)) {
      const ukey2 = cdUser.toLowerCase();
      if (!USER_PROVIDERS[ukey2] || !USER_PROVIDERS[ukey2][slug]) return send(res, 404, { error: 'Provider tidak ditemukan' });
      delete USER_PROVIDERS[ukey2][slug];
      saveUserProviders();
      return send(res, 200, { ok: true });
    }
    if (!CUSTOM[slug]) return send(res, 404, { error: 'Provider tidak ditemukan' });
    const envVar = CUSTOM[slug].envVar;
    delete CUSTOM[slug]; delete KEY['custom:' + slug]; delete M['custom:' + slug]; delete call['custom:' + slug];
    try { setEnvVar(envVar, ''); } catch {}
    delete process.env[envVar];
    saveCustom();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/models') {
    if (!isAdminUser(sessUser(req))) return send(res, 200, { models: [] }); // 9router khusus admin
    // ?router=pi|pc (default pi). Router yang dipilih down -> 502 seperti
    // sebelumnya (tanpa fallback otomatis — user pilih manual via dropdown).
    const which = routerWhich(u.searchParams.get('router'));
    const base = routerBase(which);
    if (!base) return send(res, 200, { models: [] });
    try {
      const r = await fetch(base + '/v1/models', { headers: routerHeaders(which), signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || j.error || 'HTTP ' + r.status);
      if (!Array.isArray(j.data)) throw new Error('Respons /v1/models bukan daftar model (status ' + r.status + ')');
      const models = j.data.map(m => ({ id: m.id, owned_by: m.owned_by || '' }))
        .sort((a, b) => (b.owned_by === 'combo') - (a.owned_by === 'combo') || a.id.localeCompare(b.id));
      send(res, 200, { models });
    } catch (e) { send(res, 502, { error: e.message }); }
    return;
  }
  if (req.method === 'GET' && p === '/api/job') {
    const j = jobs.get(u.searchParams.get('id'));
    if (!j) return send(res, 404, { error: 'Pekerjaan tidak ditemukan (server mungkin restart)' });
    return send(res, 200, j.status === 'running' ? { status: 'running', chars: j.chars } : j);
  }
  if (req.method === 'POST' && p === '/api/stop') {
    const j = jobs.get(u.searchParams.get('id'));
    if (j && j.status === 'running') { j.stopped = true; j.ctrl.abort(); }
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/refs') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) return send(res, 413, { error: 'Terlalu besar' }); }
    try {
      const urls = (Array.isArray(JSON.parse(raw).urls) ? JSON.parse(raw).urls : []).filter(x => typeof x === 'string').slice(0, 5);
      send(res, 200, { refs: await Promise.all(urls.map(u => refs.fetchRef(u))) });
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }
  if (req.method === 'POST' && p === '/api/run') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2e6) return send(res, 413, { error: 'Teks terlalu besar' }); }
    try {
      const { provider, prompt, messages, model, route } = JSON.parse(raw);
      const msgs = Array.isArray(messages) && messages.length
        ? messages.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
        : (typeof prompt === 'string' && prompt.trim() ? [{ role: 'user', content: prompt }] : []);
      if (!msgs.length) return send(res, 400, { error: 'Prompt kosong' });
      const mdl = model || E.ROUTER_MODEL;
      // OPSI JALUR MULTI-PROVIDER: 'direct' = Direct Official API Key,
      // 'router' (lama) / 'router-pi' = 9router Pi, 'router-pc' = 9router PC.
      // Jika route tidak dikirim, pakai perilaku lama (global R = Pi).
      const useRouter = route === 'router' || route === 'router-pi' || route === 'router-pc' ? true : route === 'direct' ? false : !!R;
      const rWhich = routerWhich(route);
      const runUser = sessUser(req);
      const runAdmin = isAdminUser(runUser);
      const ownSlug = (typeof provider === 'string' && provider.startsWith('custom:')) ? provider.slice(7) : '';
      if (!runAdmin) {
        if (useRouter || !ownSlug || !userCustom(runUser)[ownSlug]) {
          return send(res, 400, { error: 'Akunmu belum punya koneksi AI yang bisa dipakai untuk jalur ini. Tambahkan API key / base URL kamu di menu Koneksi AI (tombol + Tambah AI), lalu pilih provider itu (Direct).' });
        }
      } else if (useRouter) {
        if (rWhich === 'pc' && !RPC) return send(res, 400, { error: 'ROUTER_URL_PC belum diisi di .env untuk jalur 9router PC' });
        if (rWhich === 'pi' && !R) return send(res, 400, { error: 'ROUTER_URL belum diisi di .env untuk jalur 9router' });
        if (!mdl) return send(res, 400, { error: 'Pilih model atau combo untuk tahap ini' });
      } else {
        if (!call[provider]) return send(res, 400, { error: 'Provider tidak dikenal' });
        if (!E[KEY[provider]]) return send(res, 400, { error: KEY[provider] + ' belum diisi di .env — isi lalu restart server agar langsung aktif' });
      }
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const job = { status: 'running', chars: 0, partial: '', ts: Date.now() };
      Object.defineProperty(job, 'ctrl', { value: new AbortController(), enumerable: false });
      jobs.set(id, job);
      const timer = setTimeout(() => job.ctrl.abort(), LIMIT);
      (useRouter ? viaRouter(mdl, msgs, job, rWhich) : (runAdmin ? call[provider](msgs, job) : userCustomCall(runUser, ownSlug, msgs, job)))
        .then(t => { job.status = 'done'; job.text = t; })
        .catch(e => {
          const a = abortErr(e, job) || e;
          job.status = 'error'; job.error = a.message; job.code = a.status || null; job.kind = a.kind || null;
        })
        .finally(() => clearTimeout(timer));
      send(res, 200, { id });
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }
  // Tahap 1 — Input YouTube: simpan video ke server (info + download). Tombol
  // "Simpan video ke server". Video baru = ganti video lama (job + folder dihapus).
  if (req.method === 'POST' && p === '/api/clipper/input') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const user = sessUser(req);
    const url = String(b.url || '').trim();
    if (!clipperLib.isYoutubeUrl(url)) return send(res, 400, { error: 'Link harus URL YouTube (youtube.com / youtu.be).' });
    for (const j of clipperJobs.values()) if (j.user === user && (j.status === 'running' || j.status === 'rendering')) return send(res, 409, { error: 'Masih ada proses clipper berjalan. Tunggu selesai atau hapus dulu.' });
    // Proyek baru = job baru (folder sendiri). Proyek lama TIDAK dihapus —
    // hanya hapus manual (tombol Hapus di daftar proyek / Hapus Semua) yang menghapus.
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const dir = path.join(clipUserDir(user), id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return send(res, 500, { error: 'Gagal membuat folder kerja' }); }
    const job = { id, user, ts: Date.now(), status: 'running', phase: 'info', progress: 0, error: null, log: [], candidates: [], renders: [], cues: [], videoTitle: '', duration: 0, dir, source: null, sourceReady: false, sourceUrl: url, metaDesc: '', metaUploader: '', sourceCleaned: false, cancelled: false, abortCtrl: new AbortController(), aiCtrl: null };
    clipperJobs.set(id, job);
    clipInputYoutube(job, url);
    clipNotify(job, '🔗 Link diterima: ' + clipTrunc(url, 80) + ' — mulai download…');
    return send(res, 200, { id });
  }
  // "🔄 Coba Lagi" untuk proyek GAGAL di tahap input (download/info):
  // jalankan ulang download proyek yang SAMA (jobId sama, tanpa buat proyek
  // baru, tanpa duplikat). Gagal di tahap Analisis -> frontend pakai ulang
  // endpoint /api/clipper/analyze dengan jobId yang sama (sudah mendukung).
  // Upload (tanpa sourceUrl) yang gagal input tidak bisa dicoba lagi dari
  // link — user upload ulang filenya (Buat Klip baru).
  if (req.method === 'POST' && p === '/api/clipper/retry') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (job.status === 'running' || job.status === 'rendering') return send(res, 409, { error: 'Masih ada proses clipper berjalan. Tunggu selesai atau hapus dulu.' });
    if (job.sourceReady && job.source && fs.existsSync(job.source)) return send(res, 400, { error: 'Video sudah tersimpan — pakai Analisis (bukan Coba Lagi download).' });
    if (!job.sourceUrl) return send(res, 400, { error: 'Proyek upload yang gagal tidak bisa dicoba lagi — upload ulang filenya di Buat Klip.' });
    try { if (job.source) fs.unlinkSync(job.source); } catch {}
    job.status = 'running'; job.phase = 'info'; job.progress = 0; job.downloadPct = 0;
    // LOG TIDAK di-reset (sama seperti Analisis): seluruh log job dipersist +
    // ditampilkan semua fasenya — percobaan unduh yang gagal tetap terlihat,
    // ditandai pemisah sebelum percobaan baru.
    job.error = null; job.candidates = []; job.renders = [];
    if (job.log && job.log.length) clipLog(job, '── Coba Lagi (unduh ulang) ──');
    job.source = null; job.sourceReady = false; job.sourceHeight = 0;
    job.cancelled = false; job.abortCtrl = new AbortController(); job.aiCtrl = null; job.ts = Date.now();
    clipInputYoutube(job, job.sourceUrl);
    return send(res, 200, { id: job.id, stage: 'input' });
  }
  // Tahap 1b — Input file upload: body mentah (binary video), nama file di header
  // x-filename (encodeURIComponent). Tombol "Upload video". File di-stream ke disk
  // (tanpa buffer di memori), cap 2GB, lalu dicek durasinya.
  if (req.method === 'POST' && p === '/api/clipper/upload') {
    const user = sessUser(req);
    let filename = 'video.mp4';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'video.mp4')).slice(0, 200) || 'video.mp4'; } catch {}
    const ext = (filename.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    if (!['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp'].includes(ext)) return send(res, 400, { error: 'Format video tidak didukung (pakai mp4/mov/mkv/webm/avi).' });
    for (const j of clipperJobs.values()) if (j.user === user && (j.status === 'running' || j.status === 'rendering')) return send(res, 409, { error: 'Masih ada proses clipper berjalan. Tunggu selesai atau hapus dulu.' });
    // Proyek baru = job baru (folder sendiri). Proyek lama TIDAK dihapus.
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const dir = path.join(clipUserDir(user), id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return send(res, 500, { error: 'Gagal membuat folder kerja' }); }
    const job = { id, user, ts: Date.now(), status: 'running', phase: 'upload', progress: 0, error: null, log: [], candidates: [], renders: [], cues: [], videoTitle: '', duration: 0, dir, source: null, sourceReady: false, sourceUrl: null, metaDesc: '', metaUploader: 'Upload', sourceCleaned: false, cancelled: false, abortCtrl: new AbortController(), aiCtrl: null };
    clipperJobs.set(id, job);
    const dest = path.join(dir, 'source.' + ext);
    const ws = fs.createWriteStream(dest);
    req.pipe(ws);
    await new Promise(resolve => { ws.on('finish', resolve); ws.on('error', resolve); req.on('error', resolve); });
    const written = (() => { try { return fs.statSync(dest).size; } catch { return 0; } })();
    if (written > 2 * 1024 * 1024 * 1024 || !fs.existsSync(dest)) {
      try { fs.unlinkSync(dest); } catch {}
      job.status = 'error'; job.error = 'File melebihi batas 2GB.';
      clipLog(job, 'Gagal: ' + job.error);
      clipNotifyFail(job);
      return send(res, 413, { error: 'File melebihi batas 2GB.' });
    }
    clipNotify(job, '📤 File diterima: ' + clipTrunc(filename, 80) + ' — mulai diproses…');
    job.source = dest;
    if (job.cancelled) { try { fs.unlinkSync(dest); } catch {} return send(res, 400, { error: 'Dihentikan oleh pengguna' }); }
    await clipInputUpload(job, filename);
    if (job.status === 'error') return send(res, 400, { error: job.error || 'Upload gagal' });
    return send(res, 200, { id });
  }
  // Tahap 2 — Analisis: pakai video yang SUDAH tersimpan (tanpa download ulang).
  // Tombol "Analisis AI". Kalau analisis gagal (misal AI 410), ganti AI lalu klik
  // Analisis lagi — video tidak didownload ulang.
  if (req.method === 'POST' && p === '/api/clipper/analyze') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const user = sessUser(req);
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== user) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan. Simpan video dulu (tombol Simpan video ke server / Upload video).' });
    if (job.status === 'running' || job.status === 'rendering') return send(res, 409, { error: 'Masih ada proses clipper berjalan. Tunggu selesai atau hapus dulu.' });
    if (!job.sourceReady || !job.source || !fs.existsSync(job.source)) return send(res, 400, { error: 'Video belum tersimpan di server. Klik Simpan video ke server / Upload video dulu.' });
    const duration = [15, 30, 60, 90, 120].includes(b.duration) ? b.duration : 30; // durasi klip: 15 / 30 / 60 / 90 / 120 detik (preset gaya Klipaja)
    const countAll = b.count === 'all'; // opsi '✨ Semua klip bagus' (permintaan Dzaky 23 Okt)
    const count = countAll ? 30 : clipperLib.clampInt(b.count, 1, 6, 3);
    job.countAll = countAll;
    const provider = (['gemini', 'claude', 'openai', ...Object.keys(CUSTOM).map(s => 'custom:' + s)].includes(b.provider) ? b.provider : 'claude');
    const model = String(b.model || '').slice(0, 200);
    const route = ['router', 'router-pi', 'router-pc', 'direct', 'none'].includes(b.route) ? b.route : null;
    // Mode project (dipilih di Pengaturan Proyek SEBELUM Analisis): Podcast (crop penuh),
    // Landscape (bg blur/hitam/putih, = Fit Penuh Klipaja), Auto (= Podcast + face tracking + fallback fokus),
    // Split (2 pembicara atas-bawah, caption di sambungan), Crop 1:1 (kotak tengah),
    // atau Gameplay (game atas + facecam bawah).
    // Disimpan ke job, dipakai render.
    job.mode = ['landscape', 'auto', 'split', 'crop11', 'gameplay'].includes(b.mode) ? b.mode : 'podcast';
    // Momen (sumber kandidat): 'ai' (Jalur AI: 9router/Direct — route dipakai),
    // 'loudest' (Paling Keras, deteksi suara — mengalahkan route),
    // 'heatmap' (Most Replayed YouTube — fallback ke Paling Keras bila tidak ada).
    // Tanpa nilai -> ikut route (route 'none' = loudest, selainnya = ai).
    job.moment = ['ai', 'loudest', 'heatmap'].includes(b.moment) ? b.moment : (route === 'none' ? 'loudest' : 'ai');
    job.aiNote = String(b.aiNote || '').slice(0, 500); // Instruksi AI per proyek (opsional, dari Pengaturan Proyek)
    job.bg = ['black', 'white'].includes(b.bg) ? b.bg : 'blur';
    job.focus = clipperLib.clampInt(b.focus, 0, 100, 50) / 100;
    job.faceTrack = b.faceTrack !== false;
    job.smartCover = !!b.smartCover; // Skill Smart Cover (Fase 3): poster otomatis tiap Final
    job.titleDurDefault = ['auto', '5s', 'full'].includes(b.titleDurDefault) ? b.titleDurDefault : null; // Skill Smart Hook (Fase 3): durasi judul bawaan kandidat baru
    job.quality = b.quality === '1080p' ? '1080p' : '720p'; // Kualitas Render (Pengaturan, default 720p)
    // Kartu judul (dropdown Kartu di Buat Klip, gaya Klipaja): preset judul
    // default untuk semua kandidat dari analisis ini (Edit per-klip bisa
    // mengubahnya lagi). Validasi ke daftar HOOK_PRESETS (lib).
    job.hookPreset = ['tanpa', 'kartu', 'sinema', 'keramat', 'notifchat', 'glitch', 'ketik', 'boom', 'kutipan', 'slide', 'gulung', 'stiker', 'layar', 'berita', 'stabilo', 'catatan', 'classic'].includes(b.hookPreset) ? b.hookPreset : 'kartu';
    job.autoRender = !!b.autoRender; // tombol "Analisis & Render": analisis selesai -> render otomatis (server-side, tahan reload)
    job.transcribeVia = clipNormTranscribeVia(b.transcribeVia); // Transkrip: 'groq' (cloud, cepat) / 'local' (whisper-cli) / 'auto' (Groq dulu, lalu lokal, lalu caption YouTube)
    job.transcriptLang = ['id', 'en', 'auto'].includes(b.transcriptLang) ? b.transcriptLang : 'auto'; // Bahasa transkrip: 'id' (default UI) / 'en' / 'auto' (tanpa nilai = auto-detect, perilaku lama)
    // Render ulang = TAMBAH klip, bukan ganti (permintaan Dzaky 20 Okt): kandidat
    // + render LAMA DIPERTAHANKAN. Analisis baru meng-append kandidat (indeks
    // baru melanjutkan yang tertinggi, dicap batch + setting) lewat
    // clipAppendCandidates, lalu autoRender hanya merender kandidat baru —
    // jadi hasil tiap setting Pengaturan Proyek bisa dibandingkan berdampingan.
    // Transkrip (job.cues) TIDAK di-reset: kalau Whisper sudah berhasil di
    // Analisis sebelumnya, transkripnya dipakai lagi (clipAnalyzeSaved), jadi
    // Analisis ulang setelah AI gagal tidak mengulang Whisper yang lambat.
    // LOG TIDAK di-reset: seluruh log job (unduh + analisis + render) dipersist
    // + ditampilkan semua fasenya — sebelumnya `job.log = []` menghapus baris
    // fase unduh sehingga setelah reload panel log hanya menampilkan fase
    // Analisis. Analisis ulang cukup ditandai pemisah.
    // Controller abort baru (yang lama mungkin sudah diabort oleh Stop sebelumnya).
    job.error = null; job.progress = 0;
    if (job.log && job.log.length) clipLog(job, '── Analisis baru ──');
    job.status = 'running'; job.phase = 'transcript'; job.ts = Date.now();
    job.cancelled = false; job.abortCtrl = new AbortController(); job.aiCtrl = null;
    clipAnalyzeSaved(job, duration, count, provider, model, route);
    return send(res, 200, { id: job.id });
  }
  if (req.method === 'GET' && p === '/api/clipper/status') {
    const job = clipperJobs.get(u.searchParams.get('id') || '');
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    return send(res, 200, clipPublic(job));
  }
  // Daftar proyek Clipper tersimpan milik akun (buat pulihkan setelah refresh /
  // ganti device). Diurutkan terbaru dulu.
  if (req.method === 'GET' && p === '/api/clipper/jobs') {
    const user = sessUser(req);
    const list = [...clipperJobs.values()].filter(j => j.user === user)
      .sort((a, b) => b.ts - a.ts)
      .map(j => ({ id: j.id, videoTitle: j.videoTitle, status: j.status, phase: j.phase,
        duration: j.duration, ts: j.ts, progress: j.progress, sourceReady: j.sourceReady,
        error: j.error || null, sourceHeight: j.sourceHeight || 0, sourceUrl: j.sourceUrl || null,
        candidates: (j.candidates || []).length, renders: (j.renders || []).length }));
    return send(res, 200, { jobs: list });
  }
  // Hapus SATU proyek (folder + job.json + dari memori). Hanya hapus manual yang menghapus.
  if (req.method === 'POST' && p === '/api/clipper/delete') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    job.cancelled = true;
    try { if (job.aiCtrl) job.aiCtrl.abort(); } catch {}
    try { if (job.abortCtrl) job.abortCtrl.abort(); } catch {}
    clipperJobs.delete(job.id);
    clipRm(job.dir);
    // Library: hapus juga entri Clipper proyek ini (biar clip tidak "nyangkut"
    // di Library padahal proyek + file videonya sudah dihapus).
    try {
      const arr = libLoad(sessUser(req));
      const kept = arr.filter(x => !(x.type === 'clipper' && x.jobId === job.id));
      if (kept.length !== arr.length) libSave(sessUser(req), kept);
    } catch {}
    return send(res, 200, { ok: true });
  }
  // Stop proses clipper yang sedang jalan (input / analisis / render). Tombol Stop.
  // Set cancelled + abort controller aktif (download/ffmpeg/fetch AI yang menggantung
  // langsung dibunuh), lalu tandai error "Dihentikan oleh pengguna".
  if (req.method === 'POST' && p === '/api/clipper/stop') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    job.cancelled = true;
    try { if (job.aiCtrl) job.aiCtrl.abort(); } catch {}
    try { if (job.abortCtrl) job.abortCtrl.abort(); } catch {}
    if (job.status === 'running' || job.status === 'rendering') {
      // Proyek yang SUDAH punya hasil analisis (kandidat + sumber siap) tidak
      // boleh diracuni stop analisis-ulang: status kembali 'done' agar render
      // tetap jalan dengan hasil sebelumnya (kasus 22 Okt: stop Whisper lokal
      // bikin semua render mental 409 'Analisis belum selesai').
      if (job.candidates && job.candidates.length && job.sourceReady) {
        job.status = 'done'; job.error = null;
        clipLog(job, 'Proses dihentikan \u2014 hasil analisis sebelumnya tetap dipakai (proyek kembali Siap).');
      } else {
        job.status = 'error'; job.error = 'Dihentikan oleh pengguna';
        clipLog(job, 'Dihentikan oleh pengguna.');
      }
    }
    return send(res, 200, { ok: true });
  }
  // ===== Pengaturan Clipper per akun (tersimpan di state/<user>.json,
  // field clipperSettings — biar setting ikut AKUN, bukan cuma localStorage
  // per-browser, sehingga pindah device tidak reset setting).
  // GET = baca; POST = simpan (hanya kunci yang dikenal, + updatedAt).
  // Frontend: startup muat dari server (server menang bila ada), tiap
  // perubahan disimpan ke server (debounce) + localStorage (fallback offline).
  const CLIPPER_SETTING_KEYS = ['route', 'model', 'provider', 'transcribe', 'transcriptLang', 'duration', 'moment', 'mode', 'bg', 'focus', 'faceTrack', 'quality', 'hookPreset', 'smartCover', 'titleDurDefault'];
  if (req.method === 'GET' && p === '/api/clipper/settings') {
    let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile(sessUser(req)), 'utf8')); } catch {}
    const s = (st && typeof st.clipperSettings === 'object') ? st.clipperSettings : {};
    return send(res, 200, { settings: s });
  }
  if (req.method === 'POST' && p === '/api/clipper/settings') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    if (!b || typeof b !== 'object') return send(res, 400, { error: 'Settings harus objek' });
    const f = stateFile(sessUser(req));
    let st = {}; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (!st || typeof st !== 'object') st = {};
    const cur = (st.clipperSettings && typeof st.clipperSettings === 'object') ? st.clipperSettings : {};
    const next = { ...cur };
    for (const k of CLIPPER_SETTING_KEYS) if (b[k] !== undefined) next[k] = b[k];
    next.updatedAt = Date.now();
    st.clipperSettings = next;
    try { fs.writeFileSync(f, JSON.stringify(st)); } catch { return send(res, 500, { error: 'Gagal menyimpan pengaturan' }); }
    return send(res, 200, { ok: true, settings: next });
  }
  if (req.method === 'POST' && p === '/api/clipper/render') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (job.status !== 'done' || !job.candidates.length) return send(res, 409, { error: 'Analisis belum selesai / tidak ada kandidat.' });
    if (!job.source || !fs.existsSync(job.source)) return send(res, 409, { error: 'Video sumber sudah dihapus. Analisis ulang dari link.' });
    const sel = Array.isArray(b.selected) ? b.selected : [];
    if (!sel.length || sel.length > 5) return send(res, 400, { error: 'Pilih 1-5 klip untuk di-render.' });
    const idx = new Set(job.candidates.map(c => c.index));
    for (const s of sel) if (!s || !idx.has(+s.index)) return send(res, 400, { error: 'Klip pilihan tidak valid.' });
    const fontColor = /^#[0-9a-fA-F]{6}$/.test(String(b.fontColor || '')) ? b.fontColor : '#FFFFFF';
    const subColor = /^#[0-9a-fA-F]{6}$/.test(String(b.subColor || '')) ? b.subColor : '#FFFFFF';
    const titleColor2 = /^#[0-9a-fA-F]{6}$/.test(String(b.titleColor2 || '')) ? b.titleColor2 : '#FFFF00';
    const ctaColor = /^#[0-9a-fA-F]{6}$/.test(String(b.ctaColor || '')) ? b.ctaColor : '#FFFFFF';
    const clampN = (v, lo, hi, def) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
    // JANGAN clear job.renders di sini: render ulang SATU klip (edit judul/subtitle)
    // harus mempertahankan hasil klip lain. clipRender sudah menggantikan entri
    // yang sama index-nya (tidak duplikat). Analisis (bukan render) yang me-reset renders.
    job.ts = Date.now();
    job.cancelled = false; job.abortCtrl = new AbortController(); job.aiCtrl = null;
    // Hook + speakers diteruskan per-klip (dari sel) — clipRender mengambilnya.
    // (2026-10-20: CTA dihapus — ctaText/ctaY tidak diteruskan lagi.)
    clipRender(job, sel.map(s => ({ index: +s.index, title: String(s.title || ''), hook: s.hook, speakers: s.speakers,
      // Geser Momen (Detail: ⏪ Geser −5 dtk / ⏩ Geser +5 dtk): start/end
      // HANYA dikirim bila user menggeser (render biasa tidak mengirim).
      start: s.start, end: s.end,
      // Kualitas Render per-klip (Detail): '720p' / '1080p' (bila dikirim).
      // Toggle per-klip (Detail): JANGAN di-drop (sebelumnya map ini buang flag -> toggle Detail tidak berpengaruh + tidak tersimpan ke kandidat).
      // (2026-10-20: CTA dihapus — showCta tidak diteruskan.)
      showTitle: s.showTitle, showSub: s.showSub, subSet: s.subSet,
      // Preset Gaya Subtitle / Judul Hook (Detail): JANGAN di-drop (sama alasannya).
      subPreset: s.subPreset, hookPreset: s.hookPreset,
      // Font per-klip (Edit): JANGAN di-drop (sebelumnya terbuang di sini,
      // sehingga pilihan font di Edit tidak sampai ke clipRender).
      subFont: s.subFont, titleFont: s.titleFont,
      // Setting per-preset (Edit): Kertas font + 3 warna, Pill warna,
      // Kinetik 2 warna, toggle Animasi judul — JANGAN di-drop.
      kertasFont: s.kertasFont, kertasTextColor: s.kertasTextColor, kertasPaperColor: s.kertasPaperColor, kertasHighlightColor: s.kertasHighlightColor,
      pillColor: s.pillColor, kinetikTextColor: s.kinetikTextColor, kinetikBigColor: s.kinetikBigColor,
      titleAnim: s.titleAnim,
      // Tab Video (Edit): Watermark + Musik Latar — JANGAN di-drop.
      watermark: s.watermark, music: s.music,
      // Durasi judul (Detail): default 4 detik / full / manual (detik).
      titleDur: s.titleDur, titleDurSec: s.titleDurSec,
      // Cover per-klip (Fase 2, tab Cover di Edit): teks + detik frame.
      coverText: s.coverText, coverAt: s.coverAt,
      // Posisi/ukuran judul & subtitle per-klip (Detail, slider persen Klipaja)
      // + warna teks/kartu judul per-klip (picker Warna teks / Warna kartu).
      titleYPercent: s.titleYPercent, titleSizePercent: s.titleSizePercent,
      titleColor1: s.titleColor1, titleCardColor: s.titleCardColor,
      subYPercent: s.subYPercent, subSizePercent: s.subSizePercent,
      // Kualitas Render per-klip (Detail): JANGAN di-drop (sama alasannya).
      quality: s.quality,
      // Layout per-klip (Detail, tab Video): JANGAN di-drop.
      mode: s.mode,
      // B-roll per-klip (Detail, tab Video): {enabled, keyword, start, dur}.
      broll: s.broll })), {
      bg: b.bg === 'black' ? 'black' : 'blur',
      fontColor, titleColor2, italic: !!b.italic, subtitle: b.subtitle !== false,
      titleSize: clampN(b.titleSize, 20, 140, 54), titleY: clampN(b.titleY, 0, 1100, 70),
      titleBold: b.titleBold !== false, titleFont: ['Anton', 'Montserrat', 'Montserrat ExtraBold', 'Liberation Sans', 'DejaVu Sans'].includes(b.titleFont) ? b.titleFont : 'DejaVu Sans',
      subSize: clampN(b.subSize, 12, 140, 48), subMarginV: clampN(b.subMarginV, 0, 1200, 300),
      subColor, subBold: b.subBold !== false,
      subFont: ['Anton', 'Montserrat', 'Montserrat ExtraBold', 'Liberation Sans', 'DejaVu Sans'].includes(b.subFont) ? b.subFont : 'DejaVu Sans',
      // (2026-10-20: CTA dihapus — tidak diparse lagi, render selalu enabled:false.)
      hookEnabled: b.hook !== false,
      mode: ['landscape', 'podcast', 'auto', 'split', 'crop11', 'gameplay'].includes(b.mode) ? b.mode : (b.podcast ? 'podcast' : null),
      podcast: b.mode === 'podcast' || b.mode === 'auto' || (b.mode == null && !!b.podcast), // Mode Podcast (crop penuh 9:16, tanpa bar hitam/blur) — Auto juga Podcast
      bg: ['black', 'white', 'blur'].includes(b.bg) ? b.bg : null, // null = pakai bg job (dari Analisis)
      focus: b.focus == null ? null : clampN(b.focus, 0, 100, 50) / 100, // null = pakai focus job (dari Analisis)
      faceTrack: b.faceTrack !== false, // Auto face tracking (Podcast / Gameplay) — default ON
      quality: b.quality === '1080p' ? '1080p' : (b.quality === '720p' ? '720p' : null), // Kualitas Render (Pengaturan): null = pakai kualitas job/kandidat
      raw: !!b.raw, // RAW (polos, tanpa overlay) — dipakai auto-render awal; Template Save kirim tanpa raw = Final
      thumb: typeof b.thumb === 'string' ? b.thumb : null, // Thumbnail PNG (data URL) dari modal Template -> disimpan ke file
    });
    return send(res, 200, { ok: true });
  }
  // Edit teks subtitle (perbaiki transkrip Whisper yang tidak sesuai ucapan).
  // Frontend mengirim daftar cue lengkap (yang sudah diedit); server validasi +
  // simpan ke job.cues + job.json. Render berikutnya memakai cue yang sudah diperbaiki.
  if (req.method === 'POST' && p === '/api/clipper/candidates') {
    // Simpan editan editor (judul/subtitle/gaya per kandidat) TANPA render
    // (alur baru Dzaky 23 Okt: Simpan != render; render dari tab Render).
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4e6) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.id || b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!Array.isArray(b.candidates) || !b.candidates.length) return send(res, 400, { error: 'candidates kosong.' });
    // Gabung per index dengan whitelist field yang boleh diedit editor
    // (JANGAN sanitizeCandidates di sini: fungsi itu membuang field gaya +
    // index/batch). Pola sama seperti rute render meneruskan field per-klip.
    const EDITABLE = ['title', 'hook', 'speakers', 'quality', 'showTitle', 'showSub', 'subSet', 'subPreset', 'hookPreset', 'subFont', 'titleFont', 'kertasFont', 'kertasTextColor', 'kertasPaperColor', 'kertasHighlightColor', 'pillColor', 'kinetikTextColor', 'kinetikBigColor', 'titleAnim', 'titleYPercent', 'titleSizePercent', 'subYPercent', 'subSizePercent', 'titleDur', 'titleDurSec', 'hookOn', 'coverText', 'coverAt', 'hookText', 'musicEnabled', 'musicVolume', 'brollEnabled', 'brollCount', 'brollStart', 'brollDur', 'styleOv'];
    let n = 0;
    for (const inc of b.candidates) {
      if (!inc || typeof inc !== 'object') continue;
      const cur = job.candidates.find(c => c.index === +inc.index);
      if (!cur) continue;
      for (const k of EDITABLE) if (inc[k] !== undefined) cur[k] = inc[k];
      const st = +inc.start, en = +inc.end; // Geser Momen dari editor (berpenjaga)
      if (Number.isFinite(st) && Number.isFinite(en) && st >= 0 && en > st && (!job.duration || en <= job.duration + 1)) { cur.start = st; cur.end = en; }
      n++;
    }
    if (!n) return send(res, 400, { error: 'candidates tidak valid.' });
    clipSaveJob(job);
    return send(res, 200, { ok: true, count: n });
  }
  // Audio untuk Whisper di perangkat user (Fase 10): server mengekstrak
  // audio sumber jadi mp3 mono 16kHz kecil (mesin yang sama dengan kompres
  // Groq), browser user mengunduhnya lalu mentranskrip dengan CPU/GPU-nya
  // sendiri — server tidak ikut terbebani STT.
  if (req.method === 'POST' && p === '/api/clipper/prepare-audio') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!job.source || !fs.existsSync(job.source)) return send(res, 409, { error: 'Video sumber belum tersimpan di server.' });
    const out = path.join(job.dir, 'audio_device.mp3');
    try {
      if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(job.source).mtimeMs) await clipGroqCompress(job.source, 0, 0, out, job);
      return send(res, 200, { ok: true, size: fs.statSync(out).size });
    } catch (e) { return send(res, 500, { error: 'Gagal menyiapkan audio: ' + (e.message || e) }); }
  }
  if (req.method === 'GET' && p === '/api/clipper/audio') {
    const job = clipperJobs.get(String(u.searchParams.get('id') || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const f = path.join(job.dir, 'audio_device.mp3');
    if (!fs.existsSync(f)) return send(res, 404, { error: 'Audio belum disiapkan' });
    const st = fs.statSync(f);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  if (req.method === 'POST' && p === '/api/clipper/cues') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!Array.isArray(b.cues)) return send(res, 400, { error: 'cues harus array.' });
    const cues = [];
    for (const c of b.cues) {
      if (!c || typeof c !== 'object') continue;
      const start = +c.start, end = +c.end;
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start) || start < 0) continue;
      const text = String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!text) continue;
      // Kata per kata (Koreksi Kata): frontend kirim words kalau ada flag
      // sensor/keyword/edit/disabled/warna kata; kalau tidak,
      // normalizeCueWords bagi rata dari teks.
      // Edit teks via textarea = kirim tanpa words = flag kata ikut reset.
      const words = Array.isArray(c.words) ? c.words.filter(w => w && typeof w === 'object').slice(0, 60).map(w => ({
        text: String(w.text || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        start: +w.start, end: +w.end, sensor: !!w.sensor, keyword: !!w.keyword,
        edit: typeof w.edit === 'string' ? w.edit.replace(/\s+/g, ' ').trim().slice(0, 100) : undefined,
        disabled: !!w.disabled,
        wordColor: /^#[0-9a-fA-F]{6}$/.test(String(w.wordColor || '')) ? String(w.wordColor) : undefined,
        keywordMode: ['auto', 'yes', 'no'].includes(w.keywordMode) ? w.keywordMode : undefined,
      })).filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start) : [];
      cues.push(clipperLib.normalizeCueWords({ start, end, text, words }));
    }
    cues.sort((a, b2) => a.start - b2.start);
    if (!cues.length) return send(res, 400, { error: 'Tidak ada cue subtitle yang valid.' });
    if (b.source === 'device') job.transcriptSource = 'device'; // transkrip Whisper dari perangkat user
    job.cues = cues;
    job.ts = Date.now();
    clipSaveJob(job);
    clipLog(job, 'Subtitle diperbaiki manual: ' + cues.length + ' cue.');
    return send(res, 200, { ok: true, cues: cues.length });
  }
  // Hapus satu kandidat klip (dari grid kandidat) — biar kandidat yang tidak
  // dipakai tidak ikut ke-render. Menghapus kandidat TIDAK menghapus render
  // yang sudah ada (kalau klip itu sudah di-render, hasil render-nya tetap ada).
  if (req.method === 'POST' && p === '/api/clipper/candidate/delete') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const idx = +b.index;
    if (!Number.isFinite(idx)) return send(res, 400, { error: 'index tidak valid' });
    const before = (job.candidates || []).length;
    job.candidates = (job.candidates || []).filter(c => c.index !== idx);
    if (job.candidates.length === before) return send(res, 404, { error: 'Kandidat tidak ditemukan' });
    job.ts = Date.now();
    clipSaveJob(job);
    clipLog(job, 'Kandidat Klip ' + (idx + 1) + ' dihapus.');
    return send(res, 200, { ok: true, candidates: job.candidates });
  }
  // B-roll upload manual (ganti Pexels): POST /api/clipper/broll/upload
  // (multipart, field `video`, query id + clip) -> simpan ke
  // clipper-work/broll/<jobId>-<clipIdx>.mp4 (timpa bila sudah ada).
  // Batas 200MB, terima mp4/mov/webm/mkv. Sidecar .json simpan nama asli.
  if (req.method === 'POST' && p === '/api/clipper/broll/upload') {
    const jobId = String(u.searchParams.get('id') || '');
    const clipIdx = +u.searchParams.get('clip');
    const job = clipperJobs.get(jobId);
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!Number.isFinite(clipIdx)) return send(res, 400, { error: 'clip tidak valid' });
    const ct = req.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(ct)) return send(res, 400, { error: 'Content-Type harus multipart/form-data' });
    const MAX = 200 * 1024 * 1024;
    const chunks = []; let total = 0, tooBig = false;
    for await (const c of req) { if (tooBig) continue; total += c.length; if (total > MAX + 1024 * 1024) { tooBig = true; continue; } chunks.push(c); }
    if (tooBig) return send(res, 413, { error: 'File B-roll maksimal 200MB.' });
    const parsed = clipParseMultipart(Buffer.concat(chunks), ct);
    if (!parsed || parsed.field !== 'video' || !parsed.data || !parsed.data.length) return send(res, 400, { error: 'Field `video` tidak ditemukan.' });
    const ext = String(parsed.filename || '').split('.').pop().toLowerCase();
    if (!['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return send(res, 400, { error: 'Format B-roll harus mp4/mov/webm/mkv.' });
    if (parsed.data.length > MAX) return send(res, 413, { error: 'File B-roll maksimal 200MB.' });
    const file = clipBrollPath(jobId, clipIdx);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, parsed.data); } catch { return send(res, 500, { error: 'Gagal menyimpan file B-roll.' }); }
    try { fs.writeFileSync(file.replace(/\.mp4$/, '.json'), JSON.stringify({ name: parsed.filename, size: parsed.data.length, uploadedAt: Date.now() })); } catch {}
    return send(res, 200, { ok: true, name: parsed.filename, size: parsed.data.length });
  }
  // Status B-roll: GET /api/clipper/broll/status?id=<jobId>&clip=<idx>
  if (req.method === 'GET' && p === '/api/clipper/broll/status') {
    const jobId = String(u.searchParams.get('id') || '');
    const clipIdx = +u.searchParams.get('clip');
    const job = clipperJobs.get(jobId);
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!Number.isFinite(clipIdx)) return send(res, 400, { error: 'clip tidak valid' });
    const file = clipBrollPath(jobId, clipIdx);
    let size = 0, name = '';
    if (fs.existsSync(file)) { try { size = fs.statSync(file).size; } catch {} try { const meta = JSON.parse(fs.readFileSync(file.replace(/\.mp4$/, '.json'), 'utf8')); name = String(meta.name || ''); } catch {} }
    return send(res, 200, { hasBroll: size > 0, size, name });
  }
  // Hapus B-roll: POST /api/clipper/broll/delete {jobId, clip}
  if (req.method === 'POST' && p === '/api/clipper/broll/delete') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const clipIdx = +b.clip;
    if (!Number.isFinite(clipIdx)) return send(res, 400, { error: 'clip tidak valid' });
    const file = clipBrollPath(job.id, clipIdx);
    try { fs.unlinkSync(file); } catch {}
    try { fs.unlinkSync(file.replace(/\.mp4$/, '.json')); } catch {}
    return send(res, 200, { ok: true });
  }
  // Musik Latar upload (tab Video, GRATIS): POST /api/clipper/music/upload
  // (multipart, field `audio`, query id + clip) -> simpan ke
  // clipper-work/music/<jobId>-<clipIdx>.<ext> (timpa bila sudah ada —
  // file ekstensi lama untuk klip yang sama dihapus dulu, biar
  // clipMusicPath tidak mengambil file basi).
  // Batas 50MB, terima mp3/m4a/wav/ogg/flac/aac. Sidecar .json simpan nama asli.
  if (req.method === 'POST' && p === '/api/clipper/music/upload') {
    const jobId = String(u.searchParams.get('id') || '');
    const clipIdx = +u.searchParams.get('clip');
    const job = clipperJobs.get(jobId);
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!Number.isFinite(clipIdx)) return send(res, 400, { error: 'clip tidak valid' });
    const ct = req.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(ct)) return send(res, 400, { error: 'Content-Type harus multipart/form-data' });
    const MAX = 50 * 1024 * 1024;
    const chunks = []; let total = 0, tooBig = false;
    for await (const c of req) { if (tooBig) continue; total += c.length; if (total > MAX + 1024 * 1024) { tooBig = true; continue; } chunks.push(c); }
    if (tooBig) return send(res, 413, { error: 'File musik maksimal 50MB.' });
    const parsed = clipParseMultipart(Buffer.concat(chunks), ct);
    if (!parsed || parsed.field !== 'audio' || !parsed.data || !parsed.data.length) return send(res, 400, { error: 'Field `audio` tidak ditemukan.' });
    const ext = String(parsed.filename || '').split('.').pop().toLowerCase();
    if (!['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) return send(res, 400, { error: 'Format musik harus mp3/m4a/wav/ogg/flac/aac.' });
    if (parsed.data.length > MAX) return send(res, 413, { error: 'File musik maksimal 50MB.' });
    const file = path.join(CLIPPER_DIR, 'music', String(jobId) + '-' + String(clipIdx) + '.' + ext);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Hapus file ekstensi lain untuk klip yang sama (biar tidak basi).
      for (const e2 of ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']) {
        const old = path.join(CLIPPER_DIR, 'music', String(jobId) + '-' + String(clipIdx) + '.' + e2);
        if (old !== file) { try { fs.unlinkSync(old); } catch {} }
      }
      fs.writeFileSync(file, parsed.data);
    } catch { return send(res, 500, { error: 'Gagal menyimpan file musik.' }); }
    try { fs.writeFileSync(file.replace(/\.[^.]+$/, '.json'), JSON.stringify({ name: parsed.filename, size: parsed.data.length, uploadedAt: Date.now() })); } catch {}
    return send(res, 200, { ok: true, name: parsed.filename, size: parsed.data.length });
  }
  // Status Musik Latar: GET /api/clipper/music/status?id=<jobId>&clip=<idx>
  if (req.method === 'GET' && p === '/api/clipper/music/status') {
    const jobId = String(u.searchParams.get('id') || '');
    const clipIdx = +u.searchParams.get('clip');
    const job = clipperJobs.get(jobId);
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    if (!Number.isFinite(clipIdx)) return send(res, 400, { error: 'clip tidak valid' });
    const file = clipMusicPath(jobId, clipIdx);
    let size = 0, name = '';
    if (fs.existsSync(file)) { try { size = fs.statSync(file).size; } catch {} try { const meta = JSON.parse(fs.readFileSync(file.replace(/\.[^.]+$/, '.json'), 'utf8')); name = String(meta.name || ''); } catch {} }
    return send(res, 200, { hasMusic: size > 0, size, name });
  }
  // Hapus Musik Latar: POST /api/clipper/music/delete {jobId, clip}
  if (req.method === 'POST' && p === '/api/clipper/music/delete') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const clipIdx = +b.clip;
    if (!Number.isFinite(clipIdx)) return send(res, 400, { error: 'clip tidak valid' });
    for (const e2 of ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']) {
      try { fs.unlinkSync(path.join(CLIPPER_DIR, 'music', String(job.id) + '-' + String(clipIdx) + '.' + e2)); } catch {}
    }
    try { fs.unlinkSync(path.join(CLIPPER_DIR, 'music', String(job.id) + '-' + String(clipIdx) + '.json')); } catch {}
    return send(res, 200, { ok: true });
  }
  // Laporan / masukan user soal satu klip (tombol Lapor di Detail job).
  // Disimpan nyata di kandidat (cand.reports) + job.json lewat clipSaveJob
  // (candidates ikut terserialisasi apa adanya) — bukan sekadar toast.
  if (req.method === 'POST' && p === '/api/clipper/report') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const idx = +b.index;
    if (!Number.isFinite(idx)) return send(res, 400, { error: 'index tidak valid' });
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!text) return send(res, 400, { error: 'Masukan tidak boleh kosong.' });
    const cand = (job.candidates || []).find(c => c.index === idx);
    if (!cand) return send(res, 404, { error: 'Kandidat tidak ditemukan' });
    if (!Array.isArray(cand.reports)) cand.reports = [];
    cand.reports.push({ text, ts: Date.now() });
    job.ts = Date.now();
    clipSaveJob(job);
    clipLog(job, 'Laporan Klip ' + (idx + 1) + ': ' + text.slice(0, 100));
    return send(res, 200, { ok: true, reports: cand.reports.length });
  }
  // Info sistem real-time (CPU + suhu) untuk ditampilkan di card Clipper saat render.
  // CPU: load rata-rata 1 menit / jumlah core (×100) — kasar tapi cukup untuk melihat
  // lonjakan saat render. Suhu: /sys/class/thermal (Pi/Linux); null kalau tidak tersedia.
  if (req.method === 'GET' && p === '/api/clipper/sysinfo') {
    const user = sessUser(req);
    if (!user) return send(res, 401, { error: 'Belum login' });
    // CPU (cross-platform): os.loadavg() di Windows SELALU [0,0,0] (Windows
    // tidak punya konsep load average) -> meter "CPU: 0%" macet selama
    // Whisper + render ffmpeg. Hitung dari os.cpus() (selisih 2 sampel
    // ~100ms, jalan di Windows + Linux). Cache 1 detik biar poll cepat
    // tidak menumpuk sampel.
    let cpu = null;
    try { cpu = await clipCpuPercent(); } catch {}
    let temp = null;
    try {
      const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
      const t = +raw;
      if (Number.isFinite(t)) temp = Math.round((t > 1000 ? t / 1000 : t) * 10) / 10;
    } catch {}
    // Suhu tetap null ("—") di Windows — tanpa sensor, bukan bug.
    return send(res, 200, { cpu, temp });
  }
  // Stream video SUMBER tersimpan (untuk preview segmen kandidat di kartu kandidat).
  // Sama seperti preview: Range support, tanpa hapus source (bukan download).
  if (req.method === 'GET' && p === '/api/clipper/source') {
    const job = clipperJobs.get(u.searchParams.get('id') || '');
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const file = job.source;
    if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Video sumber tidak ditemukan (belum disimpan / sudah dibersihkan).' });
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { start = m[1] ? Math.min(+m[1], size - 1) : 0; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; status = 206; }
    const ext = (file.split('.').pop() || 'mp4').toLowerCase();
    const type = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    // download=1 -> download video sumber FULL (attachment), bukan preview streaming.
    const dl = u.searchParams.get('download') === '1';
    const dlName = 'sumber-' + (job.videoTitle || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.' + ext;
    res.writeHead(status, { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'content-length': end - start + 1, ...(status === 206 ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}), ...(dl ? { 'content-disposition': 'attachment; filename="' + dlName + '"' } : {}) });
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { try { res.end(); } catch {} });
    stream.pipe(res);
    return;
  }
  // Preview klip (streaming mp4 + Range, untuk <video> di kartu hasil). Tanpa hapus source (bukan download).
  if (req.method === 'GET' && p === '/api/clipper/preview') {
    const job = clipperJobs.get(u.searchParams.get('id') || '');
    const idx = +u.searchParams.get('clip');
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const rec = job.renders.find(r => r.index === idx && r.status === 'done');
    if (!rec) return send(res, 404, { error: 'Klip belum di-render.' });
    // plain=1 → preview video POLOS (tanpa judul/subtitle) agar overlay live
    // (judul/subtitle/CTA yang sedang diedit) tidak tampil ganda di atas teks
    // yang sudah terbakar. Default: preview video berjudul (hasil render).
    const plain = u.searchParams.get('plain') === '1';
    let file = plain && rec.plainFile
      ? path.join(job.dir, path.basename(rec.plainFile))
      : path.join(job.dir, 'clip_' + idx + '.mp4');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'File klip tidak ditemukan (mungkin sudah dibersihkan).' });
    // lite=1 → salinan 360p (on-demand, sekali buat); gagal -> file asli.
    if (u.searchParams.get('lite') === '1') { const lf = await clipEnsureLite(file); if (lf) file = lf; }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { start = m[1] ? Math.min(+m[1], size - 1) : 0; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; status = 206; }
    res.writeHead(status, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'content-length': end - start + 1, ...(status === 206 ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { try { res.end(); } catch {} });
    stream.pipe(res);
    return;
  }
  // Thumbnail otomatis (gaya Klipaja): frame TERANG dari video Final
  // (dengan overlay terbakar) — dipakai sebagai poster kartu klip sehingga
  // kartu menampilkan wajah + kartu judul + subtitle SEBELUM play.
  // Bila file belum ada (klip lama / render sebelum fitur ini) -> generate
  // on-demand dari sumber terbaik yang ada: Final > polos (RAW) > sumber
  // (jendela [cand.start, cand.end]). Gagal -> 404 (frontend tanpa poster).
  if (req.method === 'GET' && p === '/api/clipper/thumb') {
    const job = clipperJobs.get(u.searchParams.get('id') || '');
    const idx = +u.searchParams.get('clip');
    // Pertahanan: job.json malformed (tanpa dir) JANGAN sampai melempar
    // exception yang membunuh server (handler async tanpa try/catch = crash).
    if (!job || job.user !== sessUser(req) || !job.dir) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const cand = (job.candidates || []).find(c => c.index === idx);
    if (u.searchParams.get('cover') === '1') {
      const cf = path.join(job.dir, 'cover_' + idx + '.jpg');
      if (!fs.existsSync(cf)) return send(res, 404, { error: 'Cover belum dibuat (Edit klip > tab Cover).' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
      fs.createReadStream(cf).pipe(res); return;
    }
    // raw=1 -> thumbnail dari video POLOS (tanpa teks ter-bake), poster
    // kartu Detail/editor (model Klipaja: editor = RAW + overlay HTML).
    // Tanpa raw -> thumbnail Final (berteks), dipakai Library.
    const wantRaw = u.searchParams.get('raw') === '1';
    const thumbFile = path.join(job.dir, wantRaw ? 'clip_' + idx + '_thumb_raw.jpg' : 'clip_' + idx + '_thumb.jpg');
    if (!fs.existsSync(thumbFile)) {
      const rec = (job.renders || []).find(r => r.index === idx);
      const finalFile = path.join(job.dir, 'clip_' + idx + '.mp4');
      let src = null, offset = 0, len = 0;
      if (!wantRaw && rec && rec.status === 'done' && !rec.raw && fs.existsSync(finalFile)) { src = finalFile; len = (cand ? cand.end - cand.start : 0); }
      else if (rec && rec.plainFile && fs.existsSync(path.join(job.dir, path.basename(rec.plainFile)))) { src = path.join(job.dir, path.basename(rec.plainFile)); len = (cand ? cand.end - cand.start : 0); }
      else if (job.source && fs.existsSync(job.source) && cand) { src = job.source; offset = cand.start; len = cand.end - cand.start; }
      if (src) { try { await clipMakeThumb(job, { index: idx }, src, offset, len, wantRaw ? 'clip_' + idx + '_thumb_raw.jpg' : undefined); } catch {} }
    }
    // Fallback RAW: bila thumb RAW gagal dibuat, pakai thumb.jpg (Final)
    // bila ada — kartu tetap menampilkan frame terang, bukan abu-abu 0:00.
    if (wantRaw && !fs.existsSync(thumbFile)) {
      const mainThumb = path.join(job.dir, 'clip_' + idx + '_thumb.jpg');
      if (fs.existsSync(mainThumb)) { res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' }); fs.createReadStream(mainThumb).pipe(res); return; }
    }
    if (!fs.existsSync(thumbFile)) return send(res, 404, { error: 'Thumbnail belum tersedia.' });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
    fs.createReadStream(thumbFile).pipe(res); return;
  }
  // Spek preset tunggal (brief A): presets.json di root app dibaca halaman
  // (grid preset) + lib (generator ASS) — satu sumber kebenaran gaya.
  if (req.method === 'GET' && p === '/presets.json') {
    const fp = path.join(__dirname, 'presets.json');
    if (!fs.existsSync(fp)) return send(res, 404, { error: 'presets.json tidak ditemukan' });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  // ASS preview editor (brief C): bangun .ass dengan generator yang SAMA
  // persis dengan render (clipperLib.buildAss) dari setting editor saat ini
  // (body.sel = field yang sama dengan body render). Murni baca — kandidat
  // dan job TIDAK diubah. Mode utama: tanpa hook (garis waktu klip utama).
  // body.hookMode === 'hook' (22 Okt ronde-2): trek KHUSUS hook — event
  // Hook di waktu sumbernya (hookAtSource) — pemutar editor memutar
  // potongan hook dari video polos lalu beralih ke trek utama.
  if (req.method === 'POST' && p === '/api/clipper/ass') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const cand = (job.candidates || []).find(c => c.index === +b.clip);
    if (!cand) return send(res, 404, { error: 'Klip tidak ditemukan' });
    const sel = (b.sel && typeof b.sel === 'object') ? b.sel : {};
    const hexOrU = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : undefined;
    const numU = (v) => Number.isFinite(+v) && v !== undefined && v !== null ? +v : undefined;
    const title = String(sel.hookText || cand.hookText || (sel.title !== undefined ? sel.title : (cand.title || ''))).trim();
    const showTitle = sel.showTitle !== undefined ? !!sel.showTitle : (cand.showTitle !== undefined ? !!cand.showTitle : true);
    const showSub = sel.showSub !== undefined ? !!sel.showSub : true;
    const subPreset = String(sel.subPreset || cand.subPreset || 'default');
    const hookPreset = String(sel.hookPreset || cand.hookPreset || 'kartu');
    const mode = String(sel.mode || cand.mode || '');
    const ass = clipperLib.buildAss(job.cues || [], cand.start, cand.end, {}, {
      title, titleColor1: hexOrU(sel.titleColor1) !== undefined ? hexOrU(sel.titleColor1) : hexOrU(cand.titleColor1),
      titleColor2: undefined,
      titleCardColor: hexOrU(sel.titleCardColor) !== undefined ? hexOrU(sel.titleCardColor) : hexOrU(cand.titleCardColor),
      titleYPercent: numU(sel.titleYPercent) !== undefined ? numU(sel.titleYPercent) : (numU(cand.titleYPercent) !== undefined ? numU(cand.titleYPercent) : 56),
      titleSizePercent: numU(sel.titleSizePercent) !== undefined ? numU(sel.titleSizePercent) : numU(cand.titleSizePercent),
      subYPercent: numU(sel.subYPercent) !== undefined ? numU(sel.subYPercent) : (numU(cand.subYPercent) !== undefined ? numU(cand.subYPercent) : 70),
      subSizePercent: numU(sel.subSizePercent) !== undefined ? numU(sel.subSizePercent) : numU(cand.subSizePercent),
      subCenterY: (mode === 'split' && sel.subYPercent === undefined && cand.subYPercent === undefined) ? 960
        : (mode === 'gameplay' && sel.subYPercent === undefined && cand.subYPercent === undefined) ? clipperLib.gameplayTopH(1920) : undefined,
      showTitle, showSub, subPreset, hookPreset,
      subFontPick: clipperLib.clipFontOk(sel.subFont || cand.subFont || '') || undefined,
      titleFontPick: clipperLib.clipFontOk(sel.titleFont || cand.titleFont || '') || undefined,
      titleDur: ['default', 'full', 'manual', '5s', 'auto'].includes(String(sel.titleDur || '')) ? String(sel.titleDur) : (cand.titleDur || 'default'),
      hookDurAi: cand.hookDurAi,
      titleDurSec: numU(sel.titleDurSec) !== undefined ? numU(sel.titleDurSec) : (numU(cand.titleDurSec) !== undefined ? numU(cand.titleDurSec) : 4),
      kertasFont: sel.kertasFont || cand.kertasFont, kertasTextColor: hexOrU(sel.kertasTextColor) || hexOrU(cand.kertasTextColor),
      kertasPaperColor: hexOrU(sel.kertasPaperColor) || hexOrU(cand.kertasPaperColor),
      kertasHighlightColor: hexOrU(sel.kertasHighlightColor) || hexOrU(cand.kertasHighlightColor),
      pillColor: hexOrU(sel.pillColor) || hexOrU(cand.pillColor),
      kinetikTextColor: hexOrU(sel.kinetikTextColor) || hexOrU(cand.kinetikTextColor),
      kinetikBigColor: hexOrU(sel.kinetikBigColor) || hexOrU(cand.kinetikBigColor),
      titleAnim: sel.titleAnim !== undefined ? !!sel.titleAnim : (cand.titleAnim !== undefined ? !!cand.titleAnim : undefined),
      styleOv: clipperLib.sanitizeStyleOv(sel.styleOv || cand.styleOv), // override gaya per-klip (Fase 13 Item 7-10)
      watermark: (sel.watermark && sel.watermark.enabled && sel.watermark.text) ? { text: String(sel.watermark.text), pos: String(sel.watermark.pos || 'bl') } : null,
      cta: { enabled: false },
      hook: [],
    });
    if (b.hookMode === 'hook') {
      const rawHook = (sel.hook === false || cand.hookOn === false) ? [] : (Array.isArray(sel.hook) ? sel.hook : (cand.hook || []));
      const assHook = clipperLib.buildAss([], cand.start, cand.end, {}, {
        title: '', showTitle: false, showSub: false,
        hook: clipHookRel(cand, rawHook), hookAtSource: true,
      });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(assHook || '');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(ass || '');
    return;
  }
  if (req.method === 'GET' && p === '/api/clipper/download') {
    const job = clipperJobs.get(u.searchParams.get('id') || '');
    const idx = +u.searchParams.get('clip');
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const rec = job.renders.find(r => r.index === idx && r.status === 'done');
    if (!rec) return send(res, 404, { error: 'Klip belum di-render.' });
    // thumb=1 → thumbnail PNG kustom (dari modal Template). plain=1 → video
    // POLOS (tanpa judul/subtitle). Default: video Final berjudul.
    if (u.searchParams.get('thumb') === '1') {
      const tf = path.join(job.dir, 'clip_' + idx + '_thumb.png');
      if (!fs.existsSync(tf)) return send(res, 404, { error: 'Thumbnail belum dibuat (Edit di kartu klip lalu Save).' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      fs.createReadStream(tf).pipe(res); return;
    }
    const plain = u.searchParams.get('plain') === '1';
    const file = plain && rec.plainFile
      ? path.join(job.dir, path.basename(rec.plainFile))
      : path.join(job.dir, 'clip_' + idx + '.mp4');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'File klip tidak ditemukan (mungkin sudah dibersihkan).' });
    const name = 'clipper-' + idx + '-' + (plain ? 'polos-' : '') + (!plain && rec.hash ? rec.hash + '-' : '') + (job.videoTitle || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.mp4';
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="' + name + '"', 'cache-control': 'no-store' });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.end(); } catch {} });
    // Sumber TIDAK dihapus pas download (sebelumnya res.on('finish') hapus source
    // -> abis download 1 klip, sumber hilang -> render/analisis berikutnya gagal
    // "Video sumber sudah dihapus"). Sumber hanya terhapus pas hapus proyek.
    stream.pipe(res);
    return;
  }
  if (req.method === 'GET' && p === '/api/clipper/peaks') {
    // Puncak audio (waveform) trek Audio di Timeline Editor Studio: ffmpeg
    // ekstrak audio segmen klip (mono 8kHz f32le ke file temp) -> maks abs
    // per ember (240 ember), dinormalkan 0..1. Cache per (start,end) klip.
    const job = clipperJobs.get(u.searchParams.get('id') || '');
    const idx = +(u.searchParams.get('clip') || 0);
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const cand = (job.candidates || []).find(c => c.index === idx);
    if (!cand) return send(res, 404, { error: 'Klip tidak ditemukan.' });
    const cacheF = path.join(job.dir, 'peaks_' + idx + '.json');
    try { const cached = JSON.parse(fs.readFileSync(cacheF, 'utf8')); if (cached && Math.abs((+cached.start || 0) - cand.start) < 0.05 && Math.abs((+cached.end || 0) - cand.end) < 0.05 && Array.isArray(cached.peaks) && cached.peaks.length) return send(res, 200, { ok: true, peaks: cached.peaks }); } catch {}
    const srcF = path.join(job.dir, 'source.mp4');
    if (!fs.existsSync(srcF)) return send(res, 404, { error: 'Video sumber tidak ada.' });
    const dur = Math.max(0.5, cand.end - cand.start);
    const tmpPcm = path.join(os.tmpdir(), 'clippeaks-' + job.id + '-' + idx + '.f32');
    try {
      const ex = await clipRun('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(cand.start), '-i', srcF, '-t', String(dur), '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-y', tmpPcm], { timeout: 120000 });
      if (ex.code !== 0 || !fs.existsSync(tmpPcm)) return send(res, 422, { error: 'Gagal membaca audio klip.' });
      const buf = fs.readFileSync(tmpPcm);
      const total = Math.floor(buf.length / 4);
      if (!total) return send(res, 422, { error: 'Audio klip kosong.' });
      const N = 240, per = total / N, peaks = new Array(N).fill(0);
      for (let b = 0; b < N; b++) { const s0 = Math.floor(b * per), s1 = Math.max(s0 + 1, Math.floor((b + 1) * per)); let mx = 0; for (let s = s0; s < s1 && s < total; s++) { const v = Math.abs(buf.readFloatLE(s * 4)); if (v > mx) mx = v; } peaks[b] = mx; }
      const gmax = Math.max.apply(null, peaks) || 1;
      const norm = peaks.map(v => Math.round((v / gmax) * 1000) / 1000);
      try { fs.writeFileSync(cacheF, JSON.stringify({ start: cand.start, end: cand.end, peaks: norm })); } catch {}
      return send(res, 200, { ok: true, peaks: norm });
    } finally { try { fs.unlinkSync(tmpPcm); } catch {} }
  }
  if (req.method === 'POST' && p === '/api/clipper/cover') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || b.id || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const cand = (job.candidates || []).find(c => c.index === +b.clip);
    if (!cand) return send(res, 404, { error: 'Klip tidak ditemukan.' });
    if (b.coverText !== undefined) cand.coverText = String(b.coverText || '').slice(0, 90);
    if (b.coverAt === null) delete cand.coverAt; else if (b.coverAt !== undefined && Number.isFinite(+b.coverAt)) cand.coverAt = Math.max(0, +b.coverAt);
    clipSaveJob(job);
    const out = await clipMakeCover(job, cand);
    if (!out) return send(res, 422, { error: 'Poster cover gagal dibuat (video polos/final klip ini belum ada).' });
    return send(res, 200, { ok: true, cover: true });
  }
  if (req.method === 'POST' && p === '/api/clipper/cover-all') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) break; }
    let b = {}; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    const job = clipperJobs.get(String(b.jobId || b.id || ''));
    if (!job || job.user !== sessUser(req)) return send(res, 404, { error: 'Pekerjaan clipper tidak ditemukan' });
    const targets = (job.candidates || []).filter(c => (job.renders || []).some(r => r.index === c.index && r.status === 'done'));
    if (!targets.length) return send(res, 400, { error: 'Belum ada klip yang selesai dirender di proyek ini.' });
    clipLog(job, '🖼️ Buat ulang cover SEMUA klip (' + targets.length + ') pakai gaya baru…');
    let made = 0;
    for (const c of targets) { if (await clipMakeCover(job, c)) made++; }
    clipSaveJob(job);
    clipLog(job, '🖼️ Cover selesai dibuat ulang: ' + made + '/' + targets.length + ' klip.');
    return send(res, 200, { ok: true, made, total: targets.length });
  }
  if (req.method === 'POST' && p === '/api/clipper/cleanup') {
    const user = sessUser(req);
    // AMAN: selamatkan dulu hasil Final yang ada di Library/Dashboard Hasil
    // SEBELUM hapus folder kerja. Yang dihapus HANYA video sumber + klip yang
    // BELUM di-render. Hasil Final (sudah "save render") dipindah ke
    // <LIBRARY_DIR>/clipper-final/<user>/<jobId>/ dan entri Library di-update
    // (finalVideo/finalThumb) — Dashboard Hasil tidak ikut terhapus.
    try {
      const arr = libLoad(user);
      let changed = false;
      for (const it of arr) {
        if (it.type !== 'clipper' || !it.jobId || it.finalVideo) continue; // sudah diselamatkan
        const job = clipperJobs.get(String(it.jobId));
        const jobDir = job && job.dir ? job.dir : path.join(clipUserDir(user), String(it.jobId));
        const srcMp4 = path.join(jobDir, 'clip_' + (Number(it.renderIdx) || 0) + '.mp4');
        const srcThumb = path.join(jobDir, 'clip_' + (Number(it.renderIdx) || 0) + '_thumb.png');
        if (!fs.existsSync(srcMp4)) continue; // belum render / sudah hilang — tidak ada yang diselamatkan
        const destDir = path.join(libDir(), 'clipper-final', encodeURIComponent(user), String(it.jobId));
        try { fs.mkdirSync(destDir, { recursive: true }); } catch {}
        const destMp4 = path.join(destDir, 'clip_' + (Number(it.renderIdx) || 0) + '.mp4');
        const destThumb = path.join(destDir, 'clip_' + (Number(it.renderIdx) || 0) + '_thumb.png');
        try {
          fs.copyFileSync(srcMp4, destMp4);
          it.finalVideo = 'clipper-final/' + encodeURIComponent(user) + '/' + String(it.jobId) + '/clip_' + (Number(it.renderIdx) || 0) + '.mp4';
          if (fs.existsSync(srcThumb)) {
            try { fs.copyFileSync(srcThumb, destThumb); it.finalThumb = 'clipper-final/' + encodeURIComponent(user) + '/' + String(it.jobId) + '/clip_' + (Number(it.renderIdx) || 0) + '_thumb.png'; } catch {}
          }
          changed = true;
        } catch {}
      }
      if (changed) libSave(user, arr);
    } catch {}
    for (const [k, j] of clipperJobs) if (j.user === user) { j.cancelled = true; try { if (j.aiCtrl) j.aiCtrl.abort(); } catch {} try { if (j.abortCtrl) j.abortCtrl.abort(); } catch {} clipperJobs.delete(k); }
    clipRm(clipUserDir(user));
    return send(res, 200, { ok: true });
  }
  // File Final Clipper yang diselamatkan (lihat /api/clipper/cleanup):
  // GET /api/library/clipper-file?id=<entryId>&kind=video|thumb
  if (req.method === 'GET' && p === '/api/library/clipper-file') {
    const user = sessUser(req);
    const id = String(u.searchParams.get('id') || '');
    const kind = u.searchParams.get('kind') === 'thumb' ? 'thumb' : 'video';
    const arr = libLoad(user);
    const it = arr.find(x => x.id === id && x.type === 'clipper');
    if (!it) return send(res, 404, { error: 'Entri tidak ditemukan' });
    const rel = kind === 'thumb' ? it.finalThumb : it.finalVideo;
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) return send(res, 404, { error: 'File tidak tersedia' });
    const file = path.join(libDir(), rel);
    // Guard: pastikan file di dalam libDir (anti traversal).
    if (!file.startsWith(libDir() + path.sep)) return send(res, 403, { error: 'Akses ditolak' });
    if (!fs.existsSync(file)) return send(res, 404, { error: 'File tidak ditemukan' });
    const ct = kind === 'thumb' ? 'image/png' : 'video/mp4';
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res); return;
  }
  res.writeHead(404); res.end('Tidak ditemukan');
});
if (require.main === module) server.listen(PORT, () => console.log('Script VO Agent berjalan di http://localhost:' + PORT));
// Ekspor helper (untuk tes unit): require() tidak menyalakan server.
module.exports = { sendTelegram, clipFmtDur, clipTrunc, clipRenderDoneText, clipNotifyFail, TELEGRAM_ENABLED, clipTranscribeGroq, clipGroqChunkPlan, clipGroqParseSegments, clipGroqTranscribeFile, clipTranscribeAuto, clipNormTranscribeVia, clipTranscriptLang, clipNormTranscriptLang, clipFilterMixedLang, clipAppendCandidates, clipFetchYoutubeCaptions, clipParseSrv1, clipFetchTranscript, clipWhisperArgs, GROQ_ENABLED, clipPlainFileName, clipFontsDir, clipLowResWarning, clipProbeHeight, clipBrollPath, clipProbeDuration, clipParseMultipart, clipAiNoteText, clipFetchHeatmap, clipHeatmapCandidates, clipHeatmapOrFallback, clipHeuristicCandidates, clipFetchYoutubeInfo, CLIP_YT_INFO_ATTEMPTS, CLIP_YT_DL_ATTEMPTS, clipYtClientArgs, clipYtPlan };
