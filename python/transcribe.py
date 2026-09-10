#!/usr/bin/env python3
"""One-shot faster-whisper transcriber for the pi-voice pi extension.

Reads raw s16le mono PCM at a fixed sample rate and writes exactly one JSON
object to stdout. All diagnostics go to stderr, because the caller parses stdout
and nothing else.

Why raw PCM: the recorder writes headerless samples, so a recording that was cut
short by a signal is still valid audio. A WAV container needs a header written on
graceful shutdown, and a truncated one is rejected by most decoders.
`faster-whisper` accepts a float32 numpy array, so no container parsing is needed
anywhere in the pipeline.

Success:
    {"text": "...", "language": "en", "languageProbability": 0.99,
     "durationSeconds": 6.49, "elapsedSeconds": 1.73, "scriptSteering": "simplified",
     "segments": [...]}

Failure (also exits non-zero):
    {"error": {"kind": "no_faster_whisper", "message": "..."}}
"""

from __future__ import annotations

import argparse
import json
import sys
import time

DEFAULT_SAMPLE_RATE = 16000

# Whisper's Chinese output has no stable script: the same voice can come back Traditional or
# Simplified, and there is no script subtag in its language list to ask for one. A short
# sentence in the wanted script, placed in the decoder context, steers it without changing
# the words. It is a bias, not a guarantee.
STEERING_PROMPTS = {
    "simplified": "以下是简体中文的句子。",
    "traditional": "以下是繁體中文的句子。",
}


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(kind: str, message: str) -> None:
    emit({"error": {"kind": kind, "message": message}})
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe raw PCM with faster-whisper")
    parser.add_argument("--audio", required=True, help="path to raw s16le PCM")
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default=None, help="omit for auto-detect")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--cpu-threads", type=int, default=0)
    parser.add_argument("--initial-prompt", default=None)
    parser.add_argument(
        "--steer-script",
        choices=sorted(STEERING_PROMPTS),
        default=None,
        help="steer Chinese output to this script instead of Whisper's own choice",
    )
    parser.add_argument("--no-vad", action="store_true", help="disable the built-in Silero VAD")
    args = parser.parse_args()

    # Separate import failures from everything else: a missing faster-whisper is
    # the single most likely cause and deserves its own actionable message.
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError as exc:
        fail("no_faster_whisper", str(exc))

    try:
        with open(args.audio, "rb") as handle:
            pcm = handle.read()
    except OSError as exc:
        fail("audio_unreadable", str(exc))

    sample_rate = args.sample_rate or DEFAULT_SAMPLE_RATE
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    duration = float(len(audio)) / float(sample_rate)

    # An empty recording is a caller-side mistake, not an error worth a traceback.
    if len(audio) == 0:
        emit({
            "text": "",
            "language": args.language or "",
            "languageProbability": 0.0,
            "durationSeconds": 0.0,
            "elapsedSeconds": 0.0,
            "scriptSteering": None,
            "segments": [],
        })
        return

    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            cpu_threads=args.cpu_threads,
        )
    except Exception as exc:
        # Model download failures and a corrupt local cache both land here.
        fail("model_unavailable", f"{type(exc).__name__}: {exc}")

    # Detect the language ourselves when the caller left it open and steering is on, because
    # the steering prompt has to be chosen before decoding. This is not extra work:
    # transcribe() runs the same detection internally when language is None.
    language = args.language
    if language is None and args.steer_script:
        language, _probability, _all_probabilities = model.detect_language(
            audio=audio, vad_filter=not args.no_vad
        )

    prompt = args.initial_prompt or None
    steered = None
    if args.steer_script and language is not None and language.startswith("zh"):
        steering_prompt = STEERING_PROMPTS[args.steer_script]
        prompt = f"{prompt} {steering_prompt}" if prompt else steering_prompt
        steered = args.steer_script

    started = time.time()
    try:
        # `segments` is a generator: it must be consumed here, where a
        # transcription error can still be attributed and reported.
        segments, info = model.transcribe(
            audio,
            beam_size=args.beam_size,
            language=language,
            vad_filter=not args.no_vad,
            initial_prompt=prompt,
        )
        collected = [
            {"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip()}
            for seg in segments
        ]
    except Exception as exc:
        fail("python_failed", f"{type(exc).__name__}: {exc}")

    emit({
        "text": " ".join(seg["text"] for seg in collected).strip(),
        "language": info.language,
        "languageProbability": float(info.language_probability),
        "durationSeconds": duration,
        "elapsedSeconds": time.time() - started,
        "scriptSteering": steered,
        "segments": collected,
    })


if __name__ == "__main__":
    main()
