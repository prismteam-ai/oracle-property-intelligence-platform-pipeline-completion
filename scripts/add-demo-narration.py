#!/usr/bin/env python3
"""Add README-transcript voiceover to the demo video."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import edge_tts

PROJECT_ROOT = Path(__file__).resolve().parents[1]
VIDEO_IN = PROJECT_ROOT / "demo" / "oracle-property-intelligence-demo.webm"
VIDEO_OUT = PROJECT_ROOT / "demo" / "oracle-property-intelligence-demo-voiced.webm"
WORK_DIR = PROJECT_ROOT / "demo" / ".narration"
VOICE = "en-US-AndrewNeural"
SPEECH_RATE = "+20%"

# Short lines aligned to on-screen scene changes (~34s video)
SEGMENTS: list[tuple[float, str]] = [
    (0.0, "Oracle pipeline demo for Santa Clara County, including Palo Alto."),
    (3.5, "Pipeline run summary with six source types, counts, and constraints."),
    (7.5, "IPFS artifacts and DuckDB querying without a hosted database."),
    (11.0, "Properties with roofs older than fifteen years, with permit evidence."),
    (15.5, "Properties near public transportation, using parcel coordinates."),
    (22.5, "All six README demo questions return source-backed answers."),
    (26.0, "Agents use MCP queryProperties. The system is MCP-ready."),
]


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_duration(path: Path) -> float:
    ff = ffmpeg()
    result = subprocess.run(
        [ff, "-i", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    for line in result.stderr.splitlines():
        if "Duration:" in line:
            part = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = part.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise RuntimeError(f"Could not probe duration for {path}")


def probe_audio_duration(path: Path) -> float:
    return probe_duration(path)


async def synthesize_segment(idx: int, text: str) -> Path:
    path = WORK_DIR / f"seg_{idx:02d}.mp3"
    communicate = edge_tts.Communicate(text, VOICE, rate=SPEECH_RATE)
    await communicate.save(str(path))
    return path


async def build_timed_audio(video_duration: float) -> Path:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg()
    pieces: list[Path] = []

    for idx, (start_s, text) in enumerate(SEGMENTS):
        seg = await synthesize_segment(idx, text)
        seg_len = probe_audio_duration(seg)
        print(f"OK  segment {idx}: {seg_len:.1f}s at {start_s:.1f}s")

        next_start = SEGMENTS[idx + 1][0] if idx + 1 < len(SEGMENTS) else video_duration
        slot = max(0.5, next_start - start_s)
        piece = WORK_DIR / f"piece_{idx:02d}.m4a"
        cmd = [
            ff,
            "-y",
            "-i",
            str(seg),
            "-af",
            f"apad=whole_dur={slot:.3f}",
            "-t",
            f"{slot:.3f}",
            "-c:a",
            "aac",
            str(piece),
        ]
        subprocess.run(cmd, check=True)
        pieces.append(piece)

    out_audio = WORK_DIR / "narration.m4a"
    concat_list = WORK_DIR / "concat.txt"
    concat_list.write_text("".join(f"file '{p.resolve()}'\n" for p in pieces))
    subprocess.run(
        [
            ff,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-t",
            f"{video_duration:.3f}",
            "-c:a",
            "aac",
            str(out_audio),
        ],
        check=True,
    )
    return out_audio


def mux_video_audio(audio: Path) -> None:
    ff = ffmpeg()
    subprocess.run(
        [
            ff,
            "-y",
            "-i",
            str(VIDEO_IN),
            "-i",
            str(audio),
            "-c:v",
            "copy",
            "-c:a",
            "libopus",
            "-b:a",
            "128k",
            "-shortest",
            str(VIDEO_OUT),
        ],
        check=True,
    )


async def main() -> None:
    if not VIDEO_IN.exists():
        raise SystemExit(f"Missing input video: {VIDEO_IN}")

    duration = probe_duration(VIDEO_IN)
    print(f"== Narration for {VIDEO_IN.name} ({duration:.1f}s) ==")
    audio = await build_timed_audio(duration)
    mux_video_audio(audio)
    print(f"Wrote {VIDEO_OUT}")


if __name__ == "__main__":
    asyncio.run(main())
