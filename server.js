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
const SESS_SEC = crypto.randomBytes(32), SESS_MAX = 30 * 24 * 3600; // 30 hari
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
const clipFontFile = (italic, bold) => path.join(clipFontsDir(), italic ? 'LiberationSans-BoldItalic.ttf' : (bold === false ? 'DejaVuSans.ttf' : 'DejaVuSans-Bold.ttf'));
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
      metaDesc: job.metaDesc, metaUploader: job.metaUploader, sourceCleaned: job.sourceCleaned,
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
const clipCleanupSource = job => {
  if (job.sourceCleaned) return;
  job.sourceCleaned = true;
  try { if (job.source) fs.unlinkSync(job.source); } catch {}
  try { for (const f of fs.readdirSync(job.dir)) if (f.endsWith('.srt') || f.endsWith('.vtt')) fs.unlinkSync(path.join(job.dir, f)); } catch {}
};
const clipPublic = job => ({
  id: job.id, status: job.status, phase: job.phase, progress: job.progress, downloadPct: job.downloadPct || 0, error: job.error || null,
  sourceReady: !!job.sourceReady,
  videoTitle: job.videoTitle, duration: job.duration, log: job.log, candidates: job.candidates,
  renders: job.renders.map(r => ({ index: r.index, title: r.title, status: r.status, size: r.size || 0, error: r.error || null })),
});
// Tahap 1 — Input YouTube: ambil info (-J) + download video ke server, lalu tandai
// sourceReady. Dipanggil endpoint /api/clipper/input. Video cuma disimpan sekali;
// analisis (tahap 2) memakai file ini tanpa download ulang.
async function clipInputYoutube(job, url) {
  const dir = job.dir;
  try {
    job.phase = 'info'; clipLog(job, 'Mengambil info video…');
    const info = await clipRun('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', url], { timeout: 90000, maxOut: 5000000, signal: job.abortCtrl.signal });
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
      const dl = await clipRun('yt-dlp', ['--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '3',
        '--max-filesize', '2000M',
        // YouTube kini hanya sediakan stream video+audio terpisah (DASH) untuk kebanyakan video:
        // 'best' (format gabungan) sering tidak ada -> pakai bv+ba (gabung via ffmpeg) + remux ke mp4.
        // Utamakan H.264 (avc1): ffmpeg minimal di server kadang tidak punya decoder
        // VP9/AV1 ("Error while decoding stream ... Function not implemented"), tapi
        // H.264 hampir selalu bisa di-decode. Urutan: DASH H.264 dulu, lalu H.264
        // gabungan (itag 22/18, selalu bisa di-decode), BARU DASH format lain (VP9/AV1).
        // Jangan sampai DASH VP9/AV1 dipilih padahal ada H.264 gabungan yang bisa di-decode.
        '-f', 'bv[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4][vcodec^=avc1]/bv[height<=720][ext=mp4]+ba[ext=m4a]/bv[height<=720]+ba/b[height<=720]',
        '--remux-video', 'mp4',
        '-o', src, url], { timeout: 20 * 60 * 1000, onStdout: onDl, onStderr: onDl, signal: job.abortCtrl.signal });
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
        const sub = await clipRun('yt-dlp', ['--skip-download', '--no-playlist', '--no-warnings', '--write-subs', '--write-auto-subs',
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
          cues = w.segments.map(s => ({ start: s.start, end: s.end, text: s.text }));
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
    job.cues = cues;
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
    if (chunks.length) {
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const prompt = 'Kamu analis konten video. Cari momen paling "wah" untuk klip Shorts/Reels.\n'
          + 'Video: "' + job.videoTitle + '" (durasi ' + Math.round(job.duration) + ' detik).\n'
          + 'Transkrip segmen [' + ch.start.toFixed(0) + 's - ' + ch.end.toFixed(0) + 's]:\n' + ch.text.slice(0, 12000) + '\n\n'
          + 'Tugas: cari ' + count + ' momen paling wah (mengejutkan, lucu, emosional, kontroversial, atau bikin penasaran) untuk klip durasi sekitar ' + targetDur + ' detik.\n'
          + 'Balas HANYA JSON array (tanpa markdown, tanpa penjelasan): [{"start":detik,"end":detik,"title":"Judul hook singkat maks 60 karakter","score":0-100,"reason":"satu kalimat"}]\n'
          + 'Aturan: start/end angka detik (start >= ' + Math.floor(ch.start) + ', end <= ' + Math.ceil(ch.end) + '), end-start ' + targetDur + ' detik (boleh 10 s/d ' + (targetDur + 30) + '), jangan tumpang tindih berat antar kandidat.';
        jobs.push({ prompt, tag: 'segmen ' + (i + 1) + '/' + chunks.length });
      }
    } else {
      const desc = String(job.metaDesc || '').replace(/\s+/g, ' ').slice(0, 1500);
      jobs.push({ tag: 'metadata', prompt: 'Kamu analis konten video. Transkrip TIDAK tersedia.\n'
        + 'Video: "' + job.videoTitle + '" oleh ' + (job.metaUploader || '-') + ' (durasi ' + Math.round(job.duration) + ' detik).\n'
        + (desc ? 'Deskripsi: ' + desc + '\n' : '')
        + 'Tugas: bagi video menjadi ' + count + ' kandidat klip durasi sekitar ' + targetDur + ' detik yang tersebar merata (awal, tengah, akhir), karena momen spesifik tidak bisa diketahui tanpa transkrip.\n'
        + 'Balas HANYA JSON array (tanpa markdown, tanpa penjelasan): [{"start":detik,"end":detik,"title":"Judul hook singkat maks 60 karakter","score":0-100,"reason":"satu kalimat"}]\n'
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

async function clipRender(job, selected, opts) {
  job.status = 'rendering'; job.phase = 'render'; job.progress = 0;
  const total = selected.length;
  let done = 0;
  for (const sel of selected) {
    if (job.cancelled) return;
    const cand = job.candidates.find(c => c.index === sel.index);
    if (!cand) { job.renders.push({ index: sel.index, title: sel.title || '', status: 'error', error: 'Kandidat tidak ditemukan' }); done++; continue; }
    const title = clipperLib.cleanTitle(sel.title, 120) || cand.title;
    const outFile = path.join(job.dir, 'clip_' + sel.index + '.mp4');
    const rec = { index: sel.index, title, status: 'running', size: 0 };
    job.renders.push(rec);
    clipLog(job, 'Render klip ' + (done + 1) + '/' + total + ': ' + title);
    try {
      let srtPath = null;
      if (opts.subtitle && job.cues && job.cues.length) {
        const ass = clipperLib.buildAss(job.cues, cand.start, cand.end, {
          size: opts.subSize, marginV: opts.subMarginV, color: opts.subColor, bold: opts.subBold, font: opts.subFont,
        });
        if (ass.trim()) { srtPath = path.join(job.dir, 'clip_' + sel.index + '.ass'); fs.writeFileSync(srtPath, ass); }
      }
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
      // Build ffmpeg di server bisa minimal: tanpa -preset, tanpa filter drawtext
      // (judul), subtitles, atau gblur, tanpa encoder libx264/aac. Jangan langsung
      // gagal — coba lagi dengan mengurangi satu per satu yang hilang, sampai render jalan.
      const attempt = { simple: false, title: true, subs: !!srtPath, blur: opts.bg === 'blur', vcodec: 'libx264', acodec: 'aac' };
      let r = null;
      for (let tryN = 0; tryN < 8; tryN++) {
        if (job.cancelled) break;
        const args = clipperLib.buildFfmpegArgs({
          start: cand.start, end: cand.end, input: job.source, output: outFile,
          bg: attempt.blur ? 'blur' : 'black', srtPath: attempt.subs ? srtPath : null,
          fontsDir: clipFontsDir(), fontFile: clipFontFile(!!opts.italic, opts.titleBold !== false),
          fontColor: opts.fontColor, title: attempt.title ? title : '', simple: attempt.simple,
          videoCodec: attempt.vcodec, audioCodec: attempt.acodec,
          titleStyle: { size: opts.titleSize, y: opts.titleY },
          subStyle: { size: opts.subSize, marginV: opts.subMarginV, color: opts.subColor, bold: opts.subBold, font: opts.subFont },
        });
        r = await runFfmpeg(args);
        if (r.code === 0) break;
        const missing = /No such filter:\s*'([^']+)'/.exec(r.stderr || '');
        if (missing && missing[1] === 'drawtext' && attempt.title) { attempt.title = false; clipLog(job, 'ffmpeg server tanpa filter drawtext — judul tidak dibakar ke video.'); continue; }
        if (missing && missing[1] === 'subtitles' && attempt.subs) { attempt.subs = false; clipLog(job, 'ffmpeg server tanpa filter subtitles — subtitle tidak dibakar.'); continue; }
        if (missing && missing[1] === 'gblur' && attempt.blur) { attempt.blur = false; clipLog(job, 'ffmpeg server tanpa filter gblur — background hitam.'); continue; }
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
  if (req.method === 'POST' && p === '/api/state') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) break; }
    let j; try { j = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON tidak valid' }); }
    if (!j || typeof j !== 'object') return send(res, 400, { error: 'State harus objek' });
    try { fs.writeFileSync(stateFile(sessUser(req)), JSON.stringify(j)); } catch { return send(res, 500, { error: 'Gagal menyimpan state' }); }
    return send(res, 200, { ok: true });
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
    const duration = b.duration === 60 ? 60 : 30;
    const count = clipperLib.clampInt(b.count, 1, 5, 3);
    const provider = ['gemini', 'claude', 'openai'].includes(b.provider) ? b.provider : 'claude';
    const model = String(b.model || '').slice(0, 200);
    const route = ['router', 'direct', 'none'].includes(b.route) ? b.route : null;
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
    const clampN = (v, lo, hi, def) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
    job.renders = [];
    job.ts = Date.now();
    job.cancelled = false; job.abortCtrl = new AbortController(); job.aiCtrl = null;
    clipRender(job, sel.map(s => ({ index: +s.index, title: String(s.title || '') })), {
      bg: b.bg === 'black' ? 'black' : 'blur',
      fontColor, italic: !!b.italic, subtitle: b.subtitle !== false,
      titleSize: clampN(b.titleSize, 28, 80, 54), titleY: clampN(b.titleY, 0, 500, 70),
      titleBold: b.titleBold !== false,
      subSize: clampN(b.subSize, 16, 48, 30), subMarginV: clampN(b.subMarginV, 20, 500, 90),
      subColor, subBold: b.subBold !== false,
      subFont: b.subFont === 'Liberation Sans' ? 'Liberation Sans' : 'DejaVu Sans',
    });
    return send(res, 200, { ok: true });
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
    res.writeHead(status, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(status === 206 ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
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
    const file = path.join(job.dir, 'clip_' + idx + '.mp4');
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
    const file = path.join(job.dir, 'clip_' + idx + '.mp4');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'File klip tidak ditemukan (mungkin sudah dibersihkan).' });
    const name = 'clipper-' + idx + '-' + (job.videoTitle || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.mp4';
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="' + name + '"' });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.end(); } catch {} });
    res.on('finish', () => clipCleanupSource(job));
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
