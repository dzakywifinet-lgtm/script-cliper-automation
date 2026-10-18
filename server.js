// Script VO Agent: server tanpa dependensi (Node 18+). API key hanya ada di server.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');
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
const M = { gemini: E.GEMINI_MODEL || 'gemini-2.5-flash', claude: E.CLAUDE_MODEL || 'claude-sonnet-4-6', openai: E.OPENAI_MODEL || 'gpt-4o' };
const KEY = { gemini: 'GEMINI_API_KEY', claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const R = (E.ROUTER_URL || '').replace(/\/+$/, '').replace(/\/v1$/, '');
const rh = () => { const h = {}; if (E.ROUTER_API_KEY) h.authorization = 'Bearer ' + E.ROUTER_API_KEY; if (E.CF_ACCESS_CLIENT_ID) { h['CF-Access-Client-Id'] = E.CF_ACCESS_CLIENT_ID; h['CF-Access-Client-Secret'] = E.CF_ACCESS_CLIENT_SECRET || ''; } return h; };
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
// Alasan berhenti yang berarti selesai normal; selain itu (length, max_tokens, MAX_TOKENS, dll) = terpotong
const NORMAL = /^(?:finish_reason_)?(stop|end_turn|stop_sequence|eos|completed?|natural)$/i;
const abortErr = (e, job) => e.name === 'AbortError' ? (job.stopped ? fail('Dihentikan oleh pengguna', 'stopped') : fail('Waktu habis menunggu AI (10 menit)', 'timeout')) : null;
// Mode 9router: streaming, hasil sebagian disimpan di job.partial
async function viaRouter(model, msgs, job) {
  let r;
  try {
    r = await fetch(R + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...rh() }, signal: job.ctrl.signal,
      body: JSON.stringify({ model, max_tokens: MAXT, stream: true, messages: msgs }) });
  } catch (e) { throw abortErr(e, job) || fail('Tidak bisa menjangkau 9router: ' + (e.cause?.code || e.cause?.message || e.message), 'network'); }
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
    throw fail('Koneksi ke 9router terputus saat menulis: ' + (e.cause?.code || e.message), 'cut');
  }
  if (!out.trim()) throw fail('Model membalas kosong', 'empty');
  // selesai normal hanya jika ada alasan berhenti normal, atau [DONE] tanpa alasan apa pun; stream putus mendadak = terpotong
  job.truncated = job.finish ? !NORMAL.test(job.finish) : !job.sawDone;
  return cleanThink(out);
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
const CLIPPER_DIR = E.CLIPPER_WORK_DIR || '/opt/docker/clipper-work';
const clipperJobs = new Map();
setInterval(() => { for (const [k, v] of clipperJobs) if (Date.now() - v.ts > 24 * 3600 * 1000) clipperJobs.delete(k); }, 60 * 1000).unref();
const clipUserDir = user => path.join(CLIPPER_DIR, encodeURIComponent(user));
const clipFontsDir = () => path.join(__dirname, 'public', 'fonts');
const clipFontFile = (italic, bold, fontName) => {
  // Font judul: DejaVu Sans (default) atau Liberation Sans (hanya ada file BoldItalic).
  if (fontName === 'Liberation Sans') return path.join(clipFontsDir(), 'LiberationSans-BoldItalic.ttf');
  return path.join(clipFontsDir(), italic ? 'LiberationSans-BoldItalic.ttf' : (bold === false ? 'DejaVuSans.ttf' : 'DejaVuSans-Bold.ttf'));
};
const clipLog = (job, msg) => { job.log.push({ t: new Date().toISOString().slice(11, 19), msg: String(msg).slice(0, 500) }); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); clipSaveJob(job); };
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
      downloadPct: job.downloadPct };
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
            job.log.push({ t: new Date().toISOString().slice(11, 19), msg: 'Server restart — proses terputus.' });
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
  sourceReady: !!job.sourceReady,
  videoTitle: job.videoTitle, duration: job.duration, log: job.log, candidates: job.candidates,
  cues: job.cues || [],
  renders: job.renders.map(r => ({ index: r.index, title: r.title, status: r.status, size: r.size || 0, plainSize: r.plainSize || 0, raw: !!r.raw, thumb: !!r.thumb, error: r.error || null })),
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
async function clipInputYoutube(job, url) {
  const dir = job.dir;
  try {
    job.phase = 'info'; clipLog(job, 'Mengambil info video…');
    // Fallback player Android: client web YouTube kini sering minta PO token
    // ("The page needs to be reloaded") yang yt-dlp tidak bisa bikin. Client
    // Android tidak butuh PO token. Coba web dulu (format terbaik), kalau
    // gagal karena reload/bot, ulang pakai Android (kita cap 720p, jadi
    // format Android cukup).
    const ytAuthRetry = /needs to be reloaded|Sign in to confirm|not a bot|PO token|player response/i;
    let info = await clipRun('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', ...clipYtCookies(), url], { timeout: 90000, maxOut: 5000000, signal: job.abortCtrl.signal });
    if (info.code !== 0 && !job.cancelled && ytAuthRetry.test(info.stderr || '')) {
      clipLog(job, 'YouTube web minta reload/auth — coba ulang pakai player Android/iOS/Embed…');
      info = await clipRun('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--extractor-args', 'youtube:player_client=android,ios,web_embedded', ...clipYtCookies(), url], { timeout: 90000, maxOut: 5000000, signal: job.abortCtrl.signal });
    }
    // Fallback TANPA cookies: kalau cookies-nya bermasalah (tidak lengkap /
    // kedaluwarsa / akun tidak cocok), request ber-auth justru ditolak YouTube
    // padahal videonya PUBLIK (tanpa cookies malah jalan). Coba tanpa cookies.
    if (info.code !== 0 && !job.cancelled && clipYtCookies().length) {
      clipLog(job, 'Pakai cookies tetap gagal — coba tanpa cookies (video publik)…');
      info = await clipRun('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--extractor-args', 'youtube:player_client=android,ios,web_embedded', url], { timeout: 90000, maxOut: 5000000, signal: job.abortCtrl.signal });
    }
    if (job.cancelled) return;
    if (info.code !== 0) throw fail('yt-dlp tidak bisa membaca link ini: ' + info.stderr.replace(/\s+/g, ' ').slice(-300), 'yt-dlp');
    let meta = {};
    try { meta = JSON.parse(info.stdout || ''); } catch {}
    job.videoTitle = meta.title || 'Video YouTube';
    job.duration = +meta.duration || 0;
    job.metaDesc = String(meta.description || '');
    job.metaUploader = String(meta.uploader || '');
    if (!(job.duration > 0)) throw fail('Durasi video tidak terbaca (video live / belum tayang?).', 'input');
    job.phase = 'download'; job.downloadPct = 0; clipLog(job, 'Mengunduh video (maks 720p)…');
    const src = path.join(dir, 'source.mp4');
    // Progress download yt-dlp: baca baris "[download] 45.2%" dari stdout/stderr, petakan ke bar 10-40%.
    const onDl = s => { const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(s); if (m) { job.downloadPct = +m[1]; job.progress = 10 + job.downloadPct * 0.3; } };
    // Download bisa terpotong diam-diam (file tersimpan tapi durasinya lebih pendek
    // dari info video — misal cuma 900 detik dari video yang lebih panjang).
    // Verifikasi durasi file hasil download; kalau terpotong, download ulang sekali;
    // kalau masih terpotong, gagalkan dengan pesan jelas (jangan tandai ready).
    let savedDur = 0;
    for (let dlTry = 0; dlTry < 2; dlTry++) {
      // Fallback player Android (sama kayak info di atas): kalau download web
      // gagal karena reload/bot, ulang pakai Android.
      const dlArgs = ['--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '3', '--concurrent-fragments', '4', ...clipYtCookies(),
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
      const dlOpts = { timeout: 20 * 60 * 1000, onStdout: onDl, onStderr: onDl, signal: job.abortCtrl.signal };
      let dl = await clipRun('yt-dlp', dlArgs, dlOpts);
      if (dl.code !== 0 && !job.cancelled && ytAuthRetry.test(dl.stderr || '')) {
        clipLog(job, 'Download web gagal (reload/auth) — coba ulang pakai player Android/iOS/Embed…');
        dl = await clipRun('yt-dlp', ['--extractor-args', 'youtube:player_client=android,ios,web_embedded', ...dlArgs], dlOpts);
      }
      // Fallback TANPA cookies (sama kayak info di atas): cookies bermasalah
      // bisa bikin download ditolak padahal videonya publik.
      if (dl.code !== 0 && !job.cancelled && clipYtCookies().length) {
        const noCookieArgs = dlArgs.filter((a, i) => !(a === '--cookies' || dlArgs[i - 1] === '--cookies'));
        clipLog(job, 'Download pakai cookies tetap gagal — coba tanpa cookies…');
        dl = await clipRun('yt-dlp', ['--extractor-args', 'youtube:player_client=android,ios,web_embedded', ...noCookieArgs], dlOpts);
      }
      if (job.cancelled) return;
      if (dl.code !== 0 || !fs.existsSync(src)) throw fail('Gagal mengunduh video: ' + dl.stderr.replace(/\s+/g, ' ').slice(-300), 'download');
      savedDur = await clipProbeDuration(src);
      if (savedDur >= job.duration * 0.95) break;
      clipLog(job, 'Video terpotong (tersimpan ' + Math.round(savedDur) + ' detik dari ' + Math.round(job.duration) + ' detik)' + (dlTry === 0 ? ', mencoba download ulang…' : '.'));
      try { fs.unlinkSync(src); } catch {}
    }
    if (savedDur < job.duration * 0.95) throw fail('Video terpotong: tersimpan ' + Math.round(savedDur) + ' detik dari ' + Math.round(job.duration) + ' detik. Coba klik Simpan lagi.', 'download');
    // Durasi FILE (ffprobe) jadi acuan — kalau info -J ternyata lebih pendek dari
    // file aslinya, analisis harus mencakup seluruh file, bukan cuma durasi -J.
    if (savedDur > 0) job.duration = savedDur;
    // Warning dini: kalau codec sumber bukan H.264, ffmpeg minimal mungkin tidak
    // bisa decode (render akan gagal "Error while decoding stream").
    const srcCodec = await clipProbeCodec(src);
    if (srcCodec && srcCodec !== 'h264') clipLog(job, 'Perhatian: video sumber codec ' + srcCodec.toUpperCase() + ' (bukan H.264) — ffmpeg server mungkin tidak bisa decode. Jika render gagal, coba video lain / install ffmpeg yang lebih lengkap.');
    if (job.cancelled) return;
    const sizeMB = (fs.statSync(src).size / 1048576).toFixed(1);
    job.source = src; job.sourceReady = true;
    job.phase = 'input-done'; job.progress = 100; job.status = 'ready';
    clipLog(job, 'Video tersimpan di server (' + sizeMB + ' MB, durasi ' + Math.round(job.duration) + ' detik). Klik Analisis AI untuk mulai.');
  } catch (e) {
    // Dihentikan via tombol Stop: endpoint stop sudah set status/error/log — jangan timpa.
    if (!job.cancelled) { job.status = 'error'; job.error = e.message || String(e); clipLog(job, 'Gagal: ' + job.error); }
  }
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
// Transkrip otomatis (Whisper, lokal) via whisper-transcribe.py — dipakai saat
// Analisis dan tidak ada transkrip YouTube. Hasilnya jadi auto-caption kayak
// CapCut (subtitle di render) + dipakai analisis AI. Gagal -> throw, pemanggil
// lanjut analisis metadata (jangan gagalkan analisis).
async function clipWhisperTranscribe(file, job) {
  const model = process.env.WHISPER_MODEL || 'tiny';
  const script = path.join(__dirname, 'whisper-transcribe.py');
  const p = await clipRun('python3', [script, file, '--model', model], { timeout: 20 * 60 * 1000, signal: job && job.abortCtrl ? job.abortCtrl.signal : undefined });
  if (p.code !== 0) throw new Error('whisper-transcribe gagal: ' + (p.stderr || '').replace(/\s+/g, ' ').slice(-300));
  let out = {};
  try { out = JSON.parse(p.stdout || ''); } catch { throw new Error('whisper-transcribe: output bukan JSON'); }
  return { segments: Array.isArray(out.segments) ? out.segments : [], language: out.language || '' };
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
  } catch (e) {
    if (!job.cancelled) { job.status = 'error'; job.error = e.message || String(e); clipLog(job, 'Gagal: ' + job.error); }
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
    let maxVol = -60;
    try {
      const p = await clipRun('ffmpeg', ['-ss', String(w.start), '-t', String(w.end - w.start), '-i', job.source, '-af', 'volumedetect', '-vn', '-sn', '-dn', '-f', 'null', '-'], { timeout: 120000 });
      const m = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(p.stderr || '');
      if (m) maxVol = +m[1];
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
    scored.push({ ...w, maxVol, boost, sampleText });
  }
  scored.sort((a, b) => (b.maxVol + b.boost) - (a.maxVol + a.boost));
  return scored.slice(0, count).map((w, i) => {
    const title = w.sampleText ? clipperLib.cleanTitle(w.sampleText, 60) : 'Momen paling keras ' + (i + 1);
    const score = Math.max(50, Math.min(100, Math.round(100 + w.maxVol * 1.5)));
    return { start: Math.round(w.start), end: Math.round(w.end), title,
      score, reason: 'Volume max ' + w.maxVol.toFixed(1) + ' dB' + (w.boost > 0 ? ' + transkrip ramai' : '') + ' (deteksi suara, tanpa AI).' };
  });
}

// Tahap 2 — Analisis: pakai video yang SUDAH tersimpan (tanpa download ulang).
// Transkrip diambil lagi tiap analisis (cepat, bukan video), lalu AI cari kandidat.
// Dipanggil endpoint /api/clipper/analyze.
async function clipAnalyzeSaved(job, targetDur, count, provider, model, route) {
  const dir = job.dir;
  try {
    job.phase = 'transcript'; job.progress = 0; clipLog(job, 'Mencari transkrip/caption…');
    let cues = [];
    if (job.sourceUrl) {
      try {
        const sub = await clipRun('yt-dlp', ['--skip-download', '--no-playlist', '--no-warnings', '--write-subs', '--write-auto-subs', ...clipYtCookies(),
          '--sub-langs', 'id.*,en.*', '--sub-format', 'vtt/best', '--convert-subs', 'vtt',
          '--socket-timeout', '30', '-o', path.join(dir, 'sub.%(ext)s'), job.sourceUrl], { timeout: 150000, signal: job.abortCtrl.signal });
        if (sub.code === 0) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.vtt'));
          const all = [];
          for (const f of files) { try { all.push(...clipperLib.parseVtt(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {} }
          all.sort((a, b) => a.start - b.start);
          const seen = new Set();
          for (const c of all) { const k = c.start.toFixed(1) + '|' + c.text; if (!seen.has(k)) { seen.add(k); cues.push(c); } }
        }
      } catch {}
    }
    // Jika tidak ada transkrip YouTube, coba transkrip otomatis (Whisper, lokal,
    // gratis). Ini yang jadi auto-caption kayak CapCut + dipakai analisis AI.
    // Transkrip yang SUDAH berhasil di Analisis sebelumnya dipakai lagi — jangan
    // transkrip ulang (Whisper lambat; AI gagal lalu Analisis lagi harusnya
    // cuma ngulang AI-nya, bukan Whisper-nya).
    if (!cues.length) {
      if (job.cues && job.cues.length) {
        cues = job.cues;
        clipLog(job, 'Memakai transkrip tersimpan (' + (job.transcriptSource === 'whisper' ? 'Whisper' : 'sebelumnya') + ', ' + cues.length + ' cue) — tidak transkrip ulang.');
      } else {
      try {
        clipLog(job, 'Transkrip YouTube tidak ada — menjalankan transkrip otomatis (Whisper, lokal, bisa beberapa menit)…');
        const w = await clipWhisperTranscribe(path.join(dir, 'source.mp4'), job);
        if (w.segments.length) {
          // Kata per kata ikut disimpan (dari Whisper tokens) — dipakai
          // subtitle karaoke + Koreksi Kata. Cue tanpa words = bagi rata.
          cues = w.segments.map(s => clipperLib.normalizeCueWords({ start: s.start, end: s.end, text: s.text, words: s.words }));
          job.transcriptSource = 'whisper';
          clipLog(job, 'Transkrip otomatis (Whisper) selesai: ' + cues.length + ' segmen' + (w.language ? ' (bahasa: ' + w.language + ')' : '') + '.');
        } else {
          clipLog(job, 'Transkrip otomatis (Whisper) tidak menghasilkan teks.');
        }
      } catch (e) {
        // Whisper belum terpasang / gagal — jangan gagalkan analisis, lanjut metadata.
        if (job.cancelled) return;
        clipLog(job, 'Transkrip otomatis (Whisper) gagal — lanjut analisis dari judul + metadata. (Pasang whisper.cpp di server: build whisper-cli + model ggml-tiny.bin)');
      }
      }
    }
    job.cues = cues.map(c => clipperLib.normalizeCueWords(c));
    if (job.cancelled) return;
    clipLog(job, cues.length ? ('Transkrip ditemukan: ' + cues.length + ' cue.') : 'Transkrip tidak tersedia — analisis dari judul + metadata saja.');
    job.phase = 'ai';
    // Tanpa AI: deteksi suara saja (nol token). Transkrip (kalau ada) dipakai buat
    // boost + judul, tapi tidak ada panggilan API AI sama sekali.
    if (route === 'none') {
      clipLog(job, 'Mencari momen paling keras (deteksi suara, tanpa AI — nol token)…');
      let cand = await clipHeuristicCandidates(job, targetDur, count);
      if (job.cancelled) return;
      cand = clipperLib.sanitizeCandidates(cand, job.duration, targetDur, count);
      if (!cand.length) { cand = clipperLib.fallbackCandidates(job.duration, targetDur, count); clipLog(job, 'Deteksi suara tidak menemukan kandidat — memakai pembagian merata.'); }
      job.candidates = cand.map((c, i) => ({ ...c, index: i }));
      job.renders = [];
      job.phase = 'done'; job.progress = 100; job.status = 'done';
      clipLog(job, 'Analisis selesai: ' + cand.length + ' kandidat klip (tanpa AI).');
    // Auto-render (server-side): analisis selesai -> render semua kandidat otomatis.
    // Tahan reload / tutup halaman (frontend tidak perlu trigger render lagi).
    // Status langsung 'rendering' (clipRender set status di awal, sinkron) jadi
    // poll() frontend tidak berhenti di 'done' lalu kehilangan render.
    if (job.autoRender && !job.cancelled && (job.candidates || []).length) {
      job.autoRender = false;
      clipLog(job, 'Analisis selesai — render otomatis dimulai…');
      const selected = (job.candidates || []).map(c => ({ index: c.index, title: c.title }));
      clipRender(job, selected, { raw: true, ctaText: 'VIDEO LENGKAPNYA | KLIK DISINI ↓', hookEnabled: true }).catch(() => {});
    }
      return;
    }
    clipLog(job, 'AI menganalisis momen terbaik…');
    const chunks = cues.length ? clipperLib.chunkTranscript(cues, 8, 5000) : [];
    const useRouter = route === 'router' ? true : route === 'direct' ? false : !!R;
    if (useRouter && !model) throw fail('Pilih model/combo 9router untuk analisis di pengaturan AI Auto Clipper.', 'input');
    if (!useRouter && !call[provider]) throw fail('Provider Direct tidak dikenal.', 'input');
    if (!useRouter && !E[KEY[provider]]) throw fail(KEY[provider] + ' belum diisi di .env.', 'input');
    let allCand = [];
    const jobs = [];
    // Model cadangan kalau model 9router yang dipilih ternyata sudah EOL (410 Gone)
    // padahal masih tampil di daftar model — sudah terbukti jalan sebelumnya.
    const CLIP_FALLBACK_MODEL = 'gemini/gemini-3.8-flash';
    let aiModel = model;
    // Instruksi AI per proyek (dari Pengaturan Proyek, opsional): disisipkan ke
    // SEMUA prompt analisis (segmen + metadata) — misal "fokus ke momen lucu".
    const aiNoteTxt = String(job.aiNote || '').trim() ? '\nInstruksi tambahan dari user (WAJIB dipatuhi, di atas aturan lain kecuali format JSON): ' + String(job.aiNote).trim().slice(0, 500) + '\n' : '';
    if (chunks.length) {
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const prompt = 'Kamu analis konten video. Cari momen paling "wah" untuk klip Shorts/Reels.\n'
          + 'Video: "' + job.videoTitle + '" (durasi ' + Math.round(job.duration) + ' detik).\n'
          + 'Transkrip segmen [' + ch.start.toFixed(0) + 's - ' + ch.end.toFixed(0) + 's]:\n' + ch.text.slice(0, 12000) + '\n\n'
          + 'Tugas: cari ' + count + ' momen paling wah (mengejutkan, lucu, emosional, kontroversial, atau bikin penasaran) untuk klip durasi sekitar ' + targetDur + ' detik.\n'
          + 'Balas HANYA JSON array (tanpa markdown, tanpa penjelasan): [{"start":detik,"end":detik,"title":"Judul hook singkat maks 60 karakter","score":0-100,"reason":"satu kalimat","hook":[{"start":detik,"end":detik,"text":"TEKS 2-5 KATA"}],"caption":"1-2 kalimat caption siap posting tanpa hashtag","hashtags":["#tag1","#tag2"]}]\n'
          + 'Caption + hashtag per kandidat (gaya Klipaja): caption 1-2 kalimat siap posting (tanpa hashtag, maks 200 karakter, nyambung sama momen klip itu), hashtags 3-5 hashtag relevan (diawali #).\n'
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
        + 'Balas HANYA JSON array (tanpa markdown, tanpa penjelasan): [{"start":detik,"end":detik,"title":"Judul hook singkat maks 60 karakter","score":0-100,"reason":"satu kalimat","hook":[{"start":detik,"end":detik,"text":"TEKS 2-5 KATA"}],"caption":"1-2 kalimat caption siap posting tanpa hashtag","hashtags":["#tag1","#tag2"]}]\n'
        + 'Caption + hashtag per kandidat (gaya Klipaja): caption 1-2 kalimat siap posting (tanpa hashtag, maks 200 karakter), hashtags 3-5 hashtag relevan (diawali #).\n'
        + 'Hook multi-hook: untuk TIAP kandidat, isi 2–3 potongan pendek (0,5–2 detik) DI DALAM kandidat itu (start/end hook HARUS di dalam start/end kandidat, tersebar di awal/tengah/akhir kandidat), masing-masing dengan teks on-screen singkat 2–5 kata (huruf besar).\n'
        + aiNoteTxt
        + 'Aturan: start/end angka detik dalam 0 s/d ' + Math.round(job.duration) + ', end-start ' + targetDur + ' detik (boleh 10 s/d ' + (targetDur + 30) + '), jangan tumpang tindih berat.' });
    }
    for (const j of jobs) {
      const aiJob = { ctrl: new AbortController(), chars: 0, partial: '', finish: '', truncated: false };
      job.aiCtrl = aiJob.ctrl;
      const timer = setTimeout(() => aiJob.ctrl.abort(), 10 * 60 * 1000);
      let out = '';
      try {
        out = useRouter ? await viaRouter(aiModel, [{ role: 'user', content: j.prompt }], aiJob)
          : await call[provider]([{ role: 'user', content: j.prompt }], aiJob);
      } catch (e) {
        // Model 9router bisa EOL (410 Gone) padahal masih tampil di daftar model.
        // Coba sekali lagi pakai model cadangan, jangan langsung gagal — dan pakai
        // model cadangan untuk sisa segmen di analisis ini (biar nggak 410 berulang).
        const gone = useRouter && aiModel !== CLIP_FALLBACK_MODEL && (e.status === 410 || /410|end of life|gone/i.test(e.message || ''));
        if (!gone) {
          // Biar jelas sumber gagalnya: error via 9router diawali "9router: "
          // (bukan kode Clipper). Kalau pakai Direct, pesannya dari provider itu.
          if (useRouter && e && e.message && !/^9router:/.test(e.message)) e.message = '9router: ' + e.message;
          throw e;
        }
        clipLog(job, 'Model ' + aiModel + ' sudah tidak tersedia (410), mencoba model cadangan ' + CLIP_FALLBACK_MODEL + '…');
        aiModel = CLIP_FALLBACK_MODEL;
        out = await viaRouter(aiModel, [{ role: 'user', content: j.prompt }], aiJob);
      } finally { clearTimeout(timer); job.aiCtrl = null; }
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
    job.candidates = cand.map((c, i) => ({ ...c, index: i }));
    job.renders = [];
    if (job.cancelled) return;
    job.phase = 'done'; job.progress = 100; job.status = 'done';
    clipLog(job, 'Analisis selesai: ' + cand.length + ' kandidat klip.');
    // Auto-render (server-side): analisis selesai -> render semua kandidat otomatis.
    // Tahan reload / tutup halaman (frontend tidak perlu trigger render lagi).
    // Status langsung 'rendering' (clipRender set status di awal, sinkron) jadi
    // poll() frontend tidak berhenti di 'done' lalu kehilangan render.
    if (job.autoRender && !job.cancelled && (job.candidates || []).length) {
      job.autoRender = false;
      clipLog(job, 'Analisis selesai — render otomatis dimulai…');
      const selected = (job.candidates || []).map(c => ({ index: c.index, title: c.title }));
      clipRender(job, selected, { raw: true, ctaText: 'VIDEO LENGKAPNYA | KLIK DISINI ↓', hookEnabled: true }).catch(() => {});
    }
  } catch (e) {
    if (!job.cancelled) { job.status = 'error'; job.error = e.message || String(e); clipLog(job, 'Gagal: ' + job.error); }
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
async function clipFaceTrack(job, sel, cand) {
  const trackFile = path.join(job.dir, 'clip_' + sel.index + '_facetrack.json');
  try {
    if (fs.existsSync(trackFile) && fs.statSync(trackFile).size > 0) {
      const d = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
      if (Array.isArray(d.track) && d.track.length >= 2) return d.track;
    }
  } catch {}
  const script = path.join(__dirname, 'face_track.py');
  if (!fs.existsSync(script)) return null;
  const dockerImage = E.FACE_TRACK_IMAGE || (E.FACE_TRACK_DOCKER === '1' ? 'facetrack' : null);
  try {
    clipLog(job, 'Face tracking klip ' + sel.index + ' (deteksi wajah + suara)…');
    const ftArgs = ['--input', job.source, '--start', String(cand.start), '--end', String(cand.end), '--out', trackFile, '--fps', '2', '--ema', '0.5'];
    if (dockerImage) {
      // Docker: mount job dir + dir sumber (path sama di dalam container = di host).
      const mounts = [...new Set([job.dir, path.dirname(job.source)])];
      const dArgs = ['run', '--rm'];
      for (const m of mounts) dArgs.push('-v', m + ':' + m);
      dArgs.push(dockerImage, ...ftArgs);
      await clipRun('docker', dArgs, { timeout: 180000 });
    } else {
      const py = E.FACE_TRACK_PYTHON || 'python3';
      await clipRun(py, [script, ...ftArgs], { timeout: 180000 });
    }
    const d = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    if (Array.isArray(d.track) && d.track.length >= 2) {
      clipLog(job, 'Face tracking selesai (' + d.track.length + ' titik, ' + d.track.filter(s => s.speaking).length + ' titik ngomong).');
      return d.track;
    }
  } catch (e) {
    clipLog(job, 'Face tracking gagal (' + (e.message || e).toString().slice(0, 120) + ') — pakai fokus statis. Install OpenCV biar tracking jalan (pip install opencv-python-headless).');
  }
  return null;
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
    // Toggle per-klip dari Detail (Pakai Judul / CTA / Subtitle): sel > flag
    // tersimpan di kandidat > global (judul default ON, CTA/Sub ikut global).
    if (sel.showTitle !== undefined) cand.showTitle = !!sel.showTitle;
    if (sel.showCta !== undefined) cand.showCta = !!sel.showCta;
    if (sel.showSub !== undefined) cand.showSub = !!sel.showSub;
    // Preset Gaya Subtitle / Judul Hook (Detail): sel > tersimpan di kandidat >
    // default. Disimpan ke kandidat biar render ulang / render dari Hasil Klip
    // tetap pakai preset yang dipilih (tidak reset ke Default).
    if (sel.subPreset !== undefined) cand.subPreset = String(sel.subPreset || 'default');
    if (sel.hookPreset !== undefined) cand.hookPreset = String(sel.hookPreset || 'tanpa');
    const subPreset = sel.subPreset !== undefined ? String(sel.subPreset || 'default') : (cand.subPreset || 'default');
    const hookPreset = sel.hookPreset !== undefined ? String(sel.hookPreset || 'tanpa') : (cand.hookPreset || 'tanpa');
    // Durasi judul (Detail): sel > tersimpan di kandidat > default (4 detik).
    if (sel.titleDur !== undefined && ['default', 'full', 'manual'].includes(String(sel.titleDur))) cand.titleDur = String(sel.titleDur);
    if (sel.titleDurSec !== undefined && Number.isFinite(+sel.titleDurSec)) cand.titleDurSec = Math.min(120, Math.max(0.5, +sel.titleDurSec));
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
    const titleYPercent = sel.titleYPercent !== undefined ? +sel.titleYPercent : (cand.titleYPercent !== undefined ? +cand.titleYPercent : undefined);
    const titleSizePercent = sel.titleSizePercent !== undefined ? +sel.titleSizePercent : (cand.titleSizePercent !== undefined ? +cand.titleSizePercent : undefined);
    // Warna teks judul: per-klip (picker Detail) > preset > global (global
    // cuma dipakai kalau preset 'tanpa' — preset lain punya warna sendiri).
    const titleColor1 = sel.titleColor1 !== undefined ? hexOr(sel.titleColor1, undefined)
      : (cand.titleColor1 !== undefined ? cand.titleColor1 : (hookPreset === 'tanpa' ? opts.fontColor : undefined));
    const titleCardColor = sel.titleCardColor !== undefined ? hexOr(sel.titleCardColor, undefined)
      : (cand.titleCardColor !== undefined ? cand.titleCardColor : undefined);
    const subYPercent = sel.subYPercent !== undefined ? +sel.subYPercent : (cand.subYPercent !== undefined ? +cand.subYPercent : undefined);
    const subSizePercent = sel.subSizePercent !== undefined ? +sel.subSizePercent : (cand.subSizePercent !== undefined ? +cand.subSizePercent : undefined);
    const showTitle = sel.showTitle !== undefined ? !!sel.showTitle : (cand.showTitle !== undefined ? !!cand.showTitle : true);
    const showCta = sel.showCta !== undefined ? !!sel.showCta : (cand.showCta !== undefined ? !!cand.showCta : opts.ctaEnabled !== false);
    const showSub = sel.showSub !== undefined ? !!sel.showSub : (cand.showSub !== undefined ? !!cand.showSub : !!opts.subtitle);
    // Hook multi-hook (gaya Hook V2): potongan pendek dari dalam kandidat ini,
    // disambung di depan klip utama. Frontend kirim sel.hook kalau toggle hook
    // ON; kalau tidak, pakai hook AI di kandidat (kalau ada). Waktu absolut
    // (sumber) -> relatif ke awal klip (cand.start) untuk buildAss + ffmpeg.
    let hookRel = [];
    if (opts.hookEnabled !== false) {
      const rawHook = Array.isArray(sel.hook) && sel.hook.length ? sel.hook : (cand.hook || []);
      for (const h of rawHook) {
        if (!h || typeof h !== 'object') continue;
        const hs = +h.start - cand.start, he = +h.end - cand.start;
        if (!Number.isFinite(hs) || !Number.isFinite(he) || he - hs < 0.5 || he - hs > 2.5) continue;
        if (hs < 0 || he > cand.end - cand.start) continue;
        hookRel.push({ start: Math.round(hs * 100) / 100, end: Math.round(he * 100) / 100, text: clipperLib.cleanTitle(h.text, 30) });
        if (hookRel.length >= 3) break;
      }
    }
    // Sensor kata (Koreksi Kata): kata yang di-sensor di rentang klip ini ->
    // rentang bisu (waktu RELATIF output = relatif klip + hookTotal, karena
    // klip utama mulai setelah hook di timeline hasil render).
    const hookTotal = hookRel.reduce((a, h) => a + (h.end - h.start), 0);
    const sensorRel = [];
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
    // Mode dari request (Pengaturan Proyek) — kalau request tidak kirim mode/bg/focus, pakai mode job (dari Analisis).
    if (opts.mode == null && job.mode) opts.mode = job.mode;
    if (opts.mode === 'podcast' || opts.mode === 'auto') opts.podcast = true; else if (opts.mode === 'landscape') opts.podcast = false;
    if (opts.bg == null && job.bg) opts.bg = job.bg;
    if (opts.focus == null && Number.isFinite(job.focus)) opts.focus = job.focus;
    const bg = ['black', 'white'].includes(opts.bg) ? opts.bg : 'blur';
    // Face tracking (Podcast + checkbox ON): hitung dulu — nama file polos beda
    // kalau pakai tracking (_ft) vs fokus statis, biar cache tidak ketuker.
    let faceTrack = null;
    if (opts.podcast && opts.faceTrack !== false) faceTrack = await clipFaceTrack(job, sel, cand);
    // Video POLOS (tanpa judul/subtitle) — cache. Nama file menyertakan bg agar
    // ganti bg (blur<->hitam) membuat file polos baru (tidak pakai cache yang salah).
    const plainFile = path.join(job.dir, 'clip_' + sel.index + '_plain_' + (opts.podcast ? (faceTrack ? 'podcast_ft' : 'podcast') : bg) + '.mp4');
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
      // atau tidak ada cue (kalau tidak, judul + CTA ikut hilang).
      const hasOverlay = (showTitle && !!title.trim()) || (showCta && String(sel.ctaText || opts.ctaText || '').trim());
      // Helper bangun .ass (dengan / tanpa hook) — kalau render hook gagal
      // (misal klip polos tanpa audio -> concat a=1 gagal), .ass di-rebuild
      // tanpa hook lalu render diulang tanpa hook (fallback, bukan gagal total).
      const buildAssFile = (useHook) => {
        if (!hasOverlay && !(showSub && job.cues && job.cues.length)) return null;
        const ass = clipperLib.buildAss(job.cues, cand.start, cand.end, {
          size: opts.subSize, marginV: opts.subMarginV, color: opts.subColor, bold: opts.subBold, font: opts.subFont,
        }, {
          title, titleColor1, titleColor2: opts.titleColor2,
          titleSize: opts.titleSize, titleY: opts.titleY, titleBold: opts.titleBold, titleFont: opts.titleFont, titleItalic: !!opts.italic,
          titleYPercent, titleSizePercent, titleCardColor, // posisi/ukuran/warna kartu judul per-klip (Detail)
          subYPercent, subSizePercent, // posisi/ukuran subtitle per-klip (Detail)
          showTitle, showSub, // toggle per-klip (Detail) — buildAss hormati (judul/subtitle tidak dibakar kalau off)
          subPreset, hookPreset, // preset Gaya Subtitle / Judul Hook (Detail) — buildAss override gaya
          titleDur, titleDurSec, // durasi judul (Detail): default 4 detik / full / manual
          cta: { enabled: showCta, text: sel.ctaText || opts.ctaText, y: opts.ctaY, color: opts.ctaColor }, // CTA per-klip (toggle Detail + teks di kartu), fallback ke global
          hook: useHook ? hookRel : [],
        });
        if (!ass.trim()) return null;
        const fp = path.join(job.dir, 'clip_' + sel.index + '.ass'); fs.writeFileSync(fp, ass); return fp;
      };
      srtPath = buildAssFile(hookRel.length > 0);
      const len = cand.end - cand.start;
      const runFfmpeg = a => clipRun('ffmpeg', ['-hide_banner', '-loglevel', 'info', ...a], {
        timeout: 20 * 60 * 1000, signal: job.abortCtrl.signal,
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
            bg: attempt.bg, plainOnly: true, simple: attempt.simple, podcast: !!opts.podcast, focus: opts.focus, faceTrack,
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
      // MODE RAW (workflow baru: Hasil Klip = polos): skip Tahap 2 (overlay
      // judul/subtitle/CTA). Render selesai = video POLOS (crop + tracking,
      // tanpa teks). Final (dengan teks) baru di-render pas Save di Template.
      // Thumbnail (dari modal Template, data URL PNG) disimpan ke file.
      if (opts.raw) {
        rec.status = 'done'; rec.size = rec.plainSize; rec.raw = true;
        if (opts.thumb && typeof opts.thumb === 'string' && opts.thumb.startsWith('data:image/png')) {
          try { const b64 = opts.thumb.split(',')[1] || ''; if (b64) { fs.writeFileSync(path.join(job.dir, 'clip_' + sel.index + '_thumb.png'), Buffer.from(b64, 'base64')); rec.thumb = true; } } catch {}
        }
        clipLog(job, 'Klip ' + (done + 1) + ' selesai (RAW, polos ' + (rec.size / 1048576).toFixed(1) + ' MB — edit di Template lalu Save untuk Final).');
        done++;
        continue;
      }
      // Simpan thumbnail (Final): dari modal Template (data URL PNG) -> file.
      if (opts.thumb && typeof opts.thumb === 'string' && opts.thumb.startsWith('data:image/png')) {
        try { const b64 = opts.thumb.split(',')[1] || ''; if (b64) { fs.writeFileSync(path.join(job.dir, 'clip_' + sel.index + '_thumb.png'), Buffer.from(b64, 'base64')); rec.thumb = true; } } catch {}
      }
      // Tahap 2 — timpa judul + subtitle ke video polos (encode ulang saja, tanpa
      // scale/blur/crop — jauh lebih ringan CPU-nya daripada render dari source).
      // Judul + CTA + subtitle semuanya lewat file .ass + filter subtitles
      // (tidak pakai drawtext lagi, karena ffmpeg Pi tidak punya filter itu).
      const attempt = { simple: false, subs: !!srtPath, vcodec: 'libx264', acodec: 'aac', hook: hookRel.length > 0 };
      let r = null;
      for (let tryN = 0; tryN < 8 && !job.cancelled; tryN++) {
        const args = clipperLib.buildFfmpegArgs({
          input: plainFile, output: outFile, overlayOnly: true,
          hook: attempt.hook ? hookRel : [],
          speakers: speakersRel,
          sensor: sensorRel, // kata yang di-sensor -> audio dibisukan di rentang itu
          bg: 'black', srtPath: attempt.subs ? srtPath : null,
          fontsDir: clipFontsDir(), fontFile: clipFontFile(!!opts.italic, opts.titleBold !== false, opts.titleFont),
          fontColor: opts.fontColor, titleColor2: opts.titleColor2, title, simple: attempt.simple,
          videoCodec: attempt.vcodec, audioCodec: attempt.acodec,
          titleStyle: { size: opts.titleSize, y: opts.titleY },
          subStyle: { size: opts.subSize, marginV: opts.subMarginV, color: opts.subColor, bold: opts.subBold, font: opts.subFont },
          cta: { enabled: opts.ctaEnabled !== false, text: sel.ctaText || opts.ctaText, y: opts.ctaY, color: opts.ctaColor }, // CTA per-kandidat (edit di kartu kandidat), fallback ke global
        });
        r = await runFfmpeg(args);
        if (r.code === 0) break;
        const missing = /No such filter:\s*'([^']+)'/.exec(r.stderr || '');
        // Hook gagal karena klip polos tanpa audio (asplit/concat butuh audio)
        // -> matikan hook, rebuild .ass tanpa hook, render ulang tanpa hook.
        if (attempt.hook && /(matches no streams|Stream map.*0:a|concat.*Invalid|asplit|atrim)/i.test(r.stderr || '')) { attempt.hook = false; srtPath = buildAssFile(false); attempt.subs = !!srtPath; clipLog(job, 'Render hook gagal (klip polos tanpa audio?) — render ulang tanpa hook (klip tetap jadi).'); continue; }
        if (missing && missing[1] === 'subtitles' && attempt.subs) { attempt.subs = false; clipLog(job, 'ffmpeg server tanpa filter subtitles — judul + CTA + subtitle tidak dibakar.'); continue; }
        const unkEnc = /Unknown encoder\s*'([^']+)'/.exec(r.stderr || '');
        if (unkEnc && unkEnc[1] === 'libx264' && attempt.vcodec === 'libx264') { attempt.vcodec = 'mpeg4'; attempt.simple = true; clipLog(job, 'ffmpeg server tanpa encoder libx264 — memakai mpeg4 (kualitas lebih rendah, tetap bisa di-upload ke Shorts/TikTok).'); continue; }
        if (unkEnc && unkEnc[1] === 'aac' && attempt.acodec === 'aac') { attempt.acodec = null; clipLog(job, 'ffmpeg server tanpa encoder aac — klip tanpa suara.'); continue; }
        if (!attempt.simple) { attempt.simple = true; clipLog(job, 'ffmpeg argumen lengkap gagal, mencoba argumen sederhana…'); continue; }
        break;
      }
      if (!r || r.code !== 0 || !fs.existsSync(outFile)) throw new Error('ffmpeg gagal: ' + clipFfmpegError(r ? r.stderr : ''));
      rec.status = 'done'; rec.size = fs.statSync(outFile).size;
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
}
// Muat ulang proyek Clipper yang tersimpan di disk (dari deploy/restart sebelumnya).
clipRestoreJobs();
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  const serve = (f, type) => fs.createReadStream(path.join(__dirname, 'public', f))
    .on('open', () => res.writeHead(200, { 'content-type': type }))
    .on('error', () => { res.writeHead(404); res.end('Tidak ditemukan'); }).pipe(res);
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
  if (req.method === 'GET' && p === '/api/library') {
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
  // Restart service dari dashboard (tanpa SSH): balas dulu, baru jalankan restart terpisah agar tidak ikut terbunuh
  if (req.method === 'POST' && p === '/api/restart') {
    send(res, 200, { ok: true });
    setTimeout(() => {
      try {
        const cmd = E.RESTART_CMD || '/etc/init.d/hermes-vo restart';
        const child = spawn('sh', ['-c', 'sleep 1; ' + cmd], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch {}
    }, 300);
    return;
  }
  if (await tts.route(req, res, u, p)) return;
  if (req.method === 'GET' && (p === '/' || p === '/index.html'))
    return serve('index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && p === '/api/health') {
    const direct = Object.fromEntries(Object.keys(KEY).map(k => [k, { ok: !!E[KEY[k]], model: M[k] }]));
    for (const [slug, c] of Object.entries(CUSTOM)) direct['custom:' + slug] = { ok: !!E[c.envVar], model: c.model || '', name: c.name, custom: true, baseUrl: c.baseUrl };
    const router = R ? { ok: true, host: new URL(R).host, url: R } : { ok: false };
    return send(res, 200, { mode: R ? 'router' : 'direct', router, direct, elevenlabs: { ok: !!E.ELEVENLABS_API_KEY }, ...direct,
      // legacy fields agar dashboard lama tetap jalan:
      ...(R ? { host: router.host, url: router.url } : {}) });
  }
  // Simpan API key ke .env dari dashboard (login-protected; nilai key tidak pernah dikembalikan ke browser)
  const ENV_KEYS = { GEMINI_API_KEY: 1, ANTHROPIC_API_KEY: 1, OPENAI_API_KEY: 1, ELEVENLABS_API_KEY: 1, ROUTER_API_KEY: 1, ROUTER_URL: 1, RESEND_API_KEY: 1, RESEND_FROM: 1, PUBLIC_URL: 1 };
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
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
    let name = '', value = '';
    try { const j = JSON.parse(raw); name = j.name; value = j.value; } catch {}
    if (!ENV_KEYS[name]) return send(res, 400, { error: 'Nama variabel tidak diizinkan' });
    value = String(value == null ? '' : value).trim();
    if (/[\r\n]/.test(value) || value.length > 2000) return send(res, 400, { error: 'Nilai tidak valid' });
    if (name === 'ROUTER_URL' && value && !/^https?:\/\/.+/i.test(value)) return send(res, 400, { error: 'ROUTER_URL harus diawali http:// atau https://' });
    try { setEnvVar(name, value); } catch { return send(res, 500, { error: 'Gagal menyimpan .env' }); }
    return send(res, 200, { ok: true });
  }
  // Provider AI custom (tombol + di Koneksi AI): key -> .env, definisi -> custom-providers.json.
  // Key langsung aktif (process.env di-set juga), tanpa restart.
  const saveCustom = () => { try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(Object.values(CUSTOM), null, 2)); } catch {} };
  if (req.method === 'POST' && p === '/api/custom-provider') {
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
    if (!CUSTOM[slug]) return send(res, 404, { error: 'Provider tidak ditemukan' });
    const envVar = CUSTOM[slug].envVar;
    delete CUSTOM[slug]; delete KEY['custom:' + slug]; delete M['custom:' + slug]; delete call['custom:' + slug];
    try { setEnvVar(envVar, ''); } catch {}
    delete process.env[envVar];
    saveCustom();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/models') {
    if (!R) return send(res, 200, { models: [] });
    try {
      const r = await fetch(R + '/v1/models', { headers: rh(), signal: AbortSignal.timeout(15000) });
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
      // OPSI JALUR MULTI-PROVIDER: 'direct' = Direct Official API Key, 'router' = 9router SSE Stream
      // Jika route tidak dikirim, pakai perilaku lama (global R).
      const useRouter = route === 'router' ? true : route === 'direct' ? false : !!R;
      if (useRouter) {
        if (!R) return send(res, 400, { error: 'ROUTER_URL belum diisi di .env untuk jalur 9router' });
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
      (useRouter ? viaRouter(mdl, msgs, job) : call[provider](msgs, job))
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
    return send(res, 200, { id });
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
      return send(res, 413, { error: 'File melebihi batas 2GB.' });
    }
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
    const count = clipperLib.clampInt(b.count, 1, 6, 3);
    const provider = (['gemini', 'claude', 'openai', ...Object.keys(CUSTOM).map(s => 'custom:' + s)].includes(b.provider) ? b.provider : 'claude');
    const model = String(b.model || '').slice(0, 200);
    const route = ['router', 'direct', 'none'].includes(b.route) ? b.route : null;
    // Mode project (dipilih di Pengaturan Proyek SEBELUM Analisis): Podcast (crop penuh),
    // Landscape (bg blur/hitam/putih), atau Auto (= Podcast + face tracking + fallback fokus).
    // Disimpan ke job, dipakai render.
    job.mode = b.mode === 'landscape' ? 'landscape' : (b.mode === 'auto' ? 'auto' : 'podcast');
    job.aiNote = String(b.aiNote || '').slice(0, 500); // Instruksi AI per proyek (opsional, dari Pengaturan Proyek)
    job.bg = ['black', 'white'].includes(b.bg) ? b.bg : 'blur';
    job.focus = clipperLib.clampInt(b.focus, 0, 100, 50) / 100;
    job.faceTrack = b.faceTrack !== false;
    job.autoRender = !!b.autoRender; // tombol "Analisis & Render": analisis selesai -> render otomatis (server-side, tahan reload)
    // Reset hasil analisis lama — video tetap tersimpan, tidak download ulang.
    // Transkrip (job.cues) TIDAK di-reset: kalau Whisper sudah berhasil di
    // Analisis sebelumnya, transkripnya dipakai lagi (clipAnalyzeSaved), jadi
    // Analisis ulang setelah AI gagal tidak mengulang Whisper yang lambat.
    // Controller abort baru (yang lama mungkin sudah diabort oleh Stop sebelumnya).
    job.candidates = []; job.renders = []; job.log = []; job.error = null; job.progress = 0;
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
      job.status = 'error'; job.error = 'Dihentikan oleh pengguna';
      clipLog(job, 'Dihentikan oleh pengguna.');
    }
    return send(res, 200, { ok: true });
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
    clipRender(job, sel.map(s => ({ index: +s.index, title: String(s.title || ''), hook: s.hook, speakers: s.speakers, ctaText: String(s.ctaText || ''),
      // Toggle per-klip (Detail): JANGAN di-drop (sebelumnya map ini buang flag -> toggle Detail tidak berpengaruh + tidak tersimpan ke kandidat).
      showTitle: s.showTitle, showCta: s.showCta, showSub: s.showSub,
      // Preset Gaya Subtitle / Judul Hook (Detail): JANGAN di-drop (sama alasannya).
      subPreset: s.subPreset, hookPreset: s.hookPreset,
      // Durasi judul (Detail): default 4 detik / full / manual (detik).
      titleDur: s.titleDur, titleDurSec: s.titleDurSec,
      // Posisi/ukuran judul & subtitle per-klip (Detail, slider persen Klipaja)
      // + warna teks/kartu judul per-klip (picker Warna teks / Warna kartu).
      titleYPercent: s.titleYPercent, titleSizePercent: s.titleSizePercent,
      titleColor1: s.titleColor1, titleCardColor: s.titleCardColor,
      subYPercent: s.subYPercent, subSizePercent: s.subSizePercent })), {
      bg: b.bg === 'black' ? 'black' : 'blur',
      fontColor, titleColor2, italic: !!b.italic, subtitle: b.subtitle !== false,
      titleSize: clampN(b.titleSize, 20, 140, 54), titleY: clampN(b.titleY, 0, 1100, 70),
      titleBold: b.titleBold !== false, titleFont: ['Anton', 'Montserrat', 'Montserrat ExtraBold', 'Liberation Sans', 'DejaVu Sans'].includes(b.titleFont) ? b.titleFont : 'DejaVu Sans',
      subSize: clampN(b.subSize, 12, 140, 48), subMarginV: clampN(b.subMarginV, 0, 1200, 300),
      subColor, subBold: b.subBold !== false,
      subFont: ['Anton', 'Montserrat', 'Montserrat ExtraBold', 'Liberation Sans', 'DejaVu Sans'].includes(b.subFont) ? b.subFont : 'DejaVu Sans',
      // CTA "VIDEO LENGKAPNYA KLIK DISINI ↓" (mengarah ke link video panjang).
      ctaEnabled: b.cta !== false, ctaText: String(b.ctaText || 'VIDEO LENGKAPNYA | KLIK DISINI ↓').slice(0, 120),
      ctaY: clampN(b.ctaY, 0, 1200, 1150), ctaColor,
      hookEnabled: b.hook !== false,
      mode: b.mode === 'landscape' ? 'landscape' : (b.mode === 'podcast' ? 'podcast' : (b.mode === 'auto' ? 'auto' : (b.podcast ? 'podcast' : null))),
      podcast: b.mode === 'podcast' || b.mode === 'auto' || (b.mode == null && !!b.podcast), // Mode Podcast (crop penuh 9:16, tanpa bar hitam/blur) — Auto juga Podcast
      bg: ['black', 'white', 'blur'].includes(b.bg) ? b.bg : null, // null = pakai bg job (dari Analisis)
      focus: b.focus == null ? null : clampN(b.focus, 0, 100, 50) / 100, // null = pakai focus job (dari Analisis)
      faceTrack: b.faceTrack !== false, // Auto face tracking (Podcast) — default ON
      raw: !!b.raw, // RAW (polos, tanpa overlay) — dipakai auto-render awal; Template Save kirim tanpa raw = Final
      thumb: typeof b.thumb === 'string' ? b.thumb : null, // Thumbnail PNG (data URL) dari modal Template -> disimpan ke file
    });
    return send(res, 200, { ok: true });
  }
  // Edit teks subtitle (perbaiki transkrip Whisper yang tidak sesuai ucapan).
  // Frontend mengirim daftar cue lengkap (yang sudah diedit); server validasi +
  // simpan ke job.cues + job.json. Render berikutnya memakai cue yang sudah diperbaiki.
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
      // sensor/keyword; kalau tidak, normalizeCueWords bagi rata dari teks.
      // Edit teks via textarea = kirim tanpa words = flag kata ikut reset.
      const words = Array.isArray(c.words) ? c.words.filter(w => w && typeof w === 'object').slice(0, 60).map(w => ({
        text: String(w.text || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        start: +w.start, end: +w.end, sensor: !!w.sensor, keyword: !!w.keyword,
      })).filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start) : [];
      cues.push(clipperLib.normalizeCueWords({ start, end, text, words }));
    }
    cues.sort((a, b2) => a.start - b2.start);
    if (!cues.length) return send(res, 400, { error: 'Tidak ada cue subtitle yang valid.' });
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
    let cpu = null;
    try {
      const cores = Math.max(1, (require('os').cpus() || []).length);
      cpu = Math.round((require('os').loadavg()[0] / cores) * 100);
    } catch {}
    let temp = null;
    try {
      const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
      const t = +raw;
      if (Number.isFinite(t)) temp = Math.round((t > 1000 ? t / 1000 : t) * 10) / 10;
    } catch {}
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
    res.writeHead(status, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(status === 206 ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}), ...(dl ? { 'content-disposition': 'attachment; filename="' + dlName + '"' } : {}) });
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
    const file = plain && rec.plainFile
      ? path.join(job.dir, path.basename(rec.plainFile))
      : path.join(job.dir, 'clip_' + idx + '.mp4');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'File klip tidak ditemukan (mungkin sudah dibersihkan).' });
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { start = m[1] ? Math.min(+m[1], size - 1) : 0; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; status = 206; }
    res.writeHead(status, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(status === 206 ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { try { res.end(); } catch {} });
    stream.pipe(res);
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
      if (!fs.existsSync(tf)) return send(res, 404, { error: 'Thumbnail belum dibuat (edit di Template lalu Save).' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      fs.createReadStream(tf).pipe(res); return;
    }
    const plain = u.searchParams.get('plain') === '1';
    const file = plain && rec.plainFile
      ? path.join(job.dir, path.basename(rec.plainFile))
      : path.join(job.dir, 'clip_' + idx + '.mp4');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'File klip tidak ditemukan (mungkin sudah dibersihkan).' });
    const name = 'clipper-' + idx + '-' + (plain ? 'polos-' : '') + (job.videoTitle || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.mp4';
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="' + name + '"' });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.end(); } catch {} });
    // Sumber TIDAK dihapus pas download (sebelumnya res.on('finish') hapus source
    // -> abis download 1 klip, sumber hilang -> render/analisis berikutnya gagal
    // "Video sumber sudah dihapus"). Sumber hanya terhapus pas hapus proyek.
    stream.pipe(res);
    return;
  }
  if (req.method === 'POST' && p === '/api/clipper/cleanup') {
    const user = sessUser(req);
    for (const [k, j] of clipperJobs) if (j.user === user) { j.cancelled = true; try { if (j.aiCtrl) j.aiCtrl.abort(); } catch {} try { if (j.abortCtrl) j.abortCtrl.abort(); } catch {} clipperJobs.delete(k); }
    clipRm(clipUserDir(user));
    return send(res, 200, { ok: true });
  }
  res.writeHead(404); res.end('Tidak ditemukan');
}).listen(PORT, () => console.log('Script VO Agent berjalan di http://localhost:' + PORT));
