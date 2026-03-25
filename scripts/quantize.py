"""
Quantize Kokoro ONNX model from FP32 → INT8 (dynamic quantization).

Usage:
    pip install onnx onnxruntime
    python scripts/quantize.py

Input:  models/kokoro-v1.0.onnx       (~310 MB, FP32)
Output: models/kokoro-v1.0-int8.onnx  (~80 MB, INT8)
"""

import os
import sys
from pathlib import Path

try:
    import onnx
    from onnxruntime.quantization import quantize_dynamic, QuantType
except ImportError:
    print("Missing dependencies. Run:")
    print("  pip install onnx onnxruntime")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
MODELS_DIR = PROJECT_ROOT / "models"

INPUT_MODEL = MODELS_DIR / "kokoro-v1.0.onnx"
OUTPUT_INT8 = MODELS_DIR / "kokoro-v1.0-int8.onnx"


def get_file_size_mb(path):
    return os.path.getsize(path) / (1024 * 1024)


def main():
    if not INPUT_MODEL.exists():
        print(f"Model not found: {INPUT_MODEL}")
        print("Place kokoro-v1.0.onnx in the models/ directory first.")
        sys.exit(1)

    input_size = get_file_size_mb(INPUT_MODEL)
    print(f"Input model:  {INPUT_MODEL}")
    print(f"Input size:   {input_size:.1f} MB")
    print()
    print("Quantizing FP32 → INT8 (dynamic)...")
    print("This may take a minute...")

    quantize_dynamic(
        model_input=str(INPUT_MODEL),
        model_output=str(OUTPUT_INT8),
        weight_type=QuantType.QInt8,
    )

    output_size = get_file_size_mb(OUTPUT_INT8)
    ratio = input_size / output_size

    print()
    print(f"Output model: {OUTPUT_INT8}")
    print(f"Output size:  {output_size:.1f} MB ({ratio:.1f}x smaller)")
    print()
    print("Next steps:")
    print("  1. Test quality by running scripts/test_quantized.py")
    print("  2. Upload to HuggingFace:")
    print("     huggingface-cli upload BRJ45/Kokoro-tts-onnx models/kokoro-v1.0-int8.onnx")
    print("  3. Update HF_MODEL_URL in src/offscreen/offscreen.js")


if __name__ == "__main__":
    main()
