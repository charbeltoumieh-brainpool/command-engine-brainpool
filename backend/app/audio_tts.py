from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import wave
from typing import Any

import edge_tts
import numpy as np

DEFAULT_ALEX_VOICE = os.environ.get("COMMAND_ENGINE_TTS_ALEX_VOICE", "marius").strip() or "marius"
DEFAULT_MAYA_VOICE = os.environ.get("COMMAND_ENGINE_TTS_MAYA_VOICE", "alba").strip() or "alba"

VOICE_CANDIDATES: dict[str, tuple[str, ...]] = {
    "Alex": (DEFAULT_ALEX_VOICE, "marius", "jean", "george"),
    "Maya": (DEFAULT_MAYA_VOICE, "alba", "fantine", "cosette"),
}

_TTS_LOCK = threading.Lock()
_POCKET_MODEL: Any = None
_VOICE_STATE_CACHE: dict[str, Any] = {}


@dataclass(frozen=True)
class AudioSynthesisResult:
    engine: str
    voices: dict[str, str]
    sample_rate: int
    duration_sec: int


def normalize_text_for_tts(text: str) -> str:
    """Clean markdown/code symbols and expand tech tokens so Pocket TTS speaks naturally."""
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""

    # Replace markdown links [label](url) -> label, then drop bare URLs
    cleaned = re.sub(r"\[([^\]]+)\]\((?:https?://|file://)[^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"https?://\S+", "", cleaned)

    # Convert "number" references like #2891 or repo-name#2891 BEFORE stripping markdown #
    cleaned = re.sub(r"\b([A-Za-z0-9_-]+)#(\d+)\b", r"\1 number \2", cleaned)
    cleaned = re.sub(r"(?<!\w)#(\d+)\b", r"number \1", cleaned)

    # Strip markdown formatting markers
    cleaned = re.sub(r"[*_`~#]+", " ", cleaned)

    # Replace separators with natural pauses
    cleaned = cleaned.replace("->", ", ").replace("=>", ", ")
    cleaned = re.sub(r"\s*[—–]+\s*", ", ", cleaned)
    cleaned = re.sub(r"\s+--\s+", ", ", cleaned)
    cleaned = cleaned.replace("&", " and ")

    # Normalize version strings (v0.397.0 -> version 0 point 397 point 0)
    def _version_repl(match: re.Match[str]) -> str:
        parts = match.group(1).split(".")
        return "version " + " point ".join(parts)

    cleaned = re.sub(r"\bv(\d+(?:\.\d+){1,3})\+?\b", _version_repl, cleaned)

    # Expand hyphenated repo/service slugs ("service-kit" -> "service kit") before acronym pass
    cleaned = re.sub(
        r"\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b",
        lambda m: m.group(1).replace("-", " "),
        cleaned,
    )

    # Expand common cloud/engineering acronyms & priority levels for smoother pronunciation
    replacements: tuple[tuple[str, str], ...] = (
        (r"\bOAuth\b", "O Auth"),
        (r"\b(?:IAC|iac)\b", "I A C"),
        (r"\b(?:GKE|gke)\b", "G K E"),
        (r"\b(?:GCP|gcp)\b", "G C P"),
        (r"\bGMT\b", "G M T"),
        (r"\bCTO\b", "C T O"),
        (r"\bPRs\b", "P Rs"),
        (r"\bPR\b", "P R"),
        (r"\bCI\b", "C I"),
        (r"\bKB\b", "K B"),
        (r"\bDM\b", "D M"),
        (r"\bAPI\b", "A P I"),
        (r"\bUI\b", "U I"),
        (r"\bTOC\b", "table of contents"),
        (r"\bDITA\b", "Dita"),
        (r"\bP0\b", "P zero"),
        (r"\bP1\b", "P one"),
        (r"\bP2\b", "P two"),
    )
    for pattern, repl in replacements:
        cleaned = re.sub(pattern, repl, cleaned)

    # Replace remaining slashes between words ("KB/Project" -> "KB or Project")
    cleaned = re.sub(r"([A-Za-z0-9])\s*/\s*([A-Za-z0-9])", r"\1 or \2", cleaned)

    # Remove non-ASCII pictographs/symbols while keeping standard punctuation/accents
    cleaned = re.sub(r"[^\w\s.,!?;:'\"()\-%$@/]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r"\s+([.,!?;:)])", r"\1", cleaned)
    cleaned = re.sub(r"\(\s+", "(", cleaned)

    if cleaned and cleaned[-1] not in ".!?":
        cleaned += "."
    return cleaned


def _split_into_sentences(text: str, max_chars: int = 380) -> list[str]:
    """Split long turns at sentence boundaries for cleaner Pocket TTS prosody."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if not sentences:
        return [text] if text else []

    chunks: list[str] = []
    current = ""
    for sent in sentences:
        if not current:
            current = sent
        elif len(current) + 1 + len(sent) <= max_chars:
            current = f"{current} {sent}"
        else:
            chunks.append(current)
            current = sent
    if current:
        chunks.append(current)
    return chunks


def _shape_pcm_chunk(pcm: np.ndarray, sample_rate: int, target_rms: float = 0.115) -> np.ndarray:
    """Remove DC offset, balance loudness across hosts, and apply micro-fades."""
    arr = np.asarray(pcm, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return arr

    arr = arr - float(np.mean(arr))

    rms = float(np.sqrt(np.mean(np.square(arr))))
    if rms > 1e-4:
        gain = min(target_rms / rms, 3.2)
        arr = arr * gain

    peak = float(np.max(np.abs(arr)))
    if peak > 0.94:
        arr = np.tanh(arr * (0.94 / peak) * 1.1) / np.tanh(1.1)

    fade_in = min(int(sample_rate * 0.010), arr.size // 4)
    fade_out = min(int(sample_rate * 0.018), arr.size // 4)
    if fade_in > 1:
        arr[:fade_in] *= np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
    if fade_out > 1:
        arr[-fade_out:] *= np.linspace(1.0, 0.0, fade_out, dtype=np.float32)

    return np.clip(arr, -0.98, 0.98)


def _get_pocket_tts_model_and_voice(speaker: str) -> tuple[Any, Any, str]:
    global _POCKET_MODEL
    from pocket_tts import TTSModel

    if _POCKET_MODEL is None:
        _POCKET_MODEL = TTSModel.load_model()

    candidates = VOICE_CANDIDATES.get(speaker, (DEFAULT_ALEX_VOICE, "marius", "alba"))
    last_err: Exception | None = None
    for voice_name in candidates:
        cache_key = voice_name.lower()
        if cache_key in _VOICE_STATE_CACHE:
            return _POCKET_MODEL, _VOICE_STATE_CACHE[cache_key], voice_name
        try:
            state = _POCKET_MODEL.get_state_for_audio_prompt(voice_name)
            _VOICE_STATE_CACHE[cache_key] = state
            return _POCKET_MODEL, state, voice_name
        except Exception as exc:
            last_err = exc
            continue
    raise RuntimeError(f"Failed to load Pocket TTS voice for {speaker}: {last_err}")


def _encode_pcm_wav_bytes(pcm: np.ndarray, sample_rate: int) -> bytes:
    """Encode float/numeric mono PCM array directly into 16-bit WAV bytes in memory."""
    arr = np.asarray(pcm, dtype=np.float32).reshape(-1)
    pcm_i16 = (np.clip(arr, -1.0, 1.0) * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate or 24000))
        wf.writeframes(pcm_i16.tobytes())
    return buf.getvalue()


def _write_wav_and_encode_mp3(
    pcm: np.ndarray,
    sample_rate: int,
    output_mp3_path: Path,
    *,
    allow_wav_fallback: bool = False,
) -> Path:
    wav_bytes = _encode_pcm_wav_bytes(pcm, sample_rate)
    if output_mp3_path.suffix.lower() == ".wav":
        output_mp3_path.parent.mkdir(parents=True, exist_ok=True)
        output_mp3_path.write_bytes(wav_bytes)
        return output_mp3_path

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        if allow_wav_fallback:
            wav_path = output_mp3_path.with_suffix(".wav")
            wav_path.parent.mkdir(parents=True, exist_ok=True)
            wav_path.write_bytes(wav_bytes)
            return wav_path
        raise RuntimeError("ffmpeg binary is not available on PATH.")

    output_mp3_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        dir=str(output_mp3_path.parent),
        prefix=f".{output_mp3_path.stem}_",
        suffix=".wav",
        delete=False,
    ) as tmp:
        tmp_wav_path = Path(tmp.name)

    try:
        tmp_wav_path.write_bytes(wav_bytes)

        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(tmp_wav_path),
                "-af",
                "highpass=f=65,acompressor=threshold=-18dB:ratio=2.2:attack=12:release=120,loudnorm=I=-16:TP=-1.5:LRA=11",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "192k",
                "-ar",
                "44100",
                "-ac",
                "1",
                str(output_mp3_path),
            ],
            capture_output=True,
            text=True,
            timeout=180,
            shell=False,
        )
        if proc.returncode != 0 or not output_mp3_path.exists() or output_mp3_path.stat().st_size == 0:
            raise RuntimeError(f"ffmpeg MP3 encoding failed (code={proc.returncode}): {proc.stderr.strip()}")
        return output_mp3_path
    finally:
        tmp_wav_path.unlink(missing_ok=True)


def _synthesize_with_pocket_tts_sync(
    turns: list[dict[str, str]],
    output_mp3_path: Path,
) -> AudioSynthesisResult:
    segments: list[np.ndarray] = []
    used_voices: dict[str, str] = {}
    sample_rate = 24000

    with _TTS_LOCK:
        for turn_idx, turn in enumerate(turns):
            speaker = "Maya" if str(turn.get("speaker") or "").strip().lower() == "maya" else "Alex"
            spoken = normalize_text_for_tts(turn.get("text") or "")
            if not spoken:
                continue

            model, voice_state, voice_name = _get_pocket_tts_model_and_voice(speaker)
            sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)
            used_voices[speaker] = voice_name

            if turn_idx == 0:
                segments.append(np.zeros(int(sample_rate * 0.12), dtype=np.float32))
            else:
                segments.append(np.zeros(int(sample_rate * 0.30), dtype=np.float32))

            sentences = _split_into_sentences(spoken)
            for sent_idx, sentence in enumerate(sentences):
                wav_tensor = model.generate_audio(voice_state, sentence, copy_state=True)
                if hasattr(wav_tensor, "detach"):
                    wav_np = wav_tensor.detach().cpu().numpy()
                else:
                    wav_np = np.asarray(wav_tensor)
                shaped = _shape_pcm_chunk(wav_np, sample_rate)
                if shaped.size > 0:
                    segments.append(shaped)
                    if sent_idx < len(sentences) - 1:
                        segments.append(np.zeros(int(sample_rate * 0.11), dtype=np.float32))

    if not segments:
        raise RuntimeError("No audio segments generated by Pocket TTS.")

    segments.append(np.zeros(int(sample_rate * 0.35), dtype=np.float32))
    full_pcm = np.concatenate(segments)
    duration_sec = max(1, int(round(full_pcm.size / float(sample_rate))))

    _write_wav_and_encode_mp3(full_pcm, sample_rate, output_mp3_path, allow_wav_fallback=True)

    return AudioSynthesisResult(
        engine="pocket-tts",
        voices=used_voices,
        sample_rate=sample_rate,
        duration_sec=duration_sec,
    )


async def _synthesize_with_edge_tts_fallback(
    turns: list[dict[str, str]],
    output_mp3_path: Path,
) -> AudioSynthesisResult:
    voice_map = {
        "Alex": "en-US-GuyNeural",
        "Maya": "en-US-AriaNeural",
    }
    fallback_voice = "en-US-JennyNeural"

    mp3_chunks: list[bytes] = []
    used_voices: dict[str, str] = {}
    for turn in turns:
        speaker = "Maya" if str(turn.get("speaker") or "").strip().lower() == "maya" else "Alex"
        spoken = normalize_text_for_tts(turn.get("text") or "") or str(turn.get("text") or "").strip()
        primary_voice = voice_map.get(speaker, "en-US-GuyNeural")
        synthesized = False
        for candidate_voice in (primary_voice, fallback_voice):
            try:
                comm = edge_tts.Communicate(spoken, candidate_voice)
                turn_chunks = [chunk["data"] async for chunk in comm.stream() if chunk["type"] == "audio"]
                if turn_chunks:
                    mp3_chunks.extend(turn_chunks)
                    used_voices[speaker] = candidate_voice
                    synthesized = True
                    break
            except Exception:
                continue
        if not synthesized:
            raise RuntimeError(f"Edge TTS fallback failed for speaker {speaker}.")

    output_mp3_path.parent.mkdir(parents=True, exist_ok=True)
    output_mp3_path.write_bytes(b"".join(mp3_chunks))

    word_count = sum(len(str(t.get("text") or "").split()) for t in turns)
    duration_sec = max(10, int(round(word_count / 2.5)))
    return AudioSynthesisResult(
        engine="edge-tts-fallback",
        voices=used_voices,
        sample_rate=24000,
        duration_sec=duration_sec,
    )


async def synthesize_dialogue_mp3(
    turns: list[dict[str, str]],
    output_mp3_path: Path,
) -> AudioSynthesisResult:
    """Synthesize a two-host dialogue MP3 using Kyutai Pocket TTS (with Edge TTS fallback)."""
    try:
        return await asyncio.to_thread(_synthesize_with_pocket_tts_sync, turns, output_mp3_path)
    except Exception:
        return await _synthesize_with_edge_tts_fallback(turns, output_mp3_path)


def _synthesize_single_turn_pocket_tts_sync(text: str, voice: str = "Alex") -> dict[str, Any]:
    speaker = "Maya" if str(voice or "").strip().lower() == "maya" else "Alex"
    spoken = normalize_text_for_tts(text) or str(text or "").strip()
    if not spoken:
        raise ValueError("Cannot synthesize empty TTS text.")

    segments: list[np.ndarray] = []
    sample_rate = 24000
    with _TTS_LOCK:
        model, voice_state, _voice_name = _get_pocket_tts_model_and_voice(speaker)
        sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)
        segments.append(np.zeros(int(sample_rate * 0.08), dtype=np.float32))
        sentences = _split_into_sentences(spoken)
        for sent_idx, sentence in enumerate(sentences):
            wav_tensor = model.generate_audio(voice_state, sentence, copy_state=True)
            if hasattr(wav_tensor, "detach"):
                wav_np = wav_tensor.detach().cpu().numpy()
            else:
                wav_np = np.asarray(wav_tensor)
            shaped = _shape_pcm_chunk(wav_np, sample_rate)
            if shaped.size > 0:
                segments.append(shaped)
                if sent_idx < len(sentences) - 1:
                    segments.append(np.zeros(int(sample_rate * 0.10), dtype=np.float32))

    if len(segments) <= 1:
        raise RuntimeError("No audio segments generated by Pocket TTS.")

    segments.append(np.zeros(int(sample_rate * 0.22), dtype=np.float32))
    full_pcm = np.concatenate(segments)
    duration_sec = max(1, int(round(full_pcm.size / float(sample_rate))))

    if shutil.which("ffmpeg"):
        with tempfile.TemporaryDirectory(prefix="pocket_tts_turn_") as tmp_dir:
            tmp_mp3 = Path(tmp_dir) / "turn.mp3"
            _write_wav_and_encode_mp3(full_pcm, sample_rate, tmp_mp3)
            mp3_bytes = tmp_mp3.read_bytes()
        if mp3_bytes:
            return {
                "audio_b64": base64.b64encode(mp3_bytes).decode("ascii"),
                "mime_type": "audio/mpeg",
                "engine": "pocket-tts",
                "duration_sec": duration_sec,
            }

    wav_bytes = _encode_pcm_wav_bytes(full_pcm, sample_rate)
    return {
        "audio_b64": base64.b64encode(wav_bytes).decode("ascii"),
        "mime_type": "audio/wav",
        "engine": "pocket-tts-wav",
        "duration_sec": duration_sec,
    }


async def synthesize_single_turn_audio_b64(text: str, voice: str = "Alex") -> dict[str, Any]:
    """
    Synthesize a single spoken turn with Pocket TTS (MP3 via ffmpeg, or portable zero-ffmpeg WAV),
    falling back to Edge TTS MP3 if Pocket TTS is unavailable.
    """
    cleaned = normalize_text_for_tts(text)[:650] or str(text or "").strip()[:650]
    if not cleaned:
        silent_wav = _encode_pcm_wav_bytes(np.zeros(int(16000 * 0.25), dtype=np.float32), 16000)
        return {
            "audio_b64": base64.b64encode(silent_wav).decode("ascii"),
            "mime_type": "audio/wav",
            "engine": "silent-empty",
            "duration_sec": 0,
        }

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_synthesize_single_turn_pocket_tts_sync, cleaned, voice),
            timeout=12.0,
        )
    except Exception:
        pass

    speaker = "Maya" if str(voice or "").strip().lower() == "maya" else "Alex"
    voice_map = {
        "Alex": "en-US-GuyNeural",
        "Maya": "en-US-AriaNeural",
    }
    primary_voice = voice_map.get(speaker, "en-US-GuyNeural")
    for candidate_voice in (primary_voice, "en-US-JennyNeural"):
        try:
            comm = edge_tts.Communicate(cleaned, candidate_voice)
            chunks = [chunk["data"] async for chunk in comm.stream() if chunk["type"] == "audio"]
            if chunks:
                mp3_bytes = b"".join(chunks)
                duration_sec = max(1, int(round(len(cleaned.split()) / 2.5)))
                return {
                    "audio_b64": base64.b64encode(mp3_bytes).decode("ascii"),
                    "mime_type": "audio/mpeg",
                    "engine": "edge-tts-fallback",
                    "duration_sec": duration_sec,
                }
        except Exception:
            continue

    raise RuntimeError("Both Pocket TTS and Edge TTS failed to synthesize single-turn audio.")
