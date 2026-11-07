#!/usr/bin/env python3
"""Recursive self-improvement (RSI) module for Flux.ai.

Keeps a local ``memory.json`` of simulation strategies and accuracy logs.
When a run scores below the accuracy bar, the engine:

  1. Analyzes endpoint error vs biological ground truth
  2. Pulls successful past patterns from memory
  3. Updates mathematical parameters
  4. Re-runs until accuracy clears the bar (or depth is exhausted)

Successful refinements are written back so later runs start smarter.

Example::

    python3 -m engine.rsi --self-test
    python3 -m engine.rsi --run
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, MutableMapping, Sequence

ACCURACY_THRESHOLD = 0.85
MEMORY_SCHEMA_VERSION = 1
DEFAULT_MEMORY_PATH = Path(__file__).resolve().parent / "memory.json"
DEFAULT_MAX_DEPTH = 12

# Tunable simulation knobs the RSI loop is allowed to rewrite.
PARAM_KEYS = (
    "efficacy_weight",
    "toxicity_penalty",
    "pk_clearance_scale",
    "kill_coefficient",
    "response_threshold",
    "baseline_response",
)

DEFAULT_PARAMS: dict[str, float] = {
    "efficacy_weight": 1.0,
    "toxicity_penalty": 0.40,
    "pk_clearance_scale": 1.0,
    "kill_coefficient": 0.35,
    "response_threshold": 0.50,
    "baseline_response": 0.20,
}

# Soft bounds so parameter search stays biologically plausible for the toy model.
PARAM_BOUNDS: dict[str, tuple[float, float]] = {
    "efficacy_weight": (0.05, 3.0),
    "toxicity_penalty": (0.0, 2.0),
    "pk_clearance_scale": (0.2, 3.0),
    "kill_coefficient": (0.05, 1.5),
    "response_threshold": (0.05, 0.95),
    "baseline_response": (0.0, 0.80),
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def empty_memory() -> dict[str, Any]:
    """Fresh memory document: strategies + accuracy logs."""
    return {
        "schema_version": MEMORY_SCHEMA_VERSION,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "strategies": [],
        "accuracy_logs": [],
    }


def load_memory(path: Path | None = None) -> dict[str, Any]:
    """Load ``memory.json``, creating it if missing or corrupt."""
    memory_path = path or DEFAULT_MEMORY_PATH
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    if not memory_path.exists():
        memory = empty_memory()
        save_memory(memory, memory_path)
        return memory
    try:
        raw = json.loads(memory_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        memory = empty_memory()
        save_memory(memory, memory_path)
        return memory
    if not isinstance(raw, dict) or raw.get("schema_version") != MEMORY_SCHEMA_VERSION:
        memory = empty_memory()
        save_memory(memory, memory_path)
        return memory
    raw.setdefault("strategies", [])
    raw.setdefault("accuracy_logs", [])
    return raw


def save_memory(memory: Mapping[str, Any], path: Path | None = None) -> Path:
    """Persist memory atomically."""
    memory_path = path or DEFAULT_MEMORY_PATH
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(memory)
    payload["updated_at"] = _utc_now()
    payload["schema_version"] = MEMORY_SCHEMA_VERSION
    tmp = memory_path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    tmp.replace(memory_path)
    return memory_path


def normalize_params(params: Mapping[str, Any] | None = None) -> dict[str, float]:
    """Merge caller params with defaults and clamp to bounds."""
    merged = dict(DEFAULT_PARAMS)
    if params:
        for key in PARAM_KEYS:
            if key in params:
                lo, hi = PARAM_BOUNDS[key]
                merged[key] = _clamp(float(params[key]), lo, hi)
    return merged


@dataclass
class SimulationResult:
    """Predicted trial endpoints from current mathematical parameters."""

    params: dict[str, float]
    endpoints: dict[str, float]
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EvaluationResult:
    """Accuracy of a simulation vs biological ground truth."""

    accuracy: float
    residuals: dict[str, float]
    mean_abs_error: float
    passed: bool
    predicted: dict[str, float]
    ground_truth: dict[str, float]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RefineResult:
    """Outcome of the recursive RSI loop."""

    success: bool
    accuracy: float
    depth: int
    params: dict[str, float]
    evaluation: EvaluationResult
    history: list[dict[str, Any]] = field(default_factory=list)
    strategy_id: str | None = None
    message: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "accuracy": self.accuracy,
            "depth": self.depth,
            "params": dict(self.params),
            "evaluation": self.evaluation.as_dict(),
            "history": list(self.history),
            "strategy_id": self.strategy_id,
            "message": self.message,
        }


def simulate_trial(
    params: Mapping[str, float],
    *,
    dose_mg: float = 100.0,
    cohort_toxicity_risk: float = 0.25,
    disease_severity: float = 0.55,
) -> SimulationResult:
    """Toy virtual-trial forward model driven by RSI parameters.

    This is an in-silico training surface for the recursive loop — not a
    validated clinical engine. Endpoints are deliberately simple so the RSI
    module can learn parameter patterns against held-out ground truth.
    """
    p = normalize_params(params)
    clearance = max(0.05, float(p["pk_clearance_scale"]))
    exposure = dose_mg / (50.0 * clearance)  # crude AUC proxy
    raw_kill = exposure * float(p["kill_coefficient"]) * float(p["efficacy_weight"])
    efficacy = 1.0 - math.exp(-raw_kill)
    # Disease severity reduces observed response; baseline lifts floor.
    response_rate = _clamp(
        float(p["baseline_response"])
        + efficacy * (1.0 - 0.35 * disease_severity),
        0.0,
        1.0,
    )
    toxicity_rate = _clamp(
        cohort_toxicity_risk
        * (1.0 + exposure * float(p["toxicity_penalty"]))
        / (1.0 + clearance),
        0.0,
        1.0,
    )
    threshold = float(p["response_threshold"])
    # Therapeutic index-ish: success probability when response clears threshold
    # after toxicity drag.
    therapeutic_success = _clamp(
        max(0.0, response_rate - threshold) / max(1e-6, 1.0 - threshold)
        * (1.0 - 0.7 * toxicity_rate),
        0.0,
        1.0,
    )
    risk_benefit = response_rate / max(toxicity_rate, 1e-3)

    endpoints = {
        "response_rate": round(response_rate, 6),
        "toxicity_rate": round(toxicity_rate, 6),
        "therapeutic_success": round(therapeutic_success, 6),
        "risk_benefit": round(min(risk_benefit, 20.0), 6),
        "exposure_auc_proxy": round(exposure, 6),
    }
    return SimulationResult(params=p, endpoints=endpoints)


def evaluate_against_ground_truth(
    predicted: Mapping[str, float],
    ground_truth: Mapping[str, float],
    *,
    threshold: float = ACCURACY_THRESHOLD,
) -> EvaluationResult:
    """Score simulation endpoints against biological ground truth.

    Accuracy is ``1 - mean absolute error`` over shared endpoints (after
    normalizing ``risk_benefit`` onto a 0..1 scale for fair averaging).
    """
    keys = [k for k in ground_truth.keys() if k in predicted]
    if not keys:
        raise ValueError("ground_truth and predicted share no endpoint keys")

    residuals: dict[str, float] = {}
    abs_errors: list[float] = []
    for key in keys:
        truth = float(ground_truth[key])
        pred = float(predicted[key])
        if key == "risk_benefit":
            # Cap both sides so a large ratio does not dominate MAE.
            scale = 10.0
            truth_n = _clamp(truth / scale, 0.0, 1.0)
            pred_n = _clamp(pred / scale, 0.0, 1.0)
            err = abs(pred_n - truth_n)
            residuals[key] = round(pred - truth, 6)
        else:
            err = abs(pred - truth)
            residuals[key] = round(pred - truth, 6)
        abs_errors.append(err)

    mae = sum(abs_errors) / len(abs_errors)
    accuracy = _clamp(1.0 - mae, 0.0, 1.0)
    return EvaluationResult(
        accuracy=round(accuracy, 6),
        residuals=residuals,
        mean_abs_error=round(mae, 6),
        passed=accuracy >= threshold,
        predicted={k: float(predicted[k]) for k in keys},
        ground_truth={k: float(ground_truth[k]) for k in keys},
    )


def analyze_error(evaluation: EvaluationResult) -> dict[str, Any]:
    """Turn residuals into a plain diagnosis the updater can act on."""
    if not evaluation.residuals:
        return {"worst_endpoint": None, "signed_error": 0.0, "hints": []}

    worst_endpoint, signed = max(
        evaluation.residuals.items(), key=lambda item: abs(item[1])
    )
    hints: list[str] = []
    if worst_endpoint == "response_rate":
        hints.append("raise_efficacy" if signed < 0 else "lower_efficacy")
    elif worst_endpoint == "toxicity_rate":
        hints.append("lower_toxicity" if signed > 0 else "raise_toxicity_floor")
    elif worst_endpoint == "therapeutic_success":
        hints.append("raise_therapeutic" if signed < 0 else "lower_therapeutic")
    elif worst_endpoint == "risk_benefit":
        hints.append("improve_risk_benefit" if signed < 0 else "reduce_risk_benefit")
    else:
        hints.append("blend_toward_memory")

    return {
        "worst_endpoint": worst_endpoint,
        "signed_error": signed,
        "abs_error": abs(signed),
        "hints": hints,
        "accuracy": evaluation.accuracy,
    }


def fetch_successful_patterns(
    memory: Mapping[str, Any],
    *,
    min_accuracy: float = ACCURACY_THRESHOLD,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Return past strategies that cleared the accuracy bar, best first."""
    strategies = list(memory.get("strategies") or [])
    good = [
        s
        for s in strategies
        if isinstance(s, dict)
        and float(s.get("accuracy", 0.0)) >= min_accuracy
        and isinstance(s.get("params"), dict)
    ]
    good.sort(key=lambda s: float(s.get("accuracy", 0.0)), reverse=True)
    return good[:limit]


def _score_params(
    params: Mapping[str, float],
    ground_truth: Mapping[str, float],
    scenario_kwargs: Mapping[str, float],
) -> float:
    predicted = simulate_trial(params, **scenario_kwargs).endpoints
    return evaluate_against_ground_truth(predicted, ground_truth).accuracy


def update_parameters(
    params: Mapping[str, float],
    diagnosis: Mapping[str, Any],
    patterns: Sequence[Mapping[str, Any]],
    *,
    learning_rate: float = 0.45,
    ground_truth: Mapping[str, float] | None = None,
    scenario_kwargs: Mapping[str, float] | None = None,
) -> dict[str, float]:
    """Blend toward successful memory, then hill-climb on endpoint error."""
    updated = normalize_params(params)
    scenario = dict(scenario_kwargs or {})

    # 1) Pull toward the mean of successful past patterns (if any).
    if patterns:
        for key in PARAM_KEYS:
            values = [
                float(p["params"][key])
                for p in patterns
                if key in p.get("params", {})
            ]
            if not values:
                continue
            target = sum(values) / len(values)
            updated[key] = updated[key] + learning_rate * (target - updated[key])
        updated = normalize_params(updated)

    # 2) Residual-driven nudge from the error analysis.
    hints = list(diagnosis.get("hints") or [])
    step = 0.18 * (1.0 + float(diagnosis.get("abs_error", 0.0)))
    if "raise_efficacy" in hints:
        updated["efficacy_weight"] += step
        updated["kill_coefficient"] += step * 0.55
        updated["baseline_response"] += step * 0.2
    if "lower_efficacy" in hints:
        updated["efficacy_weight"] -= step
        updated["kill_coefficient"] -= step * 0.45
    if "lower_toxicity" in hints:
        updated["toxicity_penalty"] -= step
        updated["pk_clearance_scale"] += step * 0.5
    if "raise_toxicity_floor" in hints:
        updated["toxicity_penalty"] += step * 0.35
    if "raise_therapeutic" in hints:
        updated["response_threshold"] -= step * 0.3
        updated["efficacy_weight"] += step * 0.45
    if "lower_therapeutic" in hints:
        updated["response_threshold"] += step * 0.25
    if "improve_risk_benefit" in hints:
        updated["efficacy_weight"] += step * 0.35
        updated["toxicity_penalty"] -= step * 0.35
    if "reduce_risk_benefit" in hints:
        updated["efficacy_weight"] -= step * 0.25
        updated["toxicity_penalty"] += step * 0.25
    if not patterns and not hints:
        updated["efficacy_weight"] += step
        updated["toxicity_penalty"] -= step * 0.25
    updated = normalize_params(updated)

    # 3) Coordinate hill-climb: try ±delta on each knob, keep real gains.
    #    This is what lets a cold start climb past the 85% bar without memory.
    if ground_truth is not None:
        best = normalize_params(updated)
        best_score = _score_params(best, ground_truth, scenario)
        # Larger steps while accuracy is poor; finer once close.
        delta = 0.28 if best_score < 0.6 else 0.12 if best_score < 0.8 else 0.05
        for key in PARAM_KEYS:
            lo, hi = PARAM_BOUNDS[key]
            for direction in (+1.0, -1.0):
                candidate = dict(best)
                candidate[key] = _clamp(best[key] + direction * delta, lo, hi)
                score = _score_params(candidate, ground_truth, scenario)
                if score > best_score + 1e-9:
                    best, best_score = candidate, score
        # One second pass with a finer delta locks in near-threshold gains.
        fine = delta * 0.45
        for key in PARAM_KEYS:
            lo, hi = PARAM_BOUNDS[key]
            for direction in (+1.0, -1.0):
                candidate = dict(best)
                candidate[key] = _clamp(best[key] + direction * fine, lo, hi)
                score = _score_params(candidate, ground_truth, scenario)
                if score > best_score + 1e-9:
                    best, best_score = candidate, score
        updated = best

    return normalize_params(updated)


def _append_accuracy_log(
    memory: MutableMapping[str, Any],
    *,
    depth: int,
    evaluation: EvaluationResult,
    params: Mapping[str, float],
    diagnosis: Mapping[str, Any] | None = None,
) -> None:
    memory.setdefault("accuracy_logs", []).append(
        {
            "timestamp": _utc_now(),
            "depth": depth,
            "accuracy": evaluation.accuracy,
            "passed": evaluation.passed,
            "mean_abs_error": evaluation.mean_abs_error,
            "residuals": dict(evaluation.residuals),
            "params": dict(params),
            "diagnosis": dict(diagnosis or {}),
        }
    )


def _record_successful_strategy(
    memory: MutableMapping[str, Any],
    *,
    params: Mapping[str, float],
    evaluation: EvaluationResult,
    depth: int,
    scenario: Mapping[str, Any] | None = None,
) -> str:
    strategy_id = f"strat-{_utc_now().replace(':', '').replace('-', '')}-{depth}"
    memory.setdefault("strategies", []).append(
        {
            "id": strategy_id,
            "timestamp": _utc_now(),
            "accuracy": evaluation.accuracy,
            "params": dict(params),
            "endpoints": dict(evaluation.predicted),
            "ground_truth": dict(evaluation.ground_truth),
            "depth": depth,
            "scenario": dict(scenario or {}),
        }
    )
    return strategy_id


class RSIEngine:
    """Memory-backed recursive simulation improver."""

    def __init__(
        self,
        memory_path: Path | None = None,
        *,
        threshold: float = ACCURACY_THRESHOLD,
        max_depth: int = DEFAULT_MAX_DEPTH,
        learning_rate: float = 0.35,
    ) -> None:
        self.memory_path = Path(memory_path) if memory_path else DEFAULT_MEMORY_PATH
        self.threshold = threshold
        self.max_depth = max_depth
        self.learning_rate = learning_rate
        self.memory = load_memory(self.memory_path)

    def reload(self) -> dict[str, Any]:
        self.memory = load_memory(self.memory_path)
        return self.memory

    def persist(self) -> Path:
        return save_memory(self.memory, self.memory_path)

    def refine(
        self,
        ground_truth: Mapping[str, float],
        params: Mapping[str, float] | None = None,
        *,
        scenario: Mapping[str, Any] | None = None,
        depth: int = 0,
        history: list[dict[str, Any]] | None = None,
    ) -> RefineResult:
        """Recursively improve params until accuracy ≥ threshold."""
        return refine_until_accurate(
            ground_truth,
            params=params,
            scenario=scenario,
            memory_path=self.memory_path,
            threshold=self.threshold,
            max_depth=self.max_depth,
            learning_rate=self.learning_rate,
            depth=depth,
            history=history,
            memory=self.memory,
            persist=True,
        )


def refine_until_accurate(
    ground_truth: Mapping[str, float],
    params: Mapping[str, float] | None = None,
    *,
    scenario: Mapping[str, Any] | None = None,
    memory_path: Path | None = None,
    threshold: float = ACCURACY_THRESHOLD,
    max_depth: int = DEFAULT_MAX_DEPTH,
    learning_rate: float = 0.35,
    depth: int = 0,
    history: list[dict[str, Any]] | None = None,
    memory: MutableMapping[str, Any] | None = None,
    persist: bool = True,
) -> RefineResult:
    """Recursive RSI core.

    Logic::

        simulate(params) → compare to ground_truth
        if accuracy >= 85%: save strategy to memory; return success
        else: analyze error → fetch good patterns → update params → recurse
    """
    path = Path(memory_path) if memory_path else DEFAULT_MEMORY_PATH
    mem: MutableMapping[str, Any] = memory if memory is not None else load_memory(path)
    hist = list(history or [])
    current = normalize_params(params)
    scenario_kwargs = {
        "dose_mg": float((scenario or {}).get("dose_mg", 100.0)),
        "cohort_toxicity_risk": float(
            (scenario or {}).get("cohort_toxicity_risk", 0.25)
        ),
        "disease_severity": float((scenario or {}).get("disease_severity", 0.55)),
    }

    simulation = simulate_trial(current, **scenario_kwargs)
    evaluation = evaluate_against_ground_truth(
        simulation.endpoints, ground_truth, threshold=threshold
    )
    diagnosis = analyze_error(evaluation)
    _append_accuracy_log(
        mem,
        depth=depth,
        evaluation=evaluation,
        params=current,
        diagnosis=diagnosis,
    )
    hist.append(
        {
            "depth": depth,
            "accuracy": evaluation.accuracy,
            "passed": evaluation.passed,
            "params": dict(current),
            "diagnosis": diagnosis,
        }
    )

    if evaluation.passed:
        strategy_id = _record_successful_strategy(
            mem,
            params=current,
            evaluation=evaluation,
            depth=depth,
            scenario=scenario_kwargs,
        )
        if persist:
            save_memory(mem, path)
        return RefineResult(
            success=True,
            accuracy=evaluation.accuracy,
            depth=depth,
            params=current,
            evaluation=evaluation,
            history=hist,
            strategy_id=strategy_id,
            message=f"accuracy {evaluation.accuracy:.3f} met threshold {threshold}",
        )

    if depth >= max_depth:
        if persist:
            save_memory(mem, path)
        return RefineResult(
            success=False,
            accuracy=evaluation.accuracy,
            depth=depth,
            params=current,
            evaluation=evaluation,
            history=hist,
            message=(
                f"stopped at depth {depth}: accuracy "
                f"{evaluation.accuracy:.3f} < {threshold}"
            ),
        )

    patterns = fetch_successful_patterns(mem, min_accuracy=threshold)
    next_params = update_parameters(
        current,
        diagnosis,
        patterns,
        learning_rate=learning_rate,
        ground_truth=ground_truth,
        scenario_kwargs=scenario_kwargs,
    )
    # Persist logs each hop so crashes still leave a trail.
    if persist:
        save_memory(mem, path)

    return refine_until_accurate(
        ground_truth,
        params=next_params,
        scenario=scenario,
        memory_path=path,
        threshold=threshold,
        max_depth=max_depth,
        learning_rate=learning_rate,
        depth=depth + 1,
        history=hist,
        memory=mem,
        persist=persist,
    )


# ---------------------------------------------------------------------------
# Demo ground truth + CLI / self-test
# ---------------------------------------------------------------------------


def demo_ground_truth() -> dict[str, float]:
    """Biological-ish target endpoints for the toy scenario."""
    # Generated from a known-good parameter island so the loop has something
    # real to climb toward (and so memory can retain that island).
    oracle = normalize_params(
        {
            "efficacy_weight": 1.35,
            "toxicity_penalty": 0.22,
            "pk_clearance_scale": 1.15,
            "kill_coefficient": 0.55,
            "response_threshold": 0.42,
            "baseline_response": 0.18,
        }
    )
    return dict(
        simulate_trial(
            oracle,
            dose_mg=100.0,
            cohort_toxicity_risk=0.25,
            disease_severity=0.55,
        ).endpoints
    )


def intentionally_bad_params() -> dict[str, float]:
    """Start far from the oracle so RSI must recurse."""
    return normalize_params(
        {
            "efficacy_weight": 0.25,
            "toxicity_penalty": 1.40,
            "pk_clearance_scale": 0.45,
            "kill_coefficient": 0.08,
            "response_threshold": 0.80,
            "baseline_response": 0.02,
        }
    )


def run_self_test(tmp_memory: Path | None = None) -> int:
    """Prove init → recurse-below-85% → persist → reload retains strategy."""
    import tempfile

    created_tmp = False
    if tmp_memory is None:
        tmp_dir = Path(tempfile.mkdtemp(prefix="flux-rsi-"))
        tmp_memory = tmp_dir / "memory.json"
        created_tmp = True

    print("[rsi] initializing memory…")
    memory = load_memory(tmp_memory)
    assert memory["schema_version"] == MEMORY_SCHEMA_VERSION
    assert memory["strategies"] == []
    assert tmp_memory.exists()
    print(f"[rsi] memory ready at {tmp_memory}")

    truth = demo_ground_truth()
    bad = intentionally_bad_params()
    baseline = simulate_trial(bad)
    baseline_eval = evaluate_against_ground_truth(baseline.endpoints, truth)
    print(f"[rsi] baseline accuracy={baseline_eval.accuracy:.3f}")
    if baseline_eval.accuracy >= ACCURACY_THRESHOLD:
        print("FAIL: baseline should start below threshold", file=sys.stderr)
        return 1

    print("[rsi] refining recursively…")
    result = refine_until_accurate(
        truth,
        params=bad,
        memory_path=tmp_memory,
        threshold=ACCURACY_THRESHOLD,
        max_depth=20,
    )
    print(
        f"[rsi] done success={result.success} accuracy={result.accuracy:.3f} "
        f"depth={result.depth} strategy={result.strategy_id}"
    )
    if not result.success:
        print(f"FAIL: expected success, got: {result.message}", file=sys.stderr)
        return 1
    if result.accuracy < ACCURACY_THRESHOLD:
        print("FAIL: accuracy still below threshold", file=sys.stderr)
        return 1
    if result.depth < 1:
        print("FAIL: expected at least one recursive refinement", file=sys.stderr)
        return 1

    reloaded = load_memory(tmp_memory)
    strategies = reloaded.get("strategies") or []
    logs = reloaded.get("accuracy_logs") or []
    if not strategies:
        print("FAIL: successful strategy was not saved to memory.json", file=sys.stderr)
        return 1
    if len(logs) < 2:
        print("FAIL: expected multiple accuracy log entries", file=sys.stderr)
        return 1
    best = max(strategies, key=lambda s: float(s.get("accuracy", 0.0)))
    if float(best["accuracy"]) < ACCURACY_THRESHOLD:
        print("FAIL: stored strategy below threshold", file=sys.stderr)
        return 1

    # Second run should be able to fetch the successful pattern immediately.
    warm = refine_until_accurate(
        truth,
        params=intentionally_bad_params(),
        memory_path=tmp_memory,
        threshold=ACCURACY_THRESHOLD,
        max_depth=20,
    )
    print(
        f"[rsi] warm-start success={warm.success} accuracy={warm.accuracy:.3f} "
        f"depth={warm.depth}"
    )
    if not warm.success:
        print("FAIL: warm-start refine failed", file=sys.stderr)
        return 1

    print(
        "PASS: rsi memory init, recursive refine, and permanent retention verified"
    )
    if created_tmp:
        # Leave artifacts for inspection when a path was injected; otherwise
        # the tempfile directory is process-local and fine to keep on disk.
        pass
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Flux.ai RSI engine")
    parser.add_argument(
        "--memory",
        type=Path,
        default=DEFAULT_MEMORY_PATH,
        help="path to memory.json",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run offline verification of the recursive loop",
    )
    parser.add_argument(
        "--run",
        action="store_true",
        help="run one refine cycle against the demo ground truth",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=DEFAULT_MAX_DEPTH,
        help="recursion cap",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.self_test:
        return run_self_test()

    if args.run:
        engine = RSIEngine(memory_path=args.memory, max_depth=args.max_depth)
        result = engine.refine(demo_ground_truth(), intentionally_bad_params())
        print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
        return 0 if result.success else 2

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
