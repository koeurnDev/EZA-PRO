"""
Local SenseVoice-Small speech-to-text, FSMN-VAD segmentation, and CAM++ speaker diarization runner.
Outputs structured cues (startSec, endSec, text, emotionTag, eventTag, speakerId, suggestedVoice)
for EZA PRO so Gemini can translate clean Chinese lines without wasting audio quota or missing gaps.
"""

import argparse
import json
import os
import re
import sys
import warnings

os.environ.setdefault("MODELSCOPE_LOG_LEVEL", "40")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
warnings.filterwarnings("ignore")

DEFAULT_CACHE_REL = os.path.join(".ai_models", "sensevoice")

MODEL_SPECS = {
    "hf": {
        "asr": "FunAudioLLM/SenseVoiceSmall",
        "vad": "funasr/fsmn-vad",
        "spk": "funasr/campplus",
    },
    "ms": {
        "asr": "iic/SenseVoiceSmall",
        "vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "spk": "iic/speech_campplus_sv_zh-cn_16k-common",
    },
}

LANG_ALIAS = {
    "auto": "auto",
    "zh": "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-km": "zh",
    "yue": "yue",
    "en": "en",
    "en-km": "en",
    "ja": "ja",
    "ko": "ko",
}

EVENT_TAG_RE = re.compile(r"<\|([^|]+)\|>")


def emit_progress(percent: int, stage: str, text: str) -> None:
    """Emit structured progress lines on stderr for Node backend progress tracking."""
    pct = max(0, min(100, int(percent)))
    sys.stderr.write(f"EZA_STT_PROGRESS:{pct}|{stage}|{text}\n")
    sys.stderr.flush()


def setup_cache_env(cache_dir: str) -> str:
    """Point ModelScope and HuggingFace caches inside the local .ai_models folder."""
    abs_cache = os.path.abspath(cache_dir)
    ms_cache = os.path.join(abs_cache, "modelscope")
    hf_cache = os.path.join(abs_cache, "huggingface")
    hf_hub_cache = os.path.join(hf_cache, "hub")
    os.makedirs(ms_cache, exist_ok=True)
    os.makedirs(hf_hub_cache, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = ms_cache
    os.environ["HF_HOME"] = hf_cache
    os.environ["HF_HUB_CACHE"] = hf_hub_cache
    os.environ["HUGGINGFACE_HUB_CACHE"] = hf_hub_cache
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    return abs_cache


def has_sensevoice_cached_weights(base_dir: str) -> tuple:
    """Return (has_sensevoice, has_vad) indicating cached model weight presence under base_dir."""
    has_sv = False
    has_vad = False
    if not os.path.isdir(base_dir):
        return (False, False)
    abs_base = os.path.abspath(base_dir)
    for root, _, files in os.walk(abs_base):
        rel = os.path.relpath(root, abs_base).lower()
        if rel == ".":
            continue
        pt_path = os.path.join(root, "model.pt")
        st_path = os.path.join(root, "model.safetensors")
        if "sensevoice" in rel and (
            (os.path.isfile(pt_path) and os.path.getsize(pt_path) > 500_000_000)
            or (os.path.isfile(st_path) and os.path.getsize(st_path) > 500_000_000)
        ):
            has_sv = True
        if "fsmn" in rel and "vad" in rel and (
            (os.path.isfile(pt_path) and os.path.getsize(pt_path) > 500_000)
            or (os.path.isfile(st_path) and os.path.getsize(st_path) > 500_000)
        ):
            has_vad = True
        if has_sv and has_vad:
            break
    return (has_sv, has_vad)


def check_runtime(cache_dir: str) -> dict:
    """Fast runtime capability probe (~0.4s) without heavy full FunASR import."""
    import importlib.metadata
    import importlib.util

    setup_cache_env(cache_dir)
    info = {
        "available": False,
        "cuda": False,
        "device": "cpu",
        "gpuName": "",
        "funasrVersion": "",
        "modelsCached": False,
        "error": "",
    }
    try:
        if importlib.util.find_spec("funasr") is None:
            info["error"] = "funasr not installed"
            return info
        if importlib.util.find_spec("soundfile") is None:
            info["error"] = "soundfile not installed"
            return info
        import torch

        info["available"] = True
        try:
            info["funasrVersion"] = str(importlib.metadata.version("funasr"))
        except Exception:
            info["funasrVersion"] = "installed"
        if torch.cuda.is_available():
            info["cuda"] = True
            info["device"] = "cuda:0"
            try:
                info["gpuName"] = str(torch.cuda.get_device_name(0))
            except Exception:
                info["gpuName"] = "NVIDIA CUDA"

        has_sv = False
        has_vad = False
        search_roots = [cache_dir, os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")]
        for base_dir in search_roots:
            sv_ok, vad_ok = has_sensevoice_cached_weights(base_dir)
            has_sv = has_sv or sv_ok
            has_vad = has_vad or vad_ok
            if has_sv and has_vad:
                break
        info["modelsCached"] = has_sv and has_vad
    except Exception as exc:
        info["error"] = str(exc)
    return info


def resolve_device(requested: str) -> str:
    """Select CUDA when available unless CPU is explicitly requested."""
    req = str(requested or "auto").strip().lower()
    if req == "cpu":
        return "cpu"
    import torch

    if torch.cuda.is_available():
        return "cuda:0"
    return "cpu"


def detect_preferred_hubs(requested_hub: str, cache_dir: str) -> list:
    """Order ModelScope / HuggingFace hubs so already-cached or reliable weights load first."""
    req = str(requested_hub or "auto").strip().lower()
    if req in ("hf", "ms"):
        return [req]

    ms_dir = os.path.join(cache_dir, "modelscope")
    hf_dir = os.path.join(cache_dir, "huggingface")
    ms_sv, _ = has_sensevoice_cached_weights(ms_dir)
    hf_sv, _ = has_sensevoice_cached_weights(hf_dir)
    if ms_sv:
        return ["ms", "hf"]
    if hf_sv:
        return ["hf", "ms"]
    return ["ms", "hf"]


def parse_sensevoice_raw_tags(raw_text: str) -> dict:
    """Extract SenseVoice embedded language, emotion, and acoustic event tags cleanly."""
    tags = EVENT_TAG_RE.findall(str(raw_text or ""))
    lang_tag = ""
    emotion_tag = ""
    event_tag = ""
    is_nospeech = False

    known_langs = {"zh", "en", "yue", "ja", "ko", "nospeech"}
    known_emos = {"HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARFUL", "DISGUSTED", "SURPRISED", "EMO_UNKNOWN"}
    known_events = {"Speech", "BGM", "Applause", "Laughter", "Cry", "Crying", "Cough", "Sneeze", "Breath", "Sing", "Event_UNK"}

    for tag in tags:
        clean = tag.strip()
        if not clean:
            continue
        if clean.lower() == "nospeech":
            is_nospeech = True
        if clean.lower() in known_langs and not lang_tag:
            lang_tag = clean.lower()
        elif clean.upper() in known_emos and not emotion_tag:
            emotion_tag = clean.upper()
        elif clean in known_events and not event_tag:
            event_tag = clean
    return {
        "langTag": lang_tag,
        "emotionTag": emotion_tag,
        "eventTag": event_tag,
        "isNoSpeech": is_nospeech,
    }


HARD_STOP_PUNCT = set("。？！?!；;")
SOFT_PAUSE_PUNCT = set("，,、：:")
ALL_PUNCT_CHARS = HARD_STOP_PUNCT | SOFT_PAUSE_PUNCT | set(".…·\"'“”‘’《》【】()（）")


def find_quietest_split_ms(samples, sr: int, win_start_ms: int, win_end_ms: int) -> int:
    """Locate the lowest-energy (quietest RMS) point inside [win_start_ms, win_end_ms] to avoid mid-word cuts."""
    import numpy as np

    if samples is None or win_end_ms <= win_start_ms + 200:
        return (win_start_ms + win_end_ms) // 2
    frame_ms = 80
    hop_ms = 40
    best_ms = (win_start_ms + win_end_ms) // 2
    best_rms = float("inf")
    for cur_ms in range(win_start_ms, win_end_ms - frame_ms + 1, hop_ms):
        s_i = max(0, int(cur_ms * sr / 1000))
        e_i = min(len(samples), int((cur_ms + frame_ms) * sr / 1000))
        if e_i <= s_i:
            continue
        seg = samples[s_i:e_i]
        rms = float(np.sqrt(np.mean(seg * seg)))
        if rms < best_rms:
            best_rms = rms
            best_ms = cur_ms + frame_ms // 2
    return best_ms


def normalize_vad_segments(
    raw_segments: list,
    audio_len_ms: int,
    max_seg_ms: int = 16000,
    samples=None,
    sr: int = 16000,
) -> list:
    """Merge micro-pauses (<180ms), drop tiny blips (<240ms), and split extra-long turns at quietest pauses."""
    merge_cap_ms = min(max_seg_ms, 12000)
    cleaned = []
    for item in raw_segments or []:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        st = max(0, int(item[0]))
        ed = min(audio_len_ms, int(item[1]))
        if ed <= st:
            continue
        if cleaned and st - cleaned[-1][1] <= 180 and (ed - cleaned[-1][0]) <= merge_cap_ms:
            cleaned[-1][1] = ed
        else:
            cleaned.append([st, ed])

    final_segs = []
    for st, ed in cleaned:
        dur = ed - st
        if dur < 240:
            continue
        if dur <= max_seg_ms:
            final_segs.append([st, ed])
            continue
        cur = st
        while cur < ed:
            if ed - cur <= max_seg_ms:
                if ed - cur >= 240:
                    final_segs.append([cur, ed])
                break
            win_lo = cur + max(3000, max_seg_ms // 2)
            win_hi = min(ed - 900, cur + max_seg_ms)
            if samples is not None and win_hi > win_lo + 300:
                nxt = find_quietest_split_ms(samples, sr, win_lo, win_hi)
            else:
                nxt = min(ed, cur + max_seg_ms)
            if ed - nxt < 900:
                nxt = ed
            if nxt - cur >= 240:
                final_segs.append([cur, nxt])
            cur = nxt
    return final_segs


def _join_asr_tokens(tokens: list) -> str:
    """Join Chinese/multilingual tokens cleanly without stray spaces between CJK characters or digits."""
    out = ""
    for raw in tokens:
        tok = str(raw or "").strip()
        if not tok:
            continue
        if not out:
            out = tok
            continue
        prev_ch = out[-1]
        cur_ch = tok[0]
        both_digits = prev_ch.isdigit() and cur_ch.isdigit()
        both_latin = prev_ch.isascii() and prev_ch.isalpha() and cur_ch.isascii() and cur_ch.isalpha()
        need_space_after_punct = prev_ch in ",.;:?!" and cur_ch.isascii() and cur_ch.isalnum()
        out += (" " + tok) if (not both_digits and (both_latin or need_space_after_punct)) else tok
    out = re.sub(r"^[，,、：:\s]+", "", out)
    out = re.sub(r"[，,、：:\s]+$", "", out)
    return out.strip()


def _meaningful_char_count(text: str) -> int:
    """Count non-punctuation, non-whitespace characters inside text."""
    return sum(1 for ch in str(text or "") if not ch.isspace() and ch not in ALL_PUNCT_CHARS)


def split_tokens_into_cues(
    words: list,
    timestamps: list,
    vad_start_ms: int,
    vad_end_ms: int,
    tags: dict,
    sv_lang: str,
    fallback_text: str = "",
) -> list:
    """Split SenseVoice token-level timestamps along sentence punctuation and natural pauses."""
    cues = []

    def append_cue(tok_list: list, st_ms: int, ed_ms: int) -> None:
        text = _join_asr_tokens(tok_list)
        text = re.sub(r"[\U00010000-\U0010ffff\u2600-\u27bf\ufe0f]+", "", text).strip()
        if _meaningful_char_count(text) == 0:
            return
        if not re.search(r"[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0eff\u1780-\u17ff]", text):
            return
        cues.append({
            "startMs": max(0, int(st_ms)),
            "endMs": max(int(st_ms) + 220, int(ed_ms)),
            "text": text,
            "langTag": (tags or {}).get("langTag") or sv_lang,
            "emotionTag": (tags or {}).get("emotionTag") or "",
            "eventTag": (tags or {}).get("eventTag") or "",
        })

    n = min(len(words or []), len(timestamps or []))
    if n > 0:
        buf = []
        buf_st = 0
        buf_ed = 0

        for idx in range(n):
            tok = re.sub(r"<\|[^|]*\|>|[\U00010000-\U0010ffff\u2600-\u27bf\ufe0f]+", "", str(words[idx] or "")).strip()
            ts = timestamps[idx]
            if not tok or not isinstance(ts, (list, tuple)) or len(ts) < 2:
                continue
            abs_st = vad_start_ms + max(0, int(ts[0]))
            abs_ed = vad_start_ms + max(int(ts[0]) + 40, int(ts[1]))

            if buf and (abs_st - buf_ed) >= 520:
                append_cue(buf, buf_st, buf_ed)
                buf = []

            if not buf and all(ch in ALL_PUNCT_CHARS for ch in tok):
                continue

            if not buf:
                buf_st = abs_st
            buf.append(tok)
            buf_ed = max(buf_ed, abs_ed)

            next_abs_st = None
            if idx + 1 < n and isinstance(timestamps[idx + 1], (list, tuple)) and len(timestamps[idx + 1]) >= 2:
                next_abs_st = vad_start_ms + max(0, int(timestamps[idx + 1][0]))
            gap_after = (next_abs_st - buf_ed) if next_abs_st is not None else 9999

            joined_now = _join_asr_tokens(buf)
            content_len = _meaningful_char_count(joined_now)
            dur_ms = buf_ed - buf_st

            last_ch = tok[-1]
            is_decimal_dot = last_ch == "." and idx > 0 and str(words[idx - 1]).isdigit()
            if (last_ch in HARD_STOP_PUNCT or (last_ch == "." and not is_decimal_dot)) and (content_len >= 2 or gap_after >= 220):
                append_cue(buf, buf_st, buf_ed)
                buf = []
            elif last_ch in SOFT_PAUSE_PUNCT and (content_len >= 10 or dur_ms >= 2500 or (content_len >= 4 and gap_after >= 300)):
                append_cue(buf, buf_st, buf_ed)
                buf = []
            elif (content_len >= 22 or dur_ms >= 4800) and gap_after >= 160:
                append_cue(buf, buf_st, buf_ed)
                buf = []

        if buf:
            append_cue(buf, buf_st, buf_ed)

    if not cues and fallback_text:
        append_cue([fallback_text], vad_start_ms, vad_end_ms)

    # Smooth CTC token boundaries (+140ms tail, -50ms onset) cleanly without overlapping neighbors
    for idx, cue in enumerate(cues):
        prev_ed = cues[idx - 1]["endMs"] if idx > 0 else vad_start_ms
        nxt_st = cues[idx + 1]["startMs"] if idx + 1 < len(cues) else (vad_end_ms + 80)
        cue["startMs"] = max(prev_ed + 20 if idx > 0 else vad_start_ms, cue["startMs"] - 50)
        nxt_limit = (nxt_st - 30) if (idx + 1 < len(cues)) else (vad_end_ms + 80)
        max_end = nxt_limit if nxt_limit > cue["startMs"] + 40 else (cue["startMs"] + 40)
        cue["endMs"] = min(max(cue["startMs"] + 250, cue["endMs"] + 140), max_end)

    return cues


def estimate_segment_pitch_hz(samples, sr: int = 16000) -> float:
    """Fast vectorized autocorrelation vocal pitch estimator (F0 Hz) for gender archetype hinting."""
    import numpy as np

    if samples is None or len(samples) < int(0.18 * sr):
        return 0.0
    sig = np.asarray(samples, dtype=np.float32)
    if len(sig) > int(2.5 * sr):
        mid = len(sig) // 2
        half = int(1.25 * sr)
        sig = sig[max(0, mid - half) : min(len(sig), mid + half)]

    frame_len = int(0.04 * sr)
    hop = int(0.02 * sr)
    min_lag = max(1, int(sr / 380))  # <= 380 Hz
    max_lag = min(frame_len - 1, int(sr / 65))  # >= 65 Hz
    if max_lag <= min_lag + 2:
        return 0.0

    f0_list = []
    for pos in range(0, len(sig) - frame_len + 1, hop):
        frame = sig[pos : pos + frame_len]
        rms = float(np.sqrt(np.mean(frame * frame)))
        if rms < 0.015:
            continue
        frame = frame - np.mean(frame)
        acf = np.correlate(frame, frame, mode="full")[frame_len - 1 :]
        zero_e = float(acf[0])
        if zero_e <= 1e-8:
            continue
        search = acf[min_lag : max_lag + 1] / zero_e
        best_rel = int(np.argmax(search))
        if search[best_rel] >= 0.42:
            lag = min_lag + best_rel
            f0_list.append(float(sr) / float(lag))
    if len(f0_list) < 2:
        return 0.0
    return round(float(np.median(f0_list)), 1)


def pick_voice_from_pitch(pitch_hz: float, cast_mode: str, fixed_voice: str, spk_index: int) -> str:
    """Map median speaker pitch (F0 Hz) + speaker index onto valid EZA PRO voice archetypes."""
    if cast_mode == "single":
        return fixed_voice or "Sovereign King"

    if pitch_hz <= 0:
        return "Radiant Queen" if (spk_index % 2 == 1) else "Sovereign King"

    if cast_mode == "duo":
        return "Radiant Queen" if pitch_hz >= 172.0 else "Sovereign King"

    # Multi-character pitch bands with distinct archetypes for secondary voices
    if pitch_hz >= 285.0:
        return "kh_child"
    if pitch_hz >= 198.0:
        return "kh_young_girl" if (spk_index % 2 == 1) else "Radiant Queen"
    if pitch_hz >= 168.0:
        return "Radiant Queen"
    if pitch_hz <= 122.0:
        return "kh_deep_boss" if (spk_index % 2 == 1) else "Sovereign King"
    return "kh_young_man" if (spk_index % 2 == 1) else "Sovereign King"


def find_cached_model_dir(cache_dir: str, key_tokens: tuple, weight_names: tuple, min_bytes: int) -> str:
    """Locate a complete locally cached FunASR model directory to skip network checks."""
    search_roots = [cache_dir, os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")]
    for base_dir in search_roots:
        if not os.path.isdir(base_dir):
            continue
        abs_base = os.path.abspath(base_dir)
        for root, _, files in os.walk(abs_base):
            rel = os.path.relpath(root, abs_base).lower()
            if rel == ".":
                continue
            if not all(tok in rel for tok in key_tokens):
                continue
            if not ("config.yaml" in files or "configuration.json" in files):
                continue
            for wname in weight_names:
                wpath = os.path.join(root, wname)
                if wname in files and os.path.isfile(wpath) and os.path.getsize(wpath) >= min_bytes:
                    return root
    return ""


def load_models_with_fallback(hub_order: list, device: str, want_spk: bool, cache_dir: str):
    """Load FSMN-VAD, SenseVoiceSmall, and optional CAM++ from local cache first or hub fallback."""
    from funasr import AutoModel

    local_vad = find_cached_model_dir(cache_dir, ("fsmn", "vad"), ("model.pt", "model.safetensors"), 500_000)
    local_asr = find_cached_model_dir(cache_dir, ("sensevoice",), ("model.pt", "model.safetensors"), 500_000_000)
    local_spk = find_cached_model_dir(cache_dir, ("campplus",), ("campplus_cn_common.bin", "model.pt"), 10_000_000) if want_spk else ""

    if local_vad and local_asr and (not want_spk or local_spk):
        emit_progress(5, "loading", f"Loading cached local SenseVoice-Small ({device})...")
        vad_model = AutoModel(
            model=local_vad,
            device=device,
            disable_update=True,
            disable_pbar=True,
            log_level="ERROR",
        )
        asr_model = AutoModel(
            model=local_asr,
            device=device,
            disable_update=True,
            disable_pbar=True,
            log_level="ERROR",
        )
        spk_model = None
        if want_spk:
            emit_progress(10, "loading", f"Loading cached CAM++ speaker model ({device})...")
            spk_model = AutoModel(
                model=local_spk,
                device=device,
                disable_update=True,
                disable_pbar=True,
                log_level="ERROR",
            )
        return "local", vad_model, asr_model, spk_model

    last_err = None
    for hub in hub_order:
        spec = MODEL_SPECS[hub]
        try:
            emit_progress(5, "loading", f"Loading FSMN-VAD & SenseVoice-Small ({device}, hub={hub})...")
            vad_model = AutoModel(
                model=local_vad or spec["vad"],
                hub=hub,
                device=device,
                disable_update=True,
                disable_pbar=True,
                log_level="ERROR",
            )
            asr_model = AutoModel(
                model=local_asr or spec["asr"],
                hub=hub,
                device=device,
                disable_update=True,
                disable_pbar=True,
                log_level="ERROR",
            )
            spk_model = None
            if want_spk:
                emit_progress(10, "loading", f"Loading CAM++ speaker model ({device}, hub={hub})...")
                spk_model = AutoModel(
                    model=local_spk or spec["spk"],
                    hub=hub,
                    device=device,
                    disable_update=True,
                    disable_pbar=True,
                    log_level="ERROR",
                )
            return hub, vad_model, asr_model, spk_model
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"Failed to load SenseVoice FunASR models: {last_err}")


def is_cuda_runtime_error(err: Exception) -> bool:
    msg = str(err or "").lower()
    return (
        "out of memory" in msg
        or "cuda" in msg
        or "cudnn" in msg
        or "cublas" in msg
        or "alloc" in msg
    )


def clear_cuda_cache_safe() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def run_stt(args: argparse.Namespace) -> dict:
    # Configure local model cache paths BEFORE importing funasr / huggingface_hub / modelscope
    cache_dir = setup_cache_env(args.cache_dir)

    import numpy as np
    import soundfile as sf
    import torch
    from funasr.utils.postprocess_utils import rich_transcription_postprocess

    req_device = str(args.device or "auto").strip().lower()
    device = resolve_device(args.device)
    hub_order = detect_preferred_hubs(args.hub, cache_dir)
    sv_lang = LANG_ALIAS.get(str(args.lang or "auto").strip().lower(), "auto")
    cast_mode = str(args.cast_mode or "multi").strip().lower()
    if cast_mode not in ("multi", "duo", "single"):
        cast_mode = "multi"
    want_spk = cast_mode != "single"

    try:
        hub_used, vad_model, asr_model, spk_model = load_models_with_fallback(hub_order, device, want_spk, cache_dir)
    except Exception as load_err:
        if req_device == "auto" and device != "cpu" and is_cuda_runtime_error(load_err):
            clear_cuda_cache_safe()
            device = "cpu"
            emit_progress(12, "loading", "GPU memory tight — falling back to CPU...")
            hub_used, vad_model, asr_model, spk_model = load_models_with_fallback(hub_order, device, want_spk, cache_dir)
        else:
            raise

    emit_progress(14, "audio", "Reading 16kHz audio track...")
    audio, sr = sf.read(os.path.abspath(args.input), dtype="float32")
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1).astype(np.float32)
    if sr != 16000:
        import scipy.signal

        target_len = int(round(len(audio) * 16000.0 / float(sr)))
        audio = scipy.signal.resample(audio, target_len).astype(np.float32)
        sr = 16000

    audio_len_ms = int(len(audio) * 1000 / sr)
    emit_progress(18, "vad", "Scanning vocal timeline with FSMN-VAD...")
    try:
        vad_res = vad_model.generate(
            input=audio,
            fs=16000,
            max_single_segment_time=16000,
            disable_pbar=True,
        )
    except Exception as vad_err:
        if req_device == "auto" and device != "cpu" and is_cuda_runtime_error(vad_err):
            clear_cuda_cache_safe()
            device = "cpu"
            hub_used, vad_model, asr_model, spk_model = load_models_with_fallback(hub_order, device, want_spk, cache_dir)
            vad_res = vad_model.generate(
                input=audio,
                fs=16000,
                max_single_segment_time=16000,
                disable_pbar=True,
            )
        else:
            raise
    raw_vad = vad_res[0].get("value", []) if (vad_res and isinstance(vad_res, list)) else []
    vad_segments = normalize_vad_segments(raw_vad, audio_len_ms, max_seg_ms=16000, samples=audio, sr=sr)

    if not vad_segments:
        return {
            "success": True,
            "device": device,
            "hub": hub_used,
            "language": sv_lang,
            "model": MODEL_SPECS.get(hub_used, MODEL_SPECS["ms"])["asr"],
            "speakers": [],
            "segments": [],
        }

    total_segs = len(vad_segments)
    slices = [
        audio[max(0, int(st_ms * sr / 1000)) : min(len(audio), int(ed_ms * sr / 1000))]
        for st_ms, ed_ms in vad_segments
    ]

    # Batch SenseVoice-Small ASR with word-level CTC timestamps and CUDA OOM/CPU fallback
    asr_batch = 8 if device.startswith("cuda") else 2
    asr_outputs = []
    start_i = 0
    while start_i < total_segs:
        batch_slices = slices[start_i : start_i + asr_batch]
        try:
            res_batch = asr_model.generate(
                input=batch_slices,
                fs=16000,
                language=sv_lang,
                use_itn=True,
                output_timestamp=True,
                ban_emo_unk=True,
                batch_size=len(batch_slices),
                disable_pbar=True,
            )
            for idx_in_b in range(len(batch_slices)):
                item = res_batch[idx_in_b] if (idx_in_b < len(res_batch) and isinstance(res_batch[idx_in_b], dict)) else {}
                asr_outputs.append(item)
            start_i += len(batch_slices)
        except Exception as asr_err:
            if device.startswith("cuda") and is_cuda_runtime_error(asr_err):
                clear_cuda_cache_safe()
                if len(batch_slices) > 1 and asr_batch > 1:
                    asr_batch = 1
                    continue
                if req_device == "auto":
                    device = "cpu"
                    asr_batch = 2
                    emit_progress(25 + int((start_i / float(total_segs)) * 45), "asr", "GPU memory full — switching SenseVoice to CPU...")
                    hub_used, vad_model, asr_model, spk_model = load_models_with_fallback(hub_order, device, want_spk, cache_dir)
                    continue
            raise
        done = min(total_segs, start_i)
        pct = 25 + int((done / float(total_segs)) * 45)
        emit_progress(pct, "asr", f"SenseVoice ASR: {done}/{total_segs} segments")

    # Split each VAD turn into crisp sentence-level cues and slice audio per sentence for accurate CAM++ clustering
    cue_items = []
    cue_slices = []
    cue_pitches = []
    for idx, asr_item in enumerate(asr_outputs):
        raw_txt = str(asr_item.get("text", "") or "")
        tags = parse_sensevoice_raw_tags(raw_txt)
        if tags["isNoSpeech"]:
            continue
        clean_fallback = rich_transcription_postprocess(raw_txt).strip()
        clean_fallback = re.sub(r"[\U00010000-\U0010ffff\u2600-\u27bf\ufe0f]+", "", clean_fallback).strip()
        vad_st_ms, vad_ed_ms = vad_segments[idx]
        sub_cues = split_tokens_into_cues(
            asr_item.get("words") or [],
            asr_item.get("timestamp") or [],
            vad_st_ms,
            vad_ed_ms,
            tags,
            sv_lang,
            fallback_text=clean_fallback,
        )
        for c in sub_cues:
            s_i = max(0, int(c["startMs"] * sr / 1000))
            e_i = min(len(audio), int(c["endMs"] * sr / 1000))
            if e_i <= s_i:
                continue
            clip = audio[s_i:e_i]
            cue_items.append(c)
            cue_slices.append(clip)
            cue_pitches.append(estimate_segment_pitch_hz(clip, sr) if want_spk else 0.0)

    speaker_ids = [0] * len(cue_items)
    if want_spk and spk_model is not None and len(cue_items) > 0:
        emit_progress(75, "speakers", f"Clustering speaker voices with CAM++ ({len(cue_items)} lines)...")
        emb_list = []
        kept_clips = []
        for clip in cue_slices:
            if len(clip) < 16000 and len(clip) > 0:
                reps = int(np.ceil(16000.0 / float(len(clip))))
                clip = np.tile(clip, reps)[:16000]
            elif len(clip) > 16000 * 6:
                clip = clip[: 16000 * 6]
            kept_clips.append(clip)

        # Extract CAM++ embeddings at batch_size=1 so variable-length clips avoid zero-pad pooling distortion
        # and unpack every (N, 192) embedding row cleanly.
        try:
            for s_i, clip in enumerate(kept_clips):
                spk_res = spk_model.generate(input=[clip], fs=16000, batch_size=1, disable_pbar=True)
                for item in (spk_res or []):
                    emb = item.get("spk_embedding") if isinstance(item, dict) else None
                    if emb is not None:
                        emb_rows = emb.detach().cpu().reshape(-1, 192)
                        for row in emb_rows:
                            emb_list.append(row)
                if (s_i + 1) % 10 == 0 or s_i + 1 == len(kept_clips):
                    pct = 75 + int(((s_i + 1) / float(len(kept_clips))) * 18)
                    emit_progress(pct, "speakers", f"CAM++ voice clustering: {s_i + 1}/{len(kept_clips)}")
        except Exception as spk_err:
            if device.startswith("cuda") and is_cuda_runtime_error(spk_err):
                clear_cuda_cache_safe()
                emit_progress(80, "speakers", "GPU VRAM tight during speaker clustering — retrying CAM++ on CPU...")
                try:
                    cpu_spk_model = load_single_model(
                        MODEL_SPECS.get(hub_used, MODEL_SPECS["ms"])["spk"],
                        hub_used,
                        "cpu",
                        cache_dir,
                    )
                    emb_list = []
                    for s_i, clip in enumerate(kept_clips):
                        spk_res = cpu_spk_model.generate(input=[clip], fs=16000, batch_size=1, disable_pbar=True)
                        for item in (spk_res or []):
                            emb = item.get("spk_embedding") if isinstance(item, dict) else None
                            if emb is not None:
                                emb_rows = emb.detach().cpu().reshape(-1, 192)
                                for row in emb_rows:
                                    emb_list.append(row)
                        if (s_i + 1) % 10 == 0 or s_i + 1 == len(kept_clips):
                            pct = 75 + int(((s_i + 1) / float(len(kept_clips))) * 18)
                            emit_progress(pct, "speakers", f"CAM++ voice clustering (CPU): {s_i + 1}/{len(kept_clips)}")
                except Exception:
                    emb_list = []
            else:
                emb_list = []

        if len(emb_list) == len(cue_items) and len(emb_list) >= 2:
            used_cluster_backend = False
            # FunASR ClusterBackend short-circuits to all-zeros when N < 20; use cosine centroids below 20 lines
            if len(emb_list) >= 20:
                try:
                    from funasr.models.campplus.cluster_backend import ClusterBackend

                    emb_mat = torch.stack(emb_list, dim=0)
                    cb = ClusterBackend(max_num_spks=6 if cast_mode == "multi" else 2)
                    raw_labels = cb(emb_mat, oracle_num=2 if cast_mode == "duo" else None)
                    speaker_ids = [max(0, int(x)) for x in raw_labels]
                    used_cluster_backend = True
                except Exception:
                    used_cluster_backend = False
            if not used_cluster_backend:
                centroids = []
                assigned = []
                for emb_t in emb_list:
                    vec = emb_t / (torch.norm(emb_t) + 1e-8)
                    best_k = -1
                    best_sim = 0.58
                    for k, cent in enumerate(centroids):
                        sim = float(torch.dot(vec, cent))
                        if sim > best_sim:
                            best_sim = sim
                            best_k = k
                    if best_k == -1 and len(centroids) < (2 if cast_mode == "duo" else 6):
                        centroids.append(vec)
                        best_k = len(centroids) - 1
                    elif best_k == -1:
                        sims = [float(torch.dot(vec, c)) for c in centroids]
                        best_k = int(max(range(len(sims)), key=lambda i: sims[i]))
                    else:
                        centroids[best_k] = centroids[best_k] * 0.8 + vec * 0.2
                        centroids[best_k] = centroids[best_k] / (torch.norm(centroids[best_k]) + 1e-8)
                    assigned.append(best_k)
                speaker_ids = assigned

    # Aggregate median pitch per speaker cluster so each speaker gets a stable Khmer archetype
    spk_pitch_samples = {}
    for pos in range(len(cue_items)):
        spk_k = speaker_ids[pos]
        if cue_pitches[pos] > 0:
            spk_pitch_samples.setdefault(spk_k, []).append(cue_pitches[pos])

    spk_voice_map = {}
    speaker_summary = []
    for spk_k in sorted(set(speaker_ids)):
        vals = spk_pitch_samples.get(spk_k, [])
        med_pitch = float(np.median(vals)) if vals else 0.0
        voice_id = pick_voice_from_pitch(med_pitch, cast_mode, args.fixed_voice, spk_k)
        spk_voice_map[spk_k] = voice_id
        speaker_summary.append({
            "speakerId": f"spk_{spk_k}",
            "medianPitchHz": round(med_pitch, 1),
            "suggestedVoice": voice_id,
        })

    segments = []
    for pos, cue in enumerate(cue_items):
        spk_k = speaker_ids[pos]
        segments.append({
            "startSec": round(cue["startMs"] / 1000.0, 3),
            "endSec": round(cue["endMs"] / 1000.0, 3),
            "text": cue["text"],
            "langTag": cue["langTag"],
            "emotionTag": cue["emotionTag"],
            "eventTag": cue["eventTag"],
            "speakerId": f"spk_{spk_k}",
            "pitchHz": cue_pitches[pos],
            "suggestedVoice": spk_voice_map.get(spk_k, args.fixed_voice or "Sovereign King"),
        })

    if device.startswith("cuda"):
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass

    emit_progress(98, "done", f"Completed SenseVoice STT: {len(segments)} segments")
    return {
        "success": True,
        "device": device,
        "hub": hub_used,
        "language": sv_lang,
        "model": MODEL_SPECS.get(hub_used, MODEL_SPECS["ms"])["asr"],
        "speakers": speaker_summary,
        "segments": segments,
    }


def main() -> int:
    default_cache = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", DEFAULT_CACHE_REL)
    )
    parser = argparse.ArgumentParser(description="EZA PRO SenseVoice-Small Local STT Runner")
    parser.add_argument("--check", action="store_true", help="Check FunASR/CUDA readiness as JSON")
    parser.add_argument("--input", default="", help="Input 16kHz audio file")
    parser.add_argument("--output", default="", help="Output JSON result path")
    parser.add_argument("--lang", default="auto", help="auto|zh|yue|en|ja|ko")
    parser.add_argument("--device", default="auto", help="auto|cuda|cpu")
    parser.add_argument("--hub", default="auto", help="auto|hf|ms")
    parser.add_argument("--cast-mode", default="multi", help="multi|duo|single")
    parser.add_argument("--fixed-voice", default="Sovereign King", help="Voice when cast-mode=single")
    parser.add_argument("--cache-dir", default=default_cache, help="Local model cache directory")
    args = parser.parse_args()

    if args.check:
        print(json.dumps(check_runtime(args.cache_dir), ensure_ascii=False))
        return 0

    if not args.input or not args.output:
        sys.stderr.write("--input and --output are required unless --check is set\n")
        return 1

    try:
        result = run_stt(args)
    except Exception as exc:
        err_payload = {"success": False, "error": str(exc)}
        try:
            with open(os.path.abspath(args.output), "w", encoding="utf-8") as fh:
                json.dump(err_payload, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass
        sys.stderr.write(f"SENSEVOICE_ERROR: {exc}\n")
        return 2

    out_abs = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    tmp_out = f"{out_abs}.{os.getpid()}.tmp.json"
    with open(tmp_out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    os.replace(tmp_out, out_abs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
