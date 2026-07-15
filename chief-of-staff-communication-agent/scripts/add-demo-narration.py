#!/usr/bin/env python3
"""Add voiceover to the Indeedee UI demo video."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]
VIDEO_IN = ROOT / "demo" / "indeedee-chief-of-staff-demo.webm"
VIDEO_OUT = ROOT / "demo" / "indeedee-chief-of-staff-demo-voiced.webm"
WORK = ROOT / "demo" / ".narration-indeedee"
VOICE = "en-US-AndrewNeural"
RATE = "+18%"

SEGMENTS: list[tuple[float, str]] = [
    (0.0, "Indeedee — Chief of Staff Communication Agent. Unified inbox for executive communications."),
    (4.0, "One click connects demo channels across Gmail, email, SMS, WhatsApp, and X."),
    (9.0, "Sync ingests messages and runs the agent — recommendations and drafts for every inbound item."),
    (15.0, "The dashboard shows volume, overdue messages, pending approvals, and channel breakdown."),
    (21.0, "Incoming view organizes messages in a kanban board with recommended next actions."),
    (27.0, "People view links cross-channel threads for the same contact."),
    (33.0, "Approvals queue holds style-matched drafts until the owner approves send."),
    (39.0, "Connections catalog supports live OAuth and credentials per channel."),
    (45.0, "Cursor MCP tools expose the same RAG, sync, and approval workflow to agents."),
]


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def duration(path: Path) -> float:
    ff = ffmpeg()
    r = subprocess.run([ff, "-i", str(path)], capture_output=True, text=True, check=False)
    for line in r.stderr.splitlines():
        if "Duration:" in line:
            part = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = part.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise RuntimeError(f"no duration for {path}")


async def synth(idx: int, text: str) -> Path:
    p = WORK / f"seg_{idx:02d}.mp3"
    await edge_tts.Communicate(text, VOICE, rate=RATE).save(str(p))
    return p


async def main() -> None:
    if not VIDEO_IN.exists():
        raise SystemExit(f"Missing {VIDEO_IN} — run node scripts/record-ui-demo.mjs first")

    WORK.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg()
    vid_len = duration(VIDEO_IN)
    pieces: list[Path] = []

    for idx, (start, text) in enumerate(SEGMENTS):
        seg = await synth(idx, text)
        seg_len = duration(seg)
        next_start = SEGMENTS[idx + 1][0] if idx + 1 < len(SEGMENTS) else vid_len
        slot = max(0.6, next_start - start)
        piece = WORK / f"piece_{idx:02d}.m4a"
        subprocess.run(
            [
                ff,
                "-y",
                "-i",
                str(seg),
                "-af",
                f"apad=pad_dur={max(0, slot - seg_len):.3f}",
                "-t",
                f"{slot:.3f}",
                "-c:a",
                "aac",
                str(piece),
            ],
            check=True,
        )
        pieces.append(piece)
        print(f"segment {idx}: {text[:50]}…")

    concat = WORK / "concat.txt"
    concat.write_text("".join(f"file '{p.resolve()}'\n" for p in pieces))
    audio = WORK / "narration.m4a"
    subprocess.run([ff, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(audio)], check=True)

    subprocess.run(
        [ff, "-y", "-i", str(VIDEO_IN), "-i", str(audio), "-c:v", "copy", "-c:a", "aac", "-shortest", str(VIDEO_OUT)],
        check=True,
    )
    print(f"Wrote {VIDEO_OUT} ({duration(VIDEO_OUT):.1f}s)")


if __name__ == "__main__":
    asyncio.run(main())
