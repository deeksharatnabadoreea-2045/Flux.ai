"""Flux.ai simulation engine package.

Import concrete symbols from ``engine.rsi`` (or ``from engine import rsi``)
rather than eagerly loading the RSI loop at package import time — that keeps
``python3 -m engine.rsi`` free of double-import warnings.
"""

__all__ = [
    "ACCURACY_THRESHOLD",
    "RSIEngine",
    "evaluate_against_ground_truth",
    "refine_until_accurate",
]


def __getattr__(name: str):
    if name in __all__:
        from . import rsi as _rsi

        return getattr(_rsi, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
