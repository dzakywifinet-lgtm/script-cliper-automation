@echo off
REM =================================================================
REM  Hermes VO - Update Satu Klik (jalur manual / cadangan)
REM  Dipakai SETELAH install (file ini tinggal di folder install).
REM  Jalur utama adalah tombol update di dashboard (Settings, admin
REM  saja) yang bisa MENOLAK otomatis saat ada job berjalan. File ini
REM  adalah cadangan untuk: server tidak jalan, dashboard tidak bisa
REM  dibuka, atau user lebih suka manual.
REM  Cara kerja: backup file kode -> git pull dari GitHub ->
REM  npm install HANYA bila package.json berubah -> beri tahu cara
REM  restart dashboard.
REM
REM  Yang TIDAK ikut berubah: .env, users.json, user-providers.json,
REM  user-tts-keys.json, clipper-work/, state, upload.
REM  File-file itu tidak terlacak git, jadi git pull tidak
REM  menyentuhnya. JANGAN pernah menjalankan git add .env.
REM
REM  PENTING: jangan update saat render / proses AI sedang jalan,
REM  karena restart dashboard memotong proses itu. Script ini
REM  TIDAK BISA mendeteksi render dari luar dashboard — dia hanya
REM  mengingatkan, dan konfirmasi YA di bawah itu tanggung jawab
REM  kamu. (Tombol update di dashboard bisa menolak otomatis.)
REM
REM  STATUS: FINAL DRAF paket auto-update — belum dites jalan di
REM  Windows, belum dipublish. Hanya CMD (.bat) - tanpa PowerShell.
REM =================================================================
setlocal EnableExtensions
title Hermes VO - Update Satu Klik (Manual)

REM Pindah ke folder install (folder file ini berada):
cd /d "%~dp0"

echo.
echo  =====================================================
echo   Hermes VO - Update Satu Klik (Manual / Cadangan)
echo  =====================================================
echo.

REM ---------- 1. PRASYARAT ----------
where git >nul 2>&1 || (
  echo   NOTIFIKASI: git tidak ditemukan. Update ini butuh git.
  echo   Pasang git dulu, lalu jalankan lagi update.bat ini.
  pause
  exit /b 1
)
if not exist ".git" (
  echo   NOTIFIKASI: folder ini bukan hasil git clone.
  echo   Update otomatis hanya jalan untuk install dari installer
  echo   (yang memakai git clone). Kalau install kamu dari cara
  echo   lain, perbarui manual: unduh kode terbaru, timpa file
  echo   kode saja, jangan timpa .env / data.
  pause
  exit /b 1
)
if not exist "server.js" (
  echo   NOTIFIKASI: server.js tidak ditemukan di folder ini.
  echo   Pastikan update.bat ini ada di folder install Hermes VO.
  pause
  exit /b 1
)

REM ---------- 2. VERSI SEBELUM + KONFIRMASI ----------
set "V_LAMA=tidak diketahui"
set "V_LAMA_FULL="
for /f %%a in ('git rev-parse --short HEAD 2^>nul') do set "V_LAMA=%%a"
for /f %%a in ('git rev-parse HEAD 2^>nul') do set "V_LAMA_FULL=%%a"
echo   Versi sekarang: %V_LAMA%
echo.
echo   PERINGATAN - baca dulu:
echo     - Pastikan TIDAK ada render / proses AI yang sedang jalan.
echo       Restart dashboard memotong proses itu. Script ini TIDAK
echo       BISA mendeteksi job yang jalan - cek sendiri dulu.
echo     - File kode akan dibackup dulu (.bak-sebelum-update).
echo     - .env, users.json, user-providers.json, user-tts-keys.json,
echo       clipper-work/, state, dan upload TIDAK ikut berubah.
echo.
set "Y="
set /p Y="  Ketik YA untuk lanjut update, selain itu batal: "
if /i not "%Y%"=="YA" echo   Update dibatalkan. & pause & exit /b 0

REM ---------- 3. BACKUP FILE KODE ----------
echo.
echo   Membackup file kode...
for %%F in (server.js clipper-lib.js face_track.py public\index.html) do (
  if exist "%%F" copy /y "%%F" "%%F.bak-sebelum-update" >nul
)
echo   Backup selesai (.bak-sebelum-update).

REM ---------- 4. GIT PULL ----------
echo.
echo   Menarik kode terbaru dari GitHub...
git pull || (
  echo.
  echo   NOTIFIKASI: git pull GAGAL.
  echo   Penyebab umum: ada file kode yang diubah manual di mesin
  echo   ini sehingga bertabrakan dengan update. Solusi: kembalikan
  echo   file yang diubah itu (atau pindahkan dulu), lalu jalankan
  echo   lagi update.bat ini. File .bak-sebelum-update di atas
  echo   adalah salinan sebelum update dicoba.
  pause
  exit /b 1
)

REM ---------- 5. NPM INSTALL (HANYA BILA package.json BERUBAH) ----------
set "V_BARU=tidak diketahui"
set "V_BARU_FULL="
for /f %%a in ('git rev-parse --short HEAD 2^>nul') do set "V_BARU=%%a"
for /f %%a in ('git rev-parse HEAD 2^>nul') do set "V_BARU_FULL=%%a"
if "%V_LAMA_FULL%"=="" goto NPM_LEWAT
if "%V_BARU_FULL%"=="" goto NPM_LEWAT
if "%V_LAMA_FULL%"=="%V_BARU_FULL%" goto NPM_LEWAT
git diff --name-only %V_LAMA_FULL% %V_BARU_FULL% | findstr /b /c:"package.json" >nul
if errorlevel 1 goto NPM_LEWAT
echo.
echo   package.json berubah, memasang dependensi baru...
call npm install || (
  echo   NOTIFIKASI: npm install gagal. Cek koneksi internet dan
  echo   Node.js, lalu jalankan lagi update.bat ini.
  pause
  exit /b 1
)
goto NPM_SELESAI
:NPM_LEWAT
echo.
echo   package.json tidak berubah, npm install dilewati.
:NPM_SELESAI

REM ---------- 6. SELESAI + CARA RESTART ----------
echo.
echo  =====================================================
echo   UPDATE SELESAI
echo  =====================================================
echo   Versi sebelum: %V_LAMA%
echo   Versi sesudah: %V_BARU%
echo.
echo   Terakhir: RESTART dashboard supaya kode baru jalan:
echo     - Bila jalan via start-hermes-vo.bat: tutup jendela
echo       dashboard yang lama, klik 2x start-hermes-vo.bat lagi.
echo     - Bila jalan via PM2: jalankan perintah ini di CMD:
echo         "%APPDATA%\npm\pm2.cmd" restart hermes-vo
echo.
echo   Kalau update bermasalah: kembalikan file
echo   .bak-sebelum-update ke nama aslinya (hapus .bak-nya),
echo   lalu restart dashboard.
echo.
pause
endlocal
exit /b 0
