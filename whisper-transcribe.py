#!/usr/bin/env python3
# Auto-caption Auto Clipper: transkrip audio/video pakai whisper.cpp (binary).
# Dipanggil server.js saat Analisis dan tidak ada transkrip YouTube.
# Usage: python3 whisper-transcribe.py <input-file> [--model tiny] [--language id]
# Output: JSON ke stdout: {"language": "id", "segments": [{"start": 0.0, "end": 2.5, "text": "..."}]}
# Alur: ffmpeg decode audio -> WAV 16kHz -> whisper-cli (model GGML) -> JSON -> segmen.
# Kenapa whisper.cpp, bukan faster-whisper: faster-whisper tidak bisa jalan di
# OpenWrt/musl karena CTranslate2 (intinya) tidak punya wheel musllinux —
# pip gagal build dari source (butuh pkg-config + compiler + header).
# whisper.cpp adalah binary C++ statis, tanpa pip, jadi jalan di Pi.
import sys, json, subprocess, argparse, os, shutil, tempfile, re

def find_cli():
    # WHISPER_CLI env > /opt/hermes-vo/whisper-cli > /opt/docker (partisi besar)
    # > /usr/local/bin > /usr/bin > PATH.
    for cand in [os.environ.get('WHISPER_CLI'), '/opt/hermes-vo/whisper-cli',
                 '/opt/docker/whisper.cpp/build/bin/whisper-cli',
                 '/opt/docker/whisper-cli',
                 '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli']:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return shutil.which('whisper-cli') or ''

def find_model(name):
    # WHISPER_MODEL env (path .bin) > /opt/whisper/ > /opt/docker/whisper/
    # (partisi besar — root Pi cuma 851MB, model 77MB harus di /opt/docker).
    env = os.environ.get('WHISPER_MODEL')
    if env and os.path.isfile(env):
        return env
    base = 'ggml-' + (name or 'tiny') + '.bin'
    for cand in ['/opt/whisper/' + base, '/opt/docker/whisper/' + base,
                 '/opt/whisper-tiny-ggml/' + base, '/opt/docker/whisper-tiny-ggml/' + base,
                 '/opt/whisper-tiny/' + base]:
        if os.path.isfile(cand):
            return cand
    # Fallback: pakai nama apa adanya (whisper-cli akan error jelas kalau tidak ada).
    return name

def parse_ts(s):
    # "HH:MM:SS,mmm" -> detik (float).
    m = re.match(r'(\d+):(\d\d):(\d\d)[,.](\d+)', s or '')
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('--model', default='tiny')
    ap.add_argument('--language', default=None)  # None = deteksi otomatis
    args = ap.parse_args()
    cli = find_cli()
    if not cli:
        print('whisper-cli tidak ditemukan (pasang whisper.cpp di server)', file=sys.stderr)
        return 1
    model = find_model(args.model)
    lang = args.language or 'auto'
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, 'audio.wav')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                        '-i', args.input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out_prefix = os.path.join(td, 'out')
        cmd = [cli, '-m', model, '-f', wav, '-l', lang, '-oj', '-of', out_prefix]
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if p.returncode != 0:
            print('whisper-cli gagal: ' + (p.stderr or '').strip()[-500:], file=sys.stderr)
            return 1
        jf = out_prefix + '.json'
        with open(jf, 'r', encoding='utf-8') as f:
            data = json.load(f)
    segments = []
    lang_out = ''
    if isinstance(data, dict):
        lang_out = data.get('language') or (data.get('params') or {}).get('language') or ''
        items = data.get('transcription') or []
        for it in items:
            ts = it.get('timestamps') or {}
            off = it.get('offsets') or {}
            if 'from' in off and 'to' in off:
                start, end = off['from'] / 1000.0, off['to'] / 1000.0
            else:
                start, end = parse_ts(ts.get('from')), parse_ts(ts.get('to'))
            text = (it.get('text') or '').strip()
            if text:
                segments.append({'start': round(float(start), 2), 'end': round(float(end), 2), 'text': text})
    print(json.dumps({'language': lang_out, 'segments': segments}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())
