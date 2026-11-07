#!/usr/bin/env python3
"""Bridge Flux ``simulation_pipeline`` into the RSI memory loop.

Plain English
-------------
The RSI engine already knows how to improve math knobs against ground truth.
This module plugs the *real* trial cascade into that loop:

  1. Run the live simulation pipeline with current RSI params
  2. Read the biological endpoints off the dossier
  3. If accuracy < 85%, update params from errors + memory and re-run
  4. Save every successful refinement to ``memory.json``

Example::

    python3 -m engine.pipeline_rsi --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Mapping

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import simulation_pipeline as pipeline  # noqa: E402
from engine.rsi import (  # noqa: E402
    ACCURACY_THRESHOLD,
    DEFAULT_PARAMS,
    RefineResult,
    evaluate_against_ground_truth,
    intentionally_bad_params,
    load_memory,
    normalize_params,
    refine_until_accurate,
)

# Compact cohort / phase sizes keep the recursive loop practical in CI.
_FAST_TARGET_KW = {
    "n_candidates": 6,
    "cohort_n": 10,
    "phase1_n": 4,
    "phase2_n": 6,
    "phase3_n": 12,
}


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def apply_rsi_params_to_disease(
    disease: pipeline.DiseaseProfile,
    params: Mapping[str, Any] | None,
) -> pipeline.DiseaseProfile:
    """Scale disease priors from RSI knobs.

    At ``DEFAULT_PARAMS`` the multipliers are ~1.0 (identity), so a calibrated
    pipeline run is recoverable by climbing back toward defaults.
    """
    if not params:
        return disease
    p = normalize_params(params)
    eff = (p["efficacy_weight"] / DEFAULT_PARAMS["efficacy_weight"]) * (
        p["kill_coefficient"] / DEFAULT_PARAMS["kill_coefficient"]
    )
    tox = (p["toxicity_penalty"] / max(DEFAULT_PARAMS["toxicity_penalty"], 1e-6)) / max(
        p["pk_clearance_scale"] / DEFAULT_PARAMS["pk_clearance_scale"], 0.05
    )
    base_shift = p["baseline_response"] - DEFAULT_PARAMS["baseline_response"]
    thr_shift = p["response_threshold"] - DEFAULT_PARAMS["response_threshold"]
    return replace(
        disease,
        cell_sensitivity_mu=max(0.05, disease.cell_sensitivity_mu * eff),
        toxicity_threshold_mu=max(
            0.5, disease.toxicity_threshold_mu / max(tox, 0.15)
        ),
        null_efficacy_rate=_clamp(
            disease.null_efficacy_rate - base_shift + thr_shift * 0.25,
            0.05,
            0.85,
        ),
        growth_rate_mu=max(
            0.005, disease.growth_rate_mu * (1.0 + 0.15 * (1.0 - min(eff, 2.0)))
        ),
        dlt_threshold=_clamp(
            disease.dlt_threshold * (1.0 + 0.1 * (1.0 - min(tox, 2.0))),
            0.10,
            0.60,
        ),
    )


def dossier_to_endpoints(dossier: pipeline.TrialDossier) -> dict[str, float]:
    """Pull the biological scores RSI compares against ground truth."""
    cohort = dossier.virtual_cohort or {}
    trial = dossier.trial or {}
    cell = dossier.cellular_response or {}
    return {
        "response_rate": float(cohort.get("success_rate") or 0.0),
        "toxicity_rate": float(cohort.get("toxicity_breach_rate") or 0.0),
        "therapeutic_success": float(
            cohort.get("therapeutic_success_rate")
            or trial.get("overall_success_probability")
            or 0.0
        ),
        "risk_benefit": float(trial.get("risk_benefit_ratio") or 0.0),
        "platform_score": float(dossier.platform_score or 0.0),
        "cell_reduction": float(cell.get("cell_reduction_fraction") or 0.0),
    }


@dataclass
class PipelineRSIResult:
    """Bundle refine outcome with the final live dossier."""

    refine: RefineResult
    dossier: pipeline.TrialDossier
    ground_truth: dict[str, float]
    memory_path: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "refine": self.refine.as_dict(),
            "dossier": self.dossier.as_dict(),
            "ground_truth": dict(self.ground_truth),
            "memory_path": self.memory_path,
        }


def _clone_target(
    target: pipeline.PipelineTarget,
    *,
    rsi_params: Mapping[str, Any] | None,
    fast: bool,
) -> pipeline.PipelineTarget:
    kw: dict[str, Any] = {
        "smiles": target.smiles,
        "compound_id": target.compound_id,
        "disease": target.disease,
        "seed": target.seed,
        "n_candidates": target.n_candidates,
        "cohort_n": target.cohort_n,
        "phase1_n": target.phase1_n,
        "phase2_n": target.phase2_n,
        "phase3_n": target.phase3_n,
        "require_lipinski": target.require_lipinski,
        "max_tox_alerts": target.max_tox_alerts,
        "rsi_params": dict(normalize_params(rsi_params)) if rsi_params else None,
    }
    if fast:
        kw.update(_FAST_TARGET_KW)
        # Keep caller seed / smiles / disease; only shrink sweep sizes.
        kw["smiles"] = target.smiles
        kw["compound_id"] = target.compound_id
        kw["disease"] = target.disease
        kw["seed"] = target.seed
        kw["require_lipinski"] = target.require_lipinski
        kw["max_tox_alerts"] = target.max_tox_alerts
        kw["rsi_params"] = dict(normalize_params(rsi_params)) if rsi_params else None
    return pipeline.PipelineTarget(**kw)


def make_pipeline_simulate_fn(
    base_target: pipeline.PipelineTarget,
    *,
    fast: bool = True,
    dossier_sink: list[pipeline.TrialDossier] | None = None,
):
    """Return ``params → endpoints`` that runs the live cascade."""

    def simulate(params: Mapping[str, float]) -> dict[str, float]:
        target = _clone_target(base_target, rsi_params=params, fast=fast)
        dossier = pipeline.run_simulation_pipeline(target)
        if dossier_sink is not None:
            dossier_sink.append(dossier)
        return dossier_to_endpoints(dossier)

    return simulate


def run_pipeline_with_rsi(
    target: pipeline.PipelineTarget | None = None,
    *,
    ground_truth: Mapping[str, float] | None = None,
    params: Mapping[str, float] | None = None,
    memory_path: Path | None = None,
    threshold: float = ACCURACY_THRESHOLD,
    max_depth: int = 16,
    learning_rate: float = 0.55,
    fast: bool = True,
    smiles: str | None = None,
    disease: str = "oncology_solid",
    seed: int = 0,
) -> PipelineRSIResult:
    """Run the live pipeline under the RSI refine loop.

    If ``ground_truth`` is omitted, a calibrated (default-param) pipeline run
    becomes the biological reference — the loop then has to recover that
    behavior from a bad starting guess.
    """
    base = target or pipeline.PipelineTarget(
        smiles=smiles,
        disease=disease,
        seed=seed,
        **(_FAST_TARGET_KW if fast else {}),
    )
    path = Path(memory_path) if memory_path else (
        Path(__file__).resolve().parent / "memory.json"
    )

    truth = dict(ground_truth) if ground_truth else None
    if truth is None:
        oracle_target = _clone_target(
            base, rsi_params=DEFAULT_PARAMS, fast=fast
        )
        oracle_dossier = pipeline.run_simulation_pipeline(oracle_target)
        truth = dossier_to_endpoints(oracle_dossier)
        if not oracle_dossier.cellular_response:
            raise RuntimeError(
                "pipeline RSI needs a lead that clears toxicology so "
                "biological endpoints exist for ground truth"
            )

    dossier_sink: list[pipeline.TrialDossier] = []
    simulate = make_pipeline_simulate_fn(
        base, fast=fast, dossier_sink=dossier_sink
    )
    start_params = normalize_params(params or intentionally_bad_params())

    refine = refine_until_accurate(
        truth,
        params=start_params,
        scenario={
            "mode": "simulation_pipeline",
            "smiles": base.smiles,
            "disease": (
                base.disease
                if isinstance(base.disease, str)
                else getattr(base.disease, "disease_id", None)
            ),
            "seed": base.seed,
        },
        memory_path=path,
        threshold=threshold,
        max_depth=max_depth,
        learning_rate=learning_rate,
        simulate_fn=simulate,
        enable_hill_climb=False,  # full cascade is too heavy for ±delta search
    )

    final_dossier = (
        dossier_sink[-1]
        if dossier_sink
        else pipeline.run_simulation_pipeline(
            _clone_target(base, rsi_params=refine.params, fast=fast)
        )
    )
    return PipelineRSIResult(
        refine=refine,
        dossier=final_dossier,
        ground_truth=truth,
        memory_path=str(path),
    )


def run_self_test() -> int:
    """Prove live pipeline + RSI memory loop clears 85% and retains wins."""
    tmp = Path(tempfile.mkdtemp(prefix="flux-pipeline-rsi-")) / "memory.json"
    print("[pipeline_rsi] memory →", tmp)

    target = pipeline.PipelineTarget(
        smiles="CC(=O)Oc1ccccc1C(=O)O",
        disease="oncology_solid",
        seed=11,
        **_FAST_TARGET_KW,
    )

    # Baseline with bad params should be below the bar vs oracle truth.
    oracle = pipeline.run_simulation_pipeline(
        _clone_target(target, rsi_params=DEFAULT_PARAMS, fast=True)
    )
    truth = dossier_to_endpoints(oracle)
    bad = pipeline.run_simulation_pipeline(
        _clone_target(target, rsi_params=intentionally_bad_params(), fast=True)
    )
    baseline = evaluate_against_ground_truth(dossier_to_endpoints(bad), truth)
    print(f"[pipeline_rsi] baseline accuracy={baseline.accuracy:.3f}")
    if baseline.accuracy >= ACCURACY_THRESHOLD:
        print(
            "FAIL: bad params should start below accuracy threshold",
            file=sys.stderr,
        )
        return 1

    result = run_pipeline_with_rsi(
        target,
        ground_truth=truth,
        params=intentionally_bad_params(),
        memory_path=tmp,
        max_depth=20,
        fast=True,
    )
    print(
        f"[pipeline_rsi] refine success={result.refine.success} "
        f"accuracy={result.refine.accuracy:.3f} depth={result.refine.depth} "
        f"strategy={result.refine.strategy_id}"
    )
    if not result.refine.success:
        print(f"FAIL: {result.refine.message}", file=sys.stderr)
        return 1
    if result.refine.accuracy < ACCURACY_THRESHOLD:
        print("FAIL: accuracy still below threshold", file=sys.stderr)
        return 1
    if not result.dossier.cellular_response:
        print("FAIL: final dossier missing cellular response", file=sys.stderr)
        return 1

    mem = load_memory(tmp)
    if not mem.get("strategies"):
        print("FAIL: successful strategy not saved to memory.json", file=sys.stderr)
        return 1
    if len(mem.get("accuracy_logs") or []) < 2:
        print("FAIL: expected multiple accuracy log entries", file=sys.stderr)
        return 1

    warm = run_pipeline_with_rsi(
        target,
        ground_truth=truth,
        params=intentionally_bad_params(),
        memory_path=tmp,
        max_depth=20,
        fast=True,
    )
    print(
        f"[pipeline_rsi] warm-start success={warm.refine.success} "
        f"accuracy={warm.refine.accuracy:.3f} depth={warm.refine.depth}"
    )
    if not warm.refine.success:
        print("FAIL: warm-start refine failed", file=sys.stderr)
        return 1

    print("PASS: pipeline RSI refine + memory retention verified")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--smiles", default="CC(=O)Oc1ccccc1C(=O)O")
    parser.add_argument("--disease", default="oncology_solid")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--memory",
        type=Path,
        default=Path(__file__).resolve().parent / "memory.json",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test()

    if args.run:
        result = run_pipeline_with_rsi(
            smiles=args.smiles,
            disease=args.disease,
            seed=args.seed,
            memory_path=args.memory,
            fast=True,
        )
        print(json.dumps(result.as_dict(), indent=2, sort_keys=True, default=str))
        return 0 if result.refine.success else 2

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
