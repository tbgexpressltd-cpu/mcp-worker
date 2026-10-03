import json
import os
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
MAX_CLIPS = 20


def run(cmd):
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        tail = proc.stderr[-5000:]
        raise RuntimeError(f"ffmpeg failed: {tail}")
    return proc


def validate_url(value):
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http/https media URLs are supported.")
    return value


def download(url, path):
    validate_url(url)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "TBG-Motors-Media-Processor/1.0"},
    )
    total = 0
    with urllib.request.urlopen(req, timeout=60) as response, open(path, "wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise ValueError("Input media exceeds the 100 MB processing limit.")
            out.write(chunk)
    if total == 0:
        raise ValueError("Downloaded media is empty.")


def has_audio(path):
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            path,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return bool(proc.stdout.strip())


def video_filter(width, height, fit):
    if fit == "contain":
        return (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,"
            "setsar=1,fps=30"
        )
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps=30"
    )


def normalize_clip(source, target, width, height, fit, start, duration, keep_audio):
    vf = video_filter(width, height, fit)
    cmd = ["ffmpeg", "-y"]

    if start is not None and float(start) > 0:
        cmd += ["-ss", str(float(start))]

    cmd += ["-i", source]

    audio_present = has_audio(source)

    if keep_audio and not audio_present:
        cmd += [
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
        ]

    if duration is not None:
        cmd += ["-t", str(float(duration))]

    cmd += [
        "-map",
        "0:v:0",
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
    ]

    if keep_audio:
        if audio_present:
            cmd += [
                "-map",
                "0:a:0",
                "-af",
                "aresample=48000:async=1:first_pts=0",
            ]
        else:
            cmd += ["-map", "1:a:0"]

        cmd += [
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-shortest",
        ]
    else:
        cmd += ["-an"]

    cmd += ["-movflags", "+faststart", target]
    run(cmd)


def concat_clips(paths, target):
    concat_file = target + ".txt"
    with open(concat_file, "w", encoding="utf-8") as f:
        for p in paths:
            escaped = p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            concat_file,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            target,
        ]
    )


def add_music(video_path, music_path, target, keep_audio, video_volume, music_volume):
    vv = max(0.0, min(1.0, float(video_volume) / 100.0))
    mv = max(0.0, min(1.0, float(music_volume) / 100.0))

    if keep_audio:
        run(
            [
                "ffmpeg",
                "-y",
                "-i",
                video_path,
                "-stream_loop",
                "-1",
                "-i",
                music_path,
                "-filter_complex",
                (
                    f"[0:a]volume={vv}[orig];"
                    f"[1:a]volume={mv}[music];"
                    "[orig][music]amix=inputs=2:duration=first:dropout_transition=2[a]"
                ),
                "-map",
                "0:v:0",
                "-map",
                "[a]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-shortest",
                "-movflags",
                "+faststart",
                target,
            ]
        )
    else:
        run(
            [
                "ffmpeg",
                "-y",
                "-i",
                video_path,
                "-stream_loop",
                "-1",
                "-i",
                music_path,
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-shortest",
                "-movflags",
                "+faststart",
                target,
            ]
        )


def compose(payload):
    clips = payload.get("clips") or []
    if not 1 <= len(clips) <= MAX_CLIPS:
        raise ValueError(f"clips must contain 1 to {MAX_CLIPS} items.")

    width = int(payload.get("width") or 1080)
    height = int(payload.get("height") or 1920)
    if not 50 <= width <= 2000 or not 50 <= height <= 2000:
        raise ValueError("width and height must be between 50 and 2000.")

    fit = payload.get("fit") or "cover"
    if fit not in ("cover", "contain"):
        raise ValueError("fit must be cover or contain.")

    keep_audio = bool(payload.get("keep_original_audio", False))
    music_url = payload.get("music_url")
    music_volume = payload.get("music_volume", 100)
    original_audio_volume = payload.get("original_audio_volume", 30)

    work = tempfile.mkdtemp(prefix="tbg-media-")
    try:
        normalized = []

        for idx, clip in enumerate(clips):
            url = clip.get("video_url")
            if not url:
                raise ValueError(f"clips[{idx}].video_url is required.")

            src = os.path.join(work, f"source-{idx}.mp4")
            out = os.path.join(work, f"clip-{idx}.mp4")
            download(url, src)

            start = clip.get("start_seconds")
            duration = clip.get("duration_seconds")
            if start is not None and float(start) < 0:
                raise ValueError("start_seconds cannot be negative.")
            if duration is not None and not 0.1 <= float(duration) <= 90:
                raise ValueError("duration_seconds must be between 0.1 and 90.")

            normalize_clip(
                src,
                out,
                width,
                height,
                fit,
                start,
                duration,
                keep_audio,
            )
            normalized.append(out)

        joined = os.path.join(work, "joined.mp4")
        concat_clips(normalized, joined)

        final_path = joined

        if music_url:
            music = os.path.join(work, "music.m4a")
            download(music_url, music)
            mixed = os.path.join(work, "final.mp4")
            add_music(
                joined,
                music,
                mixed,
                keep_audio,
                original_audio_volume,
                music_volume,
            )
            final_path = mixed

        return final_path, work
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise


class Handler(BaseHTTPRequestHandler):
    server_version = "TBGMediaProcessor/1.0"

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        self.send_error(404)

    def do_POST(self):
        if self.path != "/compose":
            self.send_error(404)
            return

        work = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1024 * 1024:
                raise ValueError("Invalid request body size.")

            payload = json.loads(self.rfile.read(length))
            final_path, work = compose(payload)

            size = os.path.getsize(final_path)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            with open(final_path, "rb") as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except Exception as exc:
            body = json.dumps({"error": str(exc)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        finally:
            if work:
                shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
