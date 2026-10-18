#!/usr/bin/env python3
"""
face_track.py — Active Speaker Detection & Auto-Framing (praktis, ringan).

Cara kerja (versi praktis dari spek MediaPipe / PyAnnote / TalkNet / YOLOv8):
  1. Deteksi wajah per frame (OpenCV YuNet DNN — akurat, ringan, jalan di Pi + PC).
     Model face_detection_yunet_2023mar.onnx dibundel (232KB). Kalau MediaPipe
     terinstall, bisa pakai --method mediapipe (alternatif, PC).
     FALLBACK BADAN: kalau YuNet tidak menemukan wajah (muka tidak hadap kamera /
     membelakangi), pakai MOTION (frame differencing) -> crop ngikutin daerah
     yang bergerak (orangnya), bukan ke tengah. Tanpa model (HOG / YOLO dihapus:
     OpenCV 5.0 menghapus HOGDescriptor, dan model YOLO ONNX 30-250MB kegedean
     buat Pi). Motion di-rate-limit (maks 1x/detik).
  2. Deteksi SIAPA yang ngomong: gerak mulut (frame differencing di daerah mulut
     tiap wajah) + energi audio (ffmpeg volumedetect). Wajah yang mulutnya paling
     gerak = yang ngomong (pengganti TalkNet / lip-sync yang butuh model berat).
  3. Smooth cropping: Exponential Moving Average (EMA) — kamera pindah halus,
     tidak patah-patah (pengganti Kalman Filter yang lebih berat).
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
  Pi:  pip install opencv-python-headless (di venv / /opt/docker biar root nggak penuh)
  PC:  pip install opencv-python
"""
import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--ema", type=float, default=0.5,
                    help="EMA alpha (0-1): makin kecil makin halus, makin gede makin responsif")
    ap.add_argument("--method", default="yunet", choices=["yunet", "mediapipe"])
    ap.add_argument("--cascade", default=None,
                    help="Path face_detection_yunet_2023mar.onnx (default: sebelah script)")
    ap.add_argument("--min-face", type=int, default=60)
    args = ap.parse_args()

    dur = max(0.5, args.end - args.start)
    W, H = probe_wh(args.input)
    crop_w = H * 9 / 16.0
    # Kalau sumber sudah portrait (cropW > W), crop window = lebar penuh.
    crop_w = min(crop_w, float(W))

    # --- Audio: ada suara atau tidak (kalau senyap, jangan pindah-pindah crop). ---
    mean_db = audio_mean_db(args.input, args.start, dur)
    has_audio = mean_db > -60.0

    # --- Detektor wajah (YuNet default, MediaPipe opsional). ---
    detector = None
    if args.method == "mediapipe":
        try:
            import mediapipe as mp
            detector = mp.solutions.face_detection.FaceDetection(
                model_selection=0, min_detection_confidence=0.5)
        except Exception as e:
            print("MediaPipe tidak tersedia, fallback ke YuNet: " + str(e),
                  file=sys.stderr)
            args.method = "yunet"
    if args.method == "yunet":
        model_path = args.cascade
        if not model_path:
            cand = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "face_detection_yunet_2023mar.onnx")
            if os.path.exists(cand):
                model_path = cand
        if not model_path or not os.path.exists(model_path):
            raise RuntimeError(
                "Model face_detection_yunet_2023mar.onnx tidak ditemukan. "
                "Download dari https://github.com/opencv/opencv_zoo/raw/main/"
                "models/face_detection_yunet/face_detection_yunet_2023mar.onnx")
        detector = cv2.FaceDetectorYN_create(model_path, "", (320, 320), 0.7)

    # --- Ekstrak frame (pipe raw BGR). ---
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-ss", str(args.start), "-i", args.input, "-t", str(dur),
           "-vf", "fps=%s" % args.fps,
           "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = W * H * 3
    track = []
    prev_gray = None
    prev_faces = []
    # Motion fallback (badan): posisi orang terakhir dari gerak (frame diff).
    # Rate-limit: maks 1x/detik, hanya kalau YuNet tidak menemukan wajah.
    last_motion_t = -10.0
    last_person = None  # (x, y, w, h) kotak daerah bergerak terakhir
    smooth_x = None  # None = belum ada wajah yang ngomong (pakai tengah sampai ada)
    t = 0.0
    dt = 1.0 / args.fps
    while True:
        raw = proc.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(H, W, 3)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if args.method == "mediapipe":
            faces = detect_faces_mediapipe(
                cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), detector)
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
            if smooth_x is None:
                smooth_x = target_x
            else:
                smooth_x = args.ema * target_x + (1.0 - args.ema) * smooth_x
        speaking = False
        if scored and has_audio:
            # Wajah dengan gerak mulut terbesar = yang ngomong (threshold kecil
            # biar kedip / gerak kepala tidak dianggap ngomong).
            best = max(scored, key=lambda s: s["mouth"])
            if best["mouth"] > 2.0:
                speaking = True
                face_cx = best["x"] + best["w"] / 2.0
                target_x = face_cx - crop_w / 2.0
                target_x = max(0.0, min(W - crop_w, target_x))
                # EMA: kamera pindah halus (tidak patah-patah). Wajah ngomong
                # PERTAMA langsung SNAP (tanpa lag warm-up dari tengah).
                if smooth_x is None:
                    smooth_x = target_x
                else:
                    smooth_x = args.ema * target_x + (1.0 - args.ema) * smooth_x
        out_x = smooth_x if smooth_x is not None else (W - crop_w) / 2.0
        # speaking = wajah ngomong ATAU badan terdeteksi (ada suara + ada orang).
        if body is not None and has_audio:
            speaking = True
        track.append({"t": round(t, 2), "x": round(out_x, 1),
                      "speaking": speaking, "faces": scored,
                      **({"body": body} if body is not None else {})})
        prev_gray = gray
        prev_faces = faces
        t += dt
    proc.wait()

    result = {"fps": args.fps, "width": W, "height": H, "cropW": round(crop_w, 1),
              "method": args.method, "hasAudio": has_audio, "meanDb": mean_db,
              "track": track}
    with open(args.out, "w") as f:
        json.dump(result, f)
    print("face_track: %d frame, %d wajah terdeteksi, audio %.1f dB -> %s"
          % (len(track), sum(1 for s in track if s["faces"]),
             mean_db, args.out))


if __name__ == "__main__":
    main()
