# Script & Clipper Automation

Script VO Agent (dashboard voice-over: Riset, Script, SEO, Shorts, Bank Ide) + Auto Clipper (klip Shorts 9:16 dari video YouTube / upload, dengan subtitle otomatis Whisper lokal).

## Isi repo
- `server.js` — server dashboard (Node.js, tanpa dependency npm)
- `public/` — frontend dashboard + font
- `clipper-lib.js` — logika Auto Clipper (kandidat, render ffmpeg, subtitle `.ass`)
- `whisper-transcribe.py` — helper transkrip otomatis (Whisper, lokal)
- `whisper-cli-aarch64` — binary Whisper buat **Raspberry Pi (aarch64)** — di OS/arch lain pakai build yang sesuai (lihat bawah)
- `refs.js`, `tts.js` — referensi + TTS

## Syarat (semua OS)
- **Node.js 18+** (cek: `node -v`)
- **ffmpeg** — harus ada di `PATH` (cek: `ffmpeg -version`)
- **yt-dlp** — harus ada di `PATH` (buat download YouTube; cek: `yt-dlp --version`)
- **whisper-cli** — build whisper.cpp sesuai OS + arsitektur (lihat per-OS di bawah)
- **Model GGML** — file `ggml-tiny.bin` (±77 MB, **tidak ada di repo**), download dari Hugging Face (`ggerganov/whisper.cpp` → model `ggml-tiny.bin`), lalu set `WHISPER_MODEL` ke path file-nya

Tidak perlu `npm install` (proyek ini tanpa dependency npm).

## Install — Linux (Ubuntu/Debian)
```bash
# 1. Node.js 18+ + ffmpeg + yt-dlp
sudo apt update && sudo apt install -y nodejs npm ffmpeg python3-pip
pip3 install --user yt-dlp   # atau: sudo apt install yt-dlp

# 2. whisper-cli (x86_64) — download release whisper.cpp, contoh:
cd /usr/local/bin
sudo wget https://github.com/ggerganov/whisper.cpp/releases/download/v1.9.5/whisper.cpp-v1.9.5-linux-x64.tar.gz
sudo tar xzf whisper.cpp-v1.9.5-linux-x64.tar.gz
# (pastikan file `whisper-cli` ada di PATH; atau set WHISPER_CLI)

# 3. Model GGML
mkdir -p /opt/whisper && cd /opt/whisper
sudo wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin

# 4. Clone repo + .env + jalan
git clone https://github.com/dzakywifinet-lgtm/script-cliper-automation.git
cd script-cliper-automation
cp .env.example .env   # lalu isi (lihat format .env di bawah)
WHISPER_MODEL=/opt/whisper/ggml-tiny.bin node server.js
# Buka: http://localhost:3000
```

## Install — Windows
```powershell
# 1. Node.js 18+ dari https://nodejs.org (LTS). Cek di PowerShell: node -v
# 2. ffmpeg: download dari https://www.gyan.dev/ffmpeg/builds/ (essentials),
#    ekstrak, tambahkan folder `bin` ke PATH. Cek: ffmpeg -version
# 3. yt-dlp: download yt-dlp.exe dari https://github.com/yt-dlp/yt-dlp/releases,
#    taruh di folder yang ada di PATH. Cek: yt-dlp --version
# 4. whisper-cli (x64): download release whisper.cpp Windows
#    (https://github.com/ggerganov/whisper.cpp/releases), ekstrak,
#    taruh whisper-cli.exe di PATH (atau set WHISPER_CLI).
# 5. Model GGML: download ggml-tiny.bin dari Hugging Face (link di atas),
#    simpan misal di C:\whisper\ggml-tiny.bin
# 6. Clone + .env + jalan (di PowerShell, dari folder repo):
#    git clone https://github.com/dzakywifinet-lgtm/script-cliper-automation.git
#    cd script-cliper-automation
#    Copy-Item .env.example .env   # lalu isi
#    $env:WHISPER_MODEL="C:\whisper\ggml-tiny.bin"; node server.js
#    Buka: http://localhost:3000
```

## Install — macOS
```bash
# 1. Node.js 18+ + ffmpeg + yt-dlp (via Homebrew)
brew install node ffmpeg yt-dlp

# 2. whisper-cli: brew install whisper-cpp
#    (atau download release whisper.cpp macOS, taruh whisper-cli di PATH)

# 3. Model GGML
mkdir -p /opt/whisper && cd /opt/whisper
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin

# 4. Clone repo + .env + jalan
git clone https://github.com/dzakywifinet-lgtm/script-cliper-automation.git
cd script-cliper-automation
cp .env.example .env   # lalu isi
WHISPER_MODEL=/opt/whisper/ggml-tiny.bin node server.js
# Buka: http://localhost:3000
```

## Format `.env`
Buat file `.env` di folder repo (file ini **tidak pernah** di-push ke GitHub). Yang wajib diisi tergantung jalur AI yang dipakai; yang lain boleh kosong:
```ini
PORT=3000
# Jalur 9router (opsional — isi kalau pakai 9router)
ROUTER_URL=http://localhost:20128
ROUTER_API_KEY=
ROUTER_MODEL=
# Jalur Direct (opsional — isi yang dipakai saja)
GEMINI_API_KEY=
CLAUDE_API_KEY=
OPENAI_API_KEY=
# TTS ElevenLabs (opsional)
ELEVENLABS_API_KEY=
# Reset password via email (opsional)
RESEND_API_KEY=
RESEND_FROM=noreply@domain-kamu.id
# Password master dashboard (opsional — untuk pemulihan)
DASH_PASSWORD=
# Whisper (opsional — default: cari di /opt/whisper, /opt/docker/whisper, PATH)
WHISPER_MODEL=/opt/whisper/ggml-tiny.bin
WHISPER_CLI=/usr/local/bin/whisper-cli
# Folder kerja Clipper (opsional — default: ./clipper-work)
CLIPPER_WORK_DIR=
```
Catatan: API key juga bisa diisi dari dashboard (⚙ Akun / pengaturan AI) tanpa edit `.env`. `users.json` (akun login) dibuat otomatis saat pertama login — jangan pernah push file itu.

## Deploy ke Pi (Homelab-server, /opt/hermes-vo)
```bash
cd /opt/hermes-vo
git pull
cp whisper-cli-aarch64 whisper-cli && chmod +x whisper-cli
/etc/init.d/hermes-vo restart
```
Catatan: `.env` dan `users.json` TIDAK ada di repo (diisi manual di Pi, jangan pernah push).

## Update (kalau ada revisi)
```bash
cd /opt/script-cliper-automation   # repo backup (atau folder clone di OS lain)
git pull
# lalu copy file yang berubah ke folder live (misal /opt/hermes-vo di Pi) + restart
```
Rollback kalau revisi bermasalah: `git log --oneline` → `git checkout <commit-lama> -- <file>` → restart.

## Update otomatis
**Jangan** pakai cron auto-pull + auto-restart — kalau kepush kode yang rusak, dashboard live langsung ikut rusak tanpa dicek. Update manual (`git pull` + restart) lebih aman.
