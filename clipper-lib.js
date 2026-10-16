// Auto Clipper — fungsi murni (tanpa I/O jaringan / tanpa state server).
// Dipakai server.js dan diuji langsung lewat node tanpa memanggil YouTube.
// Semua nama file di sini sederhana (tanpa spasi) agar aman untuk filter ffmpeg.
'use strict';

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);

// Validasi URL: hanya youtube.com / youtu.be (dengan atau tanpa skema).
function isYoutubeUrl(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > 2000) return false;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return YT_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Bersihkan teks judul hook dari input user/AI: satu baris, tanpa karakter kontrol.
function cleanTitle(t, maxLen) {
  const max = maxLen || 120;
  let s = String(t == null ? '' : t).replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

// Escape teks untuk filter drawtext ffmpeg (argumen array, tanpa shell).
// Aturan ffmpeg (diuji empiris): nilai text dibungkus kutip tunggal + escape.
// Kutip tunggal/ganda DI DALAM judul diganti dengan karakter tipografi yang terlihat sama
// (’ / ”) karena \' di dalam kutip justru merusak penjajaran kutip parser ffmpeg.
// Koma WAJIB di-escape: di sintaks filter, koma memisahkan filter dalam satu rantai.
// Persen (%) TIDAK di-escape: drawtext dipanggil dengan expansion=none sehingga % literal.
function escapeDrawtext(s) {
  return String(s || '')
    .replace(/'/g, '’').replace(/"/g, '”')
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/,/g, '\\,');
}

// Escape path/nilai untuk filter ffmpeg (subtitles=..., dll).
// Koma di dalam nilai force_style (format ASS memakai koma) WAJIB di-escape.
function escapeFilterValue(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

// Parse WebVTT (dari yt-dlp --write-subs) menjadi cue [{start, end, text}].
// start/end dalam detik (float). Cue duplikat / kosong dibuang.
function parseVtt(vtt) {
  const cues = [];
  if (!vtt) return cues;
  const text = String(vtt).replace(/\r\n?/g, '\n');
  const ts = '(\\d+):(\\d{2}):(\\d{2})[.,](\\d{3})';
  const re = new RegExp('^' + ts + '\\s*-->\\s*' + ts + '.*$', 'm');
  const blocks = text.split(/\n\s*\n/);
  const seen = new Set();
  for (const b of blocks) {
    const m = b.match(re);
    if (!m) continue;
    const toSec = (h, mi, s, ms) => (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    const lines = b.split('\n').slice(1)
      .map(l => l.trim())
      .filter(l => l && !/^\d+$/.test(l) && !l.startsWith('NOTE') && !l.includes('-->'));
    const cleaned = lines.join(' ')
      .replace(/<[^>]*>/g, '')           // buang tag <c>, <v>, dll.
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = start.toFixed(2) + '|' + cleaned;
    if (seen.has(key)) continue;
    seen.add(key);
    cues.push({ start, end, text: cleaned });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// Format detik -> "HH:MM:SS,mmm" untuk SRT.
function fmtSrt(sec) {
  const total = Math.max(0, +sec || 0);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60), ms = Math.floor((total - Math.floor(total)) * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
}

// Bangun isi file SRT untuk segmen [start, end] dari cue transkrip.
// Waktu digeser agar 0 = awal klip. Cue di luar jendela dibuang.
function buildSrt(cues, start, end) {
  const out = [];
  let n = 1;
  for (const c of cues || []) {
    if (c.end <= start || c.start >= end) continue;
    const s = Math.max(0, c.start - start);
    const e = Math.max(0.2, Math.min(c.end - start, end - start));
    if (e <= s) continue;
    out.push(String(n++) + '\n' + fmtSrt(s) + ' --> ' + fmtSrt(e) + '\n' + c.text + '\n');
  }
  return out.join('\n');
}

// Format waktu ASS: H:MM:SS.CC (centidetik, 2 digit).
function fmtAss(t) {
  t = Math.max(0, +t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// Escape teks untuk field Dialogue ASS (yang sensitif: backslash, kurung kurawal, newline).
function escapeAssText(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N').replace(/\s+/g, ' ').trim();
}

// Bangun file .ass (bukan .srt) untuk subtitle. PlayResX/PlayResY WAJIB 720x1280:
// filter `subtitles` + force_style/original_size TIDAK bisa dipercaya untuk skala
// (diuji: font tetap kegedean + posisi ngaco meski original_size=720x1280).
// Dengan .ass, libass memakai PlayRes dari file sehingga FontSize/MarginV pas.
function buildAss(cues, start, end, subStyle) {
  const ss = subStyle || {};
  const size = Math.min(48, Math.max(16, +ss.size || 30));
  const marginV = Math.min(500, Math.max(20, +ss.marginV || 90));
  const color = /^#[0-9a-fA-F]{6}$/.test(String(ss.color || '')) ? ss.color : '#FFFFFF';
  const bold = ss.bold === false ? 0 : -1;
  const font = ss.font === 'Liberation Sans' ? 'Liberation Sans' : 'DejaVu Sans';
  const primary = '&H00' + color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3);
  const header = '[Script Info]\nTitle: Auto Clipper\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,' + font + ',' + size + ',' + primary + ',&H000000FF,&H80000000,&H00000000,' + bold + ',0,0,0,100,100,0,0,1,2,0,2,10,10,' + marginV + ',1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const out = [header];
  for (const c of cues || []) {
    if (c.end <= start || c.start >= end) continue;
    const s = Math.max(0, c.start - start);
    const e = Math.max(0.2, Math.min(c.end - start, end - start));
    if (e <= s) continue;
    const text = escapeAssText(c.text);
    if (!text) continue;
    out.push('Dialogue: 0,' + fmtAss(s) + ',' + fmtAss(e) + ',Default,,0,0,0,,' + text + '\n');
  }
  return out.join('');
}

// Validasi + rapikan kandidat klip dari AI.
// - start/end angka, 0 <= start < end <= videoDuration
// - panjang klip 10 detik s/d (targetDur + 30) detik
// - judul dibersihkan, skor 0-100
// - kandidat yang tumpang tindih > 50% (yang skornya lebih rendah) dibuang
// - urut skor tertinggi, ambil maksimal `count`
function sanitizeCandidates(raw, videoDuration, targetDur, count) {
  const dur = +videoDuration || 0;
  const maxLen = (targetDur || 60) + 30;
  let list = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      let start = +c.start, end = +c.end;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      start = Math.max(0, start);
      end = dur > 0 ? Math.min(dur, end) : end;
      if (!(end > start)) continue;
      if (end - start < 10 || end - start > maxLen) continue;
      const title = cleanTitle(c.title, 120);
      if (!title) continue;
      let score = +c.score;
      if (!Number.isFinite(score)) score = 50;
      score = Math.min(100, Math.max(0, Math.round(score)));
      list.push({ start, end, title, score, reason: cleanTitle(c.reason, 200) });
    }
  }
  // Buang tumpang tindih: urut skor tertinggi dulu, tolak yang overlap > 50% dengan yang sudah diterima.
  list.sort((a, b) => b.score - a.score || a.start - b.start);
  const kept = [];
  for (const c of list) {
    const len = c.end - c.start;
    let overlap = false;
    for (const k of kept) {
      const ov = Math.min(c.end, k.end) - Math.max(c.start, k.start);
      if (ov > 0.5 * Math.min(len, k.end - k.start)) { overlap = true; break; }
    }
    if (!overlap) kept.push(c);
  }
  return kept.slice(0, Math.max(1, count || 5));
}

// Fallback kalau AI tidak mengembalikan kandidat valid:
// bagi video menjadi `count` segmen sepanjang `targetDur`, merata dari awal.
function fallbackCandidates(videoDuration, targetDur, count) {
  const dur = +videoDuration || 0;
  if (!(dur > 0)) return [];
  const n = Math.max(1, count || 3);
  const len = Math.min(targetDur || 60, dur);
  if (dur <= len) return [{ start: 0, end: dur, title: 'Momen terbaik video ini', score: 50, reason: 'Satu-satunya segmen (video lebih pendek dari durasi klip).' }];
  const step = (dur - len) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round(i * step * 100) / 100;
    out.push({ start, end: Math.round((start + len) * 100) / 100, title: 'Momen terbaik bagian ' + (i + 1), score: 50 - i, reason: 'Pembagian merata (AI tidak mengembalikan kandidat).' });
  }
  return out;
}

// Bagi judul jadi maks 3 baris (maks 24 karakter/baris, potong per kata) agar tidak meluber
// keluar layar 720px — drawtext tidak mendukung \n untuk ganti baris.
function wrapTitle(t, maxLen, maxLines) {
  const ml = maxLen || 24, max = maxLines || 3;
  const words = String(t || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '', truncated = false;
  const flush = () => { if (cur) { if (lines.length < max) lines.push(cur); else truncated = true; cur = ''; } };
  for (let wi = 0; wi < words.length && !truncated; wi++) {
    let word = words[wi];
    while (word.length > 0) {
      if (lines.length >= max && !cur) { truncated = true; break; }
      if (!cur) {
        if (word.length <= ml) { cur = word; word = ''; }
        else { cur = word.slice(0, ml); word = word.slice(ml); flush(); }
      } else if (cur.length + 1 + word.length <= ml) { cur += ' ' + word; word = ''; }
      else flush();
    }
  }
  flush();
  if (truncated && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = (last.length > ml - 1 ? last.slice(0, ml - 1) : last) + '…';
  }
  return lines.slice(0, max);
}
// Bagi cue transkrip menjadi potongan ~8 menit (seperti referensi: 18 menit -> 3 potongan),
// agar tiap panggilan AI tidak kepanjangan. Mengembalikan [{start, end, text}].
function chunkTranscript(cues, maxMinutes, maxWords) {
  const maxSec = (maxMinutes || 8) * 60;
  const maxW = maxWords || 5000;
  const chunks = [];
  let cur = null;
  const words = t => t.split(/\s+/).filter(Boolean).length;
  for (const c of cues || []) {
    if (!cur || (c.start - cur.start) >= maxSec || cur.words + words(c.text) > maxW) {
      cur = { start: c.start, end: c.end, text: '', words: 0 };
      chunks.push(cur);
    }
    cur.text += (cur.text ? ' ' : '') + '[' + fmtClock(c.start) + '] ' + c.text;
    cur.words += words(c.text);
    cur.end = c.end;
  }
  return chunks.slice(0, 4); // maks 4 potongan agar tidak boros token
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(+sec || 0));
  const p = n => String(n).padStart(2, '0');
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
}

// Bangun argumen ffmpeg untuk satu klip (tanpa shell — dipakai via spawn argv).
// out: 720x1280 (9:16). bg: 'blur' | 'black'. subtitle: path file SRT atau null.
// fontFile: path .ttf judul. fontColor: '#RRGGBB' (sudah divalidasi).
function buildFfmpegArgs(o) {
  const start = +o.start || 0;
  const len = Math.max(1, (+o.end || 0) - start);
  const bg = o.bg === 'black' ? 'black' : 'blur';
  const args = ['-ss', String(start), '-i', o.input, '-t', String(len)];
  const filters = [];
  if (bg === 'blur') {
    filters.push('[0:v]split[a][b];[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=40[bg];[b]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v0]');
  } else {
    filters.push('[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p[v0]');
  }
  let last = 'v0';
  if (o.srtPath) {
    // File subtitle adalah .ass (buildAss) — gayanya sudah di dalam file
    // (PlayResX/Y 720x1280 + FontSize/MarginV/warna). Jangan pakai force_style
    // lagi (force_style + original_size terbukti tidak mengubah skala diuji).
    filters.push('[' + last + ']subtitles=' + escapeFilterValue(o.srtPath) + ':fontsdir=' + escapeFilterValue(o.fontsDir) + '[v1]');
    last = 'v1';
  }
  const title = cleanTitle(o.title, 120);
  const lines = title ? wrapTitle(title, 24, 3) : [];
  // Judul tampil SEPANJANG klip (tanpa enable='lt(t,3)') — sebelumnya cuma 3 detik
  // pertama sehingga judul gampang kelewat / dikira tidak ada.
  const ts = o.titleStyle || {};
  const titleSize = Math.min(80, Math.max(28, +ts.size || 54));
  const titleY = Math.min(500, Math.max(0, +ts.y || 70));
  lines.forEach((line, i) => {
    const color = /^#[0-9a-fA-F]{6}$/.test(o.fontColor || '') ? o.fontColor : '#FFFFFF';
    const hex = '0x' + color.slice(1).toUpperCase();
    const label = 'dt' + i;
    // Teks judul WAJIB dalam kutip tunggal + escape (diuji: tanpa kutip, "\:" di luar kutip tidak melindungi ":").
    filters.push('[' + last + ']drawtext=fontfile=' + escapeFilterValue(o.fontFile) + ':text=\'' + escapeDrawtext(line) + '\''
      + ':fontcolor=' + hex + ':fontsize=' + titleSize + ':borderw=2:bordercolor=black@0.8:box=1:boxcolor=black@0.65:boxborderw=14:x=(w-text_w)/2:y=' + (titleY + i * (titleSize + 18)) + ':expansion=none[' + label + ']');
    last = label;
  });
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[' + last + ']');
  const hasAudio = o.audioCodec !== null && o.audioCodec !== false;
  if (hasAudio) args.push('-map', '0:a?');
  // Codec: default libx264 + aac. Kalau ffmpeg server tanpa libx264 (Unknown encoder),
  // fallback ke mpeg4 (encoder bawaan ffmpeg, selalu ada, tetap bisa di-upload).
  // Kalau tanpa aac -> klip tanpa suara (-an).
  const vcodec = o.videoCodec === 'mpeg4' ? 'mpeg4' : 'libx264';
  if (vcodec === 'mpeg4' || o.simple) args.push('-c:v', vcodec);
  else args.push('-c:v', vcodec, '-preset', 'veryfast', '-crf', '23');
  if (vcodec === 'mpeg4') args.push('-q:v', '4');
  if (hasAudio) { args.push('-c:a', 'aac'); if (!o.simple) args.push('-b:a', '128k'); }
  else args.push('-an');
  if (!o.simple) args.push('-movflags', '+faststart');
  args.push('-y', o.output);
  return args;
}

module.exports = {
  isYoutubeUrl, clampInt, cleanTitle, escapeDrawtext, escapeFilterValue,
  parseVtt, fmtSrt, buildSrt, buildAss, sanitizeCandidates, fallbackCandidates,
  chunkTranscript, fmtClock, buildFfmpegArgs, wrapTitle,
};
