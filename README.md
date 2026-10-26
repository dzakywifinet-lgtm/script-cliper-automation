# Script VO Agent

Alur video essay faceless dalam satu dashboard:
Tahap 0 (pilihan topik) → Tahap 1 AGENT-RISET (outline) → Tahap 2 AGENT-SCRIPT (naskah VO) → Tahap 3 AGENT-SEO → Tahap 4 AGENT-SHORTS.
Tanpa dependensi, cukup Node.js 18 ke atas.

## Fitur-fitur

Dashboard ini tidak hanya Script VO. Isinya:

- **Script VO Agent** — riset, naskah VO, SEO/storyboard, dan Shorts dari satu topik (lihat bagian "Jalankan" dan "Cara kerja" di bawah).
- **Auto Clipper** — ubah video YouTube panjang jadi klip-klip pendek siap posting (lihat "Auto Clipper").
- **Post ke YouTube** — antre dan kirim video Final langsung ke channel YouTube (lihat "Post ke YouTube").
- **Voice Generator** — ubah naskah jadi suara (MP3) dari berbagai engine (lihat "Voice Generator"; detail lengkap ada di "Suara (Text-to-Speech)").

## Jalankan

### Cara 1 (disarankan): Installer satu klik — DRAF

Buat yang tidak mau pasang satu-satu secara manual:

1. Unduh file `install.bat` dari repo ini, klik 2x.
2. Installer bekerja sendiri, sambil memberi notifikasi di tiap langkah:
   - **Memilih lokasi install:** installer mengutamakan drive `D:\hermes-vo` bila drive D: ada dan sisanya cukup (minimal 5 GB). Kalau D: tidak ada atau penuh, installer mencari drive lain (E:, F:, dst.) yang masih kosong. Kalau semua mentok, installer memakai folder user (C:) sebagai fallback. Lokasi yang dipilih ditampilkan, dan kamu bisa ketik path sendiri bila mau.
   - **Membaca spek:** CPU, RAM, GPU/VRAM dibaca dari perangkatmu, lalu installer menampilkan rekomendasi Whisper yang cocok untuk spek itu.
   - **Memasang dependensi:** Node.js, Python, ffmpeg, dan git yang belum ada dicoba dipasang otomatis lewat winget. Kalau winget tidak ada, installer berhenti rapi sambil memberi tahu apa yang harus dipasang manual.
   - **Mengunduh kode + menyiapkan aplikasi:** kode ditarik dari GitHub, `npm install` dijalankan, file `.env` kosong dibuat (kamu isi key sendiri — tidak ada secret di dalam installer), dan shortcut `start-hermes-vo.bat` dibuat.
   - **Restore .env (bila punya backup dari install lama):** kalau `.env` yang dibuat masih kosong, installer bertanya path file backup `.env` lamamu. Tempelkan path-nya, key langsung pulih tanpa isi ulang satu-satu.
   - **Whisper (opsional, boleh dilewati):** kamu bisa lewati Whisper, pasang rekomendasi otomatis, atau pilih model manual dari tabel di bawah. Kalau model yang dipilih melebihi VRAM perangkatmu, installer memberi peringatan dan minta konfirmasi sebelum lanjut. Ganti model belakangan bisa dilakukan tanpa install ulang.
   - **Bonus di akhir: backup .env.** Installer menawarkan salinan `.env` ke flashdisk/drive lain (paling aman) atau ke folder backup di dalam folder install. Lihat "Backup dan restore .env" di bawah — jangan dilewati.
   - **Update:** dari dashboard (Settings → Cek update, admin saja) atau `update.bat` — lihat "Update" di bawah.
3. Isi file `.env` di folder install dengan key kamu (atau pulihkan dari backup lewat langkah restore di atas), lalu klik 2x `start-hermes-vo.bat` dan buka http://localhost:3000

#### Tabel model Whisper (faster-whisper)

| Model | Ukuran download | Butuh VRAM | Keterangan |
| --- | --- | --- | --- |
| tiny | ~75 MB | ~1 GB | Tercepat, akurasi paling rendah |
| base | ~142 MB | ~1 GB | Cepat, akurasi rendah |
| small | ~466 MB | ~2 GB | Balance terbaik (CPU-only dan GPU 4 GB) |
| medium | ~1,5 GB | ~5 GB | Akurasi tinggi |
| large-v3-turbo | ~1,6 GB | ~6 GB | Sweet spot: cepat + akurat (GPU 6 GB ke atas) |
| large-v3 | ~2,9 GB | ~10 GB | Akurasi maksimal |

### Cara 2: Manual

1. `cp .env.example .env`, isi `ROUTER_URL` + `ROUTER_API_KEY` (mode 9router) atau tiga API key (mode langsung/Direct).
2. Isi `DASH_PASSWORD` jika dashboard dibuka dari internet. Login memakai halaman bergaya Neubrutalism dengan session cookie (30 hari, HttpOnly); sesi hangus saat server restart.
3. `node server.js`, buka http://localhost:3000

## Update

Kalau ada perbaikan atau fitur baru, tidak perlu install ulang. Ada dua jalur — pakai jalur dashboard dulu, `update.bat` hanya cadangan:

### Jalur 1 (utama): dari dashboard

1. Buka halaman **Settings** (hanya akun admin yang melihat kartu update).
2. Klik **Cek update** — dashboard membandingkan versi lokal dengan GitHub secara manual (tidak ada cek otomatis saat dashboard dibuka).
3. Kalau ada yang baru, muncul banner berisi versi baru + daftar perubahan singkat. Klik **Update sekarang**.
4. Server mencadangkan file kode (`.bak-sebelum-update`), menarik kode terbaru, memasang dependensi bila `package.json` berubah, lalu restart sendiri. Browser menunggu sampai server kembali, lalu menampilkan versi baru.
5. Kalau update bermasalah, klik **Kembalikan ke versi sebelumnya** — file kode dikembalikan dari backup, lalu server restart.

**Update ditolak otomatis** bila ada job berjalan (render / tahap AI / TTS / antrean posting) — tunggu job selesai, lalu update lagi. Update juga ditolak bila ada file kode yang diubah manual di mesin itu (kembalikan dulu file itu).

### Jalur 2 (cadangan): update.bat

Kalau server tidak jalan, dashboard tidak bisa dibuka, atau kamu lebih suka manual:

1. **Pastikan tidak ada render / proses AI yang sedang jalan.** (`update.bat` tidak bisa mendeteksi job yang jalan — cek sendiri dulu.)
2. Klik 2x file `update.bat` di folder install, lalu ketik `YA` saat diminta konfirmasi.
3. `update.bat` bekerja sendiri: membackup file kode (`.bak-sebelum-update`), menarik kode terbaru dari GitHub (`git pull`), lalu menjalankan `npm install` bila `package.json` berubah. Versi sebelum dan sesudah update ditampilkan.
4. **Restart dashboard** supaya kode baru jalan: tutup jendela dashboard yang lama lalu klik 2x `start-hermes-vo.bat` lagi, atau bila jalan via PM2 jalankan `"%APPDATA%\npm\pm2.cmd" restart hermes-vo`.

**Yang tidak ikut berubah (kedua jalur):** `.env`, `users.json`, `user-providers.json`, `user-tts-keys.json`, `clipper-work/`, state, dan upload. File-file itu tidak terlacak git, jadi `git pull` tidak menyentuhnya. Jangan pernah menjalankan `git add .env`.

**Kalau update bermasalah:** kembalikan file `.bak-sebelum-update` ke nama aslinya (hapus `.bak-sebelum-update` dari namanya), lalu restart dashboard. Level lanjut: commit sebelum update tercatat di `update-backup.json`, jadi bisa `git reset --hard <commit lama>` lalu restart.

**Catatan:** update (kedua jalur) hanya jalan untuk install hasil installer (yang memakai `git clone`). Kalau install kamu dari cara lain, perbarui manual: unduh kode terbaru, timpa file kode saja, jangan timpa `.env` / data.

## OPSI JALUR MULTI-PROVIDER (Direct vs 9router) — BARU
Setiap Agent (Riset, Skrip, SEO/Storyboard, Shorts) kini punya dropdown **Jalur Koneksi** di header kartunya:
- **Option A: "Direct Official API Key"** — request dikirim langsung ke endpoint resmi (Anthropic, Google AI Studio, OpenAI) memakai `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, atau `OPENAI_API_KEY` dari `.env`. 100% tanpa perantara.
- **Option B: "9router SSE Stream"** — memakai jalur router cadangan (`ROUTER_URL`) dengan model/combo yang dipilih.

**Atur di mana?** Isi API key di `.env`, lalu restart server (`node server.js`). Dashboard otomatis mendeteksi:
- Di header atas: badge `Gemini ✓ aktif`, `Claude ✓ aktif`, dll. Jika masih `(kunci belum diisi)`, berarti key belum terbaca.
- Di dropdown jalur: opsi Direct akan disabled sampai key-nya ada.
- Logika pencabangan ada di `server.js` (`/api/run` menerima `route: 'direct'|'router'`) dan `public/index.html` (`getRoute()`, `routeSel()`).

**Apakah jalur Direct sudah ada?** Ya. Sebelumnya Direct hanya aktif jika `ROUTER_URL` dikosongkan (mode global). Sekarang bisa dipilih per-agent, jadi bisa campur: misalnya Riset pakai 9router, Script pakai Direct Claude.

## Cara kerja
- Link referensi: tempel link YouTube atau artikel di kolom Topik (bisa banyak, maks 5; dikenali dari awalan http). Server mengambil teksnya (transkrip atau isi artikel), masuk ke kolom "Topik / Transkrip Sumber" di prompt Agent Riset, dalam salah satu dari dua cara: catatan fakta ringkas (default, hemat token) atau transkrip lengkap. Saat revisi atau lanjutkan, transkrip lengkap tidak dikirim ulang. Gagal diambil? Pakai tombol "Tempel transkrip".
- Pengambilan YouTube memakai jalur tidak resmi dan bisa berhenti bekerja sewaktu-waktu. Alamat jaringan lokal otomatis ditolak.
- Prompt tiap tahap = isi `hub-prompt-ultimate-v2.txt`; hanya kolom topik, audien, gaya, durasi, dan jumlah Shorts yang terisi otomatis (Tahap 2 mendapat satu baris tambahan berisi gaya bahasa). Klik "Lihat prompt yang dikirim" di tiap kartu.
- Stop: menghentikan tahap yang sedang jalan, hasil sebagian tetap tersimpan.
- Terpotong atau gagal di tengah: "Lanjutkan yang terpotong" meneruskan dari bagian terakhir, tidak mengulang dari awal.
- Revisi (Tahap 1 dan 2): lewat kolom chat. AI hanya menerima hasil terakhir + permintaan Anda.
- Hasil terpotong dideteksi dari alasan berhenti model, koneksi yang putus, dan penanda bagian akhir (Outro, Konsep Thumbnail, Hashtag). Terdeteksi terpotong? Klik "Lanjutkan yang terpotong". Sering terpotong? Naikkan `MAX_TOKENS` di `.env` (jangan melebihi batas output model di combo Anda).

## Tahap 0: transkrip referensi
Tempel link di kolom Topik. Tahap 0 menampilkan transkrip LENGKAP tiap link (tanpa AI) agar bisa dibandingkan dengan naskah Agent Script. Setelah itu klik "Kirim ke Agent Riset". Tiap link diringkas sendiri-sendiri menjadi catatan poin (hasilnya disimpan, jadi menambah link baru hanya meringkas link barunya). AI membaca maksimal 5.000 kata pertama tiap link.

## Prompt bisa diedit
Di tiap kartu ada "Prompt yang dikirim (bisa diedit)". Tanda {{SUMBER}}, {{OUTLINE}}, dan {{NASKAH}} diganti otomatis saat dijalankan. "Kembalikan prompt asli" membatalkan editan.

## Suara (Text-to-Speech)
Di kartu Agent Script, di bawah naskah, ada panel Voice Generator: pilih engine (9router, OpenAI, ElevenLabs, Google), voice, kecepatan, lalu Generate Voice. Naskah dibersihkan otomatis (judul, timestamp, dan petunjuk dalam kurung dibuang), dipecah per bagian sesuai batas tiap engine, lalu disambung jadi satu MP3 yang bisa diputar dan diunduh. "Tes singkat" membuat sampel 300 karakter pertama untuk mencoba suara dengan biaya kecil.

**Di mana atur pilihan AI untuk generate voice?** Di dropdown **"Model AI / Engine"** dalam panel Voice Generator itu sendiri.
- Engine yang belum diatur tampil `(belum diatur)` dan tidak bisa dipilih.
- Cara mengaktifkan: isi key-nya di `.env` lalu restart server — langsung aktif otomatis, tanpa setting lain:
  - `9router` → isi `ROUTER_URL` (Edge TTS gratis, tanpa key tambahan)
  - `Google AI Studio (Gemini TTS)` → isi `GEMINI_API_KEY`
  - `Google Cloud TTS` → isi `GOOGLE_TTS_API_KEY`
  - `OpenAI TTS` → isi `OPENAI_API_KEY`
  - `ElevenLabs` → isi `ELEVENLABS_API_KEY`

**Kenapa "Tes singkat" jalan tapi "Generate Voice" error 502?**
"Tes singkat" hanya mengirim 300 karakter pertama, sedangkan Generate penuh mengirim ribuan karakter sekaligus.
Jika 9router / Cloudflare menolak chunk besar (HTTP 502 / halaman web), sekarang diperbaiki:
- Default `TTS_ROUTER_CHUNK` diturunkan dari 4000 → **1800** karakter.
- Jika masih ditolak, teks otomatis dipecah lebih kecil secara agresif (sampai ±900 karakter, 5x percobaan) — sebelumnya hanya 3x dan setengah ukuran.
- Tips: jika masih 502, set `TTS_ROUTER_CHUNK=1000` di `.env` lalu restart. Atau pakai voice **Edge TTS gratis** yang paling stabil. Pastikan server 9router menyala dan provider voice-nya terhubung.

- Panel suara juga ada di kartu Agent Shorts, hanya membacakan bagian "Skrip Voice Over" (pilih Shorts ke-N jika lebih dari satu).
- Gemini TTS (Google AI Studio): gratis dengan jatah terbatas, hasil WAV (jadi MP3 otomatis jika STB punya ffmpeg). Pakai GEMINI_API_KEY.
- Google Cloud TTS: pilihan cepat Pria/Wanita disusun dari suara yang benar-benar tersedia (id-ID-Neural2 tidak ada untuk Bahasa Indonesia; dipakai Wavenet). Pitch -2 sampai +2.
- 9router: jika server suara menolak (502 atau halaman web), teks otomatis dipecah lebih kecil dan dicoba lagi.
- 9router: Edge TTS (gratis) atau model TTS lain yang tersedia di 9router; voice dikirim lewat kolom `model`.
- Pitch hanya tersedia di Google. ElevenLabs membatasi kecepatan 0.7x sampai 1.2x.
- Tombol "Tema" di pojok kanan atas: Otomatis, Terang, Gelap (sekarang default Neubrutalism).

## Fitur baru lainnya
- **Shorts dari Agent Script**: di Tahap 4 ada tombol **"Ambil dari Agent Script"**. Shorts diambil dari naskah video panjang (Tahap 2), diberi hook penasaran + open loop + CTA "tonton video lengkapnya" agar penonton lanjut ke video panjang.
- **Cek kemiripan**: di Tahap 2 ada tombol **"Cek kemiripan"** yang membandingkan naskah dengan transkrip referensi (Tahap 0) dan menandai kalimat yang terlalu mirip (skor >50%).
- **Tampilan Neubrutalism**: dashboard kini bergaya Neo-brutalism (background krem #F7F4EA, card putih border hitam tebal 3-4px, hard shadow 4px, tombol pop-out). ID elemen, class JS, output, dan logika backend tidak diubah — hanya CSS dan wrapper.

## Auto Clipper
Ubah video YouTube panjang jadi klip-klip pendek siap posting, dari dalam dashboard yang sama:

- **Alur:** tempel link YouTube (atau upload video) → AI menganalisis isi video → kandidat klip muncul → render → kartu Hasil (video Final) → unduh, atau kirim ke Post.
- **Framing otomatis ikut siapa yang ngomong, per segmen:** satu orang ngomong → full frame ke mukanya; dua orang tampil tapi satu yang ngomong → crop ke yang ngomong; dua orang ngomong bareng → blur landscape. Mode klip (Auto, Podcast, Landscape, Split, Crop 1:1, Gameplay) diatur di panel Video, dropdown "Layout Klip (klip ini)".
- **Hook opsional:** potongan terbaik dari dalam klip itu sendiri (maks 3 potongan) disambung di depan klip utama; ada juga Smart Cover dan Smart Hook.
- **Subtitle, watermark, B-roll, musik:** subtitle otomatis di atas video; watermark logo + teks bisa tampil bersamaan (logo dan setelan disimpan per akun); B-roll dan musik bisa ditambahkan saat render.
- **Hasil:** video Final 1080. Render ulang kandidat yang sama akan menimpa Final lamanya; kandidat baru masuk sebagai batch baru. "Render Semua Klip" menyimpan semua yang selesai otomatis ke Hasil.
- **Catatan tampilan:** halaman Auto Clipper kadang tampak blank (hanya judul + kartu CPU/Suhu) — klik kartu CPU/Suhu itu, kontennya baru muncul. Bukan error.
- **Kebutuhan:** ffmpeg (dipasang otomatis oleh installer satu klik). Untuk video YouTube yang butuh login, tersedia upload cookies YouTube per akun di Settings.

## Post ke YouTube
Kirim video Final langsung ke channel YouTube dari dashboard, tanpa unduh-upload manual:

- **Alur:** buka halaman Post → hubungkan akun YouTube lewat OAuth Google → pilih video Final → atur visibilitas dan thumbnail → masuk antrean → terkirim.
- **Visibilitas:** Publik, Privat, atau Draft. Video terjadwal selalu dikirim sebagai private + waktu tayang (syarat YouTube).
- **Thumbnail:** Otomatis, atau frame awal video Final. Kalau thumbnail gagal, video tetap terkirim (hanya dicatat sebagai peringatan).
- **Catatan:** channel yang belum verifikasi nomor HP di youtube.com/verify belum bisa pakai thumbnail custom (YouTube menolak dengan error 403) — verifikasi dulu bila perlu. Menghapus antrean yang sudah terkirim hanya menghapus catatannya di dashboard; video yang sudah tayang di YouTube tidak ikut terhapus.
- **OAuth:** akun Google yang dipakai login harus terdaftar sebagai Test user bila aplikasi masih berstatus Testing; token Testing kedaluwarsa sekitar 7 hari, sambungkan ulang bila perlu.

## Voice Generator
Ubah naskah jadi suara (MP3) tanpa rekaman manual:

- **Tempatnya:** panel Voice Generator di bawah naskah di kartu Agent Script (dan di kartu Agent Shorts, khusus bagian "Skrip Voice Over").
- **Cara pakai:** pilih engine (9router/Edge gratis, OpenAI, ElevenLabs, Google), pilih voice dan kecepatan, lalu Generate Voice. Naskah dibersihkan otomatis, dipecah per bagian sesuai batas tiap engine, lalu disambung jadi satu MP3 yang bisa diputar dan diunduh. "Tes singkat" membuat sampel 300 karakter pertama untuk mencoba suara dengan biaya kecil.
- **Detail lengkap** (engine, key yang harus diisi, batas kecepatan, dan perbaikan error 502) ada di bagian "Suara (Text-to-Speech)" di atas.

## Backup dan restore .env (penting, jangan dilewati)

File `.env` itu satu file kecil yang berisi **semua API key** kamu. Tanpa file ini, dashboard tidak bisa memakai AI maupun voice. File ini **sengaja tidak ada di GitHub** — jadi kalau hilang, tidak bisa diunduh ulang dari repo. Sekali hilang, semua key harus diisi ulang satu-satu. Karena itu, backup itu wajib.

### Di mana file .env itu?

Di folder install, misalnya `D:\hermes-vo\.env` (atau folder yang kamu pilih saat install). Namanya persis `.env` — titik di depan, tanpa nama lain.

### Cara backup (pakai File Explorer, tanpa perintah aneh-aneh)

1. Buka folder install (misalnya `D:\hermes-vo`).
2. Cari file bernama `.env`. Kalau tidak kelihatan, pastikan File Explorer menampilkan semua file.
3. Klik kanan file `.env` → **Copy**.
4. Pindah ke tempat aman **di luar folder install** — paling aman flashdisk, atau folder khusus di drive lain. Klik kanan → **Paste**.
5. Selesai. Ulangi langkah ini **setiap kali kamu ganti atau tambah key**, supaya backup selalu yang terbaru.

### Cara restore (mengembalikan backup ke install baru)

- **Lewat installer:** saat install baru, installer bertanya path file backup `.env` lamamu. Tempelkan path-nya (misalnya `E:\.env`), key langsung pulih tanpa isi ulang.
- **Manual:** copy file backup → paste ke folder install yang baru → timpa file `.env` yang masih kosong → restart dashboard (`node server.js` lagi atau klik `start-hermes-vo.bat`).

### Yang TIDAK boleh dilakukan dengan file backup

- Jangan upload ke GitHub.
- Jangan kirim ke orang lain lewat chat, email, atau grup.
- Jangan screenshot isinya.
- File backup sama rahasianya dengan password.

### Catatan (opsional, untuk pindah mesin lengkap)

API key ada di `.env`. Sebagian setelan akun dashboard (misalnya Koneksi AI) tersimpan juga di file akun (`user-providers.json`, `user-tts-keys.json`). Kalau mau pindah mesin secara lengkap, backup juga 2 file itu. Kalau tidak, cukup backup `.env`, lalu isi ulang setelan akun di dashboard sekali saja.

## Di server sendiri (OpenWrt/ImmortalWrt)
- Jalan otomatis lewat procd (lihat `/etc/init.d/hermes-vo` di panduan).
- Di belakang nginx/Cloudflare tidak perlu timeout panjang: pekerjaan berjalan di latar dan browser hanya polling.
