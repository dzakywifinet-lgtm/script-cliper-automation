// Text-to-Speech untuk Script VO Agent. Tanpa dependensi (Node 18+).
// Engine: 9router (/v1/audio/speech), Gemini TTS (AI Studio), Google Cloud TTS, OpenAI, ElevenLabs.
const { spawn, spawnSync } = require('child_process');
const MAX_CHARS = 60000, MAX_CHUNKS = 40;
module.exports = function ({ E, R, rh, send }) {
  const OPENAI = E.OPENAI_BASE || 'https://api.openai.com', ELEVEN = E.ELEVEN_BASE || 'https://api.elevenlabs.io';
  const GOOGLE = E.GOOGLE_TTS_BASE || 'https://texttospeech.googleapis.com', GEMINI = E.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
  const jobs = new Map(), audios = new Map(), vcache = {};
  const err = (msg, kind, status) => { const x = new Error(msg); if (kind) x.kind = kind; if (status) x.status = status; return x; };
  const cap = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, +v || 1));
  const sleep = (ms, sig) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (sig) sig.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }, { once: true });
  });

  const engines = () => [
    { id: 'router', label: '9router (Edge TTS gratis, dll.)', ok: !!R, note: R ? '' : 'ROUTER_URL belum diisi' },
    { id: 'gemini', label: 'Google AI Studio (Gemini TTS, gratis)', ok: !!E.GEMINI_API_KEY, note: E.GEMINI_API_KEY ? '' : 'GEMINI_API_KEY belum diisi' },
    { id: 'google', label: 'Google Cloud TTS', ok: !!E.GOOGLE_TTS_API_KEY, note: E.GOOGLE_TTS_API_KEY ? '' : 'GOOGLE_TTS_API_KEY belum diisi' },
    { id: 'openai', label: 'OpenAI TTS', ok: !!E.OPENAI_API_KEY, note: E.OPENAI_API_KEY ? '' : 'OPENAI_API_KEY belum diisi' },
    { id: 'elevenlabs', label: 'ElevenLabs', ok: !!E.ELEVENLABS_API_KEY, note: E.ELEVENLABS_API_KEY ? '' : 'ELEVENLABS_API_KEY belum diisi' }
  ];
  const getJson = async (url, headers) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.detail?.message || 'HTTP ' + r.status, '', r.status);
    return j;
  };
  const OPENAI_VOICES = [
    { id: 'onyx', label: 'Male - Onyx' }, { id: 'echo', label: 'Male - Echo' }, { id: 'fable', label: 'Male - Fable (aksen Inggris)' },
    { id: 'alloy', label: 'Netral - Alloy' }, { id: 'nova', label: 'Female - Nova' }, { id: 'shimmer', label: 'Female - Shimmer' }
  ];
  const GEMINI_VOICES = [['Zephyr', 'Cerah'], ['Puck', 'Ceria'], ['Charon', 'Informatif'], ['Kore', 'Tegas'], ['Fenrir', 'Bersemangat'], ['Leda', 'Muda'], ['Orus', 'Tegas'], ['Aoede', 'Santai'], ['Callirrhoe', 'Santai'], ['Autonoe', 'Cerah'], ['Enceladus', 'Berembus'], ['Iapetus', 'Jernih'], ['Umbriel', 'Santai'], ['Algieba', 'Halus'], ['Despina', 'Halus'], ['Erinome', 'Jernih'], ['Algenib', 'Serak'], ['Rasalgethi', 'Informatif'], ['Laomedeia', 'Ceria'], ['Achernar', 'Lembut'], ['Alnilam', 'Tegas'], ['Schedar', 'Rata'], ['Gacrux', 'Dewasa'], ['Pulcherrima', 'Lugas'], ['Achird', 'Ramah'], ['Zubenelgenubi', 'Kasual'], ['Vindemiatrix', 'Lembut'], ['Sadachbia', 'Hidup'], ['Sadaltager', 'Berpengetahuan'], ['Sulafat', 'Hangat']]
    .map(([n, s]) => ({ id: n, label: n + ' - ' + s }));

  // Google Cloud: pilihan cepat disusun dari daftar suara yang BENAR-BENAR ada di akun (gender dari API)
  async function googleVoices() {
    const key = encodeURIComponent(E.GOOGLE_TTS_API_KEY);
    const list = async lc => (await getJson(GOOGLE + '/v1/voices?languageCode=' + lc + '&key=' + key, {})).voices || [];
    const [idv, env] = await Promise.all([list('id-ID'), list('en-US')]);
    const gen = v => String(v.ssmlGender || '').toUpperCase();
    const tier = n => /Neural2|Studio/.test(n) ? 0 : /Wavenet/i.test(n) ? 1 : /Standard/.test(n) ? 2 : 3;
    const used = new Set(); let substituted = false;
    const pick = (arr, want, gender, prefer) => {
      const ex = arr.find(v => v.name === want && gen(v) === gender);
      if (ex && !used.has(ex.name)) return ex;
      const pool = arr.filter(v => gen(v) === gender && !used.has(v.name) && !/Chirp/i.test(v.name));
      const sorted = fn => pool.filter(fn).sort((a, b) => tier(a.name) - tier(b.name) || a.name.localeCompare(b.name))[0];
      return (prefer && sorted(v => prefer.test(v.name))) || sorted(() => true);
    };
    const curated = [];
    const add = (arr, label, want, gender, prefer) => {
      const v = pick(arr, want, gender, prefer); if (!v) return;
      used.add(v.name); if (v.name !== want) substituted = true;
      curated.push({ id: v.name, label: (prefer && !/Studio/.test(v.name) ? label.replace(' Studio', '') : label) + ' (' + v.name + ')', group: 'Pilihan cepat' });
    };
    add(idv, 'Indonesian - Pria 1', 'id-ID-Neural2-B', 'MALE');
    add(idv, 'Indonesian - Wanita 1', 'id-ID-Neural2-A', 'FEMALE');
    add(idv, 'Indonesian - Pria 2', 'id-ID-Neural2-D', 'MALE');
    add(idv, 'Indonesian - Wanita 2', 'id-ID-Neural2-C', 'FEMALE');
    add(env, 'English US - Male Studio', 'en-US-Studio-O', 'MALE', /Studio/);
    add(env, 'English US - Female Studio', 'en-US-Studio-Q', 'FEMALE', /Studio/);
    const others = idv.filter(v => !used.has(v.name)).map(v => ({ id: v.name, label: (gen(v) && gen(v) !== 'SSML_VOICE_GENDER_UNSPECIFIED' ? cap(gen(v)) + ' - ' : '') + v.name, group: 'Semua suara Indonesia (id-ID)' })).slice(0, 60);
    return { voices: curated.concat(others), pitch: true, pitchMin: -2, pitchMax: 2, pitchStep: 0.5,
      note: 'Pitch -2 sampai +2 semitone (sebagian voice Studio atau Chirp tidak mendukung, otomatis diabaikan).' + (substituted ? ' Nama voice yang diminta tidak semuanya tersedia (misalnya id-ID-Neural2 tidak ada untuk Bahasa Indonesia), jadi dipakai pengganti terdekat. Nama voice sebenarnya ada di dalam kurung.' : '') };
  }
  async function loadVoices(engine) {
    if (engine === 'openai') return { voices: OPENAI_VOICES, pitch: false, note: 'Kecepatan 0.5x sampai 2.0x didukung.' };
    if (engine === 'gemini') return { voices: GEMINI_VOICES, pitch: false, speed: false, style: true, note: 'Gratis: maks ~3 request/menit & 15 request/hari. Tempo dan emosi diatur lewat kolom Gaya bicara (misalnya "Bacakan pelan dan tenang").' };
    if (engine === 'google') return googleVoices();
    if (engine === 'elevenlabs') {
      const j = await getJson(ELEVEN + '/v1/voices', { 'xi-api-key': E.ELEVENLABS_API_KEY });
      const catName = c => ({ premade: 'Premade', cloned: 'Kloningan', generated: 'AI', professional: 'Pro', famous: 'Famous' }[(c || '').toLowerCase()] || (c ? cap(c) : 'Suara'));
      // Semua voice di daftar bisa dipakai di tier gratis; yang dibatasi hanya kuota (10rb karakter/bulan), bukan per-voice.
      const voices = (j.voices || []).map(v => ({ id: v.voice_id, label: (v.labels?.gender ? cap(v.labels.gender) + ' - ' : '') + v.name + ' (' + catName(v.category) + ')' })).slice(0, 200);
      return { voices, pitch: false, note: 'Gratis: 10.000 karakter/bulan untuk semua voice di daftar. Kecepatan hanya 0.7x–1.2x.' };
    }
    if (engine === 'router') {
      let edge = [], models = [], note = 'Kecepatan mengikuti dukungan provider di 9router. Bagian teks yang ditolak server suara akan otomatis dipecah lebih kecil.';
      try {
        const j = await getJson(R + '/v1/audio/voices?provider=edge-tts&lang=id', rh());
        edge = (j.data || []).map(v => ({ id: v.model || v.id, label: (v.gender ? cap(v.gender) + ' - ' : '') + (v.name || String(v.model || v.id).split('/').pop()), group: 'Edge TTS Indonesia (gratis)' })).filter(v => v.id);
      } catch {}
      if (!edge.length) edge = [{ id: 'edge-tts/id-ID-ArdiNeural', label: 'Male - Ardi (Edge)', group: 'Edge TTS Indonesia (gratis)' }, { id: 'edge-tts/id-ID-GadisNeural', label: 'Female - Gadis (Edge)', group: 'Edge TTS Indonesia (gratis)' }];
      try {
        const j = await getJson(R + '/v1/models/tts', rh());
        const seen = new Set(edge.map(v => v.id));
        models = (j.data || []).map(m => ({ id: m.id, label: m.name || m.id, group: 'Model TTS di 9router' })).filter(v => v.id && !seen.has(v.id)).slice(0, 150);
      } catch (e) { note += ' (Daftar model TTS 9router tidak terbaca: ' + e.message + ')'; }
      return { voices: edge.concat(models), pitch: false, note };
    }
    throw err('Engine tidak dikenal');
  }

  // Pecah teks per paragraf/kalimat agar tiap bagian di bawah batas panjang engine
  function chunkText(t, limit, bytes) {
    const len = s => bytes ? Buffer.byteLength(s) : s.length, units = [];
    for (const para of t.split(/\n\s*\n/)) {
      const p = para.trim(); if (!p) continue;
      if (len(p) <= limit) { units.push([p, '\n\n']); continue; }
      let first = true;
      for (const s of p.split(/(?<=[.!?…])\s+/)) {
        const sep = first ? '\n\n' : ' '; first = false;
        if (len(s) <= limit) { units.push([s, sep]); continue; }
        let cur = '', f = true;
        for (const w of s.split(/\s+/)) { if (cur && len(cur + ' ' + w) > limit) { units.push([cur, f ? sep : ' ']); f = false; cur = w; } else cur = cur ? cur + ' ' + w : w; }
        if (cur) units.push([cur, f ? sep : ' ']);
      }
    }
    const out = []; let cur = '';
    for (const [u, sep] of units) { const cand = cur ? cur + sep + u : u; if (len(cand) <= limit) cur = cand; else { if (cur) out.push(cur); cur = u; } }
    if (cur) out.push(cur);
    return out;
  }
  const audioFrom = async r => {
    const ct = r.headers.get('content-type') || '';
    const html = t => ct.includes('html') || /^\s*<(!doctype|html)/i.test(t || '');
    // Ambil <title> halaman error biar ketahuan siapa yang balikin 502 (Cloudflare / cloudflared / 9router)
    const titleOf = t => { const m = /<title[^>]*>([^<]{1,140})/i.exec(t || ''); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
    const htmlErr = (t, code) => {
      const ti = titleOf(t);
      return err('Balasan berupa halaman web (HTTP ' + code + (ti ? ' — judul: "' + ti + '"' : '') + '), bukan audio. Kemungkinan Cloudflare atau 9router bermasalah', 'html', code);
    };
    if (!r.ok) {
      const t = await r.text();
      if (html(t)) throw htmlErr(t, r.status);
      let j = {}; try { j = JSON.parse(t); } catch {}
      throw err(j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.detail?.message || j.message || ('HTTP ' + r.status + ': ' + t.replace(/\s+/g, ' ').slice(0, 160)), '', r.status);
    }
    if (ct.includes('html')) throw htmlErr(await r.text(), r.status);
    if (ct.includes('json')) { const j = await r.json(); if (j.audio) return Buffer.from(j.audio, 'base64'); throw err(j.error?.message || 'Balasan JSON tanpa audio'); }
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 200) throw err('Audio kosong dari engine (mungkin voice tidak cocok)');
    return b;
  };
  const post = (url, headers, body, signal) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });

  // 9router: kalau server suara menolak (5xx / halaman web), coba tanpa speed lalu pecah teks jadi lebih kecil
  // Perbaikan: pecah agresif sampai ~800 karakter, depth sampai 5, karena "tes singkat" (300 char) selalu lolos
  // sedangkan chunk 4000 char sering kena 502 dari Cloudflare/9router.
  async function routerSynth(text, o, job, depth = 0) {
    const once = withSpeed => post(R + '/v1/audio/speech?response_format=mp3', rh(), { model: o.voice, input: text, ...(withSpeed && !job.noSpeed && o.speed !== 1 ? { speed: o.speed } : {}) }, job.ctrl.signal).then(audioFrom);
    try { return await once(true); }
    catch (e) {
      if (e.name === 'AbortError' || job.stopped) throw e;
      if (!(e.status >= 500 || e.kind === 'html')) throw e;
      if (o.speed !== 1 && !job.noSpeed) {
        job.note = 'Mencoba lagi tanpa pengaturan kecepatan...';
        try { const b = await once(false); job.noSpeed = true; job.note = 'Kecepatan diabaikan: server suara menolaknya'; return b; }
        catch (e2) { if (e2.name === 'AbortError') throw e2; e = e2; }
      }
      if (text.length > 400 && depth < 5) {
        const target = Math.min(Math.ceil(text.length / 2) + 50, 900);
        job.note = 'Server suara menolak teks panjang (coba ' + (depth + 1) + '/5), bagian dipecah jadi ±' + target + ' karakter...';
        const parts = chunkText(text, target, false), bufs = [];
        if (parts.length < 2) throw e;
        for (const p of parts) bufs.push(await routerSynth(p, o, job, depth + 1));
        return Buffer.concat(bufs);
      }
      throw e;
    }
  }
  async function geminiSynth(text, o, job) {
    const model = E.TTS_GEMINI_MODEL || 'gemini-2.5-flash-preview-tts';
    const prompt = o.style ? o.style.replace(/[\s:：]+$/, '') + ': ' + text : text;
    for (let attempt = 0; ; attempt++) {
      const r = await post(GEMINI + '/v1beta/models/' + model + ':generateContent', { 'x-goog-api-key': E.GEMINI_API_KEY },
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } } } }, job.ctrl.signal);
      const j = await r.json().catch(() => ({}));
      if (r.status === 429 && attempt < 4) {
        const m = JSON.stringify(j).match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
        const delaySecs = m ? +m[1] : 0;
        // retryDelay lebih dari 2 menit = bukan batas per-menit, melainkan jatah harian yang habis.
        // Retry tidak ada gunanya: gagal cepat dengan pesan jelas (sekaligus hemat jatah).
        if (delaySecs > 120) throw err('Jatah harian gratis Gemini habis (maks 15 request/hari, reset sekitar jam 14:00 WIB). Kurangi klik Tes/Generate berulang karena tiap klik makan jatah.', '', 429);
        const min = E.TTS_RETRY_MIN !== undefined && E.TTS_RETRY_MIN !== '' ? +E.TTS_RETRY_MIN : 5;
        const wait = Math.min(65, Math.max(min, m ? Math.ceil(+m[1]) + 1 : 30));
        job.note = 'Menunggu batas gratis Gemini (' + wait + ' detik)...'; await sleep(wait * 1000, job.ctrl.signal); job.note = ''; continue;
      }
      if (r.status >= 500 && attempt < 2) { await sleep(2000, job.ctrl.signal); continue; }
      if (!r.ok) throw err(j.error?.message || 'HTTP ' + r.status, '', r.status);
      const part = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
      if (!part) { if (attempt < 2) { await sleep(1500, job.ctrl.signal); continue; } throw err('Balasan Gemini tanpa audio' + (j.candidates?.[0]?.finishReason ? ' (' + j.candidates[0].finishReason + ')' : '')); }
      return { pcm: Buffer.from(part.inlineData.data, 'base64'), rate: +(String(part.inlineData.mimeType || '').match(/rate=(\d+)/) || [])[1] || 24000 };
    }
  }
  async function googleSynth(text, o, job) {
    const call = async withPitch => {
      const audioConfig = { audioEncoding: 'MP3', speakingRate: clamp(o.speed, 0.25, 4) };
      if (withPitch) audioConfig.pitch = Math.min(20, Math.max(-20, +o.pitch));
      const r = await post(GOOGLE + '/v1/text:synthesize?key=' + encodeURIComponent(E.GOOGLE_TTS_API_KEY), {},
        { input: { text }, voice: { languageCode: (o.voice.match(/^[a-z]{2,3}-[A-Z]{2}/) || ['id-ID'])[0], name: o.voice }, audioConfig }, job.ctrl.signal);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw err(j.error?.message || 'HTTP ' + r.status, '', r.status);
      if (!j.audioContent) throw err('Balasan Google tanpa audio');
      return Buffer.from(j.audioContent, 'base64');
    };
    const p = +o.pitch || 0;
    try { return await call(p !== 0); }
    catch (e) { if (p !== 0 && /pitch/i.test(e.message)) { job.note = 'Pitch tidak didukung voice ini, diabaikan'; return call(false); } throw e; }
  }
  async function synth(engine, text, o, job, prev, next) {
    const sig = job.ctrl.signal;
    if (engine === 'router') return routerSynth(text, o, job);
    if (engine === 'gemini') return geminiSynth(text, o, job);
    if (engine === 'google') return googleSynth(text, o, job);
    if (engine === 'openai') return audioFrom(await post(OPENAI + '/v1/audio/speech', { authorization: 'Bearer ' + E.OPENAI_API_KEY }, { model: E.TTS_OPENAI_MODEL || 'tts-1', voice: o.voice, input: text, response_format: 'mp3', ...(o.speed !== 1 ? { speed: clamp(o.speed, 0.25, 4) } : {}) }, sig));
    if (engine === 'elevenlabs') return audioFrom(await post(ELEVEN + '/v1/text-to-speech/' + encodeURIComponent(o.voice), { 'xi-api-key': E.ELEVENLABS_API_KEY },
      { text, model_id: E.TTS_ELEVEN_MODEL || 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: clamp(o.speed, 0.7, 1.2) }, ...(prev ? { previous_text: prev.slice(-300) } : {}), ...(next ? { next_text: next.slice(0, 300) } : {}) }, sig));
    throw err('Engine tidak dikenal');
  }
  // WAV dari PCM 16-bit mono; MP3 hanya jika ffmpeg tersedia di server
  const wavOf = (pcm, rate) => { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
  let ff = null;
  const hasFfmpeg = () => { if (E.TTS_FFMPEG === '0') return false; if (ff === null) { try { ff = spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0; } catch { ff = false; } } return ff; };
  // Volume (0-200%, default 100): diterapkan via ffmpeg setelah audio jadi — universal semua engine.
  // 0% = senyap, 100% = normal, 200% = 2x lebih keras (hati-hati clipping).
  const applyVolume = (buf, format, vol) => new Promise((res, rej) => {
    if (!vol || vol === 100 || !hasFfmpeg()) return res(buf);
    const gain = (vol / 100).toFixed(2);
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-af', 'volume=' + gain, '-f', format === 'wav' ? 'wav' : 'mp3', '-b:a', '128k', 'pipe:1']), out = [];
    p.stdout.on('data', d => out.push(d)); p.on('error', rej); p.stdin.on('error', () => {});
    p.on('close', c => c === 0 && out.length ? res(Buffer.concat(out)) : rej(new Error('ffmpeg volume gagal')));
    p.stdin.end(buf);
  });
  const toMp3 = (pcm, rate) => new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '128k', 'pipe:1']), out = [];
    p.stdout.on('data', d => out.push(d)); p.on('error', rej); p.stdin.on('error', () => {});
    p.on('close', c => c === 0 && out.length ? res(Buffer.concat(out)) : rej(new Error('ffmpeg gagal')));
    p.stdin.end(pcm);
  });
  const limitOf = e => e === 'openai' ? 4000 : e === 'google' ? 4500 : e === 'elevenlabs' ? 4500 : e === 'gemini' ? (+E.TTS_GEMINI_CHUNK > 500 ? +E.TTS_GEMINI_CHUNK : 6000) : (+E.TTS_ROUTER_CHUNK > 200 ? +E.TTS_ROUTER_CHUNK : 1800);
  // Jeda antar chunk khusus Gemini: jatah gratis model TTS ini hanya ~3 request/menit (15 request/hari).
  // Tanpa jeda yang cukup, kena 429 lalu menunggu 65 detik per retry — jauh lebih lama.
  const GEMINI_PACE = E.TTS_GEMINI_PACE !== undefined && E.TTS_GEMINI_PACE !== '' ? +E.TTS_GEMINI_PACE : 25;

  function start(b) {
    const eng = engines().find(e => e.id === b.engine);
    if (!eng) throw err('Engine tidak dikenal', 'config', 400);
    if (!eng.ok) throw err(eng.note, 'config', 400);
    const text = String(b.text || '').trim();
    if (!text) throw err('Teks kosong', '', 400);
    if (text.length > MAX_CHARS) throw err('Teks terlalu panjang (maksimal ' + MAX_CHARS + ' karakter)', '', 413);
    if (!b.voice) throw err('Voice belum dipilih', '', 400);
    if ([...jobs.values()].some(j => j.status === 'running')) throw err('Masih ada proses suara yang berjalan', '', 409);
    const o = { voice: String(b.voice), speed: clamp(b.speed, 0.5, 2), pitch: +b.pitch || 0, style: String(b.style || '').trim().slice(0, 200), volume: Math.min(200, Math.max(0, +b.volume || 100)) };
    const chunks = chunkText(text, limitOf(b.engine), b.engine === 'google');
    if (chunks.length > MAX_CHUNKS) throw err('Teks terlalu panjang untuk diproses sekaligus', '', 413);
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const job = { status: 'running', done: 0, total: chunks.length, chars: text.length, ts: Date.now(), note: '', format: b.engine === 'gemini' ? 'wav' : 'mp3' };
    Object.defineProperty(job, 'ctrl', { value: new AbortController(), enumerable: false });
    jobs.set(id, job);
    const timer = setTimeout(() => job.ctrl.abort(), 20 * 60 * 1000);
    (async () => {
      const parts = []; let rate = 24000;
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0 && b.engine === 'gemini' && GEMINI_PACE > 0) {
          job.note = 'Jeda ' + GEMINI_PACE + ' dtk sebelum chunk ' + (i + 1) + '/' + chunks.length + ' (hindari batas gratis)...';
          await sleep(GEMINI_PACE * 1000, job.ctrl.signal); job.note = '';
        }
        const r = await synth(b.engine, chunks[i], o, job, chunks[i - 1], chunks[i + 1]);
        if (b.engine === 'gemini') { parts.push(r.pcm); rate = r.rate; } else parts.push(r);
        job.done = i + 1;
      }
      let buf, format = 'mp3';
      if (b.engine === 'gemini') {
        const pcm = Buffer.concat(parts); format = 'wav'; buf = wavOf(pcm, rate);
        if (hasFfmpeg()) { try { buf = await toMp3(pcm, rate); format = 'mp3'; } catch { job.note = 'ffmpeg gagal, hasil dalam WAV'; } }
      } else buf = Buffer.concat(parts);
      if (o.volume !== 100) { try { buf = await applyVolume(buf, format, o.volume); } catch { job.note = 'Volume tidak diterapkan (ffmpeg gagal)'; } }
      audios.set(id, { buf, ts: Date.now(), format });
      while (audios.size > 4) audios.delete(audios.keys().next().value);
      job.status = 'done'; job.bytes = buf.length; job.format = format;
    })().catch(e => {
      job.status = 'error';
      if (e.name === 'AbortError') { job.kind = job.stopped ? 'stopped' : 'timeout'; job.error = job.stopped ? 'Dibatalkan oleh pengguna' : 'Waktu habis'; }
      else { job.error = e.cause?.code ? e.message + ' (' + e.cause.code + ')' : e.message; job.code = e.status || null; job.kind = e.kind || (e.cause ? 'network' : null); }
    }).finally(() => clearTimeout(timer));
    return id;
  }
  setInterval(() => { for (const [k, v] of jobs) if (Date.now() - v.ts > 3600e3) jobs.delete(k); for (const [k, v] of audios) if (Date.now() - v.ts > 3600e3) audios.delete(k); }, 60e3).unref();

  const body = async req => { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4e5) throw err('Terlalu besar', '', 413); } return JSON.parse(raw || '{}'); };
  return {
    chunkText, engines,
    async route(req, res, u, p) {
      if (!p.startsWith('/api/tts')) return false;
      try {
        if (req.method === 'GET' && p === '/api/tts/engines') return send(res, 200, { engines: engines() }), true;
        if (req.method === 'GET' && p === '/api/tts/voices') {
          const e = u.searchParams.get('engine'), c = vcache[e];
          if (c && Date.now() - c.ts < 600e3) return send(res, 200, c.data), true;
          const eng = engines().find(x => x.id === e);
          if (!eng || !eng.ok) return send(res, 400, { error: eng ? eng.note : 'Engine tidak dikenal' }), true;
          const data = await loadVoices(e); vcache[e] = { ts: Date.now(), data };
          return send(res, 200, data), true;
        }
        if (req.method === 'POST' && p === '/api/tts') return send(res, 200, { id: start(await body(req)) }), true;
        if (req.method === 'GET' && p === '/api/tts/status') {
          const j = jobs.get(u.searchParams.get('id'));
          return j ? send(res, 200, j) : send(res, 404, { error: 'Proses tidak ditemukan (server mungkin restart)' }), true;
        }
        if (req.method === 'GET' && p === '/api/tts/audio') {
          const a = audios.get(u.searchParams.get('id'));
          if (!a) return send(res, 404, { error: 'Audio tidak ditemukan atau sudah kedaluwarsa' }), true;
          res.writeHead(200, { 'content-type': a.format === 'wav' ? 'audio/wav' : 'audio/mpeg', 'content-length': a.buf.length, 'cache-control': 'no-store' }); res.end(a.buf); return true;
        }
        if (req.method === 'POST' && p === '/api/tts/stop') { const id = u.searchParams.get('id'); let n = 0; for (const [k, j] of jobs) if (j.status === 'running' && (!id || k === id)) { j.stopped = true; j.ctrl.abort(); n++; } return send(res, 200, { ok: true, stopped: n }), true; }
      } catch (e) { send(res, e.status || 500, { error: e.message, kind: e.kind || null }); return true; }
      return false;
    }
  };
};
