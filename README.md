# Script & Clipper Automation

Script VO Agent (dashboard voice-over) + Auto Clipper (klip Shorts dari video YouTube / upload).

## Isi repo
- `server.js` — server dashboard (Node.js)
- `public/` — frontend dashboard + font
- `clipper-lib.js` — logika Auto Clipper (kandidat, render ffmpeg, subtitle .ass)
- `whisper-transcribe.py` — helper transkrip otomatis (Whisper, lokal)
- `whisper-cli-aarch64` — binary Whisper buat Raspberry Pi (aarch64, statis, 26MB)
- `refs.js`, `tts.js` — referensi + TTS

## Deploy ke Pi (Homelab-server, /opt/hermes-vo)
```bash
cd /opt/hermes-vo
git pull
cp whisper-cli-aarch64 whisper-cli && chmod +x whisper-cli
/etc/init.d/hermes-vo restart
```
Catatan: `.env` dan `users.json` TIDAK ada di repo (diisi manual di Pi, jangan pernah push).

## Update otomatis (cron di Pi, opsional)
Cek tiap 30 menit, pull + restart kalau ada update:
```bash
*/30 * * * * cd /opt/hermes-vo && git fetch --quiet && [ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ] && git pull --quiet && /etc/init.d/hermes-vo restart
```
