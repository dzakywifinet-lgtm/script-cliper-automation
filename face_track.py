#!/usr/bin/env python3
"""
face_track.py — Active Speaker Detection & Auto-Framing (praktis, ringan).

Cara kerja (versi praktis dari spek MediaPipe / PyAnnote / TalkNet / YOLOv8):
  1. Deteksi wajah per frame — BLAZEFACE (default, model ringan buat HP,
     jalan cepat di CPU PC; via paket `mediapipe` yang membundel model
     Blazeface short-range — MediaPipe FaceDetection MEMAKAI Blazeface).
     FALLBACK berantai (tracking tidak pernah putus):
     Blazeface (mediapipe) -> YuNet (OpenCV DNN, model ONNX dibundel 232KB)
     -> Haar cascade (cv2.data.haarcascades, tanpa model tambahan).
     Model face_detection_yunet_2023mar.onnx dibundel (232KB).
     FALLBACK BADAN: kalau YuNet tidak menemukan wajah (muka tidak hadap kamera /
     membelakangi), pakai MOTION (frame differencing) -> crop ngikutin daerah
     yang bergerak (orangnya), bukan ke tengah. Tanpa model (HOG / YOLO dihapus:
     OpenCV 5.0 menghapus HOGDescriptor, dan model YOLO ONNX 30-250MB kegedean
     buat Pi). Motion di-rate-limit (maks 1x/detik).
  2. Deteksi SIAPA yang ngomong: gerak mulut (frame differencing di daerah mulut
     tiap wajah) + energi audio (ffmpeg volumedetect). Wajah yang mulutnya paling
     gerak = yang ngomong (pengganti TalkNet / lip-sync yang butuh model berat).
  3. Smooth cropping: Exponential Moving Average (EMA) + deadzone —
     gerakan kecil tidak menggerakkan crop (anti-jitter). PINDAH PEMBICARA
     = SNAP (hard cut, model Klipaja): kunci SpeakerLock pindah -> crop
     langsung ke framing pembicara baru, tanpa transit EMA.
  3b. SEGMENTASI (model Klipaja): tiap titik diganti MEDIAN segmen
     pembicaranya (batas = SpeakerLock pindah pembicara + drift jauh).
     Hasil render: crop STATIS per segmen (kepala bergerak DI DALAM frame,
     latar tetap) + HARD CUT antar segmen — tanpa glide / interpolasi.
     Wajah hilang sesaat -> posisi ditahan (hold, None), tidak loncat ke
     0/tengah. (Post-pass binomial TIDAK dipakai di pipeline ini: ia
     meratakan hard cut dan mengkontaminasi median segmen pendek.
     Fungsi smooth_track() tetap ada + diuji, tapi tidak dipanggil.)
  4. Output JSON: posisi crop X per detik (koordinat SUMBER), dipakai Clipper
     untuk membangun crop time-varying (seperti speaker-switch, tapi OTOMATIS).

Output JSON:
  { "fps": 2, "width": 1280, "height": 720, "cropW": 405,
    "track": [ { "t": 0.0, "x": 437, "speaking": true,
                 "faces": [ { "x": 500, "y": 100, "w": 200, "h": 200, "mouth": 12.5 } ] } ] }
  - x = posisi kiri crop window (koordinat sumber). Crop window = cropW x height.
  - speaking = ada suara + ada wajah yang mulutnya gerak.

Penggunaan:
  python3 face_track.py --input video.mp4 --start 0 --end 30 --out track.json
  python3 face_track.py --input video.mp4 --start 0 --end 30 --out track.json --fps 2 --ema 0.5

Dependensi: opencv-python-headless (atau opencv-python), numpy.
  Blazeface: pip install mediapipe (membundel model Blazeface).
  Pi:  pip install opencv-python-headless (di venv / /opt/docker biar root nggak penuh)
  PC:  pip install opencv-python mediapipe
"""
import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np


# --- Konstanta smoothing (bisa diatur; CLI --ema/--deadzone menimpa 2 pertama) ---
# server.js memanggil dengan --ema 0.3 --deadzone 30 -> nilai default di sini
# disamakan agar perilaku sama bila dipanggil tanpa argumen.
SMOOTH_ALPHA = 0.3     # EMA alpha (0-1): makin kecil makin halus, makin gede makin responsif.
                       # 0.3 pada fps 2 = lag ~1,5 detik mengikuti gerakan wajah
                       # (trade-off: gerakan sangat cepat tertinggal sedikit).
SMOOTH_DEADZONE = 30.0  # Deadzone anti-jitter (px): gerakan < deadzone tidak menggerakkan crop.
SMOOTH_PASSES = 1      # Pass binomial zero-phase pada track akhir (1 = lembut,
                       # 2 = lebih lembut; tanpa lag karena simetris).
SEGMENT_JUMP_FRAC = 0.12  # Ambang pecah segmen (fraksi lebar frame): bila posisi
                       # crop menyimpang > ambang ini dari median segmen berjalan
                       # selama SEGMENT_STREAK sampel berturut-turut -> segmen
                       # baru (hard cut). Gerak kepala biasa (< ~100px pada
                       # sumber 1280) tidak memecah segmen; pindah pembicara /
                       # jalan jauh (> ~150px) memecah segmen. Model Klipaja:
                       # crop STATIS per segmen, hard cut antar segmen.
SEGMENT_STREAK = 2     # Sampel berturut-turut menyimpang sebelum segmen dipecah
                       # (cerminan SpeakerLock SWITCH_STREAK: 1 frame berisik
                       # tidak bikin cut).


def probe_wh(path):
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True)
    parts = (p.stdout or "").strip().split(",")
    if len(parts) != 2:
        raise RuntimeError("ffprobe gagal baca dimensi video: " + path)
    return int(parts[0]), int(parts[1])


def audio_mean_db(path, start, dur):
    """Energi audio rata-rata (dB) — < -60 = senyap (tidak ada yang ngomong)."""
    try:
        p = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "info",
             "-ss", str(start), "-i", path, "-t", str(dur), "-vn",
             "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120)
        for line in (p.stderr or "").splitlines():
            if "mean_volume" in line:
                return float(line.split("mean_volume:")[1].split("dB")[0].strip())
    except Exception:
        pass
    return -99.0


def detect_faces_yunet(frame, detector, min_size=60):
    """YuNet (OpenCV DNN). Return list (x, y, w, h), score >= 0.7."""
    h, w = frame.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(frame)
    out = []
    if faces is None:
        return out
    for f in faces:
        x, y, fw, fh, score = int(f[0]), int(f[1]), int(f[2]), int(f[3]), float(f[14])
        if score >= 0.7 and fw >= min_size and fh >= min_size:
            out.append((x, y, fw, fh))
    return out


def detect_faces_mediapipe(frame_rgb, detector):
    """MediaPipe (opsional, PC). Return list (x, y, w, h)."""
    res = detector.process(frame_rgb)
    out = []
    if not res.detections:
        return out
    h, w = frame_rgb.shape[:2]
    for det in res.detections:
        bb = det.location_data.relative_bounding_box
        out.append((max(0, int(bb.xmin * w)), max(0, int(bb.ymin * h)),
                    int(bb.width * w), int(bb.height * h)))
    return out


def detect_faces_blazeface(frame_rgb, detector):
    """Blazeface via MediaPipe FaceDetection — MediaPipe FaceDetection
    MEMAKAI model Blazeface (face_detection_short_range.tflite), bukan
    detektor lain. Return list (x, y, w, h)."""
    return detect_faces_mediapipe(frame_rgb, detector)


def detect_faces_haar(gray, cascade, min_size=60):
    """Haar cascade — fallback TERAKHIR (bila Blazeface + YuNet tidak
    tersedia). Tanpa model tambahan (pakai cv2.data.haarcascades).
    Return list (x, y, w, h)."""
    if cascade is None:
        return []
    rects = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                     minSize=(int(min_size), int(min_size)))
    return [(int(x), int(y), int(w), int(h)) for (x, y, w, h) in rects]


def mouth_score(gray_prev, gray_cur, face, prev_face=None):
    """Gerak mulut: selisih piksel daerah mulut (1/3 bawah wajah) antar frame.
    prev_face = kotak wajah di frame SEBELUMNYA (aligned) — biar gerak kepala
    tidak dianggap gerak mulut. Kalau tidak ada, pakai face yang sama."""
    if gray_prev is None:
        return 0.0
    x, y, w, h = face
    px, py, pw, ph = prev_face if prev_face else face
    my, mh = y + int(h * 0.62), max(8, int(h * 0.38))
    pmy, pmh = py + int(ph * 0.62), max(8, int(ph * 0.38))
    x0, y0 = max(0, x), max(0, my)
    x1, y1 = min(gray_cur.shape[1], x + w), min(gray_cur.shape[0], my + mh)
    px0, py0 = max(0, px), max(0, pmy)
    px1, py1 = min(gray_prev.shape[1], px + pw), min(gray_prev.shape[0], pmy + pmh)
    if x1 <= x0 or y1 <= y0 or px1 <= px0 or py1 <= py0:
        return 0.0
    cur = gray_cur[y0:y1, x0:x1]
    prev = gray_prev[py0:py1, px0:px1]
    # Samakan ukuran (wajah bisa membesar/mengecil antar frame).
    if cur.shape != prev.shape:
        prev = cv2.resize(prev, (cur.shape[1], cur.shape[0]))
    return float(cv2.absdiff(prev, cur).mean())


def ema_deadzone(smooth, target, ema, deadzone):
    """EMA + deadzone: gerakan kecil (< deadzone) tidak menggerakkan crop.

    smooth=None -> snap ke target (tanpa lag warm-up). Dipakai jalur wajah
    (SpeakerLock), jalur badan (motion), dan tiap panel mode Split.
    Fungsi murni -> bisa diuji tanpa OpenCV / video.
    """
    if smooth is None:
        return target
    if abs(target - smooth) < deadzone:
        return smooth
    return ema * target + (1.0 - ema) * smooth


def _binomial_pass(vals):
    """Satu pass filter binomial [1,2,1]/4 (edge replication).

    Membulatkan sudut trayektori; simetris -> zero-phase (tanpa lag).
    """
    n = len(vals)
    if n < 3:
        return list(vals)
    out = []
    for i in range(n):
        a = vals[max(0, i - 1)]
        b = vals[i]
        c = vals[min(n - 1, i + 1)]
        out.append((a + 2.0 * b + c) / 4.0)
    return out


def smooth_track_values(values, passes=SMOOTH_PASSES):
    """Zero-phase smoothing pada seri posisi (satu sumbu).

    values = list float|None. None = wajah belum ada / hilang sesaat ->
    forward-fill (hold posisi terakhir) untuk perhitungan, lalu posisi
    None dikembalikan (tidak mengarang nilai, tidak loncat ke 0/tengah).
    Lompatan mentah (mis. 0 -> 500 -> 0 -> 500) diubah jadi perubahan
    bertahap (max step menyusut jauh). Fungsi murni -> bisa diuji tanpa
    OpenCV / video.
    """
    vals = list(values)
    if not vals:
        return vals
    filled = []
    last = None
    for v in vals:
        if v is None:
            filled.append(last if last is not None else 0.0)
        else:
            last = float(v)
            filled.append(float(v))
    none_idx = {i for i, v in enumerate(vals) if v is None}
    for _ in range(max(0, int(passes))):
        filled = _binomial_pass(filled)
    return [None if i in none_idx else round(filled[i], 1)
            for i in range(len(vals))]


def smooth_track(track, passes=SMOOTH_PASSES, split=False, lo=0.0, hi=None):
    """Haluskan track akhir (post-pass zero-phase) sebelum ditulis ke JSON.

    Normal: seri 'x' (kiri crop). Split: seri 'leftX'/'rightX' (pusat wajah)
    + 'x' disinkronkan ke leftX yang sudah dihaluskan. Hasil di-clamp ke
    [lo, hi] (crop tidak keluar frame). Field lain (t, speaking, faces,
    body) tidak disentuh, schema output tidak berubah. Fungsi murni.
    """
    if not track:
        return track
    if split:
        for key in ("leftX", "rightX"):
            sm = smooth_track_values([p.get(key) for p in track], passes)
            for p, v in zip(track, sm):
                if v is not None:
                    p[key] = v if hi is None else max(lo, min(hi, v))
        for p in track:
            p["x"] = p.get("leftX")
    else:
        sm = smooth_track_values([p.get("x") for p in track], passes)
        for p, v in zip(track, sm):
            if v is not None:
                p["x"] = v if hi is None else max(lo, min(hi, v))
    return track


def _median(vals):
    """Median list angka (None sudah dibuang pemanggil). Return None bila kosong."""
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def detect_drift_bounds(values, jump, streak=SEGMENT_STREAK):
    """Deteksi batas segmen dari penyimpangan (drift) posisi crop.

    values: list float|None (posisi crop per sampel). Batas baru (True) bila
    nilai menyimpang > jump dari median segmen berjalan selama `streak`
    sampel berturut-turut; batas ditaruh di sampel MENYIMPANG PERTAMA.
    None (gap wajah hilang) tidak memutus segmen dan tidak dihitung.
    Fungsi murni -> bisa diuji tanpa OpenCV / video.
    """
    n = len(values)
    bounds = [False] * n
    seg_start = 0
    over = 0
    for i, v in enumerate(values):
        if v is None:
            continue
        seg_vals = [x for x in values[seg_start:i] if x is not None]
        if not seg_vals:
            continue
        if abs(v - _median(seg_vals)) > jump:
            over += 1
            if over >= max(1, int(streak)):
                b = i - max(1, int(streak)) + 1
                bounds[b] = True
                seg_start = b
                over = 0
        else:
            over = 0
    return bounds


def merge_short_bounds(values, bounds, min_len=2):
    """Gabung segmen MIKRO ke tetangganya (Dzaky 23 Okt: crop sempat
    nyorot kemeja/bahu sepersekian detik). Segmen dengan sampel non-None
    < min_len (bawaan 2 sampel = 1 dtk @fps 2) tidak mungkin tembakan
    pembicara yang sah — biasanya fallback badan sesaat / deteksi
    parsial — batasnya dibuang supaya mediannya ikut segmen tetangga
    (yang sebelumnya; segmen pertama ikut yang sesudahnya). Murni."""
    n = len(values)
    if n == 0 or not bounds or len(bounds) != n:
        return list(bounds) if bounds else [False] * n
    b = list(bounds)
    b[0] = False
    for _ in range(n):
        starts = [0] + [i for i in range(n) if b[i]]
        starts.append(n)
        segs = list(zip(starts, starts[1:]))
        changed = False
        for k, (a, e) in enumerate(segs):
            cnt = sum(1 for x in values[a:e] if x is not None)
            if cnt < max(1, int(min_len)) and len(segs) > 1:
                if k == 0:
                    b[segs[1][0]] = False  # segmen pertama -> gabung berikutnya
                else:
                    b[a] = False           # gabung ke segmen sebelumnya
                changed = True
                break
        if not changed:
            break
    return b


def segmentize_values(values, bounds=None, jump=None, streak=SEGMENT_STREAK,
                      lo=None, hi=None, min_len=2):
    """Ganti tiap nilai dengan MEDIAN segmennya (model Klipaja: crop STATIS
    per segmen, hard cut antar segmen — tanpa glide / interpolasi).

    values: list float|None (posisi crop per sampel, sudah EMA + deadzone +
    post-pass). bounds: list bool sejajar values, True = segmen baru mulai
    di indeks ini (dari SpeakerLock: pindah pembicara). Bila jump diberikan,
    drift di dalam segmen juga memecah segmen (penyimpangan > jump selama
    `streak` sampel berturut-turut — mitigasi pembicara yang jalan jauh
    dalam satu segmen: tanpa pecah, crop statis bisa membuat wajah keluar
    frame). None dipertahankan (gap wajah hilang -> hold di render, tidak
    mengarang nilai, tidak loncat ke 0/tengah). Median di-clamp ke [lo, hi]
    bila diberikan. Urutan/timestamp tidak diubah, panjang sama.
    Fungsi murni -> bisa diuji tanpa OpenCV / video.
    """
    n = len(values)
    if n == 0:
        return list(values)
    final = list(bounds) if bounds and len(bounds) == n else [False] * n
    final[0] = False  # segmen pertama selalu mulai di indeks 0
    if jump is not None:
        # Drift dideteksi PER segmen eksplisit (bukan melintasi batas
        # SpeakerLock) agar nilai transisi di batas tidak memicu cut ganda.
        starts = [0] + [i for i in range(n) if final[i]]
        starts.append(n)
        for a, b in zip(starts, starts[1:]):
            sub = detect_drift_bounds(values[a:b], jump, streak)
            for j, flag in enumerate(sub):
                if flag:
                    final[a + j] = True
    final = merge_short_bounds(values, final, min_len)
    out = list(values)
    seg_start = 0
    for i in range(n + 1):
        if i == n or final[i]:
            seg_vals = [x for x in values[seg_start:i] if x is not None]
            med = _median(seg_vals) if seg_vals else None
            if med is not None:
                if lo is not None:
                    med = max(lo, med)
                if hi is not None:
                    med = min(hi, med)
                for j in range(seg_start, i):
                    if out[j] is not None:
                        out[j] = round(med, 1)
            seg_start = i
    return out


def split_panel_centers(faces):
    """Pusat wajah panel kiri + kanan dari list wajah [(x, y, w, h)].

    2+ wajah -> paling kiri + paling kanan (terurut x); 1 wajah -> duplikat
    wajah itu untuk kedua panel; 0 wajah -> (None, None). Fungsi murni.
    """
    if not faces:
        return (None, None)
    ordered = sorted(faces, key=lambda f: f[0])
    left = ordered[0]
    right = ordered[-1]
    return (left[0] + left[2] / 2.0, right[0] + right[2] / 2.0)


def guard_empty_segments(track, crop_w, width):
    """Penjaga segmen kosong (tuning 22 Okt): setelah segmentasi, periksa tiap
    run x-sama (satu segmen crop statis): bila jendela crop [x, x+crop_w]
    TIDAK berisi wajah/badan di mayoritas sampel yang ada orangnya
    (< 35%), segmen itu "parkir kosong" (mis. pembicara pindah tempat saat
    deteksi hilang / kunci basi — crop tertinggal di kursi lama). Perbaiki:
    x digeser ke MEDIAN klaster orang dominan di segmen itu (klaster =
    pengelompokan pusat wajah/badan per 10% lebar frame, terbanyak menang).
    Segmen tanpa sampel berorang dibiarkan (tidak ada bukti lebih baik).
    Fungsi terhadap list track (dict {x, faces, body?}) — bisa diuji murni.
    """
    if not track or not crop_w or not width:
        return track
    n = len(track)
    runs = []
    start = 0
    for i in range(1, n + 1):
        if i == n or track[i].get("x") != track[start].get("x"):
            runs.append((start, i))
            start = i
    for (a, b) in runs:
        x = track[a].get("x")
        if x is None:
            continue
        per_sample = []
        for p in track[a:b]:
            cs = []
            for f in (p.get("faces") or []):
                try:
                    cs.append(float(f["x"]) + float(f["w"]) / 2.0)
                except Exception:
                    pass
            bd = p.get("body")
            if bd:
                try:
                    cs.append(float(bd["x"]) + float(bd["w"]) / 2.0)
                except Exception:
                    pass
            per_sample.append(cs)
        bearing = [cs for cs in per_sample if cs]
        if not bearing:
            continue
        inside = sum(1 for cs in bearing
                     if any(x - 1.0 <= c <= x + crop_w + 1.0 for c in cs))
        if inside / float(len(bearing)) >= 0.35:
            continue
        allc = [c for cs in bearing for c in cs]
        binw = max(1.0, float(width) * 0.10)
        counts = {}
        for c in allc:
            k = int(c // binw)
            counts[k] = counts.get(k, 0) + 1
        best_bin = max(counts.items(), key=lambda kv: kv[1])[0]
        cluster = [c for c in allc if int(c // binw) == best_bin]
        med = _median(cluster)
        if med is None:
            continue
        new_x = round(max(0.0, min(float(width) - float(crop_w),
                                   med - float(crop_w) / 2.0)), 1)
        for p in track[a:b]:
            if p.get("x") is not None:
                p["x"] = new_x
    return track


def _speaker_face(sample, win_cx):
    """Wajah pembicara per sampel (rekonstruksi target SpeakerLock).

    Mouth terbesar bila > 2.0 (ikut SpeakerLock); bila tidak ada yang
    dominan, wajah terdekat pusat jendela (ikut presence_face). Sampel
    tanpa wajah -> None (tidak ada bukti, dilewati). Fungsi murni.
    """
    faces = [f for f in (sample.get("faces") or []) if f is not None]
    if not faces:
        return None
    try:
        best = max(faces, key=lambda f: float(f.get("mouth") or 0))
        if float(best.get("mouth") or 0) > 2.0:
            return best
    except Exception:
        pass
    try:
        return min(faces, key=lambda f: abs((float(f["x"]) + float(f["w"]) / 2.0) - win_cx))
    except Exception:
        return None


def refine_segment_windows(track, crop_w, width, margin_frac=0.10):
    """Jamin muka pembicara UTUH di dalam jendela crop tiap segmen statis.

    Setelah segmentasi (median per segmen), jendela crop DIAM sepanjang
    segmen — tapi kepala pembicara BERGERAK di dalam segmen (mencondong,
    ketawa, menoleh). Bila geraknya cukup jauh dari median, muka keluar
    jendela dan KEPOTONG di tepi frame (kasus Final Klip 1 detik 73: awal
    segmen portrait, muka Radit keiris tepi kanan; hook detik 2 = potongan
    video polos dari momen yang sama). Drift-split (12% lebar) tidak
    menangkap gerak 100-200px — padahal muka ~200px sudah bisa kepotong
    setengah.

    Per run x-sama (satu segmen statis):
      - Rentang yang harus muat = [min(fx-margin), max(fx+fw+margin)]
        muka pembicara semua sampel; margin = max(8px, margin_frac*w).
      - Rentang <= crop_w: geser x agar rentang muat (pusatkan rentang di
        jendela, clamp [0, W-crop_w]). Muka dijamin utuh + ada napas.
      - Rentang > crop_w (pembicara bergerak lebih dari satu jendela):
        pecah run di lompatan cx pembicara terbesar, ulangi per sub-run
        (maks 8 pecahan per run asal; sisa terlebar dipusatkan
        best-effort).
    Hanya mengubah x (None dipertahankan); panjang, t, speaking, faces
    tidak disentuh. Bahu tetangga yang ngintip TIDAK dijamin hilang
    (punggung/bahu tanpa kotak wajah tidak bisa dideteksi dari track) —
    yang dijamin adalah muka pembicara tidak kepotong. Fungsi murni
    terhadap list track (dict) -> bisa diuji tanpa OpenCV. Mode Split
    tidak memakai fungsi ini (panel kiri/kanan punya logika sendiri).
    """
    if not track or not crop_w or not width or float(crop_w) >= float(width):
        return track
    W = float(width)
    CW = float(crop_w)
    n = len(track)
    runs = []
    start = 0
    for i in range(1, n + 1):
        if i == n or track[i].get("x") != track[start].get("x"):
            runs.append((start, i))
            start = i
    for (a, b) in runs:
        x = track[a].get("x")
        if x is None:
            continue
        segs = [(a, b)]
        for _ in range(9):  # maks 8 pecahan per run asal
            changed = False
            new_segs = []
            for (s, e) in segs:
                items = []
                for j in range(s, e):
                    f = _speaker_face(track[j], float(x) + CW / 2.0)
                    if f is None:
                        continue
                    try:
                        fx, fw = float(f["x"]), float(f["w"])
                    except Exception:
                        continue
                    items.append((j, fx, fw, fx + fw / 2.0))
                if not items:
                    new_segs.append((s, e))
                    continue
                mg = lambda fw: max(8.0, float(margin_frac) * fw)
                lo = min(fx - mg(fw) for (_, fx, fw, _) in items)
                hi = max(fx + fw + mg(fw) for (_, fx, fw, _) in items)
                if hi - lo <= CW:
                    nx = round(max(0.0, min(W - CW, (lo + hi - CW) / 2.0)), 1)
                    for j in range(s, e):
                        if track[j].get("x") is not None:
                            track[j]["x"] = nx
                    new_segs.append((s, e))
                else:
                    jumps = [(abs(items[k][3] - items[k - 1][3]), items[k][0])
                             for k in range(1, len(items))]
                    if not jumps:
                        new_segs.append((s, e))
                        continue
                    _, cut = max(jumps)
                    if cut <= s or cut >= e:
                        cxs = sorted(c for (_, _, _, c) in items)
                        med = cxs[len(cxs) // 2]
                        nx = round(max(0.0, min(W - CW, med - CW / 2.0)), 1)
                        for j in range(s, e):
                            if track[j].get("x") is not None:
                                track[j]["x"] = nx
                        new_segs.append((s, e))
                    else:
                        new_segs.append((s, cut))
                        new_segs.append((cut, e))
                        changed = True
            segs = new_segs
            if not changed:
                break
    return track


def presence_face(scored, locked_cx, frame_w):
    """Fallback KEHADIRAN (tuning 23 Okt): pilih wajah buat di-frame saat
    SpeakerLock tidak memilih siapa pun (tidak ada gerak mulut — wajah FOTO /
    gambar, pendengar diam, penyanyi mulut terbuka lebar). Tanpa ini crop
    membeku di posisi lama / jatuh ke fallback badan (bisa ke meja).
    Aturan: wajah terdekat dari kunci pembicara bila masih wajar
    (<= 25% lebar frame); selain itu wajah TERBESAR (paling dominan).
    Return dict wajah atau None. Fungsi murni.
    """
    if not scored:
        return None
    if locked_cx is not None:
        near = min(scored, key=lambda s: abs((s["x"] + s["w"] / 2.0) - locked_cx))
        if abs((near["x"] + near["w"] / 2.0) - locked_cx) <= 0.25 * float(frame_w):
            return near
    return max(scored, key=lambda s: float(s["w"]) * float(s["h"]))


class SpeakerLock:
    """Hysteresis pembicara: kunci pembicara saat ini agar crop tidak
    flip-flop A<->B tiap frame.

    Tanpa ini, tiap frame (fps 2) kode memilih wajah dengan gerak mulut
    TERBESAR; bila kedua pembicara aktif (satu ngomong, satu ketawa/reaksi),
    max bisa flip A->B->A tiap frame -> crop goyang patah-patah.

    Aturan (pick):
    - Belum ada kunci -> kunci langsung ke wajah terbaik (snap, tanpa lag).
    - Wajah terbaik adalah pembicara TERKUNCI (jarak cx <= 15% lebar frame
      dari kunci) -> streak reset, kunci ikut posisi wajah (gerak pelan).
    - Wajah terbaik adalah pembicara LAIN (jarak cx > 15% lebar) -> streak
      +1; baru PINDAH kunci bila streak >= 2 frame (>=1 detik pada fps 2);
      bila belum, tetap di pembicara terkunci (kembalikan wajah terdekat
      kunci bila masih terdeteksi, bila tidak: None = crop diam).
    - Tidak ada wajah dengan mouth > threshold (2.0) -> kunci tetap
      (tidak pindah, tidak reset streak), return None.
    Fungsi murni terhadap state internal (locked_cx, streak) -> bisa diuji
    tanpa OpenCV / video.
    """

    MOUTH_THRESHOLD = 2.0
    SWITCH_DIST_FRAC = 0.15  # 15% lebar frame
    SWITCH_STREAK = 2        # frame berturut-turut pembicara lain mendominasi

    def __init__(self):
        self.locked_cx = None
        self.streak = 0
        # switched: True bila pick() TERAKHIR PINDAH kunci ke pembicara lain
        # (batas segmen baru, model Klipaja: hard cut di sini). Di-reset
        # False di awal setiap pick(). Kunci pertama / tahan kunci / tidak
        # ada yang dominan -> False (bukan pindah pembicara).
        self.switched = False

    @staticmethod
    def _cx(face):
        return face["x"] + face["w"] / 2.0

    def pick(self, scored, frame_w):
        """Pilih wajah target dari scored ([{x,y,w,h,mouth}]).

        Return wajah dict target, atau None bila crop harus diam
        (tidak ada yang dominan / kunci dipertahankan tapi wajah terkunci
        tidak terdeteksi di frame ini).
        """
        self.switched = False
        if not scored:
            return None
        best = max(scored, key=lambda s: s["mouth"])
        if best["mouth"] <= self.MOUTH_THRESHOLD:
            return None  # tidak ada yang dominan -> kunci tetap
        best_cx = self._cx(best)
        if self.locked_cx is None:
            self.locked_cx = best_cx
            self.streak = 0
            return best
        if abs(best_cx - self.locked_cx) <= self.SWITCH_DIST_FRAC * frame_w:
            # Pembicara terkunci kembali mendominasi -> streak reset.
            self.streak = 0
            self.locked_cx = best_cx  # ikut gerak pelan wajah terkunci
            return best
        # Pembicara lain mendominasi.
        self.streak += 1
        if self.streak >= self.SWITCH_STREAK:
            self.locked_cx = best_cx
            self.streak = 0
            self.switched = True  # PINDAH kunci -> batas segmen baru
            return best
        # Tahan: tetap di pembicara terkunci.
        near = min(scored, key=lambda s: abs(self._cx(s) - self.locked_cx))
        if abs(self._cx(near) - self.locked_cx) <= self.SWITCH_DIST_FRAC * frame_w:
            return near
        return None


def select_detector(method, cascade_path=None):
    """Pilih detektor wajah (Blazeface -> YuNet -> Haar, fallback berantai).
    Return (method_aktual, detector, haar_cascade). `method_aktual` = method
    yang BENAR-BENAR dipakai (untuk field `method` di output JSON).
    Tracking tidak pernah putus karena detektor tidak tersedia."""
    detector = None
    haar_cascade = None
    if method in ("blazeface", "mediapipe"):
        try:
            import mediapipe as mp
            detector = mp.solutions.face_detection.FaceDetection(
                model_selection=0, min_detection_confidence=0.5)
            method = "blazeface"
        except Exception as e:
            print("MediaPipe/Blazeface tidak tersedia, fallback ke YuNet: " + str(e),
                  file=sys.stderr)
            method = "yunet"
    if method == "yunet":
        model_path = cascade_path
        if not model_path:
            cand = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "face_detection_yunet_2023mar.onnx")
            if os.path.exists(cand):
                model_path = cand
        if not model_path or not os.path.exists(model_path):
            # YuNet tidak ada -> fallback terakhir: Haar cascade.
            print("Model YuNet tidak ditemukan, fallback ke Haar cascade.",
                  file=sys.stderr)
            method = "haar"
        else:
            detector = cv2.FaceDetectorYN_create(model_path, "", (320, 320), 0.7)
    if method == "haar":
        cascade_xml = os.path.join(cv2.data.haarcascades,
                                   "haarcascade_frontalface_default.xml")
        if not os.path.exists(cascade_xml):
            raise RuntimeError(
                "Tidak ada detektor wajah yang tersedia (Blazeface/MediaPipe "
                "tidak terinstall, model YuNet tidak ditemukan, Haar cascade "
                "tidak ada). Install: pip install mediapipe")
        haar_cascade = cv2.CascadeClassifier(cascade_xml)
    return method, detector, haar_cascade


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--ema", type=float, default=0.5,
                    help="EMA alpha (0-1): makin kecil makin halus, makin gede makin responsif")
    ap.add_argument("--deadzone", type=float, default=SMOOTH_DEADZONE,
                    help="Deadzone anti-jitter (px): gerakan < deadzone tidak menggerakkan crop")
    ap.add_argument("--smooth-passes", type=int, default=SMOOTH_PASSES,
                    help="Pass binomial zero-phase pada track akhir (0 = tanpa post-pass; "
                         "1 = lembut, tanpa lag; 2 = lebih lembut). TIDAK DIPAKAI pipeline "
                         "Klipaja (post-pass meratakan hard cut) — dipertahankan untuk "
                         "kompatibilitas CLI.")
    ap.add_argument("--split", action="store_true",
                    help="Mode Split: keluarkan 2 pusat wajah (kiri + kanan) per titik, "
                         "tanpa SpeakerLock (kedua panel selalu tampil). "
                         "Output track: {t, leftX, rightX} (pusat wajah, koordinat sumber).")
    ap.add_argument("--method", default="blazeface",
                    choices=["blazeface", "yunet", "mediapipe"],
                    help="Detektor wajah: blazeface (default, MediaPipe = "
                         "model Blazeface, fallback YuNet -> Haar), yunet "
                         "(OpenCV DNN), mediapipe (alias blazeface).")
    ap.add_argument("--cascade", default=None,
                    help="Path face_detection_yunet_2023mar.onnx (default: sebelah script)")
    ap.add_argument("--min-face", type=int, default=60)
    ap.add_argument("--presence", action="store_true",
                    help="Mode KEHADIRAN ringan (fallback bila tracking penuh "
                         "gagal/timeout): sampel frame (diperkecil 640px) dan catat "
                         "saja ada/tidak ada wajah + pusat wajah terbesar per sampel. "
                         "Output: {presence: true, width, height, cropW, samples}. "
                         "Server memakainya untuk framing per-bagian: ada muka = "
                         "crop 9:16 full muka, tidak ada = Landscape.")
    args = ap.parse_args()

    dur = max(0.5, args.end - args.start)
    W, H = probe_wh(args.input)
    crop_w = H * 9 / 16.0
    # Kalau sumber sudah portrait (cropW > W), crop window = lebar penuh.
    crop_w = min(crop_w, float(W))

    # --- Audio: ada suara atau tidak (kalau senyap, jangan pindah-pindah crop). ---
    mean_db = audio_mean_db(args.input, args.start, dur)
    has_audio = mean_db > -60.0

    # --- Detektor wajah: Blazeface (default) -> YuNet -> Haar (fallback
    # berantai, tracking tidak pernah putus karena detektor tidak tersedia).
    args.method, detector, haar_cascade = select_detector(args.method, args.cascade)

    # --- MODE PRESENCE (ringan): deteksi saja, tanpa SpeakerLock/audio. ---
    if args.presence:
        scale = 640.0 / float(W) if W > 640 else 1.0
        sw, sh = int(W * scale), int(H * scale)
        if sw % 2: sw -= 1
        if sh % 2: sh -= 1
        min_face_p = max(20, int(args.min_face * scale))
        pcmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
                "-ss", str(args.start), "-i", args.input, "-t", str(dur),
                "-vf", "fps=%s,scale=%d:%d" % (args.fps, sw, sh),
                "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
        pproc = subprocess.Popen(pcmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        pbytes = sw * sh * 3
        samples = []
        t = 0.0
        dt = 1.0 / args.fps
        while True:
            raw = pproc.stdout.read(pbytes)
            if len(raw) < pbytes:
                break
            frame = np.frombuffer(raw, dtype=np.uint8).reshape(sh, sw, 3)
            if args.method == "blazeface":
                faces = detect_faces_blazeface(
                    cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), detector)
            elif args.method == "haar":
                faces = detect_faces_haar(
                    cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), haar_cascade, min_face_p)
            else:
                faces = detect_faces_yunet(frame, detector, min_face_p)
            if faces:
                best = max(faces, key=lambda f: float(f[2]) * float(f[3]))
                cx = (best[0] + best[2] / 2.0) / scale
                samples.append({"t": round(t, 2), "face": True,
                                "cx": round(cx, 1)})
            else:
                samples.append({"t": round(t, 2), "face": False})
            t += dt
        pproc.wait()
        out = {"v": 1, "presence": True, "width": W, "height": H,
               "cropW": round(crop_w, 1), "samples": samples}
        with open(args.out, "w") as fh:
            json.dump(out, fh)
        print("presence: %d sampel, %d ada wajah" %
              (len(samples), sum(1 for x in samples if x["face"])))
        return

    # --- Ekstrak frame (pipe raw BGR). ---
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-ss", str(args.start), "-i", args.input, "-t", str(dur),
           "-vf", "fps=%s" % args.fps,
           "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = W * H * 3
    track = []
    # switch_flags: sejajar track — True = SpeakerLock PINDAH pembicara di
    # sampel ini (batas segmen baru, model Klipaja: hard cut di sini).
    # Split: selalu False (tanpa SpeakerLock, batas dari deteksi drift).
    switch_flags = []
    prev_gray = None
    prev_faces = []
    # Motion fallback (badan): posisi orang terakhir dari gerak (frame diff).
    # Rate-limit: maks 1x/detik, hanya kalau YuNet tidak menemukan wajah.
    last_motion_t = -10.0
    last_person = None  # (x, y, w, h) kotak daerah bergerak terakhir
    smooth_x = None  # None = belum ada wajah yang ngomong (pakai tengah sampai ada)
    smoothL = None  # pusat wajah panel kiri (mode Split)
    smoothR = None  # pusat wajah panel kanan (mode Split)
    speaker_lock = SpeakerLock()  # hysteresis: kunci pembicara, cegah flip-flop
    t = 0.0
    dt = 1.0 / args.fps
    while True:
        raw = proc.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(H, W, 3)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if args.method == "blazeface":
            faces = detect_faces_blazeface(
                cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), detector)
        elif args.method == "haar":
            faces = detect_faces_haar(gray, haar_cascade, args.min_face)
        else:
            faces = detect_faces_yunet(frame, detector, args.min_face)
        # Skor mulut per wajah → siapa yang ngomong.
        scored = []
        for f in faces:
            # Wajah terdekat di frame sebelumnya (untuk alignment mulut).
            pf = None
            if prev_faces:
                pf = min(prev_faces, key=lambda p: (p[0] + p[2] / 2 - (f[0] + f[2] / 2)) ** 2 + (p[1] + p[3] / 2 - (f[1] + f[3] / 2)) ** 2)
            scored.append({"x": f[0], "y": f[1], "w": f[2], "h": f[3],
                           "mouth": round(mouth_score(prev_gray, gray, f, pf), 2)})
        # --- MODE SPLIT: 2 panel (kiri + kanan), tanpa SpeakerLock ---
        # Kedua panel SELALU tampil (tidak ada "yang ngomong" yang dipilih).
        # Tiap panel di-smoothing mandiri (EMA + deadzone). 1 wajah -> duplikat
        # untuk kedua panel; 0 wajah -> panel diam di posisi terakhir.
        if args.split:
            lc, rc = split_panel_centers(faces)
            if lc is not None:
                smoothL = ema_deadzone(smoothL, lc, args.ema, args.deadzone)
                smoothR = ema_deadzone(smoothR, rc, args.ema, args.deadzone)
            track.append({"t": round(t, 2),
                          "x": round(smoothL, 1) if smoothL is not None else None,
                          "leftX": round(smoothL, 1) if smoothL is not None else None,
                          "rightX": round(smoothR, 1) if smoothR is not None else None,
                          "speaking": bool(faces) and has_audio, "faces": scored})
            switch_flags.append(False)  # Split tanpa SpeakerLock
            prev_gray = gray
            prev_faces = faces
            t += dt
            continue
        # FALLBACK BADAN: tidak ada wajah -> cari daerah bergerak (orangnya).
        # Frame diff vs frame sebelumnya -> threshold -> kontur terbesar = orang.
        # Crop ngikutin pusat kontur (badan), bukan ke tengah.
        body = None
        if not scored and has_audio and prev_gray is not None and (t - last_motion_t) >= 1.0:
            last_motion_t = t
            try:
                diff = cv2.absdiff(prev_gray, gray)
                _, th = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
                th = cv2.morphologyEx(th, cv2.MORPH_OPEN,
                                      cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
                cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                # Kontur terbesar (area >= 0,5% frame) = orang yang bergerak.
                big = [c for c in cnts if cv2.contourArea(c) >= (W * H * 0.005)]
                if big:
                    c = max(big, key=cv2.contourArea)
                    bx, by, bw, bh = cv2.boundingRect(c)
                    last_person = (bx, by, bw, bh)
            except Exception:
                pass
        if last_person is not None and not scored:
            px, py, pw, ph = [float(v) for v in last_person]
            # Pusat badan atas: x tengah rect, y = 20% dari atas rect (kepala/bahu).
            body_cx = px + pw / 2.0
            body = {"x": round(px), "y": round(py), "w": round(pw), "h": round(ph), "body": True}
            target_x = body_cx - crop_w / 2.0
            target_x = max(0.0, min(W - crop_w, target_x))
            # EMA + deadzone (gerakan kecil tidak menggerakkan crop).
            smooth_x = ema_deadzone(smooth_x, target_x, args.ema, args.deadzone)
        speaking = False
        sw = False  # SpeakerLock pindah pembicara di frame ini?
        if scored and has_audio:
            # Siapa yang ngomong = SpeakerLock (hysteresis): wajah dengan
            # gerak mulut terbesar, TAPI kunci tidak langsung pindah ke
            # pembicara lain — butuh 2 frame berturut-turut mendominasi
            # (biar ketawa/reaksi lawan bicara tidak bikin crop goyang).
            target_face = speaker_lock.pick(scored, W)
            sw = bool(getattr(speaker_lock, "switched", False))
            if target_face is None:
                # Tidak ada yang "ngomong" menurut mulut, tapi ada wajah:
                # frame wajah yang hadir (foto / pendengar diam) — jangan
                # biarkan crop membeku / lari ke badan-meja.
                pf = presence_face(scored, speaker_lock.locked_cx, W)
                if pf is not None:
                    pcx = pf["x"] + pf["w"] / 2.0
                    ptx = max(0.0, min(W - crop_w, pcx - crop_w / 2.0))
                    smooth_x = ema_deadzone(smooth_x, ptx, args.ema, args.deadzone)
            if target_face is not None:
                speaking = True
                face_cx = target_face["x"] + target_face["w"] / 2.0
                target_x = face_cx - crop_w / 2.0
                target_x = max(0.0, min(W - crop_w, target_x))
                # PINDAH PEMBICARA = SNAP (model Klipaja: hard cut ke framing
                # pembicara baru, tanpa transit EMA ~1,5 dtk). Tanpa snap,
                # median segmen baru ketarik ke posisi pembicara lama dan
                # crop segmen pendek jadi meleset.
                if sw:
                    smooth_x = None
                # EMA + deadzone: gerakan kecil (< deadzone) tidak
                # menggerakkan crop. Wajah ngomong PERTAMA langsung SNAP
                # (tanpa lag warm-up dari tengah).
                smooth_x = ema_deadzone(smooth_x, target_x, args.ema, args.deadzone)
        out_x = smooth_x if smooth_x is not None else (W - crop_w) / 2.0
        # speaking = wajah ngomong ATAU badan terdeteksi (ada suara + ada orang).
        if body is not None and has_audio:
            speaking = True
        track.append({"t": round(t, 2), "x": round(out_x, 1),
                      "speaking": speaking, "faces": scored,
                      **({"body": body} if body is not None else {})})
        switch_flags.append(sw)
        prev_gray = gray
        prev_faces = faces
        t += dt
    proc.wait()

    # TIDAK ADA post-pass binomial di sini (sengaja): pass binomial
    # [1,2,1]/4 MERATAKAN hard cut (nilai di batas segmen jadi 260/585 dari
    # 97.5/747.5) sehingga median segmen PENDEK (1-2 sampel) terkontaminasi
    # sampai ~160px dan wajah bisa keluar frame. EMA + deadzone di loop +
    # median segmen sudah memberi stabilitas; fungsi smooth_track() tetap
    # ada (diuji di test_face_smooth.py) tapi tidak dipakai di pipeline ini.

    # Segmentasi Klipaja: crop STATIS per segmen pembicara + HARD CUT antar
    # segmen (bukan glide / interpolasi). Batas segmen = SpeakerLock pindah
    # pembicara (switch_flags) + drift (wajah bergerak jauh dalam satu
    # segmen — mitigasi pembicara yang jalan jauh: tanpa pecah, crop statis
    # bisa membuat wajah keluar frame). Tiap titik diganti MEDIAN segmennya
    # (posisi representatif); None (gap wajah hilang) dipertahankan.
    # Gagal segmentasi -> track hasil EMA tetap ditulis (jangan gagalkan
    # tracking). Schema output tidak berubah (jumlah titik sama).
    try:
        jump = SEGMENT_JUMP_FRAC * float(W)
        if args.split:
            lv = segmentize_values([p.get("leftX") for p in track], None,
                                    jump=jump, lo=0.0, hi=float(W))
            rv = segmentize_values([p.get("rightX") for p in track], None,
                                    jump=jump, lo=0.0, hi=float(W))
            for p, a, b in zip(track, lv, rv):
                if a is not None:
                    p["leftX"] = a
                if b is not None:
                    p["rightX"] = b
                p["x"] = p.get("leftX")
        else:
            sv = segmentize_values([p.get("x") for p in track], switch_flags,
                                    jump=jump, lo=0.0,
                                    hi=max(0.0, W - crop_w))
            for p, v in zip(track, sv):
                if v is not None:
                    p["x"] = v
            # Penjaga segmen kosong: segmen yang jendelanya tidak berisi
            # orang digeser ke klaster orang dominan segmen itu.
            guard_empty_segments(track, crop_w, float(W))
            # Jaminan muka utuh (fix 25 Okt): jendela statis per segmen
            # digeser/dibelah agar muka pembicara tidak kepotong tepi.
            refine_segment_windows(track, crop_w, float(W))
    except Exception:
        pass

    result = {"v": 4, "fps": args.fps, "width": W, "height": H, "cropW": round(crop_w, 1),
              "method": args.method, "hasAudio": has_audio, "meanDb": mean_db,
              "track": track}
    with open(args.out, "w") as f:
        json.dump(result, f)
    print("face_track: %d frame, %d wajah terdeteksi, audio %.1f dB -> %s"
          % (len(track), sum(1 for s in track if s["faces"]),
             mean_db, args.out))


if __name__ == "__main__":
    main()
