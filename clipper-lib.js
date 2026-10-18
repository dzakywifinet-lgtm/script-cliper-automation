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
    const s = hookTotal + Math.max(0, c.start - start);
    const e = hookTotal + Math.max(0.2, Math.min(c.end - start, end - start));
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
// Preset Gaya Subtitle + Judul Hook — PLEK KETIPLEK daftar editor Klipaja
// (ground truth dari editor: 12 gaya subtitle, 14 gaya judul).
// Subtitle: karaoke=Casual dkk. activeColor = warna kata yang sedang diucapin
// (Karaoke=kuning, Casual=hijau — sesuai mini-preview editor).
// box=true = teks di atas kotak (BorderStyle 3), boxColor = warna kotak.
// anim: 'pop' = membesar 80->100%; 'bounce' = 70->115->100%; 'fade' = fade
// in/out; 'rotate' = miring settle; 'slidepop' = geser+pop.
const SUB_PRESETS = {
  karaoke: { label: 'Karaoke', emoji: '🎤', font: 'Montserrat ExtraBold', size: 65, color: '#FFFFFF', activeColor: '#FFFF00', bold: true, karaoke: true },
  casual: { label: 'Casual', emoji: '💬', font: 'Montserrat ExtraBold', size: 52, color: '#FFFFFF', activeColor: '#22C55E', bold: true, anim: 'fade' },
  pill: { label: 'Pill', emoji: '💊', font: 'Montserrat ExtraBold', size: 48, color: '#FFFFFF', activeColor: '#FFFF00', bold: true, box: true, boxColor: '#000000', anim: 'pop' },
  kinetik: { label: 'Kinetik', emoji: '⚡', font: 'Montserrat ExtraBold', size: 71, color: '#FFFFFF', activeColor: '#FFFF00', bold: true, anim: 'slidepop' },
  kertas: { label: 'Kertas', emoji: '📄', font: 'Montserrat ExtraBold', size: 48, color: '#1A1A1A', activeColor: '#B45309', bold: true, box: true, boxColor: '#FFE600', anim: 'fade' },
  kombo: { label: 'Kombo', emoji: '🎨', font: 'Montserrat ExtraBold', size: 65, color: '#FFFFFF', activeColor: '#FFFF00', bold: true, box: true, boxColor: '#000000', anim: 'pop' },
  puisi: { label: 'Puisi', emoji: '🌙', font: 'Liberation Sans', size: 48, color: '#FFFFFF', bold: false, italic: true, anim: 'fade' },
  chat: { label: 'Chat', emoji: '🗨️', font: 'Montserrat ExtraBold', size: 48, color: '#1A1A1A', bold: true, box: true, boxColor: '#FFE600', anim: 'pop' },
  simpel: { label: 'Simpel', emoji: '✨', font: 'Montserrat', size: 48, color: '#FFFFFF', bold: false, anim: 'fade' },
  pantul: { label: 'Pantul', emoji: '🏀', font: 'Montserrat ExtraBold', size: 65, color: '#FFFFFF', activeColor: '#FFFF00', bold: true, anim: 'bounce' },
  bebas: { label: 'Bebas', emoji: '🕊️', font: 'Montserrat ExtraBold', size: 48, color: '#FFFFFF', bold: true, anim: 'rotate' },
  polos: { label: 'Polos', emoji: '⬜', font: 'Montserrat ExtraBold', size: 65, color: '#FFFFFF', bold: true, anim: 'none' },
  default: { label: 'Default', emoji: '📝', font: 'Montserrat ExtraBold', size: 78 },
};
// Font subtitle: SEMUA preset pakai "Montserrat ExtraBold", KECUALI Puisi
// (Liberation Sans italic) dan Simpel ("Montserrat" + Bold=0, ringan plain).
// Alasan: Pi hanya punya Anton-Regular + Montserrat-Regular — libass selama
// ini mensintesis bold palsu dari Regular. File Montserrat-Bold/ExtraBold/
// Black (OFL) dipasang terpisah ke /root/.fonts/ di Pi (tidak di-bundle ke
// repo). Kalau family "Montserrat ExtraBold" belum terinstall di mesin render,
// libass fallback ke font lain — bobot final HANYA bisa diverifikasi lewat
// tes live di Pi setelah font terinstall, bukan dari VM.
// Ukuran subtitle di atas sudah diskala x52/32 (dibulatkan ke bawah) dari
// nilai awal, karena ukuran terukur Klipaja: Casual ~52px pada slider 100%
// (bukan 32). Mini-preview editor Klipaja menunjukkan ke-12 gaya pada skala
// visual yang setara, jadi semua preset ikut faktor yang sama.
// Gaya judul hook (14, ground truth editor). Gaya terkunci di Klipaja
// (Keramat, Notif Chat, Glitch, Ketik, Boom — "bersuara, terbuka setelah
// topup pertama") di sini TETAP BISA DIPAKAI karena dashboard kita tidak
// punya sistem top-up — mengunci tanpa cara buka = fitur mati.
// boxColor = warna kotak; align 2 = bawah-tengah (Sinema);
// letterbox = bar hitam atas-bawah (Layar Lebar).
const HOOK_PRESETS = {
  tanpa: { label: 'Tanpa', emoji: '➖' },
  kartu: { label: 'Kartu', emoji: '🃏', font: 'Montserrat', size: 54, color1: '#000000', box: true, boxColor: '#FFFFFF', bold: true, anim: 'fade' },
  sinema: { label: 'Sinema', emoji: '🎬', font: 'Liberation Sans', size: 60, color1: '#FFFFFF', bold: false, italic: true, align: 2, y: 100, anim: 'fade' },
  keramat: { label: 'Keramat', emoji: '🌙', font: 'Liberation Sans', size: 56, color1: '#FFD93D', bold: true, italic: true, spacing: 2, anim: 'fade' },
  notifchat: { label: 'Notif Chat', emoji: '💬', font: 'Montserrat', size: 32, color1: '#000000', box: true, boxColor: '#FFFFFF', bold: true, anim: 'slidedown' },
  glitch: { label: 'Glitch', emoji: '📺', font: 'Anton', size: 64, color1: '#FFFFFF', bold: true, anim: 'glitch' },
  ketik: { label: 'Ketik', emoji: '⌨️', font: 'Liberation Sans', size: 48, color1: '#FFFFFF', bold: false, anim: 'type' },
  boom: { label: 'Boom', emoji: '💥', font: 'Anton', size: 64, color1: '#FFE600', color2: '#FFFFFF', bold: true, anim: 'bounce' },
  kutipan: { label: 'Kutipan Terang', emoji: '💡', font: 'Liberation Sans', size: 48, color1: '#000000', box: true, boxColor: '#FFFFFF', bold: true, italic: true, anim: 'slidein' },
  slide: { label: 'Slide Dinamis', emoji: '🎞️', font: 'Anton', size: 56, color1: '#FFFFFF', bold: true, anim: 'slidelines' },
  stiker: { label: 'Stiker', emoji: '🏷️', font: 'Anton', size: 56, color1: '#FFE600', bold: true, anim: 'sticker' },
  layar: { label: 'Layar Lebar', emoji: '🎥', font: 'Liberation Sans', size: 48, color1: '#FFFFFF', bold: false, italic: true, spacing: 2, anim: 'fade', letterbox: true },
  berita: { label: 'Berita', emoji: '📰', font: 'Anton', size: 48, color1: '#FFFFFF', box: true, boxColor: '#CC0000', bold: true, anim: 'slidein' },
  stabilo: { label: 'Stabilo', emoji: '🖍️', font: 'Montserrat', size: 54, color1: '#000000', box: true, boxColor: '#FFFF00', bold: true, anim: 'fade' },
  catatan: { label: 'Catatan', emoji: '📝', font: 'Liberation Sans', size: 44, color1: '#1A1A1A', box: true, boxColor: '#FFF9C4', bold: false, italic: true, anim: 'rotate' },
};
function animTag(a) {
  if (a === 'pop') return '{\\fscx80\\fscy80\\t(0,200,\\fscx100\\fscy100)}';
  if (a === 'bounce') return '{\\fscx70\\fscy70\\t(0,150,\\fscx115\\fscy115)\\t(150,300,\\fscx100\\fscy100)}';
  if (a === 'fade') return '{\\fad(150,100)}';
  if (a === 'rotate') return '{\\frz-4\\t(0,300,\\frz0)}';
  if (a === 'slidepop') return '{\\fscx85\\fscy85\\t(0,200,\\fscx100\\fscy100)}{\\fad(100,100)}';
  return '';
}

// Kata per kata dari satu cue.
// - Kalau cue sudah bawa words (Whisper tokens / Koreksi Kata), pakai itu
//   (validasi: waktu naik, di dalam cue, teks gabungan ≈ teks cue).
// - Kalau tidak, BAGI RATA: kata dibagi merata sepanjang cue (dipakai untuk
//   transkrip YouTube yang cuma punya timestamp segmen — karaoke jadi
//   perkiraan, bukan pas persis suara; Whisper = akurat).
// - *kata* (bintang) di teks -> keyword=true (pop kuning / sorot kuning).
// Flag per kata: sensor=true (kata di-sensor: hilang dari subtitle + suara
// dibisukan pas render), keyword=true (kata penting: kuning).
function distributeWords(cue) {
  const start = +cue.start || 0, end = +cue.end || 0;
  const raw = String(cue.text || '').replace(/\*([^*\s]+)\*/g, '\u0001$1\u0002').replace(/\*/g, '');
  const toks = raw.split(/\s+/).filter(Boolean);
  if (!toks.length || !(end > start)) return [];
  const dur = (end - start) / toks.length;
  return toks.map((tok, i) => {
    const m = /^\u0001(.*)\u0002$/.exec(tok);
    return { text: m ? m[1] : tok.replace(/\u0001|\u0002/g, ''), start: Math.round((start + i * dur) * 100) / 100, end: Math.round((start + (i + 1) * dur) * 100) / 100, keyword: !!m };
  });
}
function cueWords(cue) {
  if (!cue || typeof cue !== 'object') return [];
  const ws = Array.isArray(cue.words) ? cue.words : [];
  const ok = ws.length && ws.every(w => w && typeof w.text === 'string' && w.text.trim()
    && Number.isFinite(+w.start) && Number.isFinite(+w.end) && +w.end > +w.start
    && +w.start >= (+cue.start || 0) - 0.05 && +w.end <= (+cue.end || 0) + 0.05);
  if (ok) {
    // Jaga urutan waktu + flag sensor/keyword dari Koreksi Kata.
    return ws.map(w => ({ text: String(w.text).trim(), start: +w.start, end: +w.end, sensor: !!w.sensor, keyword: !!w.keyword, edit: w.edit !== undefined ? String(w.edit) : undefined }))
      .sort((a, b) => a.start - b.start);
  }
  return distributeWords(cue);
}
// Normalisasi satu cue: selalu bawa words (biar job.json / render / preview
// konsisten — cue dari transkrip YouTube / edit teks ikut dapat kata).
function normalizeCueWords(cue) {
  if (!cue || typeof cue !== 'object') return cue;
  return { ...cue, words: cueWords(cue) };
}

function buildAss(cues, start, end, subStyle, overlay) {
  const ss = subStyle || {};
  const ov = overlay || {};
  // Preset dari Detail (ov.subPreset / ov.hookPreset) — override nilai manual.
  const sp = SUB_PRESETS[ov.subPreset] || {};
  const hp = HOOK_PRESETS[ov.hookPreset] || {};
  const subAnimTag = animTag(sp.anim), titleAnimTag = animTag(hp.anim);
  // Ukuran subtitle: slider "Otomatis (100%)" (ov.subSizePercent) mengalikan
  // ukuran dasar preset/manual.
  const subBase = Math.min(110, Math.max(16, +(sp.size || ss.size) || 48));
  const size = Math.min(140, Math.max(12, Math.round(subBase * (Number.isFinite(+ov.subSizePercent) ? (+ov.subSizePercent || 100) / 100 : 1))));
  // Posisi vertikal subtitle: slider persen editor = posisi ATAS blok subtitle
  // (% tinggi frame; ground truth Klipaja: slider 70% -> atas blok ~67%).
  // Alignment 2 = bawah-tengah, jadi MarginV per-event = 1280 - atasPx -
  // blockHeight (blockHeight = jumlah baris x lineH). Style Default MarginV =
  // fallback estimasi 2 baris. Tanpa persen: pakai marginV lama (px).
  const subTopPx = Number.isFinite(+ov.subYPercent) ? Math.round((+ov.subYPercent) / 100 * 1280) : null;
  const lineH = Math.round(size * 1.25);
  const subMarginVFor = (lines) => subTopPx === null ? 0 : Math.min(1200, Math.max(0, 1280 - subTopPx - Math.max(1, lines) * lineH));
  const marginV = subTopPx === null ? Math.min(1200, Math.max(0, +ss.marginV || 90)) : subMarginVFor(2);
  const color = /^#[0-9a-fA-F]{6}$/.test(String(sp.color || ss.color || '')) ? (sp.color || ss.color) : '#FFFFFF';
  const bold = (sp.bold !== undefined ? sp.bold : ss.bold) === false ? 0 : -1;
  const subItalic = (sp.italic || ss.italic) ? -1 : 0;
  // Font subtitle: Anton (Hormozi) + Montserrat + DejaVu + Liberation. Kalau font
  // tidak ada di Pi (belum di-download), libass fallback ke DejaVu (tidak crash).
  const font = ['Anton', 'Montserrat', 'Montserrat ExtraBold', 'Liberation Sans', 'DejaVu Sans'].includes(sp.font || ss.font) ? (sp.font || ss.font) : 'DejaVu Sans';
  // Kotak subtitle: warna kotak dari preset (Kertas/Chat = kuning, Pill/Kombo
  // = hitam) atau override Detail (ov.subBoxColor). BorderStyle 3 = kotak opaque.
  const subBoxColor = /^#[0-9a-fA-F]{6}$/.test(String(sp.boxColor || ov.subBoxColor || '')) ? (sp.boxColor || ov.subBoxColor) : null;
  const subBorder = sp.box ? 3 : 1, subOutline = sp.box ? 0 : (ov.subPreset === 'puisi' ? 3 : 6);
  // Outline 6 = ground truth Klipaja (tebal, terukur di klip download).
  // Kotak (Kertas/Chat/dll) tetap 0 — visualnya kotak, bukan outline glyph.
  // Puisi tetap 3 (tipis elegan).
  const subBack = sp.box ? '&H00' + (subBoxColor || '#000000').slice(5, 7) + (subBoxColor || '#000000').slice(3, 5) + (subBoxColor || '#000000').slice(1, 3) : '&H00000000';
  const primary = '&H00' + color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3);
  // Kata yang sedang diucapin = SecondaryColour (karaoke sweep \k):
  // Karaoke = kuning, Casual = hijau, dst. Tanpa activeColor, secondary =
  // primary (tidak ada sweep terlihat — gaya Simpel/Polos/Puisi/Default).
  const activeHex = /^#[0-9a-fA-F]{6}$/.test(String(sp.activeColor || sp.karaokeColor || '')) ? (sp.activeColor || sp.karaokeColor) : color;
  const karaokeSec = '&H00' + activeHex.slice(5, 7) + activeHex.slice(3, 5) + activeHex.slice(1, 3);
  // Judul + CTA (overlay) — dibakar lewat ASS juga (bukan drawtext), karena
  // ffmpeg Pi tidak punya filter drawtext. Judul 2 warna (pisah |) + CTA
  // masing-masing jadi style sendiri (Alignment 8 = atas-tengah).
  // Ukuran judul: slider "Otomatis (100%)" (ov.titleSizePercent) mengalikan
  // ukuran dasar preset/manual.
  const tBase = Math.min(80, Math.max(28, +(hp.size || ov.titleSize) || 54));
  const tSize = Math.min(110, Math.max(20, Math.round(tBase * (Number.isFinite(+ov.titleSizePercent) ? (+ov.titleSizePercent || 100) / 100 : 1))));
  // Posisi vertikal judul: slider persen editor = posisi ATAS judul (% tinggi
  // frame; ground truth Klipaja: slider 56% -> atas kartu ~54%). Alignment 8
  // = atas-tengah, jadi MarginV = persen x 1280. Tanpa persen: hp.y / ov.titleY (px).
  const tY = Number.isFinite(+ov.titleYPercent)
    ? Math.min(1100, Math.max(0, Math.round((+ov.titleYPercent) / 100 * 1280)))
    : Math.min(500, Math.max(0, +(hp.y !== undefined ? hp.y : ov.titleY) || 70));
  const tBold = (hp.bold !== undefined ? hp.bold : ov.titleBold) === false ? 0 : -1;
  // Judul miring (italic): dari preset (Sinema/Keramat/Kutipan/Layar/Catatan)
  // atau checkbox "Judul miring" di Detail / Clipper.
  const tItalic = (hp.italic || ov.titleItalic) ? -1 : 0;
  const tFont = ['Anton', 'Montserrat', 'Montserrat ExtraBold', 'Liberation Sans', 'DejaVu Sans'].includes(hp.font || ov.titleFont) ? (hp.font || ov.titleFont) : 'DejaVu Sans';
  const tC1 = /^#[0-9a-fA-F]{6}$/.test(String(hp.color1 || ov.titleColor1 || '')) ? (hp.color1 || ov.titleColor1) : '#FFFFFF';
  const tC2 = /^#[0-9a-fA-F]{6}$/.test(String(hp.color2 || ov.titleColor2 || '')) ? (hp.color2 || ov.titleColor2) : '#FFFF00';
  const tSpacing = +hp.spacing || 0;
  // Warna kotak judul: preset (Kartu/Kutipan = putih, Berita = merah,
  // Stabilo = kuning, Catatan = kuning pucat) atau override Detail
  // (ov.titleCardColor).
  const tBoxColor = /^#[0-9a-fA-F]{6}$/.test(String(hp.boxColor || ov.titleCardColor || '')) ? (hp.boxColor || ov.titleCardColor) : null;
  const titleBorder = hp.box ? 3 : 1, titleOutline = hp.box ? 0 : 2;
  const titleBack = hp.box ? '&H00' + (tBoxColor || '#000000').slice(5, 7) + (tBoxColor || '#000000').slice(3, 5) + (tBoxColor || '#000000').slice(1, 3) : '&H00000000';
  const tAlign = hp.align === 2 ? 2 : 8;
  const tP1 = '&H00' + tC1.slice(5, 7) + tC1.slice(3, 5) + tC1.slice(1, 3);
  const tP2 = '&H00' + tC2.slice(5, 7) + tC2.slice(3, 5) + tC2.slice(1, 3);
  const cta = ov.cta || {};
  const ctaSize = Math.min(48, Math.max(20, Math.round(tSize * 0.6)));
  const ctaY = Math.min(1200, Math.max(0, +cta.y || 1150)); // default 1150 (di bawah subtitle y~880-1000, biar tidak numpuk; sebelumnya 950 ketutup subtitle)
  const ctaColor = /^#[0-9a-fA-F]{6}$/.test(String(cta.color || '')) ? cta.color : '#FFFFFF';
  const ctaP = '&H00' + ctaColor.slice(5, 7) + ctaColor.slice(3, 5) + ctaColor.slice(1, 3);
  // Kotak \p1: BorderStyle 3 + BackColour tidak menggambar kotak di
  // ffmpeg/libass (diuji 0 piksel) — jadi kotak digambar manual sebagai
  // event persegi terisi SEBELUM event teksnya (urutan file = urutan gambar).
  // BorderStyle 3 + BackColour di Style TETAP dipertahankan (tidak berbahaya).
  // Sudut kotak persegi (bukan membulat seperti Klipaja) — perbedaan diterima.
  const assColorBGR = (hex) => '&H00' + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2);
  const fadOf = (tag) => { const t = String(tag || ''); const i = t.indexOf('\\fad('); if (i < 0) return ''; const j = t.indexOf(')', i); return j < 0 ? '' : '{' + t.slice(i, j + 1) + '}'; };
  const titleBoxHex = hp.box ? (tBoxColor || '#000000').replace('#', '').toUpperCase() : null;
  const subBoxHex = sp.box ? (subBoxColor || '#000000').replace('#', '').toUpperCase() : null;
  const boxStyles = [titleBoxHex, subBoxHex].filter((v, i, a) => v && a.indexOf(v) === i)
    .map(h => 'Style: BoxRect_' + h + ',DejaVu Sans,10,' + assColorBGR(h) + ',&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,10,10,0,1\n').join('');
  const boxRectEvent = (styleName, s, e, x, y, w, h, fadTag) => {
    const rx = Math.max(0, Math.round(x)), ry = Math.max(0, Math.round(y));
    const rw = Math.min(720 - rx, Math.max(1, Math.round(w))), rh = Math.min(1280 - ry, Math.max(1, Math.round(h)));
    return 'Dialogue: 0,' + fmtAss(s) + ',' + fmtAss(e) + ',' + styleName + ',,0,0,0,,' + (fadTag || '') + '{\\an7\\pos(' + rx + ',' + ry + ')\\p1}m 0 0 l ' + rw + ' 0 l ' + rw + ' ' + rh + ' l 0 ' + rh + '{\\p0}\n';
  };
  // WrapStyle: 0 = smart wrapping (libass membungkus teks jadi beberapa baris).
  // Sebelumnya WrapStyle: 2 (no wrapping) → subtitle 1 baris raksasa kepotong layar.
  const header = '[Script Info]\nTitle: Auto Clipper\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,' + font + ',' + size + ',' + primary + ',' + karaokeSec + ',&H80000000,' + subBack + ',' + bold + ',' + subItalic + ',0,0,100,100,0,0,' + subBorder + ',' + subOutline + ',0,2,10,10,' + marginV + ',1\nStyle: Title1,' + tFont + ',' + tSize + ',' + tP1 + ',&H000000FF,&H80000000,' + titleBack + ',' + tBold + ',' + tItalic + ',0,0,100,100,' + tSpacing + ',0,' + titleBorder + ',' + titleOutline + ',0,8,10,10,' + tY + ',1\nStyle: Title2,' + tFont + ',' + tSize + ',' + tP2 + ',&H000000FF,&H80000000,' + titleBack + ',' + tBold + ',' + tItalic + ',0,0,100,100,' + tSpacing + ',0,' + titleBorder + ',' + titleOutline + ',0,8,10,10,' + tY + ',1\nStyle: Cta,' + tFont + ',' + ctaSize + ',' + ctaP + ',&H000000FF,&H80000000,&H00000000,' + tBold + ',' + tItalic + ',0,0,100,100,0,0,1,2,0,8,10,10,' + ctaY + ',1\nStyle: Hook,' + tFont + ',' + Math.round(tSize * 1.3) + ',&H00FFFFFF,&H000000FF,&H80000000,&H00000000,' + tBold + ',' + tItalic + ',0,0,100,100,0,0,1,2,0,5,10,10,0,1\n' + boxStyles + '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const out = [header];
  const clipDur = Math.max(0.2, (end || 0) - (start || 0));
  // Durasi judul (gaya Klipaja): 'default' = 4 detik (judul hook cuma di awal),
  // 'full' = sepanjang klip, 'manual' = titleDurSec detik. CTA tetap sepanjang klip.
  const titleDurMode = ov.titleDur === 'full' ? 'full' : ov.titleDur === 'manual' ? 'manual' : 'default';
  const titleDurSec = titleDurMode === 'full' ? clipDur : titleDurMode === 'manual' ? Math.min(clipDur, Math.max(0.5, +ov.titleDurSec || 4)) : Math.min(clipDur, 4);
  // --- Hook multi-hook (gaya Hook V2): potongan pendek (0,5–2,5 detik) disambung
  // di DEPAN klip utama. ov.hook = array {start, end, text} waktu RELATIF ke
  // awal klip (sudah dikurangi cand.start oleh server). Timeline hook: item
  // ke-i menempati [pos_i, pos_i + dur_i], total hookTotal. Klip utama mulai
  // di hookTotal — jadi judul/CTA/subtitle utama di-offset hookTotal (muncul
  // setelah hook, bukan selama hook). Teks hook + flash putih di-render di sini.
  const hookItems = (Array.isArray(ov.hook) ? ov.hook : []).filter(h => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start).slice(0, 3);
  let hookTotal = 0;
  const hookTimeline = hookItems.map(h => { const pos = hookTotal; hookTotal += (h.end - h.start); return { pos, dur: h.end - h.start, text: String(h.text || '').trim() }; });
  // Teks hook (Anton gede, center, bayangan). Tanpa flash putih (hard cut):
  // flash .ass {\p1} merusak Dialogue sesudahnya, filter fade out->in
  // bikin video putih semua. Lihat catatan di buildFfmpegArgs.
  for (const ht of hookTimeline) {
    if (ht.text) out.push('Dialogue: 0,' + fmtAss(ht.pos) + ',' + fmtAss(ht.pos + ht.dur) + ',Hook,,0,0,0,,' + escapeAssText(ht.text) + '\n');
  }
  // --- Judul + CTA: tampil sepanjang KLIP UTAMA (hookTotal → hookTotal + clipDur).
  // (bagian 1 = warna 1, bagian 2+ = warna 2), tiap baris jadi Dialogue sendiri
  // dengan MarginV sendiri (biar bertumpuk atas-bawah, center).
  // Pakai Judul (per-klip, checkbox di Detail): kalau off, judul tidak dibakar.
  const titleText = String(ov.title || '').trim();
  if (ov.showTitle !== false && titleText) {
    const parts = titleText.split('|').map(s => s.trim()).filter(Boolean);
    const charsPerLine = Math.max(10, Math.floor(680 / (0.6 * tSize)));
    // Bungkus jadi baris-baris dulu (biar align bawah/Sinema bisa numpuk ke atas).
    const allLines = [];
    parts.forEach((part, pi) => {
      const words = part.split(/\s+/).filter(Boolean);
      let cur = '';
      for (const w of words) {
        if (!cur) { cur = w; continue; }
        if (cur.length + 1 + w.length <= charsPerLine) cur += ' ' + w;
        else { allLines.push({ text: cur, pi }); cur = w; }
      }
      if (cur) allLines.push({ text: cur, pi });
    });
    // Layar Lebar: bar hitam atas-bawah (gambar \p); judul dipaksa masuk area
    // aman (di bawah bar atas) biar tidak ketutup bar.
    const tYeff = hp.letterbox ? Math.max(tY, 160) : tY;
    if (hp.letterbox) {
      const barH = 140;
      const barTag = '{\\an7\\p1\\1c&H000000&}m 0 0 l 720 0 l 720 ' + barH + ' l 0 ' + barH + '{\\p0}';
      out.push('Dialogue: 2,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',Title1,,0,0,0,,' + '{\\pos(0,0)}' + barTag + '\n');
      out.push('Dialogue: 2,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',Title1,,0,0,0,,' + '{\\pos(0,' + (1280 - barH) + ')}' + barTag + '\n');
    }
    // Kotak judul: SATU rect untuk seluruh blok (Kartu/dll). Fad sama seperti teks.
    if (hp.box && titleBoxHex) {
      const tLineH = tSize * 1.25;
      const tMaxW = Math.max(...allLines.map(ln => ln.text.length * tSize * 0.54));
      out.push(boxRectEvent('BoxRect_' + titleBoxHex, hookTotal, hookTotal + titleDurSec,
        360 - tMaxW / 2 - 28, tYeff - 16, tMaxW + 56, allLines.length * tLineH + 32, fadOf(titleAnimTag) || (hp.anim === 'slidedown' || hp.anim === 'slidein' || hp.anim === 'slidelines' ? '{\\fad(100,100)}' : '')));
    }
    // Ketik (typewriter): tiap karakter muncul satu per satu (teks kumulatif,
    // event yang lebih panjang menutup yang pendek — jadi kelihatan ngetik).
    // Kursor ▌ menempel di event karakter terakhir.
    if (hp.anim === 'type') {
      allLines.forEach((ln, li) => {
        const mv = tYeff + li * (tSize + 18);
        const chars = ln.text.split('');
        chars.forEach((_, ci) => {
          const prefix = ln.text.slice(0, ci + 1) + (ci === chars.length - 1 ? '▌' : '');
          out.push('Dialogue: 0,' + fmtAss(hookTotal + ci * 0.06) + ',' + fmtAss(hookTotal + titleDurSec) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,' + mv + ',,' + escapeAssText(prefix) + '\n');
        });
      });
    } else if (hp.anim === 'glitch') {
      // Glitch: 3 salinan RGB-split (merah / cyan / putih) bergeser ±3px.
      allLines.forEach((ln, li) => {
        const mv = tYeff + li * (tSize + 18);
        const copies = ['{\\1c&H0000FF&\\pos(357,' + mv + ')}', '{\\1c&HFFFF00&\\pos(363,' + mv + ')}', '{\\1c&HFFFFFF&\\pos(360,' + mv + ')}'];
        for (const tag of copies) {
          out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,0,,' + tag + '{\\fad(100,100)}' + escapeAssText(ln.text) + '\n');
        }
      });
    } else {
      allLines.forEach((ln, li) => {
        const mv = tAlign === 2 ? tYeff + (allLines.length - 1 - li) * (tSize + 18) : tYeff + li * (tSize + 18);
        let tag = titleAnimTag;
        if (hp.anim === 'slidedown') tag = '{\\move(360,-80,360,' + mv + ',0,400)}{\\fad(100,100)}';
        else if (hp.anim === 'slidein') tag = '{\\move(-200,' + mv + ',360,' + mv + ',0,400)}{\\fad(100,100)}';
        else if (hp.anim === 'slidelines') { const fx = (li % 2 === 0) ? -200 : 920; tag = '{\\move(' + fx + ',' + mv + ',360,' + mv + ',0,400)}{\\fad(100,100)}'; }
        else if (hp.anim === 'sticker') tag = '{\\bord8\\3c&HFFFFFF&\\frz-3\\t(0,300,\\frz0)}';
        const alignTag = tAlign === 2 ? '{\\an2}' : '';
        out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,' + mv + ',,' + alignTag + tag + escapeAssText(ln.text) + '\n');
      });
    }
  }
  if (cta.enabled !== false && String(cta.text || '').trim()) {
    const lines = String(cta.text).split('|').map(s => s.trim()).filter(Boolean);
    lines.forEach((line, li) => {
      const mv = ctaY + li * (ctaSize + 8);
      out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + clipDur) + ',Cta,,0,0,' + mv + ',,' + escapeAssText(line) + '\n');
    });
  }
  // --- Subtitle gaya HORMOZI: cue dipecah jadi grup maks 5 KATA (punchy, ganti
  // cepat), tiap grup jadi Dialogue sendiri. Tiap grup dipecah lagi jadi baris
  // eksplisit (\N, maks 2 baris) — biar pasti 1–2 baris center, tidak 1 baris
  // raksasa kepotong (WrapStyle 0 jadi jaring pengaman).
  // *kata* (bintang) = kata yang nge-POP: lebih gede (+50%) + kuning (override
  // inline \fs + \c). Tulis di editor subtitle, misal: ini *PENTING* banget.
  const charsPerLine = Math.max(10, Math.floor(680 / (0.6 * size)));
  // Subtitle Klipaja = HURUF BESAR SEMUA, kecuali gaya Simpel (mixed-case
  // "Aku bisa."). Uppercase hanya di output bakar (.ass) — teks editor /
  // transkrip tidak diubah.
  const upperSub = (t) => (ov.subPreset === 'simpel' ? String(t) : String(t).toUpperCase());
  // Hitung jumlah baris hasil wrap greedy (sama seperti renderGroup) — buat
  // MarginV per-event yang sadar jumlah baris.
  function countWrapLines(texts, cpl) { let lines = 1, cur = 0; for (const t of texts) { const wl = String(t).length; if (cur === 0) cur = wl; else if (cur + 1 + wl <= cpl) cur += 1 + wl; else { lines++; cur = wl; } } return lines; }
  const popSize = Math.round(size * 1.5);
  const popColor = '&H0000FFFF'; // kuning (ASS BGR)
  const normalColor = '&H00' + color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3);
  // Render satu grup kata (array {text, pop}) jadi teks .ass (baris \N + override pop).
  function renderGroup(group) {
    // Bungkus grup jadi baris-baris ≤charsPerLine (hitung panjang tanpa override).
    const lines = [];
    let lcur = []; let lcurLen = 0;
    for (const w of group) {
      const wl = w.text.length;
      if (!lcur.length) { lcur = [w]; lcurLen = wl; continue; }
      if (lcurLen + 1 + wl <= charsPerLine) { lcur.push(w); lcurLen += 1 + wl; }
      else { lines.push(lcur); lcur = [w]; lcurLen = wl; }
    }
    if (lcur.length) lines.push(lcur);
    return lines.map(lineWords => lineWords.map(w => w.pop
      ? '{\\fs' + popSize + '}{\\c' + popColor + '&}' + escapeAssText(upperSub(w.text)) + '{\\c' + normalColor + '&}{\\fs' + size + '}'
      : escapeAssText(upperSub(w.text))).join(' ')).join('\\N');
  }
  // Gabung cue yang kepotong kalimat: kalau cue sebelumnya tidak berakhir
  // dengan tanda akhir kalimat (. ! ? …) dan jeda ke cue berikutnya < 0,5 detik
  // (kemungkinan lanjutan kalimat, bukan kalimat baru), gabung jadi satu cue.
  // Jadi subtitle menampilkan kalimat UTUH, bukan fragmen ("Saya pergi ke" +
  // "pasar" -> "Saya pergi ke pasar").
  // Pakai Subtitle (per-klip): kalau off, subtitle tidak dibakar (cues diabaikan).
  const subCues = (ov.showSub === false) ? [] : (cues || []).map(c => ({ ...c, words: cueWords(c) }));
  const merged = [];
  for (const c of subCues.slice().sort((a, b) => (a.start || 0) - (b.start || 0))) {
    if (!c || !String(c.text || '').trim()) continue;
    const prev = merged[merged.length - 1];
    const gap = prev ? (c.start || 0) - (prev.end || 0) : 999;
    const prevText = prev ? String(prev.text || '').trim() : '';
    const endsSentence = /[.!?…]["”']?$/.test(prevText);
    if (prev && !endsSentence && gap < 0.5 && gap >= -0.1) {
      prev.end = c.end; prev.text = prevText + ' ' + String(c.text || '').trim();
      prev.words = (prev.words || []).concat(c.words || []); // karaoke: kata ikut kegabung
    } else merged.push({ start: c.start, end: c.end, text: c.text, words: (c.words || []).slice() });
  }
  // --- Jalur \k (karaoke sweep): dipakai gaya yang punya activeColor
  // (Karaoke, Casual, Pill, Kinetik, Kertas, Kombo, Pantul) + preset karaoke.
  // Subtitle dari KATA, tiap kata dapat tag \k (durasi centidetik) — kata
  // yang lagi diucapin = SecondaryColour (activeColor preset). Sensor =
  // slot kosong (cuma \k + spasi) biar timing kata sesudahnya tetap pas
  // suara. Keyword = kuning + lebih gede. Animasi grup via subAnimTag.
  if (sp.karaoke || sp.activeColor) {
    for (const c of merged) {
      if (c.end <= start || c.start >= end) continue;
      const words = (c.words || []).filter(w => w && w.text);
      if (!words.length) continue;
      // Grup kata (aturan sama: pecah di akhir kalimat / koma (grup>=3) / maks 5 kata).
      const groups = [];
      let cur = [];
      for (const w of words) {
        cur.push(w);
        const endsSent = /[.!?…]["”']?$/.test(w.text);
        const endsClause = /[,;:]["”']?$/.test(w.text);
        if (endsSent || (endsClause && cur.length >= 3) || cur.length >= 5) { groups.push(cur); cur = []; }
      }
      if (cur.length) groups.push(cur);
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const gs = hookTotal + Math.max(0, group[0].start - start);
        // Event membentang sepanjang SLOT grup: sampai awal grup berikutnya,
        // atau akhir cue untuk grup terakhir (jadi blok tidak hilang di
        // tengah jeda kata, dan tidak bertumpuk dengan grup berikutnya).
        // \k hanya menutupi kata-kata; setelah sapuan selesai, blok tetap
        // tersorot penuh sampai slot berakhir.
        const slotEnd = gi + 1 < groups.length ? groups[gi + 1][0].start : c.end;
        const ge = hookTotal + Math.max(0.2, Math.min(Math.max(slotEnd - start, group[group.length - 1].end - start), end - start));
        if (ge <= gs) continue;
        // Pecah baris karaoke: greedy berbasis lebar, max 560px (720 - 2x80);
        // lebar pecah = karakter (termasuk spasi) x size x 0.65. Max 2 baris;
        // kalau masih meluber, redistribusi rata jadi 3 baris. Kata tidak dibuang.
        // Lebar RECT (0.70) dipisah — kotak harus sedikit lebih longgar dari
        // teks biar tidak kekecilan.
        const kLineW = (ws) => ws.map(w => upperSub(w.text)).join(' ').length * size * 0.65;
        const kRectW = (ws) => ws.map(w => upperSub(w.text)).join(' ').length * size * 0.70;
        let kLines = [];
        { let cur = [];
          for (const w of group) {
            if (!cur.length) { cur = [w]; continue; }
            if (kLineW([...cur, w]) <= 560) cur.push(w);
            else { kLines.push(cur); cur = [w]; }
          }
          if (cur.length) kLines.push(cur);
        }
        if (kLines.length > 3) {
          const per = Math.ceil(group.length / 3);
          kLines = [group.slice(0, per), group.slice(per, per * 2), group.slice(per * 2)].filter(c => c.length);
        }
        const kTotal = kLines.length;
        const kBase = subMarginVFor(kTotal);
        // Kotak subtitle karaoke: SATU rect per grup, menutupi semua barisnya.
        if (sp.box && subBoxHex) {
          const kMaxW = Math.max(...kLines.map(kRectW));
          out.push(boxRectEvent('BoxRect_' + subBoxHex, gs, ge,
            360 - kMaxW / 2 - 28, 1280 - kBase - kTotal * lineH - 16, kMaxW + 56, kTotal * lineH + 32, fadOf(subAnimTag)));
        }
        // Sorotan kata-per-kata TANPA \k: \k di libass menyorot kata yang
        // BELUM diucapin (Secondary sebelum intervalnya — terverifikasi
        // frame hitam: kata mendatang hijau, kata yang diucapin putih),
        // kebalikan dari Klipaja (kata yang SEDANG diucapin = aktif).
        // Jadi tiap kata dapat jendelanya sendiri: untuk kata ke-j,
        // pancarkan satu event per baris yang membentang
        // [kata_j.start, kata_{j+1}.start) (kata terakhir sampai akhir
        // slot grup), dengan kata_j diwarnai activeColor dan kata lain
        // putih. Hasilnya: blok stabil, hanya kata yang sedang diucapin
        // yang berwarna — persis Klipaja. Tanpa subAnimTag (anim per
        // kata akan berkedip tiap ganti kata).
        group.forEach((wAct, wi) => {
          const ws = hookTotal + Math.max(0, wAct.start - start);
          const we = wi + 1 < group.length
            ? hookTotal + Math.max(0, group[wi + 1].start - start)
            : ge;
          if (we <= ws) return;
          kLines.forEach((lineWords, li) => {
            let line = '';
            let hasText = false;
            lineWords.forEach((w) => {
              if (w.sensor) return;
              hasText = true;
              const txt = escapeAssText(upperSub(w.text));
              if (w.keyword) line += '{\\c' + popColor + '&}{\\fs' + popSize + '}' + txt + '{\\c' + normalColor + '&}{\\fs' + size + '} ';
              else if (w === wAct) line += '{\\c' + karaokeSec + '&}' + txt + '{\\c' + normalColor + '&} ';
              else line += txt + ' ';
            });
            if (!hasText) return;
            const mv = kBase + (kTotal - 1 - li) * lineH;
            out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Default,,0,0,' + mv + ',,' + (subItalic ? '{\\i1}' : '') + line.trimEnd() + '\n');
          });
        });
      }
    }
  } else {
  for (const c of merged) {
    if (c.end <= start || c.start >= end) continue;
    // Kata yang di-sensor / keyword (Koreksi Kata): kalau ada flag di kata,
    // teks subtitle dibangun dari KATA (sensor = dibuang, keyword = *kata*).
    // Tanpa flag, pakai teks cue apa adanya (perilaku lama).
    let displayText = c.text;
    const wlist = c.words || [];
    if (wlist.some(w => w.sensor || w.keyword)) {
      displayText = wlist.map(w => w.sensor ? '' : (w.keyword ? '*' + w.text + '*' : w.text)).filter(Boolean).join(' ');
    }
    const s = hookTotal + Math.max(0, c.start - start);
    const e = hookTotal + Math.max(0.2, Math.min(c.end - start, end - start));
    if (e <= s) continue;
    // Tandai kata pop: *kata* (satu kata, tanpa spasi di dalam bintang). Bintang
    // yang mengapit lebih dari satu kata dihapus saja (jadi teks biasa, tidak pop).
    const raw = String(displayText || '').replace(/\*([^*\s]+)\*/g, '\u0001$1\u0002').replace(/\*/g, '');
    if (!raw.trim()) continue;
    // Pecah jadi kata-kata, sambil ingat mana yang pop (diapit \u0001..\u0002).
    const words = [];
    for (const tok of raw.split(/\s+/).filter(Boolean)) {
      const m = /^\u0001(.*)\u0002$/.exec(tok);
      if (m) words.push({ text: m[1], pop: true });
      else words.push({ text: tok.replace(/\u0001|\u0002/g, ''), pop: false });
    }
    if (!words.length) continue;
    // Grup NGIKUTIN JEDA ALAMI NGOMONG (bukan asal 5 kata): pecah di akhir
    // kalimat (. ! ?) atau di koma/titik-koma (jeda alami, kalau grup sudah
    // >= 3 kata). Batas keras 5 kata hanya kalau tidak ada tanda baca — jadi
    // subtitle tidak kepotong di tengah kalimat/frasa, tapi tetap punchy.
    const groups = [];
    let cur = [];
    for (const w of words) {
      cur.push(w);
      const endsSent = /[.!?…]["”']?$/.test(w.text);
      const endsClause = /[,;:]["”']?$/.test(w.text);
      if (endsSent || (endsClause && cur.length >= 3) || cur.length >= 5) { groups.push(cur); cur = []; }
    }
    if (cur.length) groups.push(cur);
    const totalLen = words.reduce((a, w) => a + w.text.length, 0) || 1;
    let t0 = s;
    groups.forEach((group, gi) => {
      const glen = group.reduce((a, w) => a + w.text.length, 0);
      const dur = (e - s) * (glen / totalLen);
      const t1 = gi === groups.length - 1 ? e : Math.max(t0 + 0.2, t0 + dur);
      const rendered = renderGroup(group);
      const gLines = rendered.split('\\N');
      const mv = subMarginVFor(gLines.length);
      // Kotak subtitle jalur grup: SATU rect per grup, menutupi semua barisnya.
      if (sp.box && subBoxHex) {
        const gMaxW = Math.max(...gLines.map(l => l.replace(/\{[^}]*\}/g, '').length * size * 0.70));
        out.push(boxRectEvent('BoxRect_' + subBoxHex, t0, t1,
          360 - gMaxW / 2 - 28, 1280 - mv - gLines.length * lineH - 16, gMaxW + 56, gLines.length * lineH + 32, fadOf(subAnimTag)));
      }
      out.push('Dialogue: 0,' + fmtAss(t0) + ',' + fmtAss(t1) + ',Default,,0,0,' + mv + ',,' + (subItalic ? '{\\i1}' : '') + subAnimTag + rendered + '\n');
      t0 = t1;
    });
  }
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
      // Hook multi-hook (gaya Hook V2 repo referensi): 2–3 potongan pendek dari
      // momen paling mencolok DI DALAM kandidat ini, masing-masing ada teks
      // on-screen singkat. Validasi: waktu absolut (sumber), di dalam
      // [start, end] kandidat, durasi 0,5–2,5 detik, maks 3 item.
      let hook = [];
      if (Array.isArray(c.hook)) {
        for (const h of c.hook) {
          if (!h || typeof h !== 'object') continue;
          let hs = +h.start, he = +h.end;
          if (!Number.isFinite(hs) || !Number.isFinite(he)) continue;
          hs = Math.max(start, hs); he = Math.min(end, he);
          const hd = he - hs;
          if (hd < 0.5 || hd > 2.5) continue;
          const htext = cleanTitle(h.text, 30);
          if (!htext) continue;
          hook.push({ start: Math.round(hs * 100) / 100, end: Math.round(he * 100) / 100, text: htext });
          if (hook.length >= 3) break;
        }
      }
      list.push({ start, end, title, score, reason: cleanTitle(c.reason, 200), hook,
        // Caption + hashtag per klip (gaya Klipaja: caption + # siap posting).
        // AI diminta mengisinya di prompt; klip lama / tanpa AI = kosong.
        caption: cleanTitle(c.caption, 280),
        hashtags: (() => { const hs = []; if (Array.isArray(c.hashtags)) { for (const h of c.hashtags) { let t = String(h || '').trim(); if (!t) continue; if (!t.startsWith('#')) t = '#' + t; t = t.replace(/\s+/g, ''); if (t.length > 1 && t.length <= 40) hs.push(t); if (hs.length >= 6) break; } } return hs; })(),
      });
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
  if (dur <= len) return [{ start: 0, end: dur, title: 'Momen terbaik video ini', score: 50, reason: 'Satu-satunya segmen (video lebih pendek dari durasi klip).', caption: '', hashtags: [] }];
  const step = (dur - len) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round(i * step * 100) / 100;
    out.push({ start, end: Math.round((start + len) * 100) / 100, title: 'Momen terbaik bagian ' + (i + 1), score: 50 - i, reason: 'Pembagian merata (AI tidak mengembalikan kandidat).', caption: '', hashtags: [] });
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
// out: 720x1280 (9:16). bg: 'blur' | 'black' | 'white'. subtitle: path file SRT atau null.
// fontFile: path .ttf judul. fontColor: '#RRGGBB' (sudah divalidasi).
// plainOnly: render video POLOS saja (tanpa judul/subtitle) — dipakai sebagai cache
//   (video polos) agar render ulang judul/subtitle tidak perlu re-encode video lagi.
// overlayOnly: input SUDAH video polos 720x1280 (hasil plainOnly) — lewati scale/blur/crop,
//   hanya timpa judul + subtitle (encode ulang saja, jauh lebih ringan CPU-nya).
function buildFfmpegArgs(o) {
  const start = +o.start || 0;
  const len = Math.max(1, (+o.end || 0) - start);
  const bg = ['black', 'white'].includes(o.bg) ? o.bg : 'blur';
  // overlayOnly: input adalah video polos (sudah 720x1280) — potong dari awal
  // (tidak perlu -ss karena file polos sudah tepat durasi klipnya).
  const args = o.overlayOnly ? ['-i', o.input] : ['-ss', String(start), '-i', o.input, '-t', String(len)];
  const filters = [];
  // Hook multi-hook (overlayOnly): potongan hook (dari video polos, waktu relatif
  // ke awal klip) disambung di depan klip utama via concat (video + audio).
  // Flash putih antar segmen di-handle filter fade (bukan .ass — {\p1} merusak teks).
  // Kalau klip polos tanpa audio, concat a=1 gagal -> fallback tanpa hook (server).
  const hook = (o.overlayOnly && Array.isArray(o.hook)) ? o.hook.filter(h => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start).slice(0, 3) : [];
  const hookTotal = hook.reduce((a, h) => a + (h.end - h.start), 0);
  // Speaker-switch manual (podcast): crop yang PINDAH posisi per detik, ngikutin
  // tandaan siapa ngomong (o.speakers = [{start, end, pos}] waktu relatif ke
  // awal KLIP UTAMA; pos 0=kiri, 0.5=tengah, 1=kanan). Crop 540x960 (zoom 1,33x)
  // lalu scale balik ke 720x1280 — zoom-nya cukup kelihatan, tidak terlalu blur.
  // Waktu speaker di-offset hookTotal (klip utama mulai setelah hook).
  const speakers = (o.overlayOnly && Array.isArray(o.speakers)) ? o.speakers.filter(sp => sp && Number.isFinite(sp.start) && Number.isFinite(sp.end) && sp.end > sp.start && Number.isFinite(sp.pos)).slice(0, 20).sort((a, b) => a.start - b.start) : [];
  let speakerExpr = null;
  if (speakers.length) {
    const xFor = pos => Math.round(Math.min(1, Math.max(0, +pos)) * 180);
    // Ekspresi nested if: if(lt(t, end1+hookTotal), x1, if(lt(t, end2+hookTotal), x2, ... , 90))
    // (90 = tengah, default di luar semua segmen).
    let expr = '90';
    for (let i = speakers.length - 1; i >= 0; i--) {
      const sp = speakers[i];
      expr = 'if(lt(t,' + (sp.end + hookTotal) + '),' + xFor(sp.pos) + ',' + expr + ')';
    }
    speakerExpr = "crop=w=540:h=960:x='" + expr + "':y=140,scale=720:1280";
  }
  if (hook.length) {
    const n = hook.length + 1;
    filters.push('[0:v]split=' + n + hook.map((_, i) => '[spv' + i + ']').join('') + '[spvMain]');
    hook.forEach((h, i) => filters.push('[spv' + i + ']trim=start=' + h.start + ':end=' + h.end + ',setpts=PTS-STARTPTS[hs' + i + ']'));
    filters.push('[spvMain]setpts=PTS-STARTPTS[mainv]');
    filters.push('[0:a]asplit=' + n + hook.map((_, i) => '[spa' + i + ']').join('') + '[spaMain]');
    hook.forEach((h, i) => filters.push('[spa' + i + ']atrim=start=' + h.start + ':end=' + h.end + ',asetpts=PTS-STARTPTS[ha' + i + ']'));
    filters.push('[spaMain]asetpts=PTS-STARTPTS[maina]');
    const concatIn = hook.map((_, i) => '[hs' + i + '][ha' + i + ']').join('') + '[mainv][maina]';
    filters.push(concatIn + 'concat=n=' + n + ':v=1:a=1[outv][outa]');
    filters.push('[outv]format=yuv420p[v0]');
  } else if (o.overlayOnly) {
    filters.push('[0:v]format=yuv420p[v0]');
  } else if (o.podcast) {
    const ft = Array.isArray(o.faceTrack) ? o.faceTrack.filter(p => p && Number.isFinite(p.t) && Number.isFinite(p.x)).sort((a, b) => a.t - b.t).slice(0, 120) : [];
    if (ft.length >= 2) {
      // Crop time-varying: crop window ngikutin wajah (X dari face_track.py, sudah EMA).
      // INTERPOLASI LINEAR antar titik (bukan step): untuk t di [t_i, t_{i+1}),
      // x = x_i + (x_{i+1}-x_i)*(t-t_i)/(t_{i+1}-t_i) — gerak kontinu, tidak
      // patah-patah / kaku (step per 0.5 detik bikin perpindahan terasa lompat).
      // Nested if dari belakang: t<t0 -> x0; t in [t_i,t_{i+1}) -> lerp; t>=tLast -> xLast.
      // x dalam koordinat SUMBER. w/h pakai min() (tahan sumber portrait).
      // x di-clamp ke [0, iw-ow] biar tidak keluar frame.
      let expr = String(Math.round(ft[ft.length - 1].x));
      for (let i = ft.length - 2; i >= 0; i--) {
        const t0 = ft[i].t, t1 = ft[i + 1].t, x0 = Math.round(ft[i].x), dx = Math.round(ft[i + 1].x) - x0, dt = t1 - t0;
        const lerp = dt > 0 ? '(' + x0 + '+(' + dx + ')*(t-' + t0 + ')/' + dt + ')' : String(x0);
        expr = 'if(lt(t,' + t1 + '),' + lerp + ',' + expr + ')';
      }
      expr = 'if(lt(t,' + ft[0].t + '),' + Math.round(ft[0].x) + ',' + expr + ')';
      filters.push("[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='min(max((" + expr + "),0),iw-ow)':y='(ih-oh)/2',scale=720:1280,format=yuv420p[v0]");
    } else {
      const focus = Number.isFinite(+o.focus) ? Math.min(1, Math.max(0, +o.focus)) : 0.5;
      filters.push("[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='(iw-ow)*" + focus + "':y='(ih-oh)/2',scale=720:1280,format=yuv420p[v0]");
    }
  } else if (bg === 'white') {
    filters.push('[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p[v0]');
  } else if (bg === 'blur') {
    filters.push('[0:v]split[a][b];[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=40[bg];[b]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v0]');
  } else {
    filters.push('[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p[v0]');
  }
  let last = 'v0';
  // CATATAN: transisi white flash antar hook SENGAJA tidak dipakai (hard cut).
  // Dua pendekatan sudah dicoba dan keduanya merusak render:
  //  1) Flash .ass {\p1} kotak putih → libass merusak Dialogue sesudahnya
  //     (judul + CTA hilang total).
  //  2) Filter fade out→in → fade=in mengeluarkan warna putih untuk SEMUA
  //     frame sebelum start-nya, jadi video jadi putih semua.
  // Hook tetap jalan (segmen + teks besar), hanya tanpa flash 0,1 detik.
  // Speaker-switch: crop time-varying diaplikasikan SETELAH concat (hook + klip
  // utama), SEBELUM subtitle — jadi subtitle/judul/CTA (.ass) tidak ikut ke-zoom.
  if (speakerExpr) {
    filters.push('[' + last + ']' + speakerExpr + '[vsp]');
    last = 'vsp';
  }
  if (!o.plainOnly && o.srtPath) {
    // File subtitle adalah .ass (buildAss) — gayanya sudah di dalam file
    // (PlayResX/Y 720x1280 + FontSize/MarginV/warna). Jangan pakai force_style
    // lagi (force_style + original_size terbukti tidak mengubah skala diuji).
    filters.push('[' + last + ']subtitles=' + escapeFilterValue(o.srtPath) + ':fontsdir=' + escapeFilterValue(o.fontsDir) + '[v1]');
    last = 'v1';
  }
  // Sensor kata (Koreksi Kata): bisukan audio di rentang kata yang di-sensor.
  // o.sensor = [{start, end}] waktu RELATIF output (sudah + hookTotal, dari
  // server). Audio: [outa] kalau hook (concat), kalau tidak 0:a mentah.
  // enable = between(t,a,b)+between(t,c,d) (OR) — satu filter volume cukup.
  const sensor = (Array.isArray(o.sensor) ? o.sensor : []).filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).slice(0, 20);
  let audioOut = null;
  if (sensor.length && o.audioCodec !== null && o.audioCodec !== false) {
    const expr = sensor.map(s => 'between(t,' + s.start + ',' + s.end + ')').join('+');
    filters.push((hook.length ? '[outa]' : '[0:a]') + "volume=enable='" + expr + "':volume=0[aout]");
    audioOut = '[aout]';
  }
  const title = o.plainOnly ? '' : cleanTitle(o.title, 120);
  // Judul tampil SEPANJANG klip (tanpa enable='lt(t,3)') — sebelumnya cuma 3 detik
  // pertama sehingga judul gampang kelewat / dikira tidak ada.
  const ts = o.titleStyle || {};
  const titleSize = Math.min(80, Math.max(28, +ts.size || 54));
  const titleY = Math.min(500, Math.max(0, +ts.y || 70));
  // Lebar baris judul DISESUAIKAN ukuran font (bukan fixed 24 karakter): pada font
  // besar, 24 karakter = ±720px sehingga judul kepotong layar. Lebar karakter
  // rata-rata ±0.6×fontsize, area teks ±680px → maxChars = 680/(0.6×size).
  // Hasil: judul selalu 1–3 baris, tiap baris muat di layar, posisi center.
  const titleMaxChars = Math.max(10, Math.floor(680 / (0.6 * titleSize)));
  // Judul 2 WARNA: pisahkan dengan `|` (contoh: "KITA HUJAT | MATIC KNALPOT BRONG!").
  // Bagian 1 (sebelum |) = warna 1 (default putih), bagian 2 (sesudah |) = warna 2 (default kuning).
  // Tanpa `|`, seluruh judul memakai warna 1.
  // Judul + CTA TIDAK lagi pakai drawtext (ffmpeg Pi tidak punya filter itu).
  // Keduanya dibakar lewat file .ass (buildAss: style Title1/Title2/Cta) + filter
  // subtitles — jadi judul + CTA selalu muncul, tidak lagi ke-drop fallback.
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[' + last + ']');
  const hasAudio = o.audioCodec !== null && o.audioCodec !== false;
  // Hook: audio sudah di-concat jadi [outa] (bukan 0:a mentah).
  // Sensor: audio sudah lewat filter volume -> [aout] (bukan [outa]/0:a).
  if (audioOut) args.push('-map', audioOut);
  else if (hook.length && hasAudio) args.push('-map', '[outa]');
  else if (hasAudio) args.push('-map', '0:a?');
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
  distributeWords, cueWords, normalizeCueWords,
  SUB_PRESETS, HOOK_PRESETS,
};
