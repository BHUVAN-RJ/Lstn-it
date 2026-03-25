"""
Compare FP32 vs INT8 Kokoro models — check outputs match and measure speed.

Usage:
    pip install onnx onnxruntime numpy
    python scripts/test_quantized.py

Runs a short inference on both models and prints:
  - Output shape and sample values
  - Inference time comparison
  - Max absolute difference between outputs
"""

import os
import sys
import time
from pathlib import Path

try:
    import numpy as np
    import onnxruntime as ort
except ImportError:
    print("Missing dependencies. Run:")
    print("  pip install onnxruntime numpy")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / "models"
VOICES_DIR = MODELS_DIR / "voices"

FP32_MODEL = MODELS_DIR / "kokoro-v1.0.onnx"
INT8_MODEL = MODELS_DIR / "kokoro-v1.0-int8.onnx"
VOICE_FILE = VOICES_DIR / "af_aoede.bin"

# Short token sequence for testing (phonemized "Hello world")
TEST_TOKENS = [0, 50, 83, 65, 47, 0]  # BOS + tokens + EOS


def load_voice_style(voice_path, token_count):
    """Load style vector for given token count from a voice .bin file."""
    voice_data = np.fromfile(str(voice_path), dtype=np.float32)
    voice_data = voice_data.reshape(510, 256)
    row_index = min(token_count, 509)
    style_vector = voice_data[row_index].reshape(1, 256)
    return style_vector


def run_inference(model_path, tokens, style):
    """Run inference and return (output_samples, time_taken)."""
    session = ort.InferenceSession(str(model_path))

    # Detect input tensor name (input_ids or tokens)
    input_names = [inp.name for inp in session.get_inputs()]
    token_input_name = "input_ids" if "input_ids" in input_names else "tokens"

    input_ids = np.array([tokens], dtype=np.int64)
    speed = np.array([1.0], dtype=np.float32)

    feeds = {
        token_input_name: input_ids,
        "style": style,
        "speed": speed,
    }

    start = time.perf_counter()
    outputs = session.run(None, feeds)
    elapsed = time.perf_counter() - start

    return outputs[0], elapsed


def main():
    for path in [FP32_MODEL, INT8_MODEL, VOICE_FILE]:
        if not path.exists():
            print(f"Not found: {path}")
            sys.exit(1)

    token_count = len(TEST_TOKENS)
    style = load_voice_style(VOICE_FILE, token_count)

    print("=" * 60)
    print("Kokoro ONNX Model Comparison: FP32 vs INT8")
    print("=" * 60)
    print(f"Test tokens: {TEST_TOKENS} ({token_count} tokens)")
    print()

    # Run FP32
    print(f"FP32 model: {FP32_MODEL.name} ({os.path.getsize(FP32_MODEL) / 1e6:.1f} MB)")
    fp32_out, fp32_time = run_inference(FP32_MODEL, TEST_TOKENS, style)
    print(f"  Output shape: {fp32_out.shape}")
    print(f"  Samples:      {fp32_out.flatten()[:5]}...")
    print(f"  Inference:    {fp32_time * 1000:.0f} ms")
    print()

    # Run INT8
    print(f"INT8 model: {INT8_MODEL.name} ({os.path.getsize(INT8_MODEL) / 1e6:.1f} MB)")
    int8_out, int8_time = run_inference(INT8_MODEL, TEST_TOKENS, style)
    print(f"  Output shape: {int8_out.shape}")
    print(f"  Samples:      {int8_out.flatten()[:5]}...")
    print(f"  Inference:    {int8_time * 1000:.0f} ms")
    print()

    # Compare
    max_diff = np.max(np.abs(fp32_out.flatten()[:min(len(fp32_out.flatten()), len(int8_out.flatten()))]
                              - int8_out.flatten()[:min(len(fp32_out.flatten()), len(int8_out.flatten()))]))
    speedup = fp32_time / int8_time if int8_time > 0 else 0

    print("-" * 60)
    print(f"Max absolute difference: {max_diff:.6f}")
    print(f"Speedup: {speedup:.2f}x")
    print(f"Quality: {'GOOD (diff < 0.01)' if max_diff < 0.01 else 'CHECK — listen to output' if max_diff < 0.1 else 'WARNING — significant difference'}")


if __name__ == "__main__":
    main()
