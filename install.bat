@echo off
REM =================================================================
REM  Hermes VO - Installer Satu Klik (DRAF v5 untuk review)
REM  Perubahan dari v4: tambah yt-dlp (wajib buat download YouTube
REM  di Auto Clipper, sesuai syarat di README repo).
REM  Cara pasang yt-dlp: cek where yt-dlp -> bila belum ada, pasang
REM  via winget (yt-dlp.yt-dlp); bila winget gagal, cadangan via
REM  pip (python -m pip install -U yt-dlp).
REM
REM  REPO: https://github.com/dzakywifinet-lgtm/script-cliper-automation
REM  Fitur v4 dipertahankan: lokasi install D: dulu / drive kosong /
REM  folder user, deteksi spek + rekomendasi Whisper, dependensi
REM  via winget, restore .env dari backup, backup .env di akhir.
REM
REM  STATUS: DRAF - belum dites jalan di Windows, belum dipublish.
REM  PERBAIKAN 26 Okt 2026: kurung di teks echo dalam blok if dihapus
REM  (penyebab error '. was unexpected at this time.' di langkah 1/6).
REM  TIDAK ada secret/API key di file ini. User isi .env sendiri
REM  atau pulihkan dari backup-nya sendiri.
REM  Hanya CMD (.bat) - tanpa PowerShell.
REM =================================================================
setlocal EnableExtensions
title Hermes VO - Installer Satu Klik (DRAF v5)

REM ---------- 1. KONFIGURASI ----------
set "REPO_URL=https://github.com/dzakywifinet-lgtm/script-cliper-automation.git"
REM Ruang kosong minimal yang dianggap layak (GB):
set "MIN_GB=5"

echo.
echo  =====================================================
echo   Hermes VO - Installer Satu Klik  [DRAF v5 REVIEW]
echo  =====================================================
echo.
echo  Installer ini akan:
echo   1. Memilih lokasi install (D: dulu, atau drive lain
echo      yang masih kosong, atau folder user bila mentok)
echo   2. Membaca spek PC/laptop kamu (CPU, RAM, GPU/VRAM)
echo   3. Mengecek Node.js, Python, ffmpeg, git, dan yt-dlp
echo   4. Mengunduh kode Hermes VO dari GitHub
echo   5. Menyiapkan aplikasi + file .env (bisa restore dari
echo      backup bila kamu punya)
echo   6. Menawarkan Whisper (OPSIONAL) sesuai spek kamu
echo   Bonus di akhir: backup .env supaya key tidak hilang lagi
echo.
echo  Tekan tombol apa saja untuk mulai, atau tutup jendela
echo  ini untuk batal.
pause >nul

REM ---------- 2. PILIH DRIVE INSTALL ----------
echo.
echo  [1/6] Memilih lokasi install...
echo  -----------------------------------------------------
echo   Aturan: D: dulu bila ada dan sisanya minimal %MIN_GB% GB.
echo   Kalau D: tidak ada / penuh, cari drive lain (E:-H:) yang
echo   masih kosong. Kalau semua mentok, pakai folder user (C:).
set "PICK_DRIVE="
set "BEST_DRIVE="
set "BEST_GB=0"
set "DRIVE_FREE_GB="

call :CEKDRIVE D
if not defined PICK_DRIVE (
  for %%L in (E F G H) do if not defined PICK_DRIVE call :CEKDRIVE %%L
)

if defined PICK_DRIVE (
  set "INSTALL_DIR=%PICK_DRIVE%:\hermes-vo"
  echo   Drive terpilih: %PICK_DRIVE%: sisa sekitar %DRIVE_FREE_GB% GB
) else (
  if defined BEST_DRIVE (
    echo   NOTIFIKASI: tidak ada drive dengan sisa %MIN_GB% GB+.
    echo   Memakai drive paling lega yang ada: %BEST_DRIVE%: sisa sekitar %BEST_GB% GB.
    echo   PERINGATAN: ruang bisa habis saat mengunduh model Whisper
    echo   besar - pilih model kecil atau lewati Whisper.
    set "INSTALL_DIR=%BEST_DRIVE%:\hermes-vo"
  ) else (
    echo   NOTIFIKASI: tidak ada drive tambahan yang terbaca.
    echo   Memakai folder user C: sebagai fallback.
    set "INSTALL_DIR=%USERPROFILE%\hermes-vo"
  )
)

echo   Lokasi install: %INSTALL_DIR%
set "UBAH="
set /p UBAH="  Enter = pakai lokasi ini, atau ketik path lain lalu Enter: "
if not "%UBAH%"=="" set "INSTALL_DIR=%UBAH%"
echo   Lokasi final: %INSTALL_DIR%

REM ---------- 3. DETEKSI SPEK ----------
echo.
echo  [2/6] Membaca spek perangkat...
echo  -----------------------------------------------------
set "CPU_NAME=tidak terdeteksi"
set "RAMGB="
set "GPU_NAME=tidak terdeteksi"
set "VRAMGB="

for /f "tokens=2 delims==" %%a in ('wmic cpu get name /value 2^>nul ^| find "="') do set "CPU_NAME=%%a"
for /f "tokens=2 delims==" %%a in ('wmic computersystem get totalphysicalmemory /value 2^>nul ^| find "="') do set "RAMBYTES=%%a"
for /f "tokens=2 delims==" %%a in ('wmic path win32_VideoController get name /value 2^>nul ^| find "="') do set "GPU_NAME=%%a"
for /f "tokens=2 delims==" %%a in ('wmic path win32_VideoController get AdapterRAM /value 2^>nul ^| find "="') do set "VRAMBYTES=%%a"

REM Konversi byte ke GB dengan potong 9 digit terakhir
REM (menghindari overflow set /a 32-bit untuk angka besar).
if defined RAMBYTES set "RAMGB=%RAMBYTES:~0,-9%"
if defined VRAMBYTES set "VRAMGB=%VRAMBYTES:~0,-9%"

echo   CPU : %CPU_NAME%
if defined RAMGB (echo   RAM : sekitar %RAMGB% GB) else (echo   RAM : tidak terdeteksi)
echo   GPU : %GPU_NAME%
if defined VRAMGB (echo   VRAM: sekitar %VRAMGB% GB) else (echo   VRAM: tidak terdeteksi ^(kemungkinan CPU-only^))

REM ---------- 4. REKOMENDASI WHISPER BERDASARKAN VRAM ----------
REM  Peta (faster-whisper):
REM   VRAM 10GB+ -> large-v3 (akurasi maksimal) / turbo (cepat+akurat)
REM   VRAM 6GB+  -> large-v3-turbo (sweet spot cepat+akurat)
REM   VRAM 2-5GB -> small (aman; medium 5GB & turbo 6GB tidak muat di 4GB)
REM   CPU-only   -> small (balance terbaik di CPU)
set "REKOMENDASI=small"
set "REKOMENDASI_ALASAN=balance terbaik untuk spek ini"
if defined VRAMGB (
  if %VRAMGB% GEQ 10 (
    set "REKOMENDASI=large-v3-turbo"
    set "REKOMENDASI_ALASAN=GPU lega, cepat dan akurat"
  ) else if %VRAMGB% GEQ 6 (
    set "REKOMENDASI=large-v3-turbo"
    set "REKOMENDASI_ALASAN=sweet spot cepat + akurat untuk GPU 6GB+"
  ) else if %VRAMGB% GEQ 2 (
    set "REKOMENDASI=small"
    set "REKOMENDASI_ALASAN=aman untuk VRAM %VRAMGB% GB (medium/turbo tidak muat)"
  )
) else (
  set "REKOMENDASI=small"
  set "REKOMENDASI_ALASAN=CPU-only, small adalah balance terbaik"
)

echo.
echo  NOTIFIKASI SPEK:
echo   - Rekomendasi Whisper untuk perangkat ini: %REKOMENDASI%
echo     Alasan: %REKOMENDASI_ALASAN%
if defined VRAMGB (
  if %VRAMGB% LSS 6 echo   - PERINGATAN: model large-v3-turbo ^(6GB^) dan large-v3 ^(10GB^) TIDAK muat di VRAM %VRAMGB% GB.
)
echo.

REM ---------- 5. CEK DEPENDENSI ----------
echo  [3/6] Mengecek dependensi...
echo  -----------------------------------------------------
set "BUTUH_WINGET=0"
where node >nul 2>&1 && (echo   [OK] Node.js ditemukan) || (echo   [BELUM] Node.js & set "BUTUH_WINGET=1")
where python >nul 2>&1 && (echo   [OK] Python ditemukan) || (echo   [BELUM] Python & set "BUTUH_WINGET=1")
where ffmpeg >nul 2>&1 && (echo   [OK] ffmpeg ditemukan) || (echo   [BELUM] ffmpeg & set "BUTUH_WINGET=1")
where git >nul 2>&1 && (echo   [OK] git ditemukan) || (echo   [BELUM] git & set "BUTUH_WINGET=1")
where yt-dlp >nul 2>&1 && (echo   [OK] yt-dlp ditemukan) || (echo   [BELUM] yt-dlp - wajib buat download YouTube di Clipper & set "BUTUH_WINGET=1")

if "%BUTUH_WINGET%"=="1" (
  echo.
  echo   Beberapa dependensi belum ada. Installer akan mencoba
  echo   memasangnya lewat winget (butuh internet, mungkin minta
  echo   persetujuan admin untuk sebagian paket.
  where winget >nul 2>&1 && (
    echo   Winget ditemukan, memasang yang belum ada...
    where node >nul 2>&1 || winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    where python >nul 2>&1 || winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    where ffmpeg >nul 2>&1 || winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
    where git >nul 2>&1 || winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    where yt-dlp >nul 2>&1 || winget install -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements
    where yt-dlp >nul 2>&1 || call :PIPYTDLP
    echo.
    echo   NOTIFIKASI: kalau ada yang gagal terpasang, TUTUP jendela
    echo   ini, buka lagi installernya setelah restart PC - installer
    echo   akan melewati yang sudah terpasang dan lanjut dari sana.
    echo   Tekan tombol apa saja untuk lanjut memeriksa...
    pause >nul
  ) || (
    echo   NOTIFIKASI: winget TIDAK ditemukan di PC ini.
    echo   Pasang manual dulu: Node.js LTS, Python 3.12, ffmpeg,
    echo   git, dan yt-dlp - lalu jalankan lagi installer ini.
    echo   Installer berhenti di sini.
    pause
    exit /b 1
  )
)

REM ---------- 6. UNDUH KODE ----------
echo.
echo  [4/6] Mengunduh kode Hermes VO...
echo  -----------------------------------------------------
if exist "%INSTALL_DIR%\server.js" (
  echo   Folder %INSTALL_DIR% sudah berisi server.js.
  echo   Installer TIDAK menimpa - langsung lanjut ke persiapan.
) else (
  if exist "%INSTALL_DIR%" (
    echo   Folder %INSTALL_DIR% sudah ada tapi belum berisi server.js.
    echo   Mengunduh ke folder itu...
    git clone "%REPO_URL%" "%INSTALL_DIR%" 2>nul || (
      echo   NOTIFIKASI: git clone gagal. Cek REPO_URL di atas dan
      echo   koneksi internet, lalu jalankan lagi installer ini.
      pause
      exit /b 1
    )
  ) else (
    git clone "%REPO_URL%" "%INSTALL_DIR%" || (
      echo   NOTIFIKASI: git clone gagal. Cek REPO_URL di atas dan
      echo   koneksi internet, lalu jalankan lagi installer ini.
      pause
      exit /b 1
    )
  )
)

REM ---------- 7. NPM INSTALL + .ENV + RESTORE + SHORTCUT JALAN ----------
echo.
echo  [5/6] Menyiapkan aplikasi...
echo  -----------------------------------------------------
cd /d "%INSTALL_DIR%" || (
  echo   NOTIFIKASI: tidak bisa masuk ke %INSTALL_DIR%.
  pause
  exit /b 1
)
call npm install || (
  echo   NOTIFIKASI: npm install gagal. Cek koneksi internet dan
  echo   versi Node.js, lalu jalankan lagi installer ini.
  pause
  exit /b 1
)

set "ENVBARU="
if not exist ".env" (
  echo   Membuat file .env kosong...
  echo # Isi key kamu sendiri. JANGAN bagikan file ini ke siapa pun.> ".env"
  echo # Contoh: GROQ_API_KEY=, ELEVENLABS_API_KEY=>> ".env"
  set "ENVBARU=1"
  echo   NOTIFIKASI: file .env sudah dibuat di %INSTALL_DIR% - isi
  echo   key kamu di sana sebelum menjalankan dashboard.
) else (
  echo   File .env sudah ada, tidak ditimpa.
)

REM --- RESTORE .env dari backup (hanya bila .env baru dibuat) ---
if not "%ENVBARU%"=="1" goto LEWAT_RESTORE
echo.
echo   Punya backup .env dari install lama? Tempelkan path-nya
echo   supaya key tidak perlu diisi ulang satu-satu.
echo   (Contoh path: E:\.env atau D:\backup\.env)
set "RESTORE="
set /p RESTORE="  Path file backup .env (kosongkan bila tidak punya): "
if "%RESTORE%"=="" goto LEWAT_RESTORE
set "RESTORE=%RESTORE:"=%"
if not exist "%RESTORE%" echo   NOTIFIKASI: file tidak ditemukan di path itu. .env tetap kosong, isi manual nanti. & goto LEWAT_RESTORE
copy /y "%RESTORE%" ".env" >nul && echo   Backup berhasil disalin ke .env - key kamu pulih. || echo   NOTIFIKASI: gagal menyalin backup, .env tetap kosong.
:LEWAT_RESTORE

REM Shortcut jalan (file .bat, tanpa PowerShell):
> "start-hermes-vo.bat" (
  echo @echo off
  echo cd /d "%%~dp0"
  echo node server.js
  echo pause
)
echo   Shortcut jalan dibuat: start-hermes-vo.bat
echo   (klik 2x file itu untuk menjalankan dashboard)

REM ---------- 8. WHISPER OPSIONAL (PILIH SESUAI SPEK) ----------
echo.
echo  [6/6] Whisper - OPSIONAL, boleh dilewati
echo  -----------------------------------------------------
echo   Whisper dipakai untuk transkrip audio/video.
echo   Tabel model (faster-whisper):
echo     tiny           ~75 MB   tercepat, akurasi paling rendah
echo     base           ~142 MB  cepat, akurasi rendah
echo     small          ~466 MB  BUTUH ~2GB VRAM, balance terbaik
echo     medium         ~1,5 GB  BUTUH ~5GB VRAM, akurasi tinggi
echo     large-v3-turbo ~1,6 GB  BUTUH ~6GB VRAM, cepat + akurat
echo     large-v3       ~2,9 GB  BUTUH ~10GB VRAM, akurasi maksimal
echo.
echo   Rekomendasi untuk perangkat ini: %REKOMENDASI%
echo.
echo   Pilih:
echo     [1] Lewati Whisper (bisa dipasang kapan saja nanti)
echo     [2] Pasang rekomendasi: %REKOMENDASI%
echo     [3] Pilih model manual dari tabel di atas
echo.
set "PILIH="
set /p PILIH="  Masukkan 1 / 2 / 3 lalu Enter: "
if "%PILIH%"=="2" set "MODEL=%REKOMENDASI%" & goto PASANG_WHISPER
if "%PILIH%"=="3" goto PILIH_MANUAL
echo   Whisper dilewati. Lanjut ke selesai.
goto SELESAI

:PILIH_MANUAL
echo.
set "MODEL="
set /p MODEL="  Ketik nama model (tiny/base/small/medium/large-v3-turbo/large-v3): "
if "%MODEL%"=="" echo   Tidak ada model dipilih, Whisper dilewati. & goto SELESAI

REM Kebutuhan VRAM per model (angka bulat, untuk notifikasi):
set "MODELNEED=2"
if "%MODEL%"=="tiny" set "MODELNEED=1"
if "%MODEL%"=="base" set "MODELNEED=1"
if "%MODEL%"=="small" set "MODELNEED=2"
if "%MODEL%"=="medium" set "MODELNEED=5"
if "%MODEL%"=="large-v3-turbo" set "MODELNEED=6"
if "%MODEL%"=="large-v3" set "MODELNEED=10"

if defined VRAMGB (
  if %MODELNEED% GTR %VRAMGB% (
    echo.
    echo   PERINGATAN: model %MODEL% butuh sekitar %MODELNEED% GB VRAM,
    echo   sementara GPU kamu sekitar %VRAMGB% GB.
    echo   Kemungkinan besar GAGAL karena kehabisan memori atau sangat lambat.
    echo   Rekomendasi untuk perangkat ini: %REKOMENDASI%.
    echo.
    set "LANJUT="
    set /p LANJUT="  Tetap lanjut? ketik YA untuk lanjut, selain itu batal: "
    if /i not "%LANJUT%"=="YA" echo   Pemasangan Whisper dibatalkan. & goto SELESAI
  )
) else (
  echo   NOTIFIKASI: VRAM tidak terdeteksi, CPU-only. Model %MODEL%
  echo   akan jalan di CPU - lebih lambat dari GPU, tapi tetap jalan.
)

:PASANG_WHISPER
echo.
echo   Memasang faster-whisper + model %MODEL%...
echo   (download model bisa 75 MB - 2,9 GB tergantung pilihan)
python -m pip install -U faster-whisper || (
  echo   NOTIFIKASI: pip install faster-whisper gagal. Cek Python
  echo   dan internet, lalu pasang manual: pip install faster-whisper
  goto SELESAI
)
python -c "from faster_whisper import WhisperModel; WhisperModel('%MODEL%'); print('Model %MODEL% berhasil diunduh.')" || (
  echo   NOTIFIKASI: download model gagal. Cek internet, lalu
  echo   unduh manual kapan saja dengan perintah:
  echo     python -c "from faster_whisper import WhisperModel; WhisperModel('%MODEL%')"
  goto SELESAI
)
echo   Whisper model %MODEL% siap.
echo   NOTIFIKASI: ganti model kapan saja tanpa install ulang,
echo   cukup jalankan perintah download di atas dengan nama model lain.

:SELESAI
echo.
echo  =====================================================
echo   SELESAI
echo  =====================================================
echo   Folder aplikasi : %INSTALL_DIR%
echo   Menjalankan     : klik 2x start-hermes-vo.bat di folder itu
echo   File .env       : isi key kamu sendiri sebelum jalan
if "%PILIH%"=="1" echo   Whisper         : dilewati (bisa dipasang nanti)
echo.
echo  -----------------------------------------------------
echo   BONUS: Backup .env (disarankan, supaya key tidak hilang)
echo  -----------------------------------------------------
if not exist ".env" echo   File .env tidak ditemukan, tidak ada yang dibackup. & goto AKHIR
echo   File .env berisi semua API key kamu. Sekali hilang, semua
echo   key harus diisi ulang. Simpan salinannya di tempat aman.
echo   Pilih tujuan backup:
echo     [1] Flashdisk / drive lain (paling aman - selamat walau
echo         drive install rusak)
echo     [2] Folder backup di dalam folder install (praktis, tapi
echo         tidak melindungi bila drive install rusak)
echo     [3] Lewati
echo.
set "BK="
set /p BK="  Masukkan 1 / 2 / 3 lalu Enter: "
if "%BK%"=="1" goto BK_FLASH
if "%BK%"=="2" goto BK_FOLDER
goto AKHIR

:BK_FLASH
set "BKD="
set /p BKD="  Ketik huruf drive backup (mis. E) lalu Enter: "
if "%BKD%"=="" goto AKHIR
if not exist %BKD%:\ echo   Drive %BKD%: tidak ditemukan, backup dibatalkan. & goto AKHIR
copy /y ".env" "%BKD%:\.env" >nul && echo   Backup tersimpan di %BKD%:\.env || echo   NOTIFIKASI: gagal menyalin backup.
goto AKHIR

:BK_FOLDER
if not exist "backup" mkdir backup
copy /y ".env" "backup\.env" >nul && echo   Backup tersimpan di backup\.env (di dalam folder install). || echo   NOTIFIKASI: gagal menyalin backup.
echo   CATATAN: salin juga file backup\.env itu ke flashdisk bila
echo   sempat, supaya selamat walau drive install rusak.
goto AKHIR

:AKHIR
echo.
echo   PENTING: JANGAN upload file backup .env ke GitHub, jangan
echo   kirim ke orang lain, jangan screenshot isinya. File ini
echo   sama rahasianya dengan password.
echo.
echo   Langkah lanjutan (opsional, tidak wajib):
echo     - Jalankan otomatis saat PC nyala (PM2 / Task Scheduler)
echo     - Pasang Whisper belakangan (lihat notifikasi di atas)
echo     - Ulangi backup .env tiap kali ganti / tambah key
echo.
pause
endlocal
exit /b 0

REM =================================================================
REM  SUBRUTIN: :CEKDRIVE <huruf>
REM  %1 = huruf drive (tanpa titik dua).
REM  Bila drive ada dan sisa >= MIN_GB, set PICK_DRIVE=%1.
REM  Selalu lacak drive paling lega di BEST_DRIVE/BEST_GB.
REM =================================================================
:CEKDRIVE
if not exist %1:\ exit /b 0
set "FREEBYTES="
for /f "tokens=2 delims==" %%a in ('wmic logicaldisk where "deviceid='%1:'" get freespace /value 2^>nul ^| find "="') do set "FREEBYTES=%%a"
if not defined FREEBYTES exit /b 0
set "FGB=%FREEBYTES:~0,-9%"
if "%FGB%"=="" set "FGB=0"
if %FGB% GTR %BEST_GB% (
  set "BEST_GB=%FGB%"
  set "BEST_DRIVE=%1"
)
if %FGB% GEQ %MIN_GB% (
  set "PICK_DRIVE=%1"
  set "DRIVE_FREE_GB=%FGB%"
)
exit /b 0

REM =================================================================
REM  SUBRUTIN: :PIPYTDLP
REM  Cadangan bila winget gagal memasang yt-dlp: coba lewat pip.
REM  (Dipanggil hanya bila where yt-dlp masih gagal sesudah winget.)
REM =================================================================
:PIPYTDLP
echo   Winget belum berhasil memasang yt-dlp, mencoba lewat pip...
python -m pip install -U yt-dlp
exit /b 0
