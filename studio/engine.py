"""Image engines. MfluxEngine keeps Qwen-Image-2.1 loaded in this process; MockEngine draws placeholders.

Pick with STUDIO_ENGINE=mflux (default) or STUDIO_ENGINE=mock.
"""

from __future__ import annotations

import gc
import os
import time
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw

Progress = Callable[[int, int], None]


class MockEngine:
    name = "mock"

    def status(self) -> dict:
        return {"engine": self.name, "loaded": True, "model": "mock"}

    def generate(self, plan: dict, out: Path, progress: Progress) -> None:
        w, h = plan["width"], plan["height"]
        steps = plan["steps"] or 8
        for i in range(steps):
            time.sleep(0.15)
            progress(i + 1, steps)
        hue = (plan["seed"] * 47) % 255
        img = Image.new("RGB", (w, h), (200, 190 + hue % 40, 220))
        d = ImageDraw.Draw(img)
        d.rectangle([20, 20, w - 20, h - 20], outline=(90, 80, 120), width=4)
        y = 40
        d.text((40, y), f"MOCK  {plan['panel']}  seed {plan['seed']}", fill=(30, 30, 50))
        for i, r in enumerate(plan["refs"], 1):
            y += 24
            d.text((40, y), f"image {i}: {r['name']}", fill=(30, 30, 50))
        y += 36
        for line in plan["prompt"].splitlines():
            for k in range(0, len(line), 90):
                d.text((40, y), line[k : k + 90], fill=(60, 60, 80))
                y += 16
                if y > h - 40:
                    break
        img.save(out)


class _ProgressCallback:
    def __init__(self, fn: Progress):
        self.fn = fn

    def call_in_loop(self, t, seed, prompt, latents, config, time_steps, **_):
        self.fn(t + 1, config.num_inference_steps)


class MfluxEngine:
    """One model in memory at a time. Reloads only when model or quantize changes."""

    name = "mflux"

    def __init__(self):
        self.model = None
        self.key: tuple | None = None
        self.loading = False
        self.progress_fn: Progress | None = None

    def status(self) -> dict:
        return {
            "engine": self.name,
            "loaded": self.model is not None,
            "loading": self.loading,
            "model": self.key[0] if self.key else None,
            "quantize": self.key[1] if self.key else None,
        }

    def _ensure(self, model_name: str, quantize: int | None):
        key = (model_name, quantize)
        if self.key == key and self.model is not None:
            return
        import mlx.core as mx
        from mflux.models.common.config import ModelConfig
        from mflux.models.common.vae.tiling_config import TilingConfig
        from mflux.models.qwen21.variants.edit.qwen_image_21_edit import QwenImage21Edit

        self.model = None
        gc.collect()
        mx.clear_cache()
        configs = {
            "qwen-image-2.1-turbo": ModelConfig.qwen_image_21_turbo,
            "qwen-image-2.1": ModelConfig.qwen_image_21,
        }
        if model_name not in configs:
            raise ValueError(f"unknown model {model_name!r}; use one of {list(configs)}")
        self.loading = True
        try:
            m = QwenImage21Edit(quantize=quantize, model_config=configs[model_name]())
        finally:
            self.loading = False
        # Tiled VAE decode keeps the decode peak small on a 24 GB machine.
        m.tiling_config = TilingConfig(vae_decode_tile_size=512)
        # Keep text encoder + transformer resident between jobs (no MemorySaver): that is the
        # point of a long-lived worker. Cap MLX's free-buffer cache so it doesn't hoard RAM.
        mx.set_cache_limit(int(float(os.environ.get("STUDIO_MLX_CACHE_GB", "2")) * 1024**3))
        m.callbacks.register(_ProgressCallback(lambda s, n: self.progress_fn and self.progress_fn(s, n)))
        self.model, self.key = m, key

    def generate(self, plan: dict, out: Path, progress: Progress) -> None:
        import mlx.core as mx

        self._ensure(plan["model"], plan["quantize"])
        self.progress_fn = progress
        try:
            img = self.model.generate_image(
                seed=int(plan["seed"]),
                prompt=plan["prompt"],
                num_inference_steps=plan["steps"],
                width=plan["width"],
                height=plan["height"],
                image_paths=[r["path"] for r in plan["refs"]],
                output_resolution=plan["output_resolution"],
                strength=plan["strength"],
            )
            img.save(out, export_json_metadata=False)
        finally:
            self.progress_fn = None
            mx.clear_cache()


def make_engine():
    return MockEngine() if os.environ.get("STUDIO_ENGINE", "mflux") == "mock" else MfluxEngine()
