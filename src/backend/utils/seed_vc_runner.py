"""
Local Seed-VC zero-shot voice conversion wrapper for EZA PRO.
Preserves source Khmer speech timing and phrasing while transferring vocal timbre
from a 3-25s reference sample using FP16 on 4GB+ CUDA GPUs or FP32 on CPU.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def check_dependencies(repo_dir: str) -> int:
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
    except Exception as exc:
        print(f"MISSING_TORCH: {exc}", file=sys.stderr)
        return 2

    if not os.path.isfile(os.path.join(repo_dir, "inference.py")):
        print("MISSING_SEED_VC_REPO", file=sys.stderr)
        return 3

    cuda_ok = False
    device_name = "cpu"
    try:
        import torch

        cuda_ok = bool(torch.cuda.is_available())
        if cuda_ok:
            device_name = torch.cuda.get_device_name(0)
    except Exception:
        pass

    print(f"OK cuda={cuda_ok} device={device_name}")
    return 0


def find_latest_wav(folder: str) -> str:
    candidates = []
    for root, _, files in os.walk(folder):
        for name in files:
            if name.lower().endswith(".wav"):
                full = os.path.join(root, name)
                candidates.append((os.path.getmtime(full), full))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def run_conversion(args: argparse.Namespace) -> int:
    repo_dir = os.path.abspath(args.repo_dir)
    inference_py = os.path.join(repo_dir, "inference.py")
    if not os.path.isfile(inference_py):
        print(f"Seed-VC inference.py not found in {repo_dir}", file=sys.stderr)
        return 3

    use_fp16 = "True"
    if str(args.fp16).lower() in ("false", "0", "no"):
        use_fp16 = "False"
    else:
        try:
            import torch

            if not torch.cuda.is_available():
                use_fp16 = "False"
        except Exception:
            use_fp16 = "False"

    with tempfile.TemporaryDirectory(prefix="ezapro-seedvc-") as work_out:
        cmd = [
            sys.executable,
            inference_py,
            "--source",
            os.path.abspath(args.source),
            "--target",
            os.path.abspath(args.target),
            "--output",
            work_out,
            "--diffusion-steps",
            str(max(8, min(50, int(args.steps)))),
            "--fp16",
            use_fp16,
        ]
        try:
            proc = subprocess.run(
                cmd,
                cwd=repo_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
            )
        except subprocess.TimeoutExpired:
            print("Seed-VC timed out after 300s", file=sys.stderr)
            return 6
        if proc.returncode != 0:
            err_tail = (proc.stderr or proc.stdout or "").strip()[-1500:]
            print(f"Seed-VC failed (exit {proc.returncode}): {err_tail}", file=sys.stderr)
            return proc.returncode or 4

        wav_path = find_latest_wav(work_out)
        if not wav_path or os.path.getsize(wav_path) < 256:
            print("Seed-VC produced no WAV output", file=sys.stderr)
            return 5

        out_abs = os.path.abspath(args.output)
        out_dir = os.path.dirname(out_abs)
        os.makedirs(out_dir, exist_ok=True)
        tmp_out = f"{out_abs}.{os.getpid()}.tmp.wav"
        try:
            shutil.copyfile(wav_path, tmp_out)
            os.replace(tmp_out, out_abs)
        except Exception:
            try:
                if os.path.exists(tmp_out):
                    os.unlink(tmp_out)
            except Exception:
                pass
            raise

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="EZA PRO Seed-VC Runner")
    parser.add_argument("--repo-dir", required=True, help="Path to cloned seed-vc repository")
    parser.add_argument("--check", action="store_true", help="Verify runtime imports only")
    parser.add_argument("--source", default="", help="Source Khmer speech audio path")
    parser.add_argument("--target", default="", help="Reference voice WAV path (3-25s)")
    parser.add_argument("--output", default="", help="Output converted WAV file path")
    parser.add_argument("--steps", type=int, default=18, help="Diffusion steps (default 18)")
    parser.add_argument("--fp16", default="auto", help="true | false | auto")
    args = parser.parse_args()

    if args.check:
        return check_dependencies(os.path.abspath(args.repo_dir))

    if not args.source or not args.target or not args.output:
        print("--source, --target, and --output are required unless --check is set", file=sys.stderr)
        return 1

    return run_conversion(args)


if __name__ == "__main__":
    sys.exit(main())

