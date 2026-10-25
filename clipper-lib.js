// Auto Clipper — fungsi murni (tanpa I/O jaringan / tanpa state server).
// Dipakai server.js dan diuji langsung lewat node tanpa memanggil YouTube.
// Semua nama file di sini sederhana (tanpa spasi) agar aman untuk filter ffmpeg.
'use strict';

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const TT_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com']);

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

// Validasi URL TikTok: tiktok.com / vt.tiktok.com / vm.tiktok.com.
function isTiktokUrl(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > 2000) return false;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return TT_HOSTS.has(u.hostname.toLowerCase());
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
// CATATAN: untuk PATH FILE, jangan pakai helper ini — pakai ffmpegFilterPath
// (escaping satu tahap ini TIDAK cukup untuk path Windows, lihat di bawah).
function escapeFilterValue(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

// Path file untuk filter ffmpeg (subtitles=..., fontsdir=...).
// Masalah Windows: argumen filter ffmpeg di-parse dalam DUA tahap (graph parser,
// lalu av_opt_set_from_string), dan tiap tahap memakan escape `\`. Path Windows
// mentah `D:\dir\file.ass` jadi rusak: `:` dibaca pemisah opsi, `\d` jadi `d`,
// dsb. → "Invalid argument" di Windows, padahal di Linux jalan (path Linux
// tidak punya `:` / `\`). Escaping satu tahap (escapeFilterValue) TIDAK cukup:
// setelah tahap ke-1, `D\:\\dir\\file.ass` jadi `D:\dir\file.ass`, lalu tahap
// ke-2 memakan `\` lagi → `D:dirfile.ass` (rusak).
// Perbaikan (bentuk kanonis ffmpeg, sesuai wiki HowToBurnSubtitlesIntoVideo):
//  1) `\` -> `/` (forward slash diterima ffmpeg di Windows, tidak perlu escape),
//  2) `'` -> `\'` (petik di dalam path),
//  3) `:` -> `\:` (titik dua drive letter selamat dari tahap parsing ke-2).
// Hasil DIBUNGKUS petik tunggal DI SITUS PEMAKAI (biar `\:` selamat dari tahap
// parsing ke-1 — isi kutip tidak dibelah pemisah opsi).
// Contoh: D:\hermes-vo\clipper-work\dzaky\job1\clip_0.ass
//   -> D\:/hermes-vo/clipper-work/dzaky/job1/clip_0.ass
//   -> di filter: subtitles='D\:/hermes-vo/clipper-work/dzaky/job1/clip_0.ass'
// Path Linux tidak berubah: /opt/docker/x/y.ass -> /opt/docker/x/y.ass.
function ffmpegFilterPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
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

// Dedupe pertahanan transkrip: buang cue duplikat bertimestamp identik
// (start+end sama, toleransi ±0,05 dtk) — kasus transkrip ganda bilingual
// (2 track caption YouTube EN+ID tergabung: 40 cue = 20 pasang timestamp
// identik). Bila teks beda -> simpan hanya yang sesuai bahasa yang dipilih
// (lang 'id' -> cue Indonesia, 'en' -> cue Inggris; auto (null) -> utamakan
// cue Indonesia, konsisten dengan jalur caption "id dulu"). Cue tanpa tag
// lang -> pakai urutan pertama. Teks sama -> 1 cue. Urutan/timestamp cue
// yang dipertahankan tidak diubah.
function dedupeTranscriptCues(cues, lang) {
  const list = Array.isArray(cues) ? cues.slice() : [];
  list.sort((a, b) => (+a.start || 0) - (+b.start || 0));
  const out = [];
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = lang === 'en' ? 'en' : 'id'; // auto (null) -> utamakan 'id'
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && Math.abs((+c.start || 0) - (+last.start || 0)) <= 0.05 && Math.abs((+c.end || 0) - (+last.end || 0)) <= 0.05) {
      // Timestamp identik: duplikat.
      if (norm(c.text) === norm(last.text)) continue; // teks sama -> 1 cue
      // Teks beda (bilingual): ganti hanya bila cue baru sesuai bahasa yang
      // dipilih dan cue yang disimpan bukan.
      if (c.lang === want && last.lang !== want) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

// Format detik -> "HH:MM:SS,mmm" untuk SRT.
function fmtSrt(sec) {
  // Sama seperti fmtAss: Infinity jangan bocor ke teks (lihat fmtAss).
  const total = Number.isFinite(+sec) ? Math.max(0, +sec) : 0;
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
    // (Dulu ada "hookTotal +" di sini — variabel lokal buildAss yang
    // kecopy-paste; buildSrt CRASH ReferenceError tiap dipanggil. Sesuai
    // doc di atas: waktu SRT relatif ke awal klip, tanpa offset judul.)
    const s = Math.max(0, c.start - start);
    const e = Math.max(0.2, Math.min(c.end - start, end - start));
    if (e <= s) continue;
    out.push(String(n++) + '\n' + fmtSrt(s) + ' --> ' + fmtSrt(e) + '\n' + c.text + '\n');
  }
  return out.join('\n');
}

// Format waktu ASS: H:MM:SS.CC (centidetik, 2 digit).
function fmtAss(t) {
  // Nilai tak-hingga (Infinity dari cue rusak) TIDAK boleh bocor ke teks
  // .ass ("Infinity:NaN:NaN.NaN" -> ffmpeg Invalid argument). NaN sudah
  // jadi 0 via || 0; Infinity lolos karena truthy — saring eksplisit.
  t = Number.isFinite(+t) ? Math.max(0, +t) : 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// Escape teks untuk field Dialogue ASS (yang sensitif: backslash, kurung kurawal, newline).
function escapeAssText(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N').replace(/\s+/g, ' ').trim();
}

// Bangun file .ass (bukan .srt) untuk subtitle. PlayResX/PlayResY = resolusi
// output (ov.outW/ov.outH, default 720x1280; 1080p = 1080x1920).
// filter `subtitles` + force_style/original_size TIDAK bisa dipercaya untuk skala
// (diuji: font tetap kegedean + posisi ngaco meski original_size=720x1280).
// Dengan .ass, libass memakai PlayRes dari file sehingga FontSize/MarginV pas.
// Daftar family font yang BOLEH dipakai .ass (harus ada file-nya di
// public/fonts — libass me-resolve via fontsdir clipFontsDir()).
// Semua font Flufclip (open-source, Google Fonts / OFL) + 2 font lama.
// - Hagrid (bukan Google Fonts) -> padanan open-source: Archivo Black.
// - KomikaAxis (bukan Google Fonts) -> padanan open-source: Comic Neue.
// - Montserrat-Black -> family "Montserrat Black" (alias di file statis).
// - Roboto-Black -> family file-nya "Roboto" (bukan "Roboto Black"), jadi
//   preset Roboto-Black memakai FontName "Roboto" + Bold (700) — .ass tidak
//   punya selektor bobot 900; Black 900 tidak bisa dipilih via nama family.
// - Font variabel (JetBrains Mono, Oswald, Playfair Display, Plus Jakarta
//   Sans) -> family + Regular (400); Bold=-1 memakai instance bold-nya.
const CLIP_FONT_FAMILIES = ['Anton', 'Archivo Black', 'Bangers', 'Bebas Neue', 'Comic Neue', 'DejaVu Sans', 'JetBrains Mono', 'Lato', 'Lato Black', 'Liberation Sans', 'Luckiest Guy', 'Montserrat', 'Montserrat Black', 'Montserrat ExtraBold', 'Oswald', 'Permanent Marker', 'Playfair Display', 'Plus Jakarta Sans', 'Poppins', 'Poppins Black', 'Righteous', 'Roboto', 'Russo One'];
const clipFontOk = (f) => CLIP_FONT_FAMILIES.includes(f) ? f : null;
// Override gaya per-klip (Fase 13, Item 7-10 — panel ala ClipperStudio:
// Teks / Kata yang diucapkan / Outline & bayangan / Kotak latar /
// Tampilan & posisi / Lanjutan). Disanitasi ketat: hanya field dikenal
// dengan nilai terklamp yang lolos; selain itu dibuang.
function sanitizeStyleOv(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = {};
  const hex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : undefined;
  const num = (v, lo, hi) => { const n = +v; return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? Math.min(hi, Math.max(lo, n)) : undefined; };
  if (clipFontOk(raw.font)) o.font = raw.font;
  const fs = num(raw.fontSize, 20, 110); if (fs !== undefined) o.fontSize = Math.round(fs);
  if (['asis', 'upper', 'lower'].includes(raw.capsMode)) o.capsMode = raw.capsMode;
  if (hex(raw.color)) o.color = hex(raw.color);
  if (['warna', 'kotak', 'membesar', 'glow', 'karaoke'].includes(raw.activeMode)) o.activeMode = raw.activeMode;
  if (hex(raw.activeColor)) o.activeColor = hex(raw.activeColor);
  const ol = num(raw.outline, 0, 12); if (ol !== undefined) o.outline = ol;
  if (hex(raw.outlineColor)) o.outlineColor = hex(raw.outlineColor);
  const sh = num(raw.shadow, 0, 10); if (sh !== undefined) o.shadow = sh;
  const ba = num(raw.boxAlpha, 0, 100); if (ba !== undefined) o.boxAlpha = Math.round(ba);
  if (hex(raw.backColor)) o.backColor = hex(raw.backColor);
  if (['words', 'sentence'].includes(raw.wordsMode)) o.wordsMode = raw.wordsMode;
  const mw = num(raw.maxWords, 1, 8); if (mw !== undefined) o.maxWords = Math.round(mw);
  if ([1, 2, 3].includes(+raw.align)) o.align = +raw.align;
  const spc = num(raw.spacing, -2, 10); if (spc !== undefined) o.spacing = spc;
  const ls = num(raw.lineSpacing, -50, 100); if (ls !== undefined) o.lineSpacing = Math.round(ls);
  const ml = num(raw.marginLR, 0, 200); if (ml !== undefined) o.marginLR = Math.round(ml);
  const mt = num(raw.marginTB, 0, 200); if (mt !== undefined) o.marginTB = Math.round(mt);
  return Object.keys(o).length ? o : undefined;
}
// Preset Gaya Subtitle + Judul Hook — daftar editor Klipaja (observasi
// langsung, 2026-10-19): 13 gaya subtitle (12 terobservasi + Pop
// best-effort dari nama), 15 gaya judul (10 terobservasi + 5 best-effort
// dari nama: Keramat, Notif Chat, Glitch, Ketik, Boom — di Klipaja
// terkunci top-up, di sini GRATIS). Di kita SEMUA GRATIS (tanpa paywall).
// Subtitle: caps=true = HURUF BESAR SEMUA (Klipaja: karaoke/casual/kinetik/
// polos/pop/default/classic); caps=false = kalimat biasa (pill/kertas/
// kombo/puisi/chat/simpel/pantul/bebas). activeColor = warna kata yang
// sedang diucapin. box=true = teks di atas kotak, boxColor = warna kotak.
// maxWords = batas kata per chunk (Kinetik/Pantul = 1 kata, Kombo/Pop = 2,
// sisanya 4). pill = kata aktif di dalam kapsul pill. highlight = sorotan
// stabilo di belakang kata aktif. vertical = kata tersusun vertikal (Puisi).
// bubble = gelembung chat. freeKinetic = kata sebelumnya kecil memudar di
// atas, kata berjalan SANGAT BESAR. singleWord = 1 kata per tampilan.
// underline = garis bawah aksen (Pantul: pink-merah).
// anim: 'pop' = membesar 80->100%; 'bounce' = 70->115->100%; 'fade' = fade
// in/out; 'rotate' = miring settle; 'slidepop' = geser+pop.
// SUMBER TUNGGAL PRESET (brief Dzaky 22 Okt): data preset hidup di
// presets.json di folder yang sama (server + preview JASSUB membaca file
// yang sama). Blok darurat di bawah HANYA dipakai bila presets.json hilang/
// rusak — isinya subset kecil agar render tidak pernah mati total.
const _PRESET_JSON = (() => {
  try {
    const fs = require('fs'), path = require('path');
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'presets.json'), 'utf8'));
    if (j && j.subtitles && j.hooks) return j;
  } catch (e) {}
  return null;
})();
const SUB_PRESETS = _PRESET_JSON ? _PRESET_JSON.subtitles : {
  karaoke: { label: 'Karaoke', emoji: '🎤', font: 'Montserrat', size: 65, color: '#FFFFFF', activeColor: '#FFCA28', bold: true, karaoke: true, anim: 'pop', box: true, boxColor: '#000000', caps: true, glow: { bord: 8, blur: 8 }, popFrom: 115, popTo: 106 },
  default: { label: 'Default', emoji: '📝', font: 'Montserrat', size: 78, color: '#FFFFFF', activeColor: '#22C55E', bold: true, karaoke: true, anim: 'pop', caps: true },
  simpel: { label: 'Simpel', emoji: '✨', font: 'Montserrat', size: 48, color: '#FFFFFF', bold: true, anim: 'fade', caps: false },
};
// Font subtitle: SEMUA preset pakai family "Montserrat" + Bold=1, KECUALI Puisi
// (Liberation Sans italic) dan Simpel ("Montserrat" + Bold=0, ringan plain).
// Alasan: libass tanpa fontconfig (ffmpeg static Pi) tidak me-resolve family
// "Montserrat ExtraBold" — nama family di file font OFL adalah "Montserrat"
// (ExtraBold = style, bukan family) — sehingga .ass jatuh ke fallback DejaVu.
// Family "Montserrat" + Bold me-resolve di PC (fontconfig) maupun Pi
// (scan fontsdir) ke Montserrat-Bold. Bobot ExtraBold vs Bold = perbedaan
// kecil, jauh lebih baik daripada fallback DejaVu. Folder font dicari oleh
// clipFontsDir() di server.js (harus berisi file Montserrat).
// Ukuran subtitle di atas sudah diskala x52/32 (dibulatkan ke bawah) dari
// nilai awal, karena ukuran terukur Klipaja: Casual ~52px pada slider 100%
// (bukan 32). Mini-preview editor Klipaja menunjukkan ke-12 gaya pada skala
// visual yang setara, jadi semua preset ikut faktor yang sama.
// Gaya judul hook (15 terobservasi + Classic Flufclip). Statis = anim ''
// (tanpa toggle Animasi di UI); beranimasi = anim terisi (toggle Animasi
// tampil di UI). boxColor = warna kotak; align 2 = bawah-tengah (Sinema);
// letterbox = bar hitam atas-bawah (Layar Lebar). gradient = gradasi gelap
// bawah (Sinema). holdSub = subtitle ditahan selama judul tampil (Sinema,
// Layar Lebar). quote = ikon kutip "66" kuning (Kutipan Terang). bars =
// baris judul masing-masing di atas bar berwarna (Slide Dinamis).
// border = bingkai hitam tebal di sekeliling kotak (Gulung, Stiker).
// rotate = rotasi kartu derajat (Stiker -4, Catatan +2). underline = garis
// bawah aksen (Layar Lebar: emas; Berita: biru tua). badge = lencana merah
// (Berita). highlight = sorotan stabilo di baris ke-2 (Stabilo: pink).
// tape = strip selotip di atas (Catatan). wavy = garis bawah merah
// bergelombang (Catatan). alignLeft = teks rata kiri (Berita).
const HOOK_PRESETS = _PRESET_JSON ? _PRESET_JSON.hooks : {
  kartu: { label: 'Kartu', emoji: '🃏', font: 'Montserrat', size: 54, color1: '#000000', box: true, boxColor: '#FFFFFF', bold: true, anim: '' },
  sinema: { label: 'Sinema', emoji: '🎬', font: 'Montserrat', size: 60, color1: '#FFFFFF', bold: true, align: 2, y: 100, anim: '', gradient: true, holdSub: true },
};
function animTag(a) {
  if (a === 'pop') return '{\\fscx80\\fscy80\\t(0,200,\\fscx100\\fscy100)}';
  if (a === 'pop110') return '{\\fscx110\\fscy110\\t(0,150,\\fscx100\\fscy100)}{\\fad(80,80)}';
  if (a === 'popcolor') return '{\\fscx120\\fscy120\\t(0,150,\\fscx100\\fscy100)}';
  if (a === 'bounce') return '{\\fscx70\\fscy70\\t(0,150,\\fscx115\\fscy115)\\t(150,300,\\fscx100\\fscy100)}';
  if (a === 'boom') return '{\\fscx150\\fscy150\\fad(100,0)\\t(0,300,\\fscx100\\fscy100)}';
  if (a === 'zoomfade') return '{\\fscx90\\fscy90\\fad(150,100)\\t(0,300,\\fscx100\\fscy100)}';
  if (a === 'zoomfade95') return '{\\fscx95\\fscy95\\fad(150,100)\\t(0,300,\\fscx100\\fscy100)}';
  if (a === 'fade') return '{\\fad(150,100)}';
  if (a === 'fadeslide') return '{\\fad(150,100)}';
  if (a === 'flicker') return '{\\fad(100,100)\\t(0,100,\\shad2)\\t(100,200,\\shad0)\\t(200,300,\\shad2)\\t(300,400,\\shad0)}';
  if (a === 'rotate') return '{\\frz-4\\t(0,300,\\frz0)}';
  if (a === 'noterotate') return '{\\fad(150,100)\\frz2\\t(0,300,\\frz0)}';
  if (a === 'slidepop') return '{\\fscx85\\fscy85\\t(0,200,\\fscx100\\fscy100)}{\\fad(100,100)}';
  if (a === 'slideuppop') return '{\\fscx85\\fscy85\\t(0,300,\\fscx100\\fscy100)}{\\fad(100,100)}';
  if (a === 'flyin') return '{\\fscx80\\fscy80\\t(0,200,\\fscx100\\fscy100)}{\\fad(80,80)}';
  if (a === 'sweep') return '{\\fad(100,100)}';
  if (a === 'glitch') return '{\\fad(100,100)}';
  if (a === 'type') return '';
  return '';
}
// Animasi KATA AKTIF per gaya subtitle (jalur karaoke: kata yang sedang
// diucapin saja, bukan seluruh frasa). Karaoke + Casual WAJIB persis
// wordPopInner lama (tes + ground truth Klipaja: pop 115% -> 100%);
// gaya lain = pop + ciri khasnya (tanpa \move — posisi sudah benar via
// MarginV; \move dengan koordinat absolut rawan salah tempat).
// Return: isi dalam kurung kurawal setelah \c (tanpa { }).
function subWordAnimInner(sp) {
  const a = (sp && sp.anim) || '';
  const pop = (sp && Number.isFinite(+sp.popFrom) && Number.isFinite(+sp.popTo))
    ? '\\t(0,150,\\fscx' + Math.round(+sp.popFrom) + '\\fscy' + Math.round(+sp.popFrom) + ')\\t(150,300,\\fscx' + Math.round(+sp.popTo) + '\\fscy' + Math.round(+sp.popTo) + ')'
    : '\\t(0,150,\\fscx115\\fscy115)\\t(150,300,\\fscx100\\fscy100)';
  if (a === 'pop110') return '\\fscx110\\fscy110' + pop; // Pill: pop + scale 110% -> 100%
  if (a === 'flyin') return '\\fscx80\\fscy80' + pop; // Kinetik: fly-in = mulai kecil 80% + pop
  if (a === 'fadeslide') return pop; // Kertas: pop kata aktif (tag persis seperti lama — test_boxrect mengunci itu); fade-nya ada di kotak subtitle (subAnimTag \fad via animTag 'fadeslide' -> fadOf di boxRectEvent)
  if (a === 'popcolor') return '\\fscx120\\fscy120' + pop; // Kombo: pop lebih besar + ganti warna (via karaokeSec)
  if (a === 'bounce') return '\\t(0,100,\\fscy80)\\t(100,200,\\fscy110)\\t(200,300,\\fscy100)' + pop; // Pantul: bounce 80% -> 110% -> 100%
  if (a === 'rotate') return '\\frz3\\t(0,300,\\frz0)' + pop; // Bebas: pop + miring 3 derajat lalu lurus
  return pop; // Karaoke / Casual / default: pop murni
}

// Buang awalan spasi + "-" / "—" / "–" + spasi opsional (penanda ganti
// pembicara Whisper) dari awal teks — "-YOH, BRO." -> "YOH, BRO.".
// Whisper sering mengeluarkan teks segmen berawalan spasi (" -LATANG,"),
// jadi spasi depan ikut dibuang (^\s*) agar "-" tidak lolos.
// "-" di tengah kalimat ("tiba-tiba") TIDAK dibuang (regex hanya jangkar ^).
const stripLeadDash = (t) => String(t || '').replace(/^\s*[-—–]\s*/, '');
// (Helper B-roll Pexels dihapus — sumber B-roll kini upload manual user,
// bukan Pexels API.)

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
  // Buang prefix "-" ganti pembicara SEBELUM bagi kata (biar "-" tidak
  // jadi token sendiri yang mencuri slot waktu).
  const raw = stripLeadDash(String(cue.text || '')).replace(/\*([^*\s]+)\*/g, '\u0001$1\u0002').replace(/\*/g, '');
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
  let words;
  if (ok) {
    // Jaga urutan waktu + flag sensor/keyword/edit/disabled/warna kata dari
    // Koreksi Kata (edit = teks perbaikan, disabled = teks hilang,
    // wordColor = warna kata paksa, keywordMode = auto/yes/no).
    words = ws.map(w => ({ text: String(w.text).trim(), start: +w.start, end: +w.end, sensor: !!w.sensor, keyword: !!w.keyword, edit: w.edit !== undefined ? String(w.edit) : undefined, disabled: !!w.disabled, wordColor: /^#[0-9a-fA-F]{6}$/.test(String(w.wordColor || '')) ? String(w.wordColor) : undefined, keywordMode: ['auto', 'yes', 'no'].includes(w.keywordMode) ? w.keywordMode : undefined }))
      .sort((a, b) => a.start - b.start);
  } else {
    words = distributeWords(cue);
  }
  // Buang prefix "-" ganti pembicara dari kata pertama (lihat stripLeadDash).
  if (words.length) {
    const t0 = stripLeadDash(words[0].text);
    if (t0) words[0] = { ...words[0], text: t0 };
    else words = words.slice(1);
  }
  return words;
}
// Normalisasi satu cue: selalu bawa words (biar job.json / render / preview
// konsisten — cue dari transkrip YouTube / edit teks ikut dapat kata).
function normalizeCueWords(cue) {
  if (!cue || typeof cue !== 'object') return cue;
  return { ...cue, words: cueWords(cue) };
}

// --- Subtitle model Klipaja: de-window + chunking + karaoke ---
// Strip tanda baca AKHIR kata untuk TAMPILAN subtitle (Klipaja: tanpa tanda
// baca — "nah." -> "NAH", "tiba-tiba" tetap "TIBA-TIBA"). Batas kalimat/
// frasa tetap dibaca dari teks mentah (sebelum strip).
function stripDisplayPunct(t) {
  return String(t || '').replace(/[.,!?…,:;'"”]+$/g, '').trim();
}

// De-window caption YouTube (rolling window / jendela geser): caption
// YouTube menampilkan jendela geser (frasa sebelumnya + frasa baru),
// sehingga kata yang sudah diucapkan muncul lagi di cue berikutnya —
// subtitle terasa TELAT/mengulang + hilang mendadak pas cue abis (reset
// ke 1 kata cue baru). De-window: buang cue mikro (<=20ms, artefak batas
// jendela) + buang kata yang sudah muncul di cue sebelumnya (overlap) ->
// sisa kata BARU saja. Kata baru dipetakan ke AKHIR jendela cue-nya
// (jendela geser berakhir saat kata baru diucapkan) — BUKAN dibagi merata
// se-cue. Cue dengan timestamp kata ASLI (Groq/Whisper, cue.words terisi)
// BUKAN rolling window -> dilewati apa adanya. Cue lama di job.json
// (20 cue rolling) ikut ter-de-window saat dibaca (buildAss + preview),
// jadi proyek lama tidak perlu Analisis ulang.
function dewindowCues(cues) {
  const list = (Array.isArray(cues) ? cues : []).filter(c => c && typeof c === 'object');
  if (!list.length) return [];
  const sorted = list.slice().sort((a, b) => (+a.start || 0) - (+b.start || 0));
  const hasRealWords = (c) => Array.isArray(c.words) && c.words.length > 0;
  const toksOf = (c) => String(c.text || '').split(/\s+/).filter(Boolean);
  // Pass 1: cue mikro (<=20ms) — buang, tapi selamatkan kata unik (yang
  // tidak ada di cue sebelum/sesudahnya) ke cue berikutnya (biar tidak ada
  // kata yang hilang).
  const yt = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (hasRealWords(c)) { yt.push(c); continue; }
    const dur = (+c.end || 0) - (+c.start || 0);
    if (dur > 0.02) { yt.push(c); continue; }
    const toks = toksOf(c);
    const prevSet = new Set(i > 0 ? toksOf(sorted[i - 1]) : []);
    const nextSet = new Set(i + 1 < sorted.length ? toksOf(sorted[i + 1]) : []);
    const unique = toks.filter(t => !prevSet.has(t) && !nextSet.has(t));
    if (unique.length && i + 1 < sorted.length) {
      const nxt = sorted[i + 1];
      sorted[i + 1] = { ...nxt, start: Math.min(+nxt.start || 0, +c.start || 0),
        text: unique.join(' ') + (String(nxt.text || '').trim() ? ' ' + String(nxt.text || '').trim() : '') };
    } else if (unique.length) {
      const prev = yt[yt.length - 1];
      if (prev) yt[yt.length - 1] = { ...prev, end: Math.max(+prev.end || 0, +c.end || 0),
        text: String(prev.text || '').trim() + ' ' + unique.join(' ') };
    }
    // selain itu: mikro artefak -> buang.
  }
  if (!yt.length) return [];
  // Pre-pass cue pertama: cue pertama (tanpa cue sebelumnya) bisa berisi
  // kata "lama" (diucapkan SEBELUM interval cue pertama — interval line
  // pertama hilang dari web VTT) + kata "baru". Bila suffix cue pertama
  // (>=4 kata) == prefix cue kedua, prefix-nya kata lama -> buang, sisa
  // kata baru menempati interval cue pertama. Tanpa ini, chunk pertama
  // telat ~1 dtk (kata lama + kata baru dijejalkan ke interval cue pertama).
  if (yt.length >= 2) {
    const f0 = yt[0], f1 = yt[1];
    if (!hasRealWords(f0) && !hasRealWords(f1)) {
      const t1 = toksOf(f0), t2 = toksOf(f1);
      let k = Math.min(t1.length, t2.length);
      while (k >= 4) {
        let same = true;
        for (let i = 0; i < k; i++) if (t1[t1.length - k + i] !== t2[i]) { same = false; break; }
        if (same) break;
        k--;
      }
      if (k >= 4 && k < t1.length) yt[0] = { ...f0, text: t1.slice(t1.length - k).join(' ') };
    }
  }
  // Pass 2: de-overlap antar cue YouTube berurutan.
  const out = [];
  let prevRaw = null; // kata mentah cue sebelumnya (jendela geser dibangun dari teks mentah)
  for (const c of yt) {
    if (hasRealWords(c)) { out.push(c); prevRaw = toksOf(c); continue; }
    const toks = toksOf(c);
    // Cue atomik vs jendela geser: cue atomik (web VTT) TIDAK tumpang
    // tindih waktu dengan cue sebelumnya (start >= end cue sebelumnya) —
    // intervalnya = interval ucapan frasa baru itu sendiri. Jendela geser
    // (VTT 6 jendela) TUMPANG TINDIH waktu. Tail-shift hanya benar untuk
    // jendela geser (kata baru di AKHIR jendela); untuk cue atomik,
    // tail-shift menggeser kata baru ke akhir interval -> subtitle telat
    // konstan ~1-2 dtk (bug sync: terbukti pada video 9xo4pOaTsxY).
    const prevEnd = out.length ? (+out[out.length - 1].end || 0) : -Infinity;
    const overlapsPrev = (+c.start || 0) < prevEnd;
    let dropRanges = [];
    if (prevRaw && prevRaw.length && toks.length) {
      // (a) suffix-prefix: akhir cue sebelumnya == awal cue ini (jendela geser standar).
      let k = Math.min(prevRaw.length, toks.length);
      while (k > 0) {
        let same = true;
        for (let i = 0; i < k; i++) if (prevRaw[prevRaw.length - k + i] !== toks[i]) { same = false; break; }
        if (same) break;
        k--;
      }
      if (k > 0) dropRanges = [[0, k]];
      // (b) overlap bergeser — HANYA untuk jendela tumpang tindih, dan
      // butuh >= 4 kata. Pola "[kata baru] + [overlap] + [kata baru]" pada
      // jendela geser. Kecocokan 2 kata (mis. "ada yang") pada cue atomik
      // hampir selalu pengulangan alami ucapan, BUKAN duplikat jendela —
      // menghapusnya menghilangkan kata asli + memicu tail-shift.
      else if (overlapsPrev) {
        for (let off = 1; off <= 2 && off < toks.length; off++) {
          let best = 0;
          const maxLen = Math.min(prevRaw.length, toks.length - off);
          for (let len = maxLen; len >= 4; len--) {
            let same = true;
            for (let i = 0; i < len; i++) if (prevRaw[prevRaw.length - len + i] !== toks[off + i]) { same = false; break; }
            if (same) { best = len; break; }
          }
          if (best >= 4) { dropRanges = [[off, off + best]]; break; }
        }
      }
    }
    const kept = toks.filter((_, i) => !dropRanges.some(([s, e]) => i >= s && i < e));
    prevRaw = toks; // jendela geser dibangun dari teks MENTAH
    if (!kept.length) continue; // cue ini seluruhnya overlap -> buang
    // Cue atomik: kata baru menempati SELURUH interval (jangan tail-shift).
    if (!overlapsPrev) {
      out.push({ ...c, text: kept.join(' ') });
      continue;
    }
    // Tail timing (jendela geser saja): kata baru menempati fraksi (M/N)
    // terakhir jendela cue.
    const N = toks.length, M = kept.length;
    const cueDur = (+c.end || 0) - (+c.start || 0);
    let tailDur = cueDur * (M / N);
    if (tailDur / M > 0.8) tailDur = M * 0.8; // maks 0,8 dtk/kata
    // bila tailDur/M < 0,15 -> rapatkan (ikuti tailDur apa adanya).
    const newStart = (+c.end || 0) - tailDur;
    // Jangan tumpang tindih dengan tail cue sebelumnya (biar chunk tidak bertumpuk).
    const clampedStart = Math.max(newStart, prevEnd);
    const finalStart = clampedStart < (+c.end || 0) ? clampedStart : Math.max(+c.start || 0, (+c.end || 0) - M * 0.05);
    out.push({ ...c, start: Math.round(finalStart * 1000) / 1000, text: kept.join(' ') });
  }
  return out;
}

// Chunk kata jadi chunk Klipaja: maks 4 kata, maks 2 baris, maks ~2,5 dtk.
// Pecah di akhir kalimat / koma (jeda alami, grup >=3 kata) / batas kata /
// batas durasi. Baris: 4 kata = 2+2; 3 kata = 2+1 atau 1+2 (lebih seimbang
// panjang karakternya); 1-2 kata = 1 baris. Kata sensor / hanya-tanda-baca
// tetap menempati slot waktu (tidak tampil) — timing kata sesudahnya pas.
// Mengembalikan [{words, lines: [[w...], [w...]], start, end}].
function chunkSubtitleWords(words, maxLineChars, stripPunct, maxWords) {
  const maxW = Math.max(1, Math.min(12, Number.isFinite(+maxWords) ? Math.round(+maxWords) : 4)); // 12 = mode "satu kalimat" (Fase 13 Item 10)
  const list = (Array.isArray(words) ? words : []).filter(w => w && w.text !== undefined && String(w.text || '').trim());
  if (!list.length) return [];
  // Urut waktu. Timestamp STT dipakai APA ADANYA tanpa offset/penggeseran
  // (prinsip fix sync 19:26): karaoke mengikuti awal tiap kata persis seperti
  // STT. Guard end > start hanya untuk keamanan (tidak menggeser start).
  // (Dulu ada enforcement monotonik start >= end kata sebelumnya — itu
  // menggeser SEMUA kata maju sebesar overlap (terukur +0,10 dtk pada
  // overlap sistematis Whisper) sehingga highlight telat konstan.)
  const ws = list.slice().sort((a, b) => (+a.start || 0) - (+b.start || 0)).map((w) => {
    const s = +w.start || 0;
    const e = Math.max(+w.end || 0, s + 0.01);
    return { ...w, start: s, end: e };
  });
  const dispLen = (w) => (stripPunct === false ? String(w.text || '') : stripDisplayPunct(w.text)).length;
  const isSentEnd = (w) => /[.!?…]["”']?$/.test(String(w.text || ''));
  const isClauseEnd = (w) => /[,;:]["”']?$/.test(String(w.text || ''));
  // Pecah kasar: kalimat / klausa / maks maxWords kata. (Durasi ditangani di bawah:
  // chunk 4 kata pada laju normal ~0,5-0,8 dtk/kata boleh > 2,5 dtk sedikit —
  // yang dipecah hanya chunk yang mengandung JEDA atau kata sangat panjang.)
  const raw = [];
  let cur = [];
  const flush = () => { if (cur.length) raw.push(cur); cur = []; };
  for (const w of ws) {
    cur.push(w);
    if (isSentEnd(w) || (isClauseEnd(w) && cur.length >= 3) || cur.length >= maxW) flush();
  }
  flush();
  // Pecah lagi chunk > ~2,5 dtk HANYA bila ada titik pecah alami: jeda antar
  // kata >= 0,5 dtk (di celah terbesar) atau satu kata > 1,5 dtk. Tanpa titik
  // pecah, chunk dipertahankan utuh (kata-kata rapat, laju normal).
  const chunks = [];
  for (const g of raw) {
    let part = g;
    while (part.length > 1 && (+part[part.length - 1].end || 0) - (+part[0].start || 0) > 2.5) {
      let bestIdx = 1, bestGap = -1;
      for (let i = 1; i < part.length; i++) {
        const gap = (+part[i].start || 0) - (+part[i - 1].end || 0);
        if (gap > bestGap) { bestGap = gap; bestIdx = i; }
      }
      const hasLongWord = part.some(w => (+w.end || 0) - (+w.start || 0) > 1.5);
      if (bestGap < 0.5 && !hasLongWord) break;
      chunks.push(part.slice(0, bestIdx));
      part = part.slice(bestIdx);
    }
    chunks.push(part);
  }
  // Baris: 2+2 / 2+1 / 1+2 / 1 baris.
  const maxCpl = Math.max(8, +maxLineChars || 24);
  return chunks.map(group => {
    const n = group.length;
    let split = 0; // jumlah kata baris 1 (0 = 1 baris)
    if (n === 4) split = 2;
    else if (n === 3) {
      const l21 = Math.abs((dispLen(group[0]) + 1 + dispLen(group[1])) - dispLen(group[2]));
      const l12 = Math.abs(dispLen(group[0]) - (dispLen(group[1]) + 1 + dispLen(group[2])));
      split = l21 <= l12 ? 2 : 1;
    }
    let lines = split > 0 ? [group.slice(0, split), group.slice(split)] : [group];
    // Guard lebar: bila baris terpanjang meluber, coba pecahan lain (tetap 2 baris).
    const lineChars = (ln) => ln.reduce((a, w, i) => a + (i ? 1 : 0) + dispLen(w), 0);
    if (lines.length === 2 && Math.max(...lines.map(lineChars)) > maxCpl && n >= 3) {
      const alts = n === 4 ? [1, 3] : [split === 2 ? 1 : 2];
      for (const a of alts) {
        const cand = [group.slice(0, a), group.slice(a)];
        if (Math.max(...cand.map(lineChars)) <= maxCpl) { lines = cand; break; }
      }
    }
    return { words: group, lines, start: +group[0].start || 0, end: +group[group.length - 1].end || 0 };
  });
}

function buildAss(cues, start, end, subStyle, overlay) {
  const ss = subStyle || {};
  const ov = overlay || {};
  // PlayRes ASS dikunci 1080x1920 (brief satu-sumber 22 Okt): ASS selalu
  // ditulis pada resolusi acuan yang sama untuk preview (JASSUB) dan render,
  // berapa pun resolusi output video — libass menskala ASS ke frame video,
  // jadi geometri relatif identik di 720p maupun 1080p. ov.outW/outH TIDAK
  // lagi mengubah PlayRes. S = 1,5 tetap (semua ukuran preset berbasis 720).
  const OUT_W = (_PRESET_JSON && _PRESET_JSON.playRes && +_PRESET_JSON.playRes.x) || 1080;
  const OUT_H = (_PRESET_JSON && _PRESET_JSON.playRes && +_PRESET_JSON.playRes.y) || 1920;
  const S = OUT_W / 720;
  const CX = OUT_W / 2;
  // Preset dari Detail (ov.subPreset / ov.hookPreset) — override nilai manual.
  // DEFAULT judul = 'kartu' bila preset tidak dispesifikasikan (ov.hookPreset
  // undefined/null) — Kartu Klipaja (kartu putih + teks hitam Montserrat,
  // atas ~56%). 'tanpa' yang EKSPLISIT tetap dihormati (tanpa gaya/kartu).
  // sp/hp DISALIN (bukan mutasi SUB_PRESETS/HOOK_PRESETS — objek bersama).
  const sp = { ...(SUB_PRESETS[ov.subPreset] || {}) };
  const hp = { ...((ov.hookPreset === undefined || ov.hookPreset === null) ? (HOOK_PRESETS.kartu || {}) : (HOOK_PRESETS[ov.hookPreset] || {})) };
  // Override gaya per-klip (Fase 13 Item 7-10): menimpa preset SETELAH
  // preset dipilih — font/ukuran/warna/caps/mode kata aktif/jumlah kata.
  // (Outline/kotak/bayangan/margin dibaca langsung dari `sov` di bawah.)
  const sov = sanitizeStyleOv(ov.styleOv);
  if (sov) {
    if (sov.font) sp.font = sov.font;
    if (sov.fontSize) sp.size = sov.fontSize;
    if (sov.color) sp.color = sov.color;
    if (sov.activeColor) sp.activeColor = sov.activeColor;
    if (sov.capsMode) { sp.caps = sov.capsMode === 'upper'; sp.__capsLower = sov.capsMode === 'lower'; }
    if (sov.wordsMode === 'sentence') sp.maxWords = 12; else if (sov.wordsMode === 'words') sp.maxWords = 4;
    if (sov.maxWords) sp.maxWords = sov.maxWords;
  }
  // Warna subtitle = FULL dari preset gaya (keputusan Dzaky 21 Okt:
  // pemilih warna manual dihapus — "warna full dari preset"). Override
  // warna per-preset yang dulu ada di Edit (Pill/Kinetik/Kertas) dicabut;
  // field lama di kandidat lama diabaikan.
  // Toggle Animasi judul (Edit, tab Judul): false = judul STATIS (tanpa
  // animasi masuk) — hp.anim dikosongkan, titleAnimTag ikut kosong, dan
  // cabang animasi di event teks tidak kepilih (tag = '').
  if (ov.titleAnim === false) hp.anim = '';
  const subAnimTag = animTag(sp.anim), titleAnimTag = animTag(hp.anim);
  // Ukuran subtitle: slider "Otomatis (100%)" (ov.subSizePercent) mengalikan
  // ukuran dasar preset/manual.
  const subBase = Math.min(110, Math.max(16, +(sp.size || ss.size) || 48));
  const size = Math.round(Math.min(140, Math.max(12, Math.round(subBase * (Number.isFinite(+ov.subSizePercent) ? (+ov.subSizePercent || 100) / 100 : 1)))) * S);
  // Posisi vertikal subtitle: slider persen editor = posisi ATAS blok subtitle
  // (% tinggi frame; ground truth Klipaja: slider 70% -> atas blok ~67%).
  // Alignment 2 = bawah-tengah, jadi MarginV per-event = 1280 - atasPx -
  // blockHeight (blockHeight = jumlah baris x lineH). Style Default MarginV =
  // fallback estimasi 2 baris. Tanpa persen: pakai marginV lama (px).
  const subTopPx = Number.isFinite(+ov.subYPercent) ? Math.round((+ov.subYPercent) / 100 * OUT_H) : null;
  const lineH = Math.round(size * (1.25 + ((sov && sov.lineSpacing) || 0) / 100));
  // Subtitle terpusat di sambungan (layout Split): ov.subCenterY = y TENGAH
  // blok subtitle (misal 640 = seam Split). MarginV per-event dihitung agar
  // blok terpusat di subCenterY (bukan mulai di subCenterY). Mengalahkan
  // subYPercent bila keduanya diisi. Guard judul memakai atas blok
  // ≈ subCenterY - lineH (perkiraan 2 baris).
  const subCenterY = Number.isFinite(+ov.subCenterY) ? +ov.subCenterY : null;
  const subMarginVFor = (lines) => subCenterY !== null ? Math.min(OUT_H - 80, Math.max(0, Math.round(OUT_H - subCenterY - (Math.max(1, lines) * lineH) / 2)))
    : subTopPx === null ? 0 : Math.min(OUT_H - 80, Math.max(0, OUT_H - subTopPx - Math.max(1, lines) * lineH));
  const guardSubTop = subCenterY !== null ? subCenterY - lineH : subTopPx;
  let marginV = (subCenterY !== null || subTopPx !== null) ? subMarginVFor(2) : Math.min(OUT_H - 80, Math.max(0, Math.round((+ss.marginV || 90) * S)));
  // Ruang atas-bawah (Item 10): hanya berlaku saat posisi margin bebas
  // (tanpa persen/sambungan) — persen & sambungan sudah presisi.
  if (sov && sov.marginTB && subTopPx === null && subCenterY === null) marginV = Math.min(OUT_H - 80, Math.max(0, marginV + Math.round(sov.marginTB * S)));
  const color = /^#[0-9a-fA-F]{6}$/.test(String(sp.color || ss.color || '')) ? (sp.color || ss.color) : '#FFFFFF';
  const bold = (sp.bold !== undefined ? sp.bold : ss.bold) === false ? 0 : -1;
  const subItalic = (sp.italic || ss.italic || sp.slant) ? -1 : 0;
  // Font subtitle: pilihan per-klip (Edit, ov.subFontPick) > preset > global.
  // Hanya family di CLIP_FONT_FAMILIES yang dipakai (sisanya -> DejaVu Sans).
  // Kertas + font "Ketik" = JetBrains Mono (gaya mesin ketik).
  let font = clipFontOk(ov.subFontPick) || clipFontOk(sp.font || ss.font) || 'DejaVu Sans';
  if (ov.subPreset === 'kertas' && ov.kertasFont === 'ketik') font = 'JetBrains Mono';
  // Kotak subtitle: warna kotak dari preset (Kertas/Chat = kuning, Pill/Kombo
  // = hitam) atau override Detail (ov.subBoxColor). BorderStyle 3 = kotak opaque.
  const subBoxColor = /^#[0-9a-fA-F]{6}$/.test(String(sp.boxColor || (sov && sov.backColor) || ov.subBoxColor || '')) ? (sp.boxColor || (sov && sov.backColor) || ov.subBoxColor) : null;
  // Kotak latar (Item 9): boxAlpha menimpa on/off kotak preset — 0 =
  // "Tanpa kotak" (BorderStyle 1 + outline aktif), >0 = kotak dengan
  // opasitas itu. Tanpa override: ikut preset seperti biasa.
  const boxOn = sov && sov.boxAlpha !== undefined ? sov.boxAlpha > 0 : !!sp.box;
  const subBorder = boxOn ? 3 : 1, subOutline = boxOn ? 0 : (sov && sov.outline !== undefined ? Math.round(sov.outline * S) : (ov.subPreset === 'puisi' ? Math.round(3 * S) : Math.round(6 * S)));
  // Outline 6 = ground truth Klipaja (tebal, terukur di klip download).
  // Kotak (Kertas/Chat/dll) tetap 0 — visualnya kotak, bukan outline glyph.
  // Puisi tetap 3 (tipis elegan).
  const subOutlineColor = sov && sov.outlineColor ? '&H00' + sov.outlineColor.slice(5, 7) + sov.outlineColor.slice(3, 5) + sov.outlineColor.slice(1, 3) : '&H80000000';
  const subShadow = sov && sov.shadow !== undefined ? sov.shadow : 0;
  const subAlign = sov && sov.align ? sov.align : 2;
  const subMarginLR = sov && sov.marginLR !== undefined ? Math.round(sov.marginLR * S) : 10;
  const subSpacing = sov && sov.spacing !== undefined ? Math.round(sov.spacing * S) : 0;
  const boxAlphaByte = sov && sov.boxAlpha !== undefined ? Math.round((100 - sov.boxAlpha) / 100 * 255).toString(16).padStart(2, '0').toUpperCase() : '00';
  const subBack = boxOn ? '&H' + boxAlphaByte + (subBoxColor || '#000000').slice(5, 7) + (subBoxColor || '#000000').slice(3, 5) + (subBoxColor || '#000000').slice(1, 3) : '&H00000000';
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
  const tSize = Math.round(Math.min(110, Math.max(20, Math.round(tBase * (Number.isFinite(+ov.titleSizePercent) ? (+ov.titleSizePercent || 100) / 100 : 1)))) * S);
  // Posisi vertikal judul: slider persen editor = posisi ATAS judul (% tinggi
  // frame; ground truth Klipaja: slider 56% -> atas kartu ~54%). Alignment 8
  // = atas-tengah, jadi MarginV = persen x 1280. Tanpa persen: hp.y / ov.titleY (px).
  // Tanpa persen DAN tanpa titleY -> default Klipaja 56% (717px), bukan 70px.
  const tY = Number.isFinite(+ov.titleYPercent)
    ? Math.min(OUT_H - 180, Math.max(0, Math.round((+ov.titleYPercent) / 100 * OUT_H)))
    : Math.min(OUT_H - 180, Math.max(0, Math.round((+(hp.y !== undefined ? hp.y : ov.titleY) || 717) * S)));
  const tBold = (hp.bold !== undefined ? hp.bold : ov.titleBold) === false ? 0 : -1;
  // Judul miring (italic): dari preset (Sinema/Keramat/Kutipan/Layar/Catatan)
  // atau checkbox "Judul miring" di Detail / Clipper.
  const tItalic = (hp.italic || ov.titleItalic) ? -1 : 0;
  // Font judul: pilihan per-klip (Edit, ov.titleFontPick) > preset > global.
  const tFont = clipFontOk(ov.titleFontPick) || clipFontOk(hp.font || ov.titleFont) || 'DejaVu Sans';
  const tC1 = /^#[0-9a-fA-F]{6}$/.test(String(hp.color1 || ov.titleColor1 || '')) ? (hp.color1 || ov.titleColor1) : '#FFFFFF';
  const tC2 = /^#[0-9a-fA-F]{6}$/.test(String(hp.color2 || ov.titleColor2 || '')) ? (hp.color2 || ov.titleColor2) : '#FFFF00';
  const tSpacing = Math.round((+hp.spacing || 0) * S);
  // Warna kotak judul: PRESET menang (Kartu/Kutipan = putih, Berita =
  // merah, Stabilo = kuning, Catatan = kuning pucat) — override manual
  // dicabut 21 Okt (pemilih warna dihapus, warna full dari preset gaya).
  const tBoxColor = /^#[0-9a-fA-F]{6}$/.test(String(hp.boxColor || ov.titleCardColor || '')) ? (hp.boxColor || ov.titleCardColor) : null;
  const titleBorder = hp.box ? 3 : 1, titleOutline = hp.box ? 0 : Math.round(2 * S);
  const titleBack = hp.box ? '&H00' + (tBoxColor || '#000000').slice(5, 7) + (tBoxColor || '#000000').slice(3, 5) + (tBoxColor || '#000000').slice(1, 3) : '&H00000000';
  const tAlign = hp.align === 2 ? 2 : 8;
  const tP1 = '&H00' + tC1.slice(5, 7) + tC1.slice(3, 5) + tC1.slice(1, 3);
  const tP2 = '&H00' + tC2.slice(5, 7) + tC2.slice(3, 5) + tC2.slice(1, 3);
  // --- Wrap judul MAKS 3 baris (ground truth Klipaja: judul 2-3 baris,
  // bukan 6 baris satu kata per baris menutupi wajah). Dihitung SEBELUM
  // header agar Style Title1/Title2 memakai ukuran efektif (tEffSize).
  // Greedy wrap -> bila >3 baris, kecilkan font -10% per iterasi (min 60%
  // ukuran awal) sampai muat 3 baris; bila tetap >3 pada 60%, lebarkan
  // lebar maks (faktor lebar judul 0,54 -> 0,62, yakni lebar efektif
  // 680 x 0,62/0,54) lalu wrap ulang.
  const titleTextRaw = String(ov.title || '').trim();
  function wrapTitleLines(text, effSize, widthPx) {
    const parts = text.split('|').map(s => s.trim()).filter(Boolean);
    const cpl = Math.max(10, Math.floor(widthPx / (0.6 * effSize)));
    const lines = [];
    parts.forEach((part, pi) => {
      const words = part.split(/\s+/).filter(Boolean);
      let cur = '';
      for (const w of words) {
        if (!cur) { cur = w; continue; }
        if (cur.length + 1 + w.length <= cpl) cur += ' ' + w;
        else { lines.push({ text: cur, pi }); cur = w; }
      }
      if (cur) lines.push({ text: cur, pi });
    });
    return lines;
  }
  let tEffSize = tSize;
  let titleWrapLines = titleTextRaw ? wrapTitleLines(titleTextRaw, tEffSize, Math.round(680 * S)) : [];
  while (titleWrapLines.length > 3 && tEffSize > Math.ceil(tSize * 0.6)) {
    tEffSize = Math.max(Math.ceil(tSize * 0.6), Math.round(tEffSize * 0.9));
    titleWrapLines = wrapTitleLines(titleTextRaw, tEffSize, Math.round(680 * S));
  }
  if (titleWrapLines.length > 3) {
    titleWrapLines = wrapTitleLines(titleTextRaw, tEffSize, Math.round(680 * S * 0.62 / 0.54));
  }
  const cta = ov.cta || {};
  const ctaSize = Math.min(Math.round(48 * S), Math.max(Math.round(20 * S), Math.round(tSize * 0.6)));
  const ctaY = Math.min(OUT_H - 80, Math.max(0, Math.round((+cta.y || 1150) * S))); // default 1150 (di bawah subtitle y~880-1000, biar tidak numpuk; sebelumnya 950 ketutup subtitle)
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
  // Warna kotak ekstra (pill, highlight, underline, badge) — ikut jadi Style
  // BoxRect_* supaya event \p1 bisa memakainya.
  const extraBoxHex = [];
  const pushBoxHex = (h) => { if (/^#[0-9a-fA-F]{6}$/.test(String(h || ''))) { const x = String(h).replace('#', '').toUpperCase(); if (extraBoxHex.indexOf(x) < 0) extraBoxHex.push(x); } };
  pushBoxHex(sp.pillColor); pushBoxHex(sp.highlight); pushBoxHex(sp.underline); pushBoxHex(hp.badge); pushBoxHex(hp.underline);
  const boxStyles = [titleBoxHex, subBoxHex, ...extraBoxHex].filter((v, i, a) => v && a.indexOf(v) === i)
    .map(h => 'Style: BoxRect_' + h + ',DejaVu Sans,10,' + assColorBGR(h) + ',&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,10,10,0,1\n').join('');
  // Kotak BERSUDUT MEMBULAT (Kartu Klipaja): path \p1 rounded-rect
  // (bezier kubik, k=0.45 ~ aproksimasi seperempat lingkaran). Radius
  // 24px @720p (cocok dengan border-radius:10px pratinjau ~300px).
  const roundedRectPath = (w, h) => {
    const r = Math.max(1, Math.min(Math.round(24 * S), Math.floor(Math.min(w, h) / 2)));
    const k = 0.45, a = Math.round(r * k), b = r - a;
    return 'm ' + r + ' 0 l ' + (w - r) + ' 0 b ' + (w - a) + ' 0 ' + w + ' ' + a + ' ' + w + ' ' + r
      + ' l ' + w + ' ' + (h - r) + ' b ' + w + ' ' + (h - a) + ' ' + (w - a) + ' ' + h + ' ' + (w - r) + ' ' + h
      + ' l ' + r + ' ' + h + ' b ' + a + ' ' + h + ' 0 ' + (h - a) + ' 0 ' + (h - r)
      + ' l 0 ' + r + ' b 0 ' + a + ' ' + a + ' 0 ' + r + ' 0 c';
  };
  const boxRectEvent = (styleName, s, e, x, y, w, h, fadTag, rot) => {
    const rx = Math.max(0, Math.round(x)), ry = Math.max(0, Math.round(y));
    const rw = Math.min(OUT_W - rx, Math.max(1, Math.round(w))), rh = Math.min(OUT_H - ry, Math.max(1, Math.round(h)));
    // rot = rotasi derajat (Stiker -4, Catatan +2) — \frz memutar event
    // (termasuk \p1) di sekitar anchor \pos (kiri-atas). Sudut kecil (<=4°)
    // jadi gesernya < 15px, teks tetap di dalam kotak.
    const rotTag = rot ? '\\frz' + rot : '';
    return 'Dialogue: 0,' + fmtAss(s) + ',' + fmtAss(e) + ',' + styleName + ',,0,0,0,,' + (fadTag || '') + '{\\an7\\pos(' + rx + ',' + ry + ')' + rotTag + '\\p1}' + roundedRectPath(rw, rh) + '{\\p0}\n';
  };
  // WrapStyle: 0 = smart wrapping (libass membungkus teks jadi beberapa baris).
  // Sebelumnya WrapStyle: 2 (no wrapping) → subtitle 1 baris raksasa kepotong layar.
  const header = '[Script Info]\nTitle: Auto Clipper\nScriptType: v4.00+\nPlayResX: ' + OUT_W + '\nPlayResY: ' + OUT_H + '\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,' + font + ',' + size + ',' + primary + ',' + karaokeSec + ',' + subOutlineColor + ',' + subBack + ',' + bold + ',' + subItalic + ',0,0,100,100,' + subSpacing + ',0,' + subBorder + ',' + subOutline + ',' + subShadow + ',' + subAlign + ',' + subMarginLR + ',' + subMarginLR + ',' + marginV + ',1\nStyle: Title1,' + tFont + ',' + tEffSize + ',' + tP1 + ',&H000000FF,&H80000000,' + titleBack + ',' + tBold + ',' + tItalic + ',0,0,100,100,' + tSpacing + ',0,' + titleBorder + ',' + titleOutline + ',0,8,10,10,' + tY + ',1\nStyle: Title2,' + tFont + ',' + tEffSize + ',' + tP2 + ',&H000000FF,&H80000000,' + titleBack + ',' + tBold + ',' + tItalic + ',0,0,100,100,' + tSpacing + ',0,' + titleBorder + ',' + titleOutline + ',0,8,10,10,' + tY + ',1\nStyle: Cta,' + tFont + ',' + ctaSize + ',' + ctaP + ',&H000000FF,&H80000000,&H00000000,' + tBold + ',' + tItalic + ',0,0,100,100,0,0,1,2,0,8,10,10,' + ctaY + ',1\nStyle: Hook,Montserrat,' + Math.round(71 * S) + ',&H0000FFFF,&H000000FF,&H80000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,5,10,10,0,1\nStyle: Watermark,' + tFont + ',' + Math.round(24 * S) + ',&H80FFFFFF,&H000000FF,&H80000000,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n' + boxStyles + '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const out = [header];
  const clipDur = Math.max(0.2, (end || 0) - (start || 0));
  // Durasi judul (gaya Klipaja): 'default' = 4 detik (judul hook cuma di awal),
  // 'full' = sepanjang klip, 'manual' = titleDurSec detik. CTA tetap sepanjang klip.
  const titleDurMode = resolveTitleDurMode(ov.titleDur, ov.hookDurAi, clipDur);
  const titleDurSec = titleDurMode === 'full' ? clipDur : titleDurMode === 'manual' ? Math.min(clipDur, Math.max(0.5, +ov.titleDurSec || 4)) : titleDurMode === '5s' ? Math.min(clipDur, 5) : Math.min(clipDur, 4);
  // --- Hook multi-hook (gaya Hook V2): potongan pendek (0,5–2,5 detik) disambung
  // di DEPAN klip utama. ov.hook = array {start, end, text} waktu RELATIF ke
  // awal klip (sudah dikurangi cand.start oleh server). Timeline hook: item
  // ke-i menempati [pos_i, pos_i + dur_i], total hookTotal. Klip utama mulai
  // di hookTotal — jadi judul/CTA/subtitle utama di-offset hookTotal (muncul
  // setelah hook, bukan selama hook). Teks hook + flash putih di-render di sini.
  const hookItems = (Array.isArray(ov.hook) ? ov.hook : []).filter(h => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start).slice(0, 3);
  let hookTotal = 0;
  const hookTimeline = hookItems.map(h => { const pos = hookTotal; hookTotal += (h.end - h.start); return { pos, dur: h.end - h.start, srcStart: h.start, text: String(h.text || '').trim() }; });
  // Teks hook (Anton gede, center, bayangan). Tanpa flash putih (hard cut):
  // flash .ass {\p1} merusak Dialogue sesudahnya, filter fade out->in
  // bikin video putih semua. Lihat catatan di buildFfmpegArgs.
  // hookAtSource (khusus trek pratinjau hook di editor): event hook ditaruh
  // di waktu SUMBER-nya (tiap teks di atas potongannya sendiri), bukan di
  // garis waktu gabungan — pemutar pratinjau melompat antar-potongan.
  // Beast (Dzaky 25 Okt 09:52-09:56, konfirmasi 10:47): teks hook BUKAN
  // satu Dialogue putih polos per potongan, tapi kata-per-kata ala
  // preset kinetik (singleWord): tiap kata tampil sendiri, kapital,
  // kuning (warna utama style Hook = #FFFF00), fly-in via animTag.
  // Tanpa pil gelap (style Hook BorderStyle 1, BackColour transparan).
  // Tanpa hook = nol event Hook (kontrak lama dipertahankan).
  // hookAtSource (trek pratinjau hook di editor): kata ditaruh di waktu
  // SUMBER-nya, bukan garis waktu gabungan — pemutar melompat antar-potongan.
  for (const ht of hookTimeline) {
    if (!ht.text) continue;
    const words = ht.text.toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const base = ov.hookAtSource ? ht.srcStart : ht.pos;
    const totalCs = Math.max(1, Math.round(ht.dur * 100));
    words.forEach((w, i) => {
      const ws = base + Math.round(totalCs * i / words.length) / 100;
      const we = base + Math.round(totalCs * (i + 1) / words.length) / 100;
      out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Hook,,0,0,0,,' + animTag('flyin') + escapeAssText(w) + '\n');
    });
  }
  // --- Judul + CTA: tampil sepanjang KLIP UTAMA (hookTotal → hookTotal + clipDur).
  // (bagian 1 = warna 1, bagian 2+ = warna 2), tiap baris jadi Dialogue sendiri
  // dengan MarginV sendiri (biar bertumpuk atas-bawah, center).
  // Pakai Judul (per-klip, checkbox di Detail): kalau off, judul tidak dibakar.
  const titleText = titleTextRaw;
  if (ov.showTitle !== false && titleText) {
    // allLines = hasil wrap maks-3-baris (dihitung sebelum header, memakai
    // tEffSize) — jangan wrap ulang di sini.
    const allLines = titleWrapLines;
    // Layar Lebar: bar hitam atas-bawah (gambar \p); judul dipaksa masuk area
    // aman (di bawah bar atas) biar tidak ketutup bar.
    // Cegah judul menimpa subtitle: kalau blok judul (tYeff + N baris) melewati
    // atas blok subtitle (subTopPx dari subYPercent), geser judul ke atas
    // sampai ada celah 12px. Judul yang sudah muat tidak digeser (posisi
    // Klipaja 56% dipertahankan). Tanpa subYPercent (subTopPx null) = perilaku lama.
    let tYeff = hp.letterbox ? Math.max(tY, Math.round(160 * S)) : tY;
    if (Number.isFinite(guardSubTop) && allLines.length) {
      const tBlockH = allLines.length * (tEffSize + Math.round(18 * S));
      const maxTop = guardSubTop - tBlockH - Math.round(12 * S);
      if (tYeff > maxTop) tYeff = Math.max(0, maxTop);
    }
    if (hp.letterbox) {
      const barH = Math.round(140 * S);
      const barTag = '{\\an7\\p1\\bord0\\shad0\\1c&H000000&}m 0 0 l ' + OUT_W + ' 0 l ' + OUT_W + ' ' + barH + ' l 0 ' + barH + '{\\p0}';
      out.push('Dialogue: 2,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',Title1,,0,0,0,,' + '{\\pos(0,0)}' + barTag + '\n');
      out.push('Dialogue: 2,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',Title1,,0,0,0,,' + '{\\pos(0,' + (OUT_H - barH) + ')}' + barTag + '\n');
    }
    // Sinema: gradasi gelap bawah (12 pita, opacity menebal ke bawah —
    // aproksimasi gradasi, libass tidak punya fill gradasi). Teks Sinema
    // duduk di atasnya. HATI-HATI: \1a di ASS = TRANSPARANSI (FF = tembus
    // pandang), jadi hex = (1 - opacity) * 255. Versi lama menulis opacity
    // langsung sebagai alpha -> gradasi KEBALIK (paling gelap di atas) +
    // berasa 3 tangga keras di video hasil download (keluhan Dzaky 22 Okt).
    if (hp.gradient) {
      const gY0 = Math.round(OUT_H * 0.55), gH = OUT_H - gY0, STEPS = 12;
      for (let i = 0; i < STEPS; i++) {
        const opacity = 0.18 + (0.70 - 0.18) * ((i + 0.5) / STEPS);
        // Batas KUMULATIF (pita i mulai persis di akhir pita i-1): tinggi +1
        // bikin 1 baris tumpang tindih -> komposit dobel = garis hitam di
        // tiap batas pita pada hasil render (keluhan Dzaky 22 Okt).
        const by = Math.round(gY0 + gH * (i / STEPS)), bh = Math.round(gY0 + gH * ((i + 1) / STEPS)) - by;
        const alphaHex = Math.round((1 - opacity) * 255).toString(16).toUpperCase().padStart(2, '0');
        out.push('Dialogue: 2,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',Title1,,0,0,0,,' + '{\\pos(0,' + by + ')\\an7\\p1\\bord0\\shad0\\1a&H' + alphaHex + '&\\1c&H000000&}m 0 0 l ' + OUT_W + ' 0 l ' + OUT_W + ' ' + bh + ' l 0 ' + bh + '{\\p0}\n');
      }
    }
    // Geometri kotak judul (dipakai kotak + dekorasi + clip unroll). Dihitung
    // sekali di sini biar kotak, dekorasi, dan teks konsisten.
    let tBox = null;
    if (hp.box && titleBoxHex && allLines.length) {
      const tLineH = tEffSize * 1.25;
      const tMaxW = Math.max(...allLines.map(ln => ln.text.length * tEffSize * 0.54));
      tBox = { x: CX - tMaxW / 2 - Math.round(28 * S), y: tYeff - Math.round(16 * S), w: tMaxW + Math.round(56 * S), h: allLines.length * tLineH + Math.round(32 * S), lineH: tLineH };
    }
    // Kotak judul: SATU rect untuk seluruh blok (Kartu/dll). Fad sama seperti teks.
    // Border (Gulung/Stiker): rect hitam sedikit lebih besar DI BELAKANG kotak.
    if (tBox) {
      if (hp.border) {
        out.push(boxRectEvent('BoxRect_000000', hookTotal, hookTotal + titleDurSec,
          tBox.x - Math.round(6 * S), tBox.y - Math.round(6 * S), tBox.w + Math.round(12 * S), tBox.h + Math.round(12 * S),
          fadOf(titleAnimTag) || '', hp.rotate || 0));
      }
      // Slide Dinamis: tiap baris di atas bar-nya sendiri (kuning/hitam/kuning)
      // — bukan satu kotak. Kotak tunggal dilewati; bar per-baris digambar di bawah.
      if (!hp.bars) {
        out.push(boxRectEvent('BoxRect_' + titleBoxHex, hookTotal, hookTotal + titleDurSec,
          tBox.x, tBox.y, tBox.w, tBox.h,
          fadOf(titleAnimTag) || (hp.anim === 'slidedown' || hp.anim === 'slidein' || hp.anim === 'slidelines' ? '{\\fad(100,100)}' : ''), hp.rotate || 0));
      }
      // Stabilo: sorotan pink di belakang baris ke-2 (bukan sweep kuning lama).
      if (hp.highlight && allLines.length >= 2 && !hp.bars) {
        const l2 = allLines[1];
        const hw = Math.max(20, Math.round(l2.text.length * tEffSize * 0.54 + 24 * S));
        const hx = Math.round(CX - hw / 2), hy = Math.round(tYeff + tBox.lineH + 2 * S);
        const hlHex = String(hp.highlight).replace('#', '').toUpperCase();
        out.push(boxRectEvent('BoxRect_' + hlHex, hookTotal, hookTotal + titleDurSec, hx, hy, hw, Math.round(tEffSize * 1.1), fadOf(titleAnimTag) || ''));
      }
      // Berita: lencana merah + titik putih di kiri atas panel + garis bawah biru.
      if (hp.badge) {
        const bdHex = String(hp.badge).replace('#', '').toUpperCase();
        const bs = Math.round(24 * S);
        out.push(boxRectEvent('BoxRect_' + bdHex, hookTotal, hookTotal + titleDurSec, tBox.x + Math.round(12 * S), tBox.y + Math.round(12 * S), bs, bs, ''));
        out.push(boxRectEvent('BoxRect_FFFFFF', hookTotal, hookTotal + titleDurSec, tBox.x + Math.round(12 * S) + Math.round(bs / 2) - Math.round(4 * S), tBox.y + Math.round(12 * S) + Math.round(bs / 2) - Math.round(4 * S), Math.round(8 * S), Math.round(8 * S), ''));
      }
      if (hp.underline && hp.badge) {
        const ulHex = String(hp.underline).replace('#', '').toUpperCase();
        out.push(boxRectEvent('BoxRect_' + ulHex, hookTotal, hookTotal + titleDurSec, tBox.x, tBox.y + tBox.h - Math.round(6 * S), tBox.w, Math.round(6 * S), ''));
      }
      // Catatan: strip selotip tembus pandang di tengah atas + garis bawah merah bergelombang.
      if (hp.tape) {
        const tw = Math.round(120 * S), th = Math.round(28 * S);
        out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',BoxRect_FFFFFF,,0,0,0,,' + '{\\an7\\pos(' + Math.round(CX - tw / 2) + ',' + Math.round(tBox.y - th / 2) + ')\\1a&H80&\\p1}m 0 0 l ' + tw + ' 0 l ' + tw + ' ' + th + ' l 0 ' + th + '{\\p0}\n');
      }
      if (hp.wavy && allLines.length) {
        const wvHex = String(hp.wavy).replace('#', '').toUpperCase();
        const lastLine = allLines[allLines.length - 1];
        const ww = Math.max(20, Math.round(lastLine.text.length * tEffSize * 0.54));
        const wx = Math.round(CX - ww / 2), wy = Math.round(tYeff + allLines.length * tBox.lineH + 4 * S);
        const bumps = 6, step = Math.max(4, Math.round(ww / bumps));
        let wavyPath = 'm ' + wx + ' ' + wy;
        for (let i = 0; i < bumps; i++) {
          const x0 = wx + i * step, x1 = wx + (i + 1) * step;
          wavyPath += ' b ' + Math.round(x0 + step / 2) + ' ' + (wy - Math.round(6 * S)) + ' ' + Math.round(x0 + step / 2) + ' ' + (wy + Math.round(6 * S)) + ' ' + x1 + ' ' + wy;
        }
        out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',BoxRect_' + wvHex + ',,0,0,0,,' + '{\\an7\\pos(0,0)\\p1}' + wavyPath + '{\\p0}\n');
      }
      // Kutipan Terang: ikon "66" kuning di kiri atas judul.
      if (hp.quote) {
        out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',Title1,,0,0,0,,' + '{\\pos(' + Math.round(tBox.x + 16 * S) + ',' + Math.round(tBox.y - 6 * S) + ')\\an7\\1c&H00FFFF&\\fs' + Math.round(tEffSize * 1.1) + '\\b1}66{\\p0}\n');
      }
    }
    // Slide Dinamis: bar per-baris (kuning/hitam/kuning) + teks per-baris.
    if (hp.bars && allLines.length) {
      allLines.forEach((ln, li) => {
        const barHex = String((hp.barColors || ['#FFFF00', '#000000', '#FFFF00'])[li % 3]).replace('#', '').toUpperCase();
        const lw = Math.max(20, Math.round(ln.text.length * tEffSize * 0.54 + 40 * S));
        const ly = Math.round(tYeff + li * tEffSize * 1.25 - 8 * S);
        out.push(boxRectEvent('BoxRect_' + barHex, hookTotal, hookTotal + titleDurSec, Math.round(CX - lw / 2), ly, lw, Math.round(tEffSize * 1.25 + 16 * S), fadOf(titleAnimTag) || ''));
      });
    }
    // Layar Lebar: garis bawah emas di bawah judul.
    if (hp.underline && !hp.badge && allLines.length) {
      const ulHex = String(hp.underline).replace('#', '').toUpperCase();
      const uw = Math.max(20, Math.round(Math.max(...allLines.map(ln => ln.text.length * tEffSize * 0.54)) * 0.8));
      out.push(boxRectEvent('BoxRect_' + ulHex, hookTotal, hookTotal + titleDurSec, Math.round(CX - uw / 2), Math.round(tYeff + allLines.length * tEffSize * 1.25 + 10 * S), uw, Math.round(4 * S), ''));
    }
    // Ketik (typewriter): tiap karakter muncul satu per satu (teks kumulatif,
    // event yang lebih panjang menutup yang pendek — jadi kelihatan ngetik).
    // Kursor ▌ menempel di event karakter terakhir. Interval ~40ms/karakter.
    if (hp.anim === 'type') {
      allLines.forEach((ln, li) => {
        const mv = tYeff + li * (tEffSize + Math.round(18 * S));
        const chars = ln.text.split('');
        chars.forEach((_, ci) => {
          const prefix = ln.text.slice(0, ci + 1) + (ci === chars.length - 1 ? '▌' : '');
          // Akhir event = awal karakter berikutnya (BUKAN akhir judul): semua prefix berakhir di akhir judul bikin libass menumpuk semua tahap ketikan jadi tangga garis (bug 23 Okt).
          const evEnd = ci === chars.length - 1 ? hookTotal + titleDurSec : hookTotal + (ci + 1) * 0.04;
          out.push('Dialogue: 0,' + fmtAss(hookTotal + ci * 0.04) + ',' + fmtAss(evEnd) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,' + mv + ',,' + escapeAssText(prefix) + '\n');
        });
      });
    } else if (hp.anim === 'glitch') {
      // Glitch: 3 salinan RGB-split (merah / cyan / putih) bergeser ±3px +
      // flicker (kedip alpha 3-4x dalam 300ms via \t \alpha).
      allLines.forEach((ln, li) => {
        const mv = tYeff + li * (tEffSize + Math.round(18 * S));
        const flicker = '\\t(0,75,\\alpha&HFF&)\\t(75,150,\\alpha&H00&)\\t(150,225,\\alpha&HFF&)\\t(225,300,\\alpha&H00&)';
        const copies = ['{\\1c&H0000FF&\\pos(' + (CX - Math.round(3 * S)) + ',' + mv + ')' + flicker + '}', '{\\1c&HFFFF00&\\pos(' + (CX + Math.round(3 * S)) + ',' + mv + ')' + flicker + '}', '{\\1c&HFFFFFF&\\pos(' + CX + ',' + mv + ')' + flicker + '}'];
        for (const tag of copies) {
          out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,0,,' + tag + '{\\fad(100,100)}' + escapeAssText(ln.text) + '\n');
        }
      });
    } else {
      allLines.forEach((ln, li) => {
        const mv = tAlign === 2 ? tYeff + (allLines.length - 1 - li) * (tEffSize + Math.round(18 * S)) : tYeff + li * (tEffSize + Math.round(18 * S));
        let tag = titleAnimTag;
        if (hp.anim === 'slidedown') tag = '{\\move(' + CX + ',' + Math.round(-80 * S) + ',' + CX + ',' + mv + ',0,400)}{\\fad(100,100)}';
        else if (hp.anim === 'slidein') tag = '{\\move(' + Math.round(-200 * S) + ',' + mv + ',' + CX + ',' + mv + ',0,400)}{\\fad(100,100)}';
        else if (hp.anim === 'slidelines') { const fx = (li % 2 === 0) ? Math.round(-200 * S) : Math.round(OUT_W + 200 * S); tag = '{\\move(' + fx + ',' + mv + ',' + CX + ',' + mv + ',0,400)}{\\fad(100,100)}'; }
        else if (hp.anim === 'slideuppop') tag = '{\\move(' + CX + ',' + (mv + Math.round(40 * S)) + ',' + CX + ',' + mv + ',0,300)\\fscx85\\fscy85\\t(0,300,\\fscx100\\fscy100)}{\\fad(100,100)}';
        else if (hp.anim === 'unroll' && tBox) tag = '{\\clip(' + Math.round(tBox.x) + ',' + Math.round(tBox.y) + ',' + Math.round(tBox.x + 8) + ',' + Math.round(tBox.y + tBox.h) + ')\\t(0,400,\\clip(' + Math.round(tBox.x) + ',' + Math.round(tBox.y) + ',' + Math.round(tBox.x + tBox.w) + ',' + Math.round(tBox.y + tBox.h) + '))}';
        // Kartu: statis (tanpa animasi) — blok lama fade-in dihapus sesuai
        // observasi (Kartu Klipaja statis, tanpa toggle Animasi).
        // Rotasi kartu (Stiker -4, Catatan +2): \frz pada teks (kotak ikut
        // \frz via boxRectEvent) — teks miring di dalam kartu.
        if (hp.rotate) tag += '{\\frz' + hp.rotate + '}';
        // Slide Dinamis: warna teks per-baris (bar kuning = teks hitam,
        // bar hitam = teks putih) — menimpa Title1/Title2.
        if (hp.bars) {
          const bc = (hp.barTextColors || ['#000000', '#FFFFFF', '#000000'])[li % 3];
          tag += '{\\1c&H00' + String(bc).replace('#', '').slice(4, 6) + String(bc).replace('#', '').slice(2, 4) + String(bc).replace('#', '').slice(0, 2) + '&}';
        }
        const alignTag = tAlign === 2 ? '{\\an2}' : '';
        // Berita: teks rata kiri — \pos di kiri dalam panel + \an7.
        if (hp.alignLeft && tBox) {
          out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,0,,' + '{\\pos(' + Math.round(tBox.x + 44 * S) + ',' + mv + ')\\an7}' + tag + escapeAssText(ln.text) + '\n');
        } else {
          out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + titleDurSec) + ',' + (ln.pi === 0 ? 'Title1' : 'Title2') + ',,0,0,' + mv + ',,' + alignTag + tag + escapeAssText(ln.text) + '\n');
        }
      });
    }
  }
  if (cta.enabled !== false && String(cta.text || '').trim()) {
    const lines = String(cta.text).split('|').map(s => s.trim()).filter(Boolean);
    lines.forEach((line, li) => {
      const mv = ctaY + li * (ctaSize + Math.round(8 * S));
      out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + clipDur) + ',Cta,,0,0,' + mv + ',,' + escapeAssText(line) + '\n');
    });
  }
  // Watermark (tab Video, GRATIS): teks kecil semi-transparan di pojok,
  // sepanjang klip. Posisi: bl (kiri-bawah, default Klipaja) / br / tl / tr.
  if (ov.watermark && String(ov.watermark.text || '').trim()) {
    const wmPos = ['bl', 'br', 'tl', 'tr'].includes(ov.watermark.pos) ? ov.watermark.pos : 'bl';
    const wmMargin = Math.round(20 * S), wmBottom = Math.round(40 * S);
    const wmPosTag = wmPos === 'bl' ? '{\\pos(' + wmMargin + ',' + (OUT_H - wmBottom) + ')\\an1}'
      : wmPos === 'br' ? '{\\pos(' + (OUT_W - wmMargin) + ',' + (OUT_H - wmBottom) + ')\\an3}'
      : wmPos === 'tl' ? '{\\pos(' + wmMargin + ',' + wmMargin + ')\\an7}'
      : '{\\pos(' + (OUT_W - wmMargin) + ',' + wmMargin + ')\\an9}';
    out.push('Dialogue: 0,' + fmtAss(hookTotal) + ',' + fmtAss(hookTotal + clipDur) + ',Watermark,,0,0,0,,' + wmPosTag + escapeAssText(String(ov.watermark.text).trim()) + '\n');
  }
  // --- Subtitle model Klipaja: chunk maks 4 KATA (maks 2 baris, maks ~2,5
  // dtk), tiap chunk jadi Dialogue sendiri. Seluruh chunk MUNCUL SEKALIGUS
  // di awal chunk (bukan kata per kata muncul) + karaoke per kata (tepat
  // 1 kata disorot HIJAU TERANG pada satu waktu, sorotan bergerak kiri ke
  // kanan mengikuti timing kata). Chunk lama langsung diganti chunk baru
  // (tanpa jeda kosong). TIDAK PERNAH > 2 baris (tidak ada tembok teks).
  // *kata* (bintang) = kata yang nge-POP: lebih gede (+50%) + kuning (override
  // inline \fs + \c). Tulis di editor subtitle, misal: ini *PENTING* banget.
  const charsPerLine = Math.max(10, Math.floor(Math.round(680 * S) / (0.6 * size)));
  // Subtitle: HURUF BESAR SEMUA bila preset caps=true (karaoke/casual/
  // kinetik/polos/pop/default/classic); kalimat biasa bila caps=false
  // (pill/kertas/kombo/puisi/chat/simpel/pantul/bebas). Uppercase/strip
  // hanya di output bakar (.ass) — teks editor / transkrip tidak diubah.
  const useCaps = sp.caps !== false;
  const upperSub = (t) => (useCaps ? String(t).toUpperCase() : String(t));
  // Teks TAMPIL satu kata: edit Koreksi Kata (bila ada) > teks asli, lalu
  // uppercase + strip tanda baca akhir (bila caps) atau apa adanya (bila
  // kalimat biasa). Batas kalimat/frasa tetap dibaca dari teks mentah
  // (chunkSubtitleWords).
  const dispText = (w) => {
    let t = (w && w.edit !== undefined && String(w.edit || '').trim()) ? String(w.edit).trim() : String((w && w.text) || '');
    if (sp.__capsLower) t = t.toLowerCase(); // Item 7: mode huruf "aa" (kecil semua)
    return useCaps ? stripDisplayPunct(upperSub(t)) : t;
  };
  // Warna kata (Koreksi Kata: Warna kata) — menimpa warna preset, tampil
  // dengan warna ini saat diucapkan maupun tidak. Return tag \c BGR atau null.
  const wordColorTag = (w) => {
    const h = String((w && w.wordColor) || '');
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
    return '&H00' + h.slice(5, 7) + h.slice(3, 5) + h.slice(1, 3);
  };
  // Kata kunci (Koreksi Kata: Kata kunci): 'no' = tidak pernah berwarna
  // (menang atas w.keyword), 'yes'/'auto' = ikut w.keyword.
  const isKeyword = (w) => !!(w && w.keyword && w.keywordMode !== 'no');
  const popSize = Math.round(size * 1.5);
  const popColor = '&H0000FFFF'; // kuning (ASS BGR)
  // Pop kata aktif (Klipaja): kata yang sedang diucapin membesar ke 115%
  // lalu kembali 100% dalam 300ms dari awal event jendelanya.
  // \t terikat ke awal Dialogue — event jendela kata dimulai pas kata
  // mulai diucapin, jadi pop sinkron dengan kata. Reset \fscx100 setelah
  // kata aktif adalah jaring pengaman.
  let wordAnimInner = subWordAnimInner(sp);
  // Item 8 mode "Membesar": kata aktif mulai 140% lalu turun ke 118%
  // (tetap lebih besar dari teks biasa selama jendelanya).
  if (sov && sov.activeMode === 'membesar') wordAnimInner = '\\fscx140\\fscy140\\t(0,280,\\fscx118\\fscy118)';
  // Glow kata aktif (spek spreadsheet via brief 22 Okt): HANYA preset
  // yang mendeklarasikan glow di presets.json (saat ini Karaoke) — outline
  // sewarna kata aktif + \bord8\blur8. Preset lain tetap polos (keputusan
  // Dzaky 21 Okt: tanpa glow) karena glowOpen/glowReset mereka kosong.
  // (Glow TIDAK lagi berupa tag span — lihat event glow terpisah di emitter chunk.)
  const normalColor = '&H00' + color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3);
  // Karaoke TANPA glow (keputusan Dzaky 21 Okt): kata aktif cukup ganti
  // WARNA POLOS (activeColor preset) + animasi pop — TANPA outline warna,
  // TANPA blur/neon. (Dulu di sini ada "NEON GLOW": outline warna aktif +
  // bord tebal + blur — dicabut karena Dzaky: "kalo hijau ya ijo, kalo
  // kuning ya kuning, jangan glow".)
  // Gabung cue yang kepotong kalimat: kalau cue sebelumnya tidak berakhir
  // dengan tanda akhir kalimat (. ! ? …) dan jeda ke cue berikutnya < 0,5 detik
  // (kemungkinan lanjutan kalimat, bukan kalimat baru), gabung jadi satu cue.
  // Jadi subtitle menampilkan kalimat UTUH, bukan fragmen ("Saya pergi ke" +
  // "pasar" -> "Saya pergi ke pasar").
  // Pakai Subtitle (per-klip): kalau off, subtitle tidak dibakar (cues diabaikan).
  // Teks cue di-strip prefix "-" ganti pembicara (stripLeadDash) agar
  // subtitle render tidak membawa "-YOH, BRO.".
  // De-window DULU (caption YouTube rolling -> kata baru saja, tail timing).
  const subCues = (ov.showSub === false) ? [] : dewindowCues(cues || []).map(c => {
    const stripped = { ...c, text: stripLeadDash(c.text) };
    return { ...stripped, words: cueWords(stripped) };
  });
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
  // --- Potong cue hasil merge ke jendela klip [start, end] (ANTI-TEMBOK AWAL) ---
  // Cue hasil merge bisa membentang melewati batas klip (kalimat yang mulai
  // sebelum klip lalu lanjut ke dalam klip — gap < 0,5 dtk ikut ke-merge).
  // Tanpa pemotongan, kata-kata SEBELUM klip ikut ke grup karaoke dan
  // ter-clamp ke [0, 0.2] (ws = max(0, negatif) = 0; ge = max(0.2, ...))
  // sehingga ~15-20 grup muncul sekaligus di t=0 (tembok subtitle di
  // frame pertama Final — terverifikasi repro: 19 event [0.00-0.20]).
  // Jalur else juga bocor (teks sebelum klip tampil di awal klip dengan
  // timing salah). Jadi: buang kata di luar klip, rakit ulang teks dari
  // kata dalam klip, potong [start, end] cue. Kata yang mengangkangi
  // batas klip (mulai sebelum, selesai di dalam) tetap dipertahankan
  // (sedang diucapkan saat klip mulai → tampil di t=0, benar).
  // Flag sensor/keyword/edit kata dipertahankan (objek kata diteruskan).
  const clipped = [];
  for (const c of merged) {
    const words = (c.words || []).filter(w => w && w.text && (w.end || 0) > start && (w.start || 0) < end);
    if (!words.length) continue;
    const cs = Math.max(c.start || 0, start);
    const ce = Math.min(c.end || 0, end);
    if (!(ce > cs)) continue;
    clipped.push({ start: cs, end: ce, text: words.map(w => String(w.text || '').trim()).filter(Boolean).join(' '), words });
  }
  // --- Render chunk (model Klipaja): ratakan kata semua cue terpotong jadi
  // SATU aliran waktu, lalu chunk (<=4 kata, <=2 baris). Slot chunk = sampai
  // awal chunk berikutnya (chunk lama langsung diganti chunk baru, tanpa
  // jeda kosong); chunk terakhir sampai akhir kata terakhirnya.
  // Karaoke (gaya punya activeColor): per kata dapat jendelanya sendiri
  // [kata_j.start, kata_{j+1}.start) — SELURUH chunk tampil sekaligus,
  // hanya SOROTAN yang bergerak (kata aktif = activeColor + pop, kata lain
  // putih). Tanpa \k (di libass \k menyorot kata yang BELUM diucapin,
  // kebalikan dari Klipaja). Sensor = disembunyikan (slot waktu tetap,
  // biar timing kata sesudahnya pas + suara dibisukan di render).
  // Plain (tanpa activeColor: Simpel/Polos/Puisi): satu event per chunk,
  // seluruh chunk tampil sekaligus, tanpa sorotan.
  const stream = [];
  for (const c of clipped) for (const w of (c.words || [])) if (w && w.text && !w.disabled) stream.push(w);
  // singleWord (Kinetik/Pantul): HANYA 1 kata per tampilan — maxWords paksa 1.
  // Kombo/Pop: maxWords 2. Lainnya: maxWords preset atau 4.
  const chunkMax = sp.singleWord ? 1 : (sp.maxWords || 4);
  const chunks = chunkSubtitleWords(stream, charsPerLine, useCaps, chunkMax);
  const isKaraoke = !!(sp.karaoke || sp.activeColor || (sov && sov.activeMode)); // mode kata aktif (Item 8) memaksa jalur per-kata
  const chunkSlot = (ci) => {
    const ch = chunks[ci];
    const s0 = hookTotal + Math.max(0, ch.start - start);
    const s1 = ci + 1 < chunks.length
      ? hookTotal + Math.max(0, chunks[ci + 1].start - start)
      : hookTotal + Math.max(0.2, ch.end - start);
    return [s0, Math.max(s0 + 0.01, s1)];
  };
  // Perkiraan posisi-x kata di dalam satu baris (untuk pill/highlight/
  // underline di belakang kata aktif): baris terpusat, lebar kata ≈
  // panjang tampil × 0,6 × ukuran font. Aproksimasi (bukan metrik font
  // persis) — cukup untuk menaruh sorotan di belakang kata.
  // Faktor lebar karakter rata-rata per family (em) — dikalibrasi dari frame
  // render uji 22 Okt: faktor datar 0,6 meleset jauh di font sempit (Plus
  // Jakarta/Playfair/Anton) -> pill/glow bergeser kiri. Spasi nyata ~0,32em.
  const CHAR_F = { 'Montserrat': 0.60, 'Plus Jakarta Sans': 0.52, 'JetBrains Mono': 0.60, 'Playfair Display': 0.50, 'Anton': 0.52, 'Russo One': 0.58, 'Poppins': 0.58, 'Roboto': 0.55, 'Lato': 0.55, 'Oswald': 0.50, 'Bebas Neue': 0.48, 'Liberation Sans': 0.56, 'DejaVu Sans': 0.60 };
  const charF = CHAR_F[sp.font] || 0.58;
  const estWordX = (lineWords, actWord) => {
    const lineW = lineWords.reduce((a, w, i) => a + (i ? size * 0.32 : 0) + dispText(w).length * size * charF, 0);
    let x = CX - lineW / 2;
    for (const w of lineWords) {
      if (w === actWord) break;
      x += dispText(w).length * size * charF + size * 0.32;
    }
    return { x: Math.round(x), w: Math.round(dispText(actWord).length * size * charF) };
  };
  // Subtitle ditahan (Sinema/Layar Lebar): subtitle baru muncul setelah
  // judul selesai (hookTotal + titleDurSec).
  const holdUntil = hp.holdSub ? hookTotal + titleDurSec : 0;
  chunks.forEach((ch, ci) => {
    let [gs, ge] = chunkSlot(ci);
    if (hp.holdSub) {
      if (ge <= holdUntil) return;
      gs = Math.max(gs, holdUntil);
    }
    const kTotal = ch.lines.length;
    const kBase = subMarginVFor(kTotal);
    // Kotak subtitle: SATU rect per chunk, menutupi semua barisnya.
    if (sp.box && subBoxHex) {
      const kRectW = (ws) => ws.map(w => dispText(w)).join(' ').length * size * 0.70;
      const kMaxW = Math.max(...ch.lines.map(kRectW));
      const kBoxX = CX - kMaxW / 2 - Math.round(28 * S), kBoxY = OUT_H - kBase - kTotal * lineH - Math.round(16 * S);
      out.push(boxRectEvent('BoxRect_' + subBoxHex, gs, ge,
        kBoxX, kBoxY, kMaxW + Math.round(56 * S), kTotal * lineH + Math.round(32 * S), fadOf(subAnimTag)));
      // Chat: ekor gelembung (segitiga kecil di kiri bawah bubble).
      if (sp.bubble) {
        const tailX = Math.round(kBoxX + 40 * S), tailY = Math.round(kBoxY + kTotal * lineH + 32 * S);
        out.push('Dialogue: 0,' + fmtAss(gs) + ',' + fmtAss(ge) + ',BoxRect_' + subBoxHex + ',,0,0,0,,' + '{\\an7\\pos(' + tailX + ',' + tailY + ')\\p1}m 0 0 l ' + Math.round(24 * S) + ' 0 l ' + Math.round(6 * S) + ' ' + Math.round(24 * S) + '{\\p0}\n');
      }
    }
    // Puisi: kata tersusun VERTIKAL (1 kata per baris), kata yang sedang
    // diucapkan LEBIH BESAR (1,5x), kata lain lebih kecil (0,7x) + memudar.
    // Per-word windows: tiap jendela kata menampilkan SEMUA kata chunk
    // tersusun vertikal, kata aktif besar.
    if (sp.vertical) {
      ch.words.forEach((wAct, wi) => {
        let ws = hookTotal + Math.max(0, wAct.start - start);
        let we = wi + 1 < ch.words.length
          ? hookTotal + Math.max(0, ch.words[wi + 1].start - start)
          : ge;
        if (hp.holdSub) ws = Math.max(ws, holdUntil);
        if (we <= ws) return;
        const vTop = Math.round(OUT_H * 0.30);
        const lines = ch.words.map((w) => {
          if (w.sensor) return null;
          const txt = escapeAssText(dispText(w));
          if (!txt) return null;
          const wc = wordColorTag(w);
          if (w === wAct) return '{\\fs' + Math.round(size * 1.5) + '}' + (wc ? '{\\c' + wc + '&}' : '') + txt + '{\\fs' + size + '}';
          return '{\\fs' + Math.round(size * 0.7) + '}{\\alpha&H80&}' + (wc ? '{\\c' + wc + '&}' : '') + txt + '{\\alpha&H00&\\fs' + size + '}';
        }).filter(Boolean);
        if (!lines.length) return;
        // Puisi: fade lembut (anim 'fade' preset) — fadOf(subAnimTag).
        out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Default,,0,0,0,,' + fadOf(subAnimTag) + '{\\pos(' + CX + ',' + vTop + ')\\an8}' + lines.join('\\N') + '\n');
      });
      return;
    }
    // Bebas: tipografi kinetik bebas — kata sebelumnya tampil KECIL (0,5x)
    // memudar di atas, kata berjalan tampil SANGAT BESAR (2x) rata tengah.
    if (sp.freeKinetic) {
      ch.words.forEach((wAct, wi) => {
        let ws = hookTotal + Math.max(0, wAct.start - start);
        let we = wi + 1 < ch.words.length
          ? hookTotal + Math.max(0, ch.words[wi + 1].start - start)
          : ge;
        if (hp.holdSub) ws = Math.max(ws, holdUntil);
        if (we <= ws) return;
        const prev = wi > 0 ? ch.words[wi - 1] : null;
        if (prev && !prev.sensor) {
          const pt = escapeAssText(dispText(prev));
          if (pt) out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Default,,0,0,0,,' + '{\\pos(' + CX + ',' + Math.round(OUT_H * 0.35) + ')\\an8\\fs' + Math.round(size * 0.5) + '\\alpha&H80&}' + pt + '\n');
        }
        if (!wAct.sensor) {
          const ct = escapeAssText(dispText(wAct));
          if (ct) {
            const wc = wordColorTag(wAct);
            // Bebas: pop + miring 3° lalu lurus (anim 'rotate' preset) di kata berjalan.
            out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Default,,0,0,0,,' + '{\\pos(' + CX + ',' + Math.round(OUT_H * 0.5) + ')\\an8\\fs' + Math.round(size * 2) + wordAnimInner + '}' + (wc ? '{\\c' + wc + '&}' : '') + ct + '\n');
          }
        }
      });
      return;
    }
    if (isKaraoke) {
      // Per kata: satu event per baris, [kata_j.start, kata_{j+1}.start).
      ch.words.forEach((wAct, wi) => {
        let ws = hookTotal + Math.max(0, wAct.start - start);
        const we = wi + 1 < ch.words.length
          ? hookTotal + Math.max(0, ch.words[wi + 1].start - start)
          : ge;
        if (hp.holdSub) ws = Math.max(ws, holdUntil);
        if (we <= ws) return;
        ch.lines.forEach((lineWords, li) => {
          let line = '';
          let hasText = false;
          lineWords.forEach((w) => {
            if (w.sensor) return; // sensor: disembunyikan
            const txt = escapeAssText(dispText(w));
            if (!txt) return;
            hasText = true;
            const wc = wordColorTag(w);
            if (wc) line += '{\\c' + wc + '&}' + txt + '{\\c' + normalColor + '&} ';
            else if (isKeyword(w)) line += '{\\c' + popColor + '&}{\\fs' + popSize + '}' + txt + '{\\c' + normalColor + '&}{\\fs' + size + '} ';
            else if (w === wAct) line += '{\\c' + karaokeSec + '&' + wordAnimInner + '}' + txt + '{\\c' + normalColor + '&\\fscx100\\fscy100} ';
            else line += txt + ' ';
          });
          if (!hasText) return;
          const mv = kBase + (kTotal - 1 - li) * lineH;
          // Pill (kata aktif di dalam kapsul pill biru) / Kertas (sorotan
          // stabilo kuning di belakang kata aktif): rect di belakang kata
          // aktif, digambar SEBELUM event teks (urutan file = urutan gambar).
          if (lineWords.indexOf(wAct) >= 0 && (sp.pill || sp.highlight || (sov && sov.activeMode === 'kotak'))) {
            const hlHex = String(sp.pill ? (sp.pillColor || '#2563EB') : sp.highlight ? (sp.highlight || '#FFFF00') : ((sov && sov.activeColor) || '#2563EB')).replace('#', '').toUpperCase();
            const ex = estWordX(lineWords, wAct);
            const pad = Math.round(8 * S);
            out.push(boxRectEvent('BoxRect_' + hlHex, ws, we,
              ex.x - pad, OUT_H - mv - lineH - pad, ex.w + pad * 2, lineH + pad * 2, ''));
          }
          // Pantul: garis bawah aksen pink-merah di bawah kata aktif.
          if (lineWords.indexOf(wAct) >= 0 && sp.underline) {
            const ulHex = String(sp.underline).replace('#', '').toUpperCase();
            const ex = estWordX(lineWords, wAct);
            out.push(boxRectEvent('BoxRect_' + ulHex, ws, we,
              ex.x, OUT_H - mv - Math.round(6 * S), ex.w, Math.round(4 * S), ''));
          }
          // Glow kata aktif (preset berglow di presets.json, mis. Karaoke
          // spek spreadsheet): salinan kata aktif sewarna penuh dengan
          // \\bord8\\blur8 sebagai event TERPISAH di belakang teks.
          // (Tag span langsung terbukti jadi kabut menutupi baris pada gaya
          // berkotak/BorderStyle 3 — terverifikasi frame render uji.)
          if (lineWords.indexOf(wAct) >= 0 && (sp.glow || (sov && sov.activeMode === 'glow')) && !wAct.sensor) {
            const ex = estWordX(lineWords, wAct);
            const gTxt = escapeAssText(dispText(wAct));
            if (gTxt) out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Default,,0,0,0,,{\\pos(' + (ex.x + Math.round(18 * S)) + ',' + (OUT_H - mv - lineH) + ')\\an7\\c' + karaokeSec + '&\\3c' + karaokeSec + '&\\bord' + (sp.glow ? Math.max(0, Math.round(+sp.glow.bord || 8)) : 8) + '\\blur' + (sp.glow ? Math.max(0, Math.round(+sp.glow.blur || 8)) : 8) + wordAnimInner + '}' + gTxt + '\n'); // +18*S: kalibrasi bearing teks \pos vs estimator (terukur -27px @1080)
          }
          out.push('Dialogue: 0,' + fmtAss(ws) + ',' + fmtAss(we) + ',Default,,0,0,' + mv + ',,' + (subItalic ? '{\\i1}' : '') + line.trimEnd() + '\n');
        });
      });
    } else {
      // Plain: satu event per chunk (seluruh chunk sekaligus).
      const rendered = ch.lines.map(lineWords => lineWords.map(w => {
        if (w.sensor) return null;
        const txt = escapeAssText(dispText(w));
        if (!txt) return null;
        const wc = wordColorTag(w);
        if (wc) return '{\\c' + wc + '&}' + txt + '{\\c' + normalColor + '&}';
        return isKeyword(w)
          ? '{\\fs' + popSize + '}{\\c' + popColor + '&}' + txt + '{\\c' + normalColor + '&}{\\fs' + size + '}'
          : txt;
      }).filter(v => v !== null).join(' ')).filter(l => l).join('\\N');
      if (!rendered) return;
      const mv = subMarginVFor(kTotal);
      // Chat (slide-up + pop bubble): \move butuh koordinat absolut —
      // top blok = OUT_H - MarginV - tinggi blok. Gaya lain pakai subAnimTag.
      let groupTag = subAnimTag;
      if (sp.anim === 'slidepop') {
        const top = Math.max(0, OUT_H - mv - kTotal * lineH);
        groupTag = '{\\an8\\move(' + CX + ',' + (top + Math.round(30 * S)) + ',' + CX + ',' + top + ',0,200)\\fscx85\\fscy85\\t(0,200,\\fscx100\\fscy100)}{\\fad(100,100)}';
      }
      out.push('Dialogue: 0,' + fmtAss(gs) + ',' + fmtAss(ge) + ',Default,,0,0,' + mv + ',,' + (subItalic ? '{\\i1}' : '') + groupTag + rendered + '\n');
      // Chat: frasa sebelumnya tampil lebih kecil + memudar di atas.
      if (sp.bubble && ci > 0) {
        const pc = chunks[ci - 1];
        const pText = pc.lines.map(lw => lw.map(w => (w.sensor ? null : escapeAssText(dispText(w)))).filter(Boolean).join(' ')).filter(Boolean).join('\\N');
        if (pText) {
          const pMv = mv + kTotal * lineH + Math.round(20 * S);
          out.push('Dialogue: 0,' + fmtAss(gs) + ',' + fmtAss(ge) + ',Default,,0,0,' + pMv + ',,{\\fs' + Math.round(size * 0.7) + '}{\\alpha&H80&}' + pText + '\n');
        }
      }
    }
  });
  return out.join('');
}

// Validasi + rapikan kandidat klip dari AI.
// - start/end angka, 0 <= start < end <= videoDuration
// - panjang klip 10 detik s/d (targetDur + 30) detik
// - judul dibersihkan, skor 0-100
// - kandidat yang tumpang tindih > 50% (yang skornya lebih rendah) dibuang
// - urut skor tertinggi, ambil maksimal `count`
// Resolusi mode durasi judul efektif (satu sumber: buildAss + preview):
// 'auto' -> saran AI (hookDurAi 'full'/'short'); tanpa saran -> aturan:
// klip <= 35 dtk judul sepanjang klip, lebih panjang -> default 4 detik.
// Info duo (Fase 3 — Auto pintar): seberapa sering DUA wajah besar tampil
// berdampingan dalam track wajah. Mode Auto memakainya buat mutusin: duo ->
// Landscape (muat utuh + background blur, dua-duanya kelihatan), bukan crop
// tracking 1 orang. Wajah dihitung "besar" bila lebarnya >= 5% lebar sumber;
// "berdampingan" bila jarak pusatnya >= 22% lebar sumber. Duo dinyatakan
// bila >= 40% sampel (yang ada wajahnya) berdua dan sampel >= 4.
function clipDuoInfo(track, srcW) {
  const W = +srcW || 0;
  if (!Array.isArray(track) || !track.length || W <= 0) return { ratio: 0, duo: false, samples: 0 };
  let duoN = 0, n = 0;
  for (const s of track) {
    const faces = (s && Array.isArray(s.faces)) ? s.faces.filter(f => f && (+f.w || 0) >= W * 0.05) : [];
    if (!faces.length) continue;
    n++;
    let isDuo = false;
    for (let i = 0; i < faces.length && !isDuo; i++) for (let j = i + 1; j < faces.length; j++) {
      const ci = (+faces[i].x || 0) + (+faces[i].w || 0) / 2, cj = (+faces[j].x || 0) + (+faces[j].w || 0) / 2;
      if (Math.abs(ci - cj) >= W * 0.22) { isDuo = true; break; }
    }
    if (isDuo) duoN++;
  }
  const ratio = n ? duoN / n : 0;
  return { ratio, duo: n >= 4 && ratio >= 0.4, samples: n };
}
// Kualitas track wajah (tuning 23 Okt): seberapa sering jendela crop hasil
// tracking BENAR-BENAR berisi wajah. faceIn = sampel berwajah yang minimal
// satu pusat wajahnya di dalam [x, x+cropW], dibagi sampel berwajah. Dipakai
// gerbang fallback: tracking jelek -> render Landscape blur daripada crop
// meleset (ke meja / tempat kosong).
function clipTrackQuality(track, cropW) {
  const cw = +cropW || 0;
  if (!Array.isArray(track) || !track.length || cw <= 0) return { faceIn: 0, bearing: 0, samples: 0 };
  let bearing = 0, inside = 0;
  for (const s of track) {
    const faces = (s && Array.isArray(s.faces)) ? s.faces : [];
    if (!faces.length || !Number.isFinite(+s.x)) continue;
    bearing++;
    const x = +s.x;
    if (faces.some(f => { const c = (+f.x || 0) + (+f.w || 0) / 2; return c >= x - 1 && c <= x + cw + 1; })) inside++;
  }
  return { faceIn: bearing ? inside / bearing : 0, bearing, samples: track.length };
}
// Framing per-bagian (permintaan Dzaky 23 Okt): dari sampel kehadiran wajah
// [{t, face, cx}] bangun (a) daftar segmen ADA MUKA (sisanya Landscape) dan
// (b) track sintetis [{t, x}] (x = tepi kiri crop 9:16 dari median cx per
// segmen) untuk segmen muka. Run yang lebih pendek dari minRun (detik)
// digabung ke tetangga biar tidak kedip-kedip ganti mode. Fungsi murni.
function clipPresenceSegs(samples, len, width, cropW) {
  const L = Math.max(0.1, +len || 0);
  const arr = (Array.isArray(samples) ? samples : []).filter(x => x && Number.isFinite(+x.t)).sort((a, b) => a.t - b.t);
  if (!arr.length || !(+width > 0) || !(+cropW > 0)) return { faceSegs: [], track: null, faceRatio: 0 };
  const minRun = 1.5;
  const runs = [];
  for (let i = 0; i < arr.length; i++) {
    const t0 = Math.max(0, +arr[i].t), t1 = (i + 1 < arr.length) ? +arr[i + 1].t : L;
    const f = !!arr[i].face;
    if (runs.length && runs[runs.length - 1].face === f) runs[runs.length - 1].end = Math.min(L, t1);
    else runs.push({ start: t0, end: Math.min(L, t1), face: f, cx: [] });
    if (f && Number.isFinite(+arr[i].cx)) runs[runs.length - 1].cx.push(+arr[i].cx);
  }
  // Gabung run pendek ke tetangga yang lebih panjang (berulang sampai stabil).
  for (let guard = 0; guard < 24; guard++) {
    const i = runs.findIndex(r => (r.end - r.start) < minRun && runs.length > 1);
    if (i < 0) break;
    const prev = runs[i - 1], next = runs[i + 1];
    const host = (!prev) ? next : (!next) ? prev : ((prev.end - prev.start) >= (next.end - next.start) ? prev : next);
    host.cx = host.cx.concat(runs[i].cx);
    host.start = Math.min(host.start, runs[i].start); host.end = Math.max(host.end, runs[i].end);
    runs.splice(i, 1);
    // Rapikan tumpang tindih setelah gabung.
    runs.sort((a, b) => a.start - b.start);
    for (let k = 1; k < runs.length; k++) if (runs[k].start < runs[k - 1].end) runs[k].start = runs[k - 1].end;
  }
  const faceSegs = runs.filter(r => r.face && r.end > r.start).map(r => ({ start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100 }));
  const faceSamples = arr.filter(x => x.face).length;
  let track = null;
  const faceRuns = runs.filter(r => r.face && r.cx.length);
  if (faceRuns.length) {
    const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    track = faceRuns.map(r => ({ t: Math.round(r.start * 100) / 100, x: Math.round(Math.min(Math.max(med(r.cx) - cropW / 2, 0), Math.max(0, width - cropW))) }));
    if (track.length === 1) track.push({ t: Math.round(L * 100) / 100, x: track[0].x });
  }
  return { faceSegs, track, faceRatio: arr.length ? faceSamples / arr.length : 0 };
}
// Auto frame per-segmen (aturan Dzaky 24 Okt — ganti putusan duo satu-klip
// Fase 3): dari track face_track.py [{t, x, speaking, faces:[{x,w,mouth}]}]
// bangun segmen PORTRAIT (crop 9:16 ikut pembicara) vs LANDSCAPE.
// Per sampel: wajah "besar" = w >= 5% lebar sumber (sama seperti duo);
// "ngomong" = mouth > 2.0 (MOUTH_THRESHOLD face_track.py). Aturan per
// sampel: tanpa wajah besar ATAU >= 2 wajah besar ngomong -> Landscape;
// sisanya (solo, 1 ngomong, atau pendengar diam — crop ikut kunci
// pembicara) -> Portrait. Run < 1,5 dtk digabung ke tetangga (sama
// seperti clipPresenceSegs) biar tidak kedip. Fungsi murni.
function clipTalkerSegs(track, len, srcW) {
  const W = +srcW || 0, L = Math.max(0.1, +len || 0);
  const arr = (Array.isArray(track) ? track : []).filter(s => s && Number.isFinite(+s.t)).sort((a, b) => a.t - b.t);
  if (!arr.length || W <= 0) return { portraitSegs: [], landscapeSegs: [], samples: 0 };
  const runs = [];
  for (let i = 0; i < arr.length; i++) {
    const t0 = Math.max(0, +arr[i].t), t1 = (i + 1 < arr.length) ? +arr[i + 1].t : L;
    if (t1 <= t0) continue;
    const faces = Array.isArray(arr[i].faces) ? arr[i].faces.filter(f => f && (+f.w || 0) >= W * 0.05) : [];
    const talking = faces.filter(f => (+f.mouth || 0) > 2.0).length;
    const kind = (faces.length === 0 || talking >= 2) ? 'land' : 'port';
    if (runs.length && runs[runs.length - 1].kind === kind) runs[runs.length - 1].end = Math.min(L, t1);
    else runs.push({ start: t0, end: Math.min(L, t1), kind });
  }
  // minRun 1,0 dtk (fix 24 Okt malam): ikut SpeakerLock (pindah pembicara
  // per 2 frame @ fps 2 = 1,0 dtk). Solo 1 dtk selamat; blip 1 sampel
  // (0,5 dtk, noise tracker) tetap digabung. Aturan 1,5 dtk tetap berlaku
  // di clipPresenceSegs (gap tanpa-muka), bukan di sini.
  const minRun = 1.0;
  for (let guard = 0; guard < 24; guard++) {
    const i = runs.findIndex(r => (r.end - r.start) < minRun && runs.length > 1);
    if (i < 0) break;
    const prev = runs[i - 1], next = runs[i + 1];
    const host = (!prev) ? next : (!next) ? prev : ((prev.end - prev.start) >= (next.end - next.start) ? prev : next);
    host.start = Math.min(host.start, runs[i].start); host.end = Math.max(host.end, runs[i].end);
    runs.splice(i, 1);
    runs.sort((a, b) => a.start - b.start);
    for (let k = 1; k < runs.length; k++) if (runs[k].start < runs[k - 1].end) runs[k].start = runs[k - 1].end;
  }
  // Gabung run sejenis yang berdampingan (sisa dari merge run pendek).
  const merged = [];
  for (const r of runs) {
    if (merged.length && merged[merged.length - 1].kind === r.kind && Math.abs(merged[merged.length - 1].end - r.start) < 0.01) merged[merged.length - 1].end = r.end;
    else merged.push({ start: r.start, end: r.end, kind: r.kind });
  }
  runs.length = 0; runs.push(...merged);
  const round = r => ({ start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100 });
  return {
    portraitSegs: runs.filter(r => r.kind === 'port' && r.end > r.start).map(round),
    landscapeSegs: runs.filter(r => r.kind === 'land' && r.end > r.start).map(round),
    samples: arr.length,
  };
}
function resolveTitleDurMode(titleDur, hookDurAi, clipDur) {
  if (titleDur === 'full') return 'full';
  if (titleDur === 'manual') return 'manual';
  if (titleDur === '5s') return '5s';
  if (titleDur === 'auto') {
    if (hookDurAi === 'full') return 'full';
    if (hookDurAi === 'short') return 'default';
    return clipDur <= 35 ? 'full' : 'default';
  }
  return 'default';
}
// ASS poster COVER (Fase 2, gaya ClipperStudio Smart Cover): teks cover
// BESAR di sepertiga atas frame 1080x1920 — pisah dari judul hook di video.
// Kata yang ditulis HURUF BESAR semua (min 3 huruf) tampil KUNING, sisanya
// putih; pinggiran hitam tebal biar kebaca di frame apa pun. Wrap manual
// maks ~15 karakter/baris, maks 4 baris.
function buildCoverAss(text, opts) {
  // Smart Cover gaya KARTU (keputusan Dzaky 23 Okt, ganti gaya teks besar
  // ClipperStudio): kotak putih sudut membulat + teks judul HITAM tebal
  // Montserrat di tengah kotak — persis kartu judul di kartu Detail.
  // Posisi kotak: TENGAH kotak di yPercent% tinggi frame (bawaan 65,
  // mengikuti posisi subtitle klip — server meneruskan cand.subYPercent).
  const esc = (t) => String(t || '').replace(/[{}]/g, '').replace(/\\s+/g, ' ').trim();
  const words = esc(text).split(' ').filter(Boolean).slice(0, 14);
  // Bungkus SEIMBANG: pecah kata jadi <= maxLines baris dengan panjang
  // semirip mungkin (DP kecil — kata <= 14) dan tiap baris <= maxCh.
  function wrapBalanced(ws, maxLines, maxCh) {
    const n = ws.length;
    if (!n) return [];
    let best = null;
    const lens = ws.map(w => w.length);
    const cost = (lines) => {
      const ls = lines.map(l => l.join(' ').length);
      if (ls.some(x => x > maxCh)) return Infinity;
      const avg = ls.reduce((a, b) => a + b, 0) / ls.length;
      return ls.reduce((a, l) => a + (l - avg) * (l - avg), 0) + ls.length;
    };
    const rec = (i, lines) => {
      if (i >= n) { const c = cost(lines); if (best === null || c < best.c) best = { c, lines: lines.map(l => l.slice()) }; return; }
      if (lines.length >= maxLines) return;
      for (let j = i; j < n; j++) { lines.push(ws.slice(i, j + 1)); rec(j + 1, lines); lines.pop(); }
    };
    rec(0, []);
    return best ? best.lines : [ws];
  }
  // Ukuran font bertangga: lebar teks maks 916px (frame 1080, kotak maks
  // 1008 + padding 46/sisi). Lebar aksara Montserrat bold ~ 0,54 x fs
  // (metrik sama dengan geometri kotak judul di buildAss).
  const MAX_TEXT_W = 916;
  let fs = 68, lines = wrapBalanced(words, 3, Math.floor(MAX_TEXT_W / (fs * 0.54)));
  if (!lines.length || lines.some(l => l.join(' ').length * fs * 0.54 > MAX_TEXT_W)) { fs = 60; lines = wrapBalanced(words, 3, Math.floor(MAX_TEXT_W / (fs * 0.54))); }
  if (!lines.length || lines.some(l => l.join(' ').length * fs * 0.54 > MAX_TEXT_W)) { fs = 52; lines = wrapBalanced(words, 4, Math.floor(MAX_TEXT_W / (fs * 0.54))); }
  if (!lines.length) lines = [words];
  const lineTexts = lines.map(l => l.join(' '));
  const maxLineW = Math.max.apply(null, lineTexts.map(t => t.length * fs * 0.54));
  const padX = 46, padTop = 28, padBot = 30;
  const lineH = Math.round(fs * 1.22);
  const boxW = Math.min(1080 - 48, Math.round(maxLineW) + padX * 2);
  const boxH = lineTexts.length * lineH + padTop + padBot;
  let yPct = +(opts && opts.yPercent);
  if (!Number.isFinite(yPct)) yPct = 65;
  yPct = Math.min(88, Math.max(12, yPct));
  const centerY = Math.round(1920 * yPct / 100);
  const boxY = Math.min(1920 - boxH - 20, Math.max(20, Math.round(centerY - boxH / 2)));
  const boxX = Math.round((1080 - boxW) / 2);
  // Path kotak sudut membulat (bezier kubik, pola sama dengan roundedRectPath
  // kotak judul di buildAss; radius 30 @1080).
  const roundedRectPath = (w, h) => {
    const r = Math.max(1, Math.min(30, Math.floor(Math.min(w, h) / 2)));
    const k = 0.45, a = Math.round(r * k), b = r - a;
    return 'm ' + r + ' 0 l ' + (w - r) + ' 0 b ' + (w - a) + ' 0 ' + w + ' ' + a + ' ' + w + ' ' + r
      + ' l ' + w + ' ' + (h - r) + ' b ' + w + ' ' + (h - a) + ' ' + (w - a) + ' ' + h + ' ' + (w - r) + ' ' + h
      + ' l ' + r + ' ' + h + ' b ' + a + ' ' + h + ' 0 ' + (h - a) + ' 0 ' + (h - r)
      + ' l 0 ' + r + ' b 0 ' + a + ' ' + a + ' 0 ' + r + ' 0 c';
  };
  const ev = [];
  ev.push('Dialogue: 0,0:00:00.00,0:00:01.00,CoverBox,,0,0,0,,{\\an7\\pos(' + boxX + ',' + boxY + ')\\p1}' + roundedRectPath(boxW, boxH) + '{\\p0}');
  lineTexts.forEach((t, i) => {
    ev.push('Dialogue: 1,0:00:00.00,0:00:01.00,Cover,,0,0,0,,{\\an8\\pos(540,' + (boxY + padTop + i * lineH) + ')}' + t);
  });
  return '[Script Info]\nTitle: Cover\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n'
    + '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    + 'Style: CoverBox,DejaVu Sans,10,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n'
    + 'Style: Cover,Montserrat,' + fs + ',&H00000000,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1\n\n'
    + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + ev.join('\n') + '\n';
}

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
      list.push({ start, end, origStart: Number.isFinite(+c.origStart) ? Math.round(+c.origStart * 100) / 100 : start, origEnd: Number.isFinite(+c.origEnd) ? Math.round(+c.origEnd * 100) / 100 : end, title, score, reason: cleanTitle(c.reason, 200), hook,
        // Caption + hashtag per klip (gaya Klipaja: caption + # siap posting).
        // AI diminta mengisinya di prompt; klip lama / tanpa AI = kosong.
        caption: cleanTitle(c.caption, 280),
        // Saran AI buat durasi judul hook (Fase 2, gaya ClipperStudio "AI
        // pilihkan"): 'full' = judul layak tampil sepanjang klip, 'short' =
        // cukup sebentar di awal. Dipakai buildAss saat titleDur='auto'.
        hookDurAi: (c.hookDur === 'full' || c.hookDur === 'short') ? c.hookDur : undefined,
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
  if (dur <= len) return [{ start: 0, end: dur, origStart: 0, origEnd: dur, title: 'Momen terbaik video ini', score: 50, reason: 'Satu-satunya segmen (video lebih pendek dari durasi klip).', caption: '', hashtags: [] }];
  const step = (dur - len) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round(i * step * 100) / 100;
    out.push({ start, end: Math.round((start + len) * 100) / 100, origStart: start, origEnd: Math.round((start + len) * 100) / 100, title: 'Momen terbaik bagian ' + (i + 1), score: 50 - i, reason: 'Pembagian merata (AI tidak mengembalikan kandidat).', caption: '', hashtags: [] });
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

// Ekspresi X time-varying (STEP / hard cut per segmen, model Klipaja)
// untuk filter crop. ft = [{t, x}] — x SUDAH per-segmen (face_track.py:
// tiap titik diganti MEDIAN segmen pembicaranya). faceTrackExpr HANYA
// membuat fungsi tangga: tahan x[i] untuk [t[i], t[i+1]), lalu STEP ke
// x[i+1] tepat di t[i+1] (TANPA interpolasi / glide). Dalam satu segmen
// crop DIAM TOTAL (kepala bergerak di dalam frame, latar tetap); ganti
// pembicara = HARD CUT (~0 dtk / 1 frame) ke framing berikutnya.
// Return null bila < 2 titik valid (caller pakai fallback). Dipakai
// Podcast + Gameplay facecam + Split. Titik berurutan dengan x SAMA
// (satu segmen) digabung (t pertama run) agar ekspresi tidak berulang.
function faceTrackExpr(ft) {
  const arr = (Array.isArray(ft) ? ft : []).filter(p => p && Number.isFinite(p.t) && Number.isFinite(p.x)).sort((a, b) => a.t - b.t).slice(0, 120);
  if (arr.length < 2) return null;
  // Gabung run x sama (satu segmen) -> satu titik per run (t pertama).
  const pts = [];
  for (const p of arr) {
    const x = Math.round(p.x);
    if (pts.length && pts[pts.length - 1].x === x) continue;
    pts.push({ t: p.t, x });
  }
  if (pts.length < 2) return String(pts[0].x);
  let expr = String(pts[pts.length - 1].x);
  for (let i = pts.length - 2; i >= 0; i--) {
    expr = 'if(lt(t,' + pts[i + 1].t + '),' + pts[i].x + ',' + expr + ')';
  }
  return 'if(lt(t,' + pts[0].t + '),' + pts[0].x + ',' + expr + ')';
}
// Tinggi panel atas Gameplay (~2/3 OH), dibulatkan ke kelipatan 2 terdekat
// (yuv420p/libx264 menolak tinggi ganjil). Dipakai buildFfmpegArgs (panel)
// + server.js (subCenterY = sambungan game/facecam). 720p: 854, 1080p: 1280.
function gameplayTopH(OH) { return Math.round(OH * 2 / 3 / 2) * 2; }

function faceTrackExpr(ft) {
  const arr = (Array.isArray(ft) ? ft : []).filter(p => p && Number.isFinite(p.t) && Number.isFinite(p.x)).sort((a, b) => a.t - b.t).slice(0, 120);
  if (arr.length < 2) return null;
  // Gabung run x sama (satu segmen) -> satu titik per run (t pertama).
  const pts = [];
  for (const p of arr) {
    const x = Math.round(p.x);
    if (pts.length && pts[pts.length - 1].x === x) continue;
    pts.push({ t: p.t, x });
  }
  if (pts.length < 2) return String(pts[0].x);
  // Fungsi tangga murni: tahan x[i] untuk [t[i], t[i+1]), STEP di t[i+1].
  let expr = String(pts[pts.length - 1].x);
  for (let i = pts.length - 2; i >= 0; i--) {
    expr = 'if(lt(t,' + pts[i + 1].t + '),' + pts[i].x + ',' + expr + ')';
  }
  return 'if(lt(t,' + pts[0].t + '),' + pts[0].x + ',' + expr + ')';
}

// Bangun argumen ffmpeg untuk satu klip (tanpa shell — dipakai via spawn argv).
// out: OW x OH (default 720x1280; 1080p = 1080x1920 via o.outW/o.outH).
// bg: 'blur' | 'black' | 'white'. subtitle: path file SRT atau null.
// fontFile: path .ttf judul. fontColor: '#RRGGBB' (sudah divalidasi).
// plainOnly: render video POLOS saja (tanpa judul/subtitle) — dipakai sebagai cache
//   (video polos) agar render ulang judul/subtitle tidak perlu re-encode video lagi.
// overlayOnly: input SUDAH video polos (hasil plainOnly) — lewati scale/blur/crop,
//   hanya timpa judul + subtitle (encode ulang saja, jauh lebih ringan CPU-nya).
// crop11: Crop 1:1 (kotak tengah sumber -> OW x OW di tengah frame, fill
//   blur/hitam/putih di atas-bawah, ikut bg).
// gameplay: Gameplay (game crop tengah panel atas 2/3 + facecam face-tracked
//   panel bawah 1/3, vstack -> OW x OH; subtitle di sambungan via subCenterY).
function buildFfmpegArgs(o) {
  const start = +o.start || 0;
  const len = Math.max(1, (+o.end || 0) - start);
  const bg = ['black', 'white'].includes(o.bg) ? o.bg : 'blur';
  // Resolusi output: o.outW/o.outH (default 720x1280; 1080p = 1080x1920).
  // Semua scale/crop/pad diskala dari OW/OH. 720p = nilai lama persis.
  const OW = (Number.isFinite(+o.outW) && +o.outW > 0) ? Math.round(+o.outW) : 720;
  const OH = (Number.isFinite(+o.outH) && +o.outH > 0) ? Math.round(+o.outH) : 1280;
  const OS = OW / 720;
  // overlayOnly: input adalah video polos (sudah 720x1280) — potong dari awal
  // (tidak perlu -ss karena file polos sudah tepat durasi klipnya).
  const args = o.overlayOnly ? ['-i', o.input] : ['-ss', String(start), '-i', o.input, '-t', String(len)];
  // B-roll (Final saja, BUKAN plainOnly/RAW): footage pelengkap yang
  // MENGGANTIKAN video utama selama jendela [start, start+dur] (audio utama
  // terus jalan, B-roll DIBISUKAN — audio B-roll tidak pernah di-map).
  // Input B-roll di-loop FINITE (o.broll.loop, dihitung server dari durasi
  // footage + durasi output) biar footage pendek tetap nutup jendela TANPA
  // bikin output jalan tak hingga: -stream_loop -1 TERBUKTI bikin ffmpeg
  // tidak pernah berhenti (filtergraph tidak pernah dapat EOF, output
  // 6 detik jadi 12+ menit). Output juga dibatasi -t o.outputDur (bila
  // diisi) sebagai jaring pengaman.
  const brollRaw = (o.broll && typeof o.broll === 'object') ? o.broll : null;
  const brollClipLen = brollRaw && Number.isFinite(+brollRaw.clipLen) ? +brollRaw.clipLen : len;
  let broll = null;
  if (!o.plainOnly && brollRaw && brollRaw.path) {
    const bs = Number.isFinite(+brollRaw.start) ? Math.max(0, +brollRaw.start) : Math.max(0, (brollClipLen - Math.min(4, brollClipLen)) / 2);
    const bd = Math.min(Math.max(0.5, Number.isFinite(+brollRaw.dur) ? +brollRaw.dur : 4), Math.max(0.5, brollClipLen - bs));
    const loop = Number.isFinite(+brollRaw.loop) ? Math.max(0, Math.floor(+brollRaw.loop)) : 0;
    if (bd > 0 && bs < brollClipLen) {
      broll = { path: String(brollRaw.path), start: Math.round(bs * 100) / 100, dur: Math.round(bd * 100) / 100 };
      if (loop > 0) args.push('-stream_loop', String(loop));
      args.push('-i', broll.path);
    }
  }
  // Musik Latar (tab Video, GRATIS): file audio user di-loop (-stream_loop
  // -1) lalu di-mix di bawah suara utama (amix, volume musik default 0,2).
  // Input musik = setelah B-roll (indeks 2 bila B-roll ada, 1 bila tidak).
  const musicRaw = (o.music && typeof o.music === 'object') ? o.music : null;
  let musicIdx = -1, musicVol = 0.2;
  if (!o.plainOnly && musicRaw && musicRaw.path) {
    musicVol = Math.min(1, Math.max(0, Number.isFinite(+musicRaw.volume) ? +musicRaw.volume : 0.2));
    musicIdx = broll ? 2 : 1;
    args.push('-stream_loop', '-1', '-i', String(musicRaw.path));
  }
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
    const xFor = pos => Math.round(Math.min(1, Math.max(0, +pos)) * Math.round(180 * OS));
    // Ekspresi nested if dari belakang. Model Klipaja: HARD CUT — tiap
    // segmen langsung pakai posisinya (STEP di batas segmen, tanpa glide /
    // transisi). t < s0 segmen -> posisi segmen SEBELUMNYA (gap antar
    // segmen menahan posisi sebelumnya); sebelum segmen pertama -> posisi
    // segmen pertama; sesudah segmen terakhir -> tengah (90). Pemilihan
    // pembicara TIDAK diubah — hanya geraknya yang jadi STEP (dulu: glide
    // smoothstep 0,35 dtk, crop meluncur antar pembicara).
    const defaultX = Math.round(90 * OS);
    let expr = String(defaultX);
    for (let i = speakers.length - 1; i >= 0; i--) {
      const sp = speakers[i];
      const x1 = xFor(sp.pos);
      const s0 = sp.start + hookTotal, e0 = sp.end + hookTotal;
      const beforeX = i > 0 ? xFor(speakers[i - 1].pos) : x1;
      expr = 'if(lt(t,' + s0 + '),' + beforeX + ',if(lt(t,' + e0 + '),' + x1 + ',' + expr + '))';
    }
    speakerExpr = "crop=w=" + Math.round(540 * OS) + ":h=" + Math.round(960 * OS) + ":x='" + expr + "':y=" + Math.round(140 * OS) + ",scale=" + OW + ":" + OH;
  }
  if (hook.length) {
    const n = hook.length + 1;
    filters.push('[0:v]split=' + n + hook.map((_, i) => '[spv' + i + ']').join('') + '[spvMain]');
    hook.forEach((h, i) => filters.push('[spv' + i + ']trim=start=' + h.start + ':end=' + h.end + ',setpts=PTS-STARTPTS[hs' + i + ']'));
    filters.push('[spvMain]setpts=PTS-STARTPTS[mainv]');
    if (o.hasAudio === false) {
      // Input TANPA audio: concat VIDEO saja (a=0, tanpa asplit/atrim/[outa])
      // — mereferensikan [0:a] yang tidak ada = "Invalid argument"
      // (matches no streams) dan render GAGAL TOTAL. Server mem-probe audio
      // video polos dan mengisi o.hasAudio; default (undefined) = ada audio.
      const concatIn = hook.map((_, i) => '[hs' + i + ']').join('') + '[mainv]';
      filters.push(concatIn + 'concat=n=' + n + ':v=1:a=0[outv]');
    } else {
      filters.push('[0:a]asplit=' + n + hook.map((_, i) => '[spa' + i + ']').join('') + '[spaMain]');
      hook.forEach((h, i) => filters.push('[spa' + i + ']atrim=start=' + h.start + ':end=' + h.end + ',asetpts=PTS-STARTPTS[ha' + i + ']'));
      filters.push('[spaMain]asetpts=PTS-STARTPTS[maina]');
      const concatIn = hook.map((_, i) => '[hs' + i + '][ha' + i + ']').join('') + '[mainv][maina]';
      filters.push(concatIn + 'concat=n=' + n + ':v=1:a=1[outv][outa]');
    }
    filters.push('[outv]format=yuv420p[v0]');
  } else if (o.overlayOnly) {
    filters.push('[0:v]format=yuv420p[v0]');
  } else if (o.podcast) {
    const ftExpr = faceTrackExpr(o.faceTrack);
    // Framing CAMPUR per-bagian (Dzaky 23 Okt): segmen ADA MUKA (o.mixFaceSegs,
    // detik relatif klip) tampil crop 9:16 full muka; di luar itu Landscape
    // (blur/pad sesuai bg). Dua rantai dibangun paralel lalu digabung overlay
    // dengan enable per segmen muka. Hanya bila ada track (ftExpr) — rantai
    // portrait memakai ekspresi tracking yang sama.
    const mixSegs = (ftExpr && Array.isArray(o.mixFaceSegs)) ? o.mixFaceSegs.filter(x => x && Number.isFinite(+x.start) && Number.isFinite(+x.end) && +x.end > +x.start) : [];
    if (mixSegs.length) {
      const enable = mixSegs.map(x => 'between(t,' + (+x.start) + ',' + (+x.end) + ')').join('+');
      const landChain = bg === 'white'
        ? 'scale=' + OW + ':' + OH + ':force_original_aspect_ratio=decrease,pad=' + OW + ':' + OH + ':(ow-iw)/2:(oh-ih)/2:white'
        : bg === 'black'
          ? 'scale=' + OW + ':' + OH + ':force_original_aspect_ratio=decrease,pad=' + OW + ':' + OH + ':(ow-iw)/2:(oh-ih)/2:black'
          : 'split[a][b];[a]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=increase,crop=' + OW + ':' + OH + ',gblur=sigma=40,eq=brightness=-0.18:contrast=1.05[mixbg];[b]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=decrease[mixfg];[mixbg][mixfg]overlay=(W-w)/2:(H-h)/2';
      filters.push('[0:v]split=2[mixP][mixL]');
      filters.push("[mixP]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='min(max((" + ftExpr + "),0),iw-ow)':y='(ih-oh)/2',scale=" + OW + ":" + OH + ",format=yuv420p[vport]");
      filters.push('[mixL]' + landChain + ',format=yuv420p[vland]');
      filters.push("[vland][vport]overlay=0:0:enable='" + enable + "',format=yuv420p[v0]");
    } else if (ftExpr) {
      // Crop time-varying STEP (model Klipaja): x dari face_track.py SUDAH
      // per-segmen (median segmen pembicara) -> faceTrackExpr membuat
      // fungsi tangga: crop DIAM sepanjang segmen, HARD CUT di batas
      // segmen. x dalam koordinat SUMBER. w/h pakai min() (tahan sumber
      // portrait). x di-clamp ke [0, iw-ow] biar tidak keluar frame.
      filters.push("[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='min(max((" + ftExpr + "),0),iw-ow)':y='(ih-oh)/2',scale=" + OW + ":" + OH + ",format=yuv420p[v0]");
    } else {
      const focus = Number.isFinite(+o.focus) ? Math.min(1, Math.max(0, +o.focus)) : 0.5;
      filters.push("[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='(iw-ow)*" + focus + "':y='(ih-oh)/2',scale=" + OW + ":" + OH + ",format=yuv420p[v0]");
    }
  } else if (o.split) {
    // SPLIT (2 pembicara atas-bawah, gaya OpenShorts/ViralCutter): 2 panel
    // OW x (OH/2), tiap panel crop 9:8 berpusat pada wajah panel itu (STEP
    // per segmen via faceTrackExpr — panel DIAM sepanjang segmen, HARD CUT
    // antar segmen), lalu vstack -> OW x OH.
    // Subtitle (.ass) diposisikan di SAMBUNGAN (y≈OH/2) lewat subCenterY.
    // o.splitTrack = {left: [{t, x}], right: [{t, x}]} (x = pusat wajah,
    // koordinat sumber, dari face_track.py --split). Tanpa track valid ->
    // FALLBACK belah dua tetap (kiri = 1/4 lebar, kanan = 3/4 lebar).
    const exprL = faceTrackExpr(o.splitTrack && o.splitTrack.left) || 'iw*0.25';
    const exprR = faceTrackExpr(o.splitTrack && o.splitTrack.right) || 'iw*0.75';
    const splitCrop = (expr) => "crop=w='min(iw,ih*9/8)':h='min(ih,iw*8/9)':x='min(max((" + expr + "-ow/2),0),iw-ow)':y='(ih-oh)/2'";
    filters.push('[0:v]split=2[spL][spR]');
    filters.push('[spL]' + splitCrop(exprL) + ',scale=' + OW + ':' + Math.round(OH / 2) + ',format=yuv420p[panL]');
    filters.push('[spR]' + splitCrop(exprR) + ',scale=' + OW + ':' + Math.round(OH / 2) + ',format=yuv420p[panR]');
    filters.push('[panL][panR]vstack=inputs=2,format=yuv420p[v0]');
  } else if (o.crop11) {
    // CROP 1:1 (gaya Klipaja): crop KOTAK di tengah sumber (sisi =
    // min(lebar, tinggi)), di-fit ke OW x OW, ditempatkan di tengah frame
    // OW x OH (fill blur/hitam/putih di atas-bawah, ikut bg).
    const sq = "crop=w='min(iw,ih)':h='min(iw,ih)':x='(iw-ow)/2':y='(ih-oh)/2'";
    if (bg === 'white') {
      filters.push('[0:v]' + sq + ',scale=' + OW + ':' + OW + ',pad=' + OW + ':' + OH + ':0:(' + OH + '-' + OW + ')/2:white,format=yuv420p[v0]');
    } else if (bg === 'black') {
      filters.push('[0:v]' + sq + ',scale=' + OW + ':' + OW + ',pad=' + OW + ':' + OH + ':0:(' + OH + '-' + OW + ')/2:black,format=yuv420p[v0]');
    } else {
      filters.push('[0:v]split[a][b];[a]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=increase,crop=' + OW + ':' + OH + ',gblur=sigma=40,eq=brightness=-0.18:contrast=1.05[bg];[b]' + sq + ',scale=' + OW + ':' + OW + '[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v0]');
    }
  } else if (o.gameplay) {
    // GAMEPLAY (gaya Klipaja): game (crop tengah, panel atas ~2/3 tinggi) +
    // facecam (crop ngikutin wajah / fokus, panel bawah ~1/3), vstack -> OW x OH.
    // Subtitle (.ass) diposisikan di SAMBUNGAN (y≈2/3 OH) lewat subCenterY.
    // Tanpa faceTrack valid -> facecam = crop tengah bawah (fokus).
    // topH HARUS GENAP (bulat ke kelipatan 2 terdekat): yuv420p/libx264
    // menolak tinggi ganjil (853/427 -> "height not divisible by 2" + crash
    // malloc pada ffmpeg saat encoder gagal buka). 720p: 854+426=1280.
    const topH = gameplayTopH(OH), botH = OH - topH;
    const gameCrop = "crop=w='min(iw,ih*" + OW + "/" + topH + ")':h='min(ih,iw*" + topH + "/" + OW + ")':x='(iw-ow)/2':y='(ih-oh)/2'";
    const ftExpr = faceTrackExpr(o.faceTrack);
    const faceX = ftExpr ? "min(max((" + ftExpr + "),0),iw-ow)" : "(iw-ow)*" + (Number.isFinite(+o.focus) ? Math.min(1, Math.max(0, +o.focus)) : 0.5);
    const faceCrop = "crop=w='min(iw,ih*" + OW + "/" + botH + ")':h='min(ih,iw*" + botH + "/" + OW + ")':x='" + faceX + "':y='(ih-oh)/2'";
    filters.push('[0:v]split=2[gm][fc]');
    filters.push('[gm]' + gameCrop + ',scale=' + OW + ':' + topH + ',format=yuv420p[panG]');
    filters.push('[fc]' + faceCrop + ',scale=' + OW + ':' + botH + ',format=yuv420p[panF]');
    filters.push('[panG][panF]vstack=inputs=2,format=yuv420p[v0]');
  } else if (bg === 'white') {
    filters.push('[0:v]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=decrease,pad=' + OW + ':' + OH + ':(ow-iw)/2:(oh-ih)/2:white,format=yuv420p[v0]');
  } else if (bg === 'blur') {
    // Background blur DIGELAPKAN (eq brightness -0,18 + contrast 1,05): blur
    // mentah dari sumber terang terlihat pucat/abu-abu — penggelapan bikin
    // latar lebih sinematik + teks di atasnya lebih kebaca. Video depan (fg)
    // TIDAK kena eq (hanya [bg]).
    filters.push('[0:v]split[a][b];[a]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=increase,crop=' + OW + ':' + OH + ',gblur=sigma=40,eq=brightness=-0.18:contrast=1.05[bg];[b]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v0]');
  } else {
    filters.push('[0:v]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=decrease,pad=' + OW + ':' + OH + ':(ow-iw)/2:(oh-ih)/2:black,format=yuv420p[v0]');
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
  // B-roll: scale/crop footage ke 720x1280 + overlay hanya selama jendela
  // (enable between). Di luar jendela, overlay menampilkan video utama.
  if (broll) {
    filters.push('[1:v]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=increase,crop=' + OW + ':' + OH + ',format=yuv420p[brollv]');
    filters.push('[' + last + "][brollv]overlay=0:0:enable='between(t," + broll.start + ',' + (Math.round((broll.start + broll.dur) * 100) / 100) + ")'[vovr]");
    last = 'vovr';
  }
  // Filter Cerah HD (Fase 21, permintaan Dzaky 24 Okt): cerah + kontras +
  // warna + denoise tipis + penajaman halus. Diterapkan ke VIDEO sebelum
  // subtitle dibakar (teks tetap bersih), hanya Final (bukan video polos),
  // hanya bila o.enhanceFx (batch kandidat bertanda fx 'cerah').
  if (o.enhanceFx && !o.plainOnly) {
    filters.push('[' + last + ']eq=brightness=0.05:contrast=1.08:saturation=1.12,hqdn3d=1.2:1.2:4:4,unsharp=5:5:0.7:5:5:0.3[venh]');
    last = 'venh';
  }
  if (!o.plainOnly && o.srtPath) {
    // File subtitle adalah .ass (buildAss) — gayanya sudah di dalam file
    // (PlayResX/Y 720x1280 + FontSize/MarginV/warna). Jangan pakai force_style
    // lagi (force_style + original_size terbukti tidak mengubah skala diuji).
    filters.push('[' + last + "]subtitles='" + ffmpegFilterPath(o.srtPath) + "':fontsdir='" + ffmpegFilterPath(o.fontsDir) + "'[v1]");
    last = 'v1';
  }
  // Output 30fps (Klipaja): paksa fps=30 agar output 30fps walau sumber
  // 25fps (filter fps menduplikasi/drop frame). Setelah subtitles agar
  // timing .ass (absolut) tetap pas dengan frame output.
  filters.push('[' + last + ']fps=30[vfps]');
  last = 'vfps';
  // Sensor kata (Koreksi Kata): bisukan audio di rentang kata yang di-sensor.
  // o.sensor = [{start, end}] waktu RELATIF output (sudah + hookTotal, dari
  // server). Audio: [outa] kalau hook (concat), kalau tidak 0:a mentah.
  // enable = between(t,a,b)+between(t,c,d) (OR) — satu filter volume cukup.
  const sensor = (Array.isArray(o.sensor) ? o.sensor : []).filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).slice(0, 20);
  let audioOut = null;
  // Tanpa audio (o.hasAudio === false): tidak ada yang dibisukan — SKIP
  // filter volume (mereferensikan [0:a]/[outa] yang tidak ada =
  // "Invalid argument" + render GAGAL TOTAL, tanpa retry bila hook off).
  if (sensor.length && o.hasAudio !== false && o.audioCodec !== null && o.audioCodec !== false) {
    const expr = sensor.map(s => 'between(t,' + s.start + ',' + s.end + ')').join('+');
    filters.push((hook.length ? '[outa]' : '[0:a]') + "volume=enable='" + expr + "':volume=0[aout]");
    audioOut = '[aout]';
  }
  // Musik Latar: campur audio utama + musik (amix, musik di volume
  // musicVol). Audio utama: [aout] (sensor) / [outa] (hook) / [maina]
  // (anull dari 0:a). Musik di-loop tak hingga, amix duration=shortest
  // memotong di panjang audio utama. Hanya bila klip punya audio utama
  // (tanpa audio utama, musik saja = edge case, dilewati).
  if (musicIdx >= 0 && o.hasAudio !== false && o.audioCodec !== null && o.audioCodec !== false) {
    let mainLabel;
    if (audioOut) mainLabel = 'aout';
    else if (hook.length) mainLabel = 'outa';
    else { filters.push('[0:a]anull[maina]'); mainLabel = 'maina'; }
    filters.push('[' + musicIdx + ':a]volume=' + musicVol + '[musica]');
    filters.push('[' + mainLabel + '][musica]amix=inputs=2:duration=shortest:normalize=0[amixout]');
    audioOut = '[amixout]';
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
  // Smart Cover jadi PEMBUKA Final (Fase 22, permintaan Dzaky): gambar cover
  // dibakar ±1 detik di PALING AWAL Final — ditambahkan SESUDAH semua olahan
  // (hook/subtitle/sensor/musik) supaya timing isi tidak bergeser sama
  // sekali; audio isi didahului hening se-durasi cover. Hanya Final
  // (overlayOnly) — video polos tidak pernah kena. File hasil unduhan jadi
  // membawa cover-nya (tampang awal pas diposting ke medsos = cover).
  if (o.coverPath && !o.plainOnly) {
    const covIdx = 1 + (broll ? 1 : 0) + (musicIdx >= 0 ? 1 : 0);
    args.push('-loop', '1', '-i', String(o.coverPath));
    const covDur = Number.isFinite(+o.coverDur) ? Math.min(3, Math.max(0.3, +o.coverDur)) : 1;
    filters.push('[' + covIdx + ':v]scale=' + OW + ':' + OH + ':force_original_aspect_ratio=increase,crop=' + OW + ':' + OH + ',trim=duration=' + covDur + ',setpts=PTS-STARTPTS,fps=30,format=yuv420p[covv]');
    const covHasAudio = o.audioCodec !== null && o.audioCodec !== false && o.hasAudio !== false;
    if (covHasAudio) {
      let mainA = null;
      if (audioOut) mainA = audioOut.slice(1, -1);
      else if (hook.length) mainA = 'outa';
      else { filters.push('[0:a]anull[maina]'); mainA = 'maina'; }
      filters.push('[' + mainA + ']aresample=44100,aformat=channel_layouts=stereo[maina2]');
      filters.push('anullsrc=r=44100:cl=stereo,atrim=duration=' + covDur + ',asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo[cova]');
      filters.push('[covv][' + last + ']concat=n=2:v=1:a=0[vcov]');
      filters.push('[cova][maina2]concat=n=2:v=0:a=1[acov]');
      last = 'vcov'; audioOut = '[acov]';
    } else {
      filters.push('[covv][' + last + ']concat=n=2:v=1:a=0[vcov]');
      last = 'vcov';
    }
  }
  // Watermark LOGO per-akun (Dzaky 25 Okt): SATU logo + setelan untuk SEMUA
  // klip di akun itu (file + setelan disimpan server per akun, bukan per klip).
  // Render Final saja (bukan plainOnly) — overlay PALING ATAS setelah subtitle/
  // cover, selama jendela klip utama saja [hookTotal, hookTotal+len] (sama
  // seperti watermark teks ASS) — tidak selama hook replay / cover.
  const wmLogoRaw = (!o.plainOnly && o.wmLogo && typeof o.wmLogo === 'object' && o.wmLogo.path) ? o.wmLogo : null;
  if (wmLogoRaw) {
    const logoIdx = 1 + (broll ? 1 : 0) + (musicIdx >= 0 ? 1 : 0) + ((o.coverPath && !o.plainOnly) ? 1 : 0);
    args.push('-i', String(wmLogoRaw.path));
    const wmPct = Math.min(40, Math.max(5, Number.isFinite(+wmLogoRaw.size) ? +wmLogoRaw.size : 15));
    const wmOp = Math.min(1, Math.max(0.1, (Number.isFinite(+wmLogoRaw.opacity) ? +wmLogoRaw.opacity : 80) / 100));
    // Durasi klip utama: server mengirim wmLogo.dur (overlayOnly tidak punya
    // start/end — len di sini = 1, bukan durasi klip). Fallback len bila dur tak ada.
    const wmDur = (Number.isFinite(+wmLogoRaw.dur) && +wmLogoRaw.dur > 0) ? +wmLogoRaw.dur : len;
    const M = 20;
    const wmPosExpr = wmLogoRaw.pos === 'tl' ? M + ':' + M
      : wmLogoRaw.pos === 'tr' ? 'W-w-' + M + ':' + M
      : wmLogoRaw.pos === 'bl' ? M + ':H-h-' + M
      : wmLogoRaw.pos === 'c' ? '(W-w)/2:(H-h)/2'
      : 'W-w-' + M + ':H-h-' + M;
    filters.push('[' + logoIdx + ':v][' + last + ']scale2ref=w=\'main_w*' + wmPct + '/100\':h=-1[wmL][wmMain]');
    filters.push('[wmL]format=rgba,colorchannelmixer=aa=' + wmOp + '[wmA]');
    filters.push('[wmMain][wmA]overlay=' + wmPosExpr + ':enable=\'between(t,' + hookTotal + ',' + (hookTotal + wmDur) + ')\',format=yuv420p[wmV]');
    last = 'wmV';
  }
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[' + last + ']');
  // o.hasAudio === false (input tanpa stream audio) -> output tanpa audio
  // (-an), walau audioCodec di-set. Kalau tidak, ffmpeg tetap mencoba
  // -map 0:a? (aman, opsional) tapi filter hook/sensor sudah mengasumsikan
  // audio ada — keduanya di-skip di atas bila hasAudio === false.
  const hasAudio = o.audioCodec !== null && o.audioCodec !== false && o.hasAudio !== false;
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
  else args.push('-c:v', vcodec, '-preset', 'veryfast', '-crf', '20'); // CRF 20 (was 23) -> bitrate ~2,3 Mbps seperti Klipaja
  if (vcodec === 'mpeg4') args.push('-q:v', '4');
  if (hasAudio) { args.push('-c:a', 'aac'); if (!o.simple) args.push('-b:a', '128k'); }
  else args.push('-an');
  if (!o.simple) args.push('-movflags', '+faststart');
  // Batas durasi output (jaring pengaman B-roll: output tidak boleh lebih
  // dari durasi klip walau filtergraph bermasalah).
  if (Number.isFinite(+o.outputDur) && +o.outputDur > 0) args.push('-t', String(+o.outputDur));
  args.push('-y', o.output);
  return args;
}

module.exports = {
  isYoutubeUrl, isTiktokUrl, clampInt, cleanTitle, escapeDrawtext, escapeFilterValue, ffmpegFilterPath,
  CLIP_FONT_FAMILIES, clipFontOk,
  parseVtt, fmtSrt, buildSrt, buildAss, buildCoverAss, resolveTitleDurMode, clipDuoInfo, clipTrackQuality, clipPresenceSegs, clipTalkerSegs, sanitizeCandidates, fallbackCandidates,
  chunkTranscript, fmtClock, buildFfmpegArgs, wrapTitle, faceTrackExpr,
  gameplayTopH,
  distributeWords, cueWords, normalizeCueWords, dedupeTranscriptCues,
  dewindowCues, chunkSubtitleWords, stripDisplayPunct,
  SUB_PRESETS, HOOK_PRESETS, animTag, subWordAnimInner, sanitizeStyleOv,
};
