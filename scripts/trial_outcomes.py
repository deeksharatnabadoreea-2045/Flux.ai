#!/usr/bin/env python3
"""Multi-phase in-silico trial evaluation for Flux.ai.

Runs a Phase I → II → III pipeline on virtual cohort simulations from
``virtual_cohort`` / ``cellular_model``, then emits a structured JSON trial
report for the meta-agent and evaluator to use as a high-level scientific
benchmark.

Phases
------
* **Phase I** — dose escalation; estimate maximum tolerated dose (MTD) from
  dose-limiting toxicity (DLT) rates.
* **Phase II** — efficacy screen inside the therapeutic window (≤ MTD);
  pick the dose that maximizes therapeutic success.
* **Phase III** — large-cohort confirmation with Wilson confidence intervals,
  one-sided significance vs a null response rate, and risk–benefit ratios.

Example::

    python3 scripts/trial_outcomes.py --seed 7 --json
    python3 scripts/trial_outcomes.py --self-test
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from virtual_cohort import (  # noqa: E402
    CohortBenchmark,
    generate_cohort,
    run_cohort,
)


# ---------------------------------------------------------------------------
# Statistics helpers (stdlib only)
# ---------------------------------------------------------------------------


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def wilson_interval(
    successes: int,
    n: int,
    *,
    z: float = 1.96,
) -> tuple[float, float, float]:
    """Wilson score confidence interval for a binomial proportion.

    Returns ``(point_estimate, lower, upper)``.
    """
    if n <= 0:
        return 0.0, 0.0, 0.0
    successes = max(0, min(successes, n))
    p = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denom
    margin = (z / denom) * math.sqrt((p * (1.0 - p) / n) + z2 / (4.0 * n * n))
    return p, _clamp01(center - margin), _clamp01(center + margin)


def one_sided_binomial_z_test(
    successes: int,
    n: int,
    *,
    null_rate: float,
) -> dict[str, float]:
    """Normal-approximation one-sided z-test: H1 = rate > null_rate."""
    if n <= 0:
        return {"z": 0.0, "p_value": 1.0, "observed_rate": 0.0, "null_rate": null_rate}
    p_hat = successes / n
    se = math.sqrt(max(null_rate * (1.0 - null_rate), 1e-12) / n)
    z = (p_hat - null_rate) / se
    # Survival function of standard normal via erfc.
    p_value = 0.5 * math.erfc(z / math.sqrt(2.0))
    return {
        "z": z,
        "p_value": _clamp01(p_value),
        "observed_rate": p_hat,
        "null_rate": null_rate,
    }


def risk_benefit_ratio(efficacy_rate: float, toxicity_rate: float) -> float:
    """Efficacy per unit toxicity; large when safe & effective.

    Adds a 5% toxicity floor so zero-DLT regimens stay finite and comparable
    for agent optimization (avoids 1e6 blow-ups in JSON reports).
    """
    return efficacy_rate / (toxicity_rate + 0.05)


# ---------------------------------------------------------------------------
# Phase result containers
# ---------------------------------------------------------------------------


@dataclass
class DoseLevelResult:
    dose_mg: float
    n_patients: int
    dlt_count: int
    dlt_rate: float
    dlt_ci: tuple[float, float]
    efficacy_count: int
    efficacy_rate: float
    efficacy_ci: tuple[float, float]
    therapeutic_count: int
    therapeutic_rate: float
    mean_cell_reduction: float
    risk_benefit: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "dose_mg": self.dose_mg,
            "n_patients": self.n_patients,
            "dlt_count": self.dlt_count,
            "dlt_rate": self.dlt_rate,
            "dlt_ci_95": {"lower": self.dlt_ci[0], "upper": self.dlt_ci[1]},
            "efficacy_count": self.efficacy_count,
            "efficacy_rate": self.efficacy_rate,
            "efficacy_ci_95": {
                "lower": self.efficacy_ci[0],
                "upper": self.efficacy_ci[1],
            },
            "therapeutic_count": self.therapeutic_count,
            "therapeutic_rate": self.therapeutic_rate,
            "mean_cell_reduction": self.mean_cell_reduction,
            "risk_benefit_ratio": self.risk_benefit,
        }


@dataclass
class PhaseIResult:
    name: str = "Phase I"
    objective: str = "toxicity / maximum tolerated dose"
    dlt_threshold: float = 0.33
    doses_tested_mg: list[float] = field(default_factory=list)
    dose_results: list[DoseLevelResult] = field(default_factory=list)
    mtd_mg: float | None = None
    success_probability: float = 0.0
    passed: bool = False
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "objective": self.objective,
            "dlt_threshold": self.dlt_threshold,
            "doses_tested_mg": list(self.doses_tested_mg),
            "dose_results": [d.as_dict() for d in self.dose_results],
            "mtd_mg": self.mtd_mg,
            "success_probability": self.success_probability,
            "passed": self.passed,
            "notes": self.notes,
        }


@dataclass
class PhaseIIResult:
    name: str = "Phase II"
    objective: str = "efficacy / therapeutic window"
    window_doses_mg: list[float] = field(default_factory=list)
    dose_results: list[DoseLevelResult] = field(default_factory=list)
    recommended_dose_mg: float | None = None
    success_probability: float = 0.0
    therapeutic_window: dict[str, float] | None = None
    passed: bool = False
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "objective": self.objective,
            "window_doses_mg": list(self.window_doses_mg),
            "dose_results": [d.as_dict() for d in self.dose_results],
            "recommended_dose_mg": self.recommended_dose_mg,
            "success_probability": self.success_probability,
            "therapeutic_window": self.therapeutic_window,
            "passed": self.passed,
            "notes": self.notes,
        }


@dataclass
class PhaseIIIResult:
    name: str = "Phase III"
    objective: str = "large-scale statistical significance"
    dose_mg: float | None = None
    n_patients: int = 0
    efficacy_rate: float = 0.0
    efficacy_ci_95: dict[str, float] = field(default_factory=dict)
    toxicity_rate: float = 0.0
    toxicity_ci_95: dict[str, float] = field(default_factory=dict)
    therapeutic_rate: float = 0.0
    null_efficacy_rate: float = 0.30
    z_test: dict[str, float] = field(default_factory=dict)
    alpha: float = 0.05
    statistically_significant: bool = False
    risk_benefit_ratio: float = 0.0
    success_probability: float = 0.0
    passed: bool = False
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "objective": self.objective,
            "dose_mg": self.dose_mg,
            "n_patients": self.n_patients,
            "efficacy_rate": self.efficacy_rate,
            "efficacy_ci_95": dict(self.efficacy_ci_95),
            "toxicity_rate": self.toxicity_rate,
            "toxicity_ci_95": dict(self.toxicity_ci_95),
            "therapeutic_rate": self.therapeutic_rate,
            "null_efficacy_rate": self.null_efficacy_rate,
            "z_test": dict(self.z_test),
            "alpha": self.alpha,
            "statistically_significant": self.statistically_significant,
            "risk_benefit_ratio": self.risk_benefit_ratio,
            "success_probability": self.success_probability,
            "passed": self.passed,
            "notes": self.notes,
        }


@dataclass
class TrialReport:
    """Structured scientific benchmark for meta-agent / evaluator loops."""

    schema_version: str = "1.0"
    trial_id: str = ""
    generated_at: str = ""
    seed: int = 0
    overall_passed: bool = False
    overall_success_probability: float = 0.0
    recommended_phase3_dose_mg: float | None = None
    risk_benefit_ratio: float = 0.0
    phase_i: PhaseIResult = field(default_factory=PhaseIResult)
    phase_ii: PhaseIIResult = field(default_factory=PhaseIIResult)
    phase_iii: PhaseIIIResult = field(default_factory=PhaseIIIResult)
    benchmark: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "trial_id": self.trial_id,
            "generated_at": self.generated_at,
            "seed": self.seed,
            "overall_passed": self.overall_passed,
            "overall_success_probability": self.overall_success_probability,
            "recommended_phase3_dose_mg": self.recommended_phase3_dose_mg,
            "risk_benefit_ratio": self.risk_benefit_ratio,
            "phases": {
                "phase_i": self.phase_i.as_dict(),
                "phase_ii": self.phase_ii.as_dict(),
                "phase_iii": self.phase_iii.as_dict(),
            },
            "benchmark": dict(self.benchmark),
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.as_dict(), indent=indent, sort_keys=True)


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def _benchmark_to_dose_result(benchmark: CohortBenchmark) -> DoseLevelResult:
    n = benchmark.n_patients
    dlt = sum(1 for o in benchmark.outcomes if o.result.toxicity_breach)
    eff = sum(1 for o in benchmark.outcomes if o.result.efficacy_success)
    ther = sum(
        1
        for o in benchmark.outcomes
        if o.result.efficacy_success and not o.result.toxicity_breach
    )
    _, dlt_lo, dlt_hi = wilson_interval(dlt, n)
    _, eff_lo, eff_hi = wilson_interval(eff, n)
    return DoseLevelResult(
        dose_mg=benchmark.dose_mg,
        n_patients=n,
        dlt_count=dlt,
        dlt_rate=benchmark.toxicity_breach_rate,
        dlt_ci=(dlt_lo, dlt_hi),
        efficacy_count=eff,
        efficacy_rate=benchmark.success_rate,
        efficacy_ci=(eff_lo, eff_hi),
        therapeutic_count=ther,
        therapeutic_rate=benchmark.therapeutic_success_rate,
        mean_cell_reduction=benchmark.mean_cell_reduction,
        risk_benefit=risk_benefit_ratio(
            benchmark.success_rate, benchmark.toxicity_breach_rate
        ),
    )


def run_phase_i(
    doses_mg: Sequence[float],
    *,
    n_patients: int = 12,
    seed: int = 0,
    dlt_threshold: float = 0.33,
) -> PhaseIResult:
    """Escalate across doses; MTD = highest dose with DLT rate ≤ threshold."""
    doses = list(doses_mg)
    results: list[DoseLevelResult] = []

    for i, dose in enumerate(doses):
        cohort = generate_cohort(n_patients, seed=seed + 1000 + i, id_prefix="P1")
        bench = run_cohort(dose, cohort, seed=seed + 1000 + i)
        level = _benchmark_to_dose_result(bench)
        results.append(level)
        # Classic escalation stop: first dose above DLT threshold ends the climb.
        if level.dlt_rate > dlt_threshold:
            break

    acceptable = [r.dose_mg for r in results if r.dlt_rate <= dlt_threshold]
    mtd = max(acceptable) if acceptable else None

    # Success probability: confidence that MTD exists and top acceptable DLT CI
    # upper bound is not extreme.
    if mtd is None:
        success_p = 0.0
        notes = "No dose met the DLT threshold; Phase I failed to identify an MTD."
        passed = False
    else:
        top = next(r for r in results if r.dose_mg == mtd)
        # Higher when DLT point estimate is comfortably below threshold.
        headroom = max(0.0, dlt_threshold - top.dlt_rate) / max(dlt_threshold, 1e-9)
        ci_penalty = max(0.0, top.dlt_ci[1] - dlt_threshold)
        success_p = _clamp01(0.55 + 0.45 * headroom - ci_penalty)
        notes = f"MTD estimated at {mtd:g} mg (DLT threshold {dlt_threshold:.0%})."
        passed = True

    return PhaseIResult(
        dlt_threshold=dlt_threshold,
        doses_tested_mg=[r.dose_mg for r in results],
        dose_results=results,
        mtd_mg=mtd,
        success_probability=success_p,
        passed=passed,
        notes=notes,
    )


def run_phase_ii(
    mtd_mg: float | None,
    candidate_doses_mg: Sequence[float],
    *,
    n_patients: int = 40,
    seed: int = 0,
    min_therapeutic_rate: float = 0.40,
) -> PhaseIIResult:
    """Evaluate efficacy for doses inside the therapeutic window (≤ MTD)."""
    if mtd_mg is None:
        return PhaseIIResult(
            notes="Skipped: Phase I did not establish an MTD.",
            passed=False,
            success_probability=0.0,
        )

    window = sorted(d for d in candidate_doses_mg if d <= mtd_mg + 1e-9)
    if not window:
        window = [mtd_mg]

    results: list[DoseLevelResult] = []
    for i, dose in enumerate(window):
        cohort = generate_cohort(n_patients, seed=seed + 2000 + i, id_prefix="P2")
        bench = run_cohort(dose, cohort, seed=seed + 2000 + i)
        results.append(_benchmark_to_dose_result(bench))

    # Recommend dose maximizing therapeutic success, then risk-benefit.
    best = max(
        results,
        key=lambda r: (r.therapeutic_rate, r.risk_benefit, r.efficacy_rate),
    )
    passed = best.therapeutic_rate >= min_therapeutic_rate
    success_p = _clamp01(
        0.5 * best.therapeutic_rate
        + 0.3 * best.efficacy_rate
        + 0.2 * min(1.0, best.risk_benefit / 20.0)
    )
    low = min(window)
    return PhaseIIResult(
        window_doses_mg=window,
        dose_results=results,
        recommended_dose_mg=best.dose_mg,
        success_probability=success_p,
        therapeutic_window={"low_mg": low, "high_mg": mtd_mg},
        passed=passed,
        notes=(
            f"Recommended Phase II dose {best.dose_mg:g} mg "
            f"(therapeutic={best.therapeutic_rate:.1%}, "
            f"risk_benefit={best.risk_benefit:.2f})."
        ),
    )


def run_phase_iii(
    dose_mg: float | None,
    *,
    n_patients: int = 200,
    seed: int = 0,
    null_efficacy_rate: float = 0.30,
    alpha: float = 0.05,
    max_toxicity_rate: float = 0.35,
) -> PhaseIIIResult:
    """Large-cohort confirmation with CI + one-sided significance test."""
    if dose_mg is None:
        return PhaseIIIResult(
            notes="Skipped: no recommended dose from Phase II.",
            passed=False,
            success_probability=0.0,
            null_efficacy_rate=null_efficacy_rate,
            alpha=alpha,
        )

    cohort = generate_cohort(n_patients, seed=seed + 3000, id_prefix="P3")
    bench = run_cohort(dose_mg, cohort, seed=seed + 3000)
    level = _benchmark_to_dose_result(bench)

    eff_p, eff_lo, eff_hi = wilson_interval(level.efficacy_count, level.n_patients)
    tox_p, tox_lo, tox_hi = wilson_interval(level.dlt_count, level.n_patients)
    z_test = one_sided_binomial_z_test(
        level.efficacy_count,
        level.n_patients,
        null_rate=null_efficacy_rate,
    )
    significant = z_test["p_value"] < alpha
    safe_enough = tox_p <= max_toxicity_rate
    passed = significant and safe_enough and level.therapeutic_rate > 0.0
    rb = risk_benefit_ratio(eff_p, tox_p)

    # Blend p-value strength, CI separation from null, and safety.
    p_strength = _clamp01(1.0 - z_test["p_value"] / max(alpha, 1e-9))
    ci_sep = _clamp01((eff_lo - null_efficacy_rate) / max(1.0 - null_efficacy_rate, 1e-9))
    safety = _clamp01(1.0 - tox_p / max(max_toxicity_rate, 1e-9))
    success_p = _clamp01(0.45 * p_strength + 0.30 * ci_sep + 0.25 * safety)
    if not passed:
        success_p *= 0.5

    notes = (
        f"Phase III at {dose_mg:g} mg: efficacy={eff_p:.1%} "
        f"(95% CI {eff_lo:.1%}–{eff_hi:.1%}), "
        f"toxicity={tox_p:.1%}, z={z_test['z']:.2f}, "
        f"p={z_test['p_value']:.4g}, significant={significant}."
    )
    return PhaseIIIResult(
        dose_mg=dose_mg,
        n_patients=n_patients,
        efficacy_rate=eff_p,
        efficacy_ci_95={"lower": eff_lo, "upper": eff_hi},
        toxicity_rate=tox_p,
        toxicity_ci_95={"lower": tox_lo, "upper": tox_hi},
        therapeutic_rate=level.therapeutic_rate,
        null_efficacy_rate=null_efficacy_rate,
        z_test=z_test,
        alpha=alpha,
        statistically_significant=significant,
        risk_benefit_ratio=rb,
        success_probability=success_p,
        passed=passed,
        notes=notes,
    )


def run_trial_pipeline(
    *,
    seed: int = 0,
    phase1_doses_mg: Sequence[float] | None = None,
    phase1_n: int = 12,
    phase2_n: int = 40,
    phase3_n: int = 200,
    dlt_threshold: float = 0.33,
    null_efficacy_rate: float = 0.30,
    alpha: float = 0.05,
    trial_id: str | None = None,
) -> TrialReport:
    """Execute Phase I → II → III and build the JSON-ready trial report."""
    doses = list(
        phase1_doses_mg
        if phase1_doses_mg is not None
        else [50.0, 100.0, 150.0, 200.0, 250.0, 300.0, 400.0, 500.0]
    )

    phase_i = run_phase_i(
        doses,
        n_patients=phase1_n,
        seed=seed,
        dlt_threshold=dlt_threshold,
    )
    phase_ii = run_phase_ii(
        phase_i.mtd_mg,
        doses,
        n_patients=phase2_n,
        seed=seed,
    )
    phase_iii = run_phase_iii(
        phase_ii.recommended_dose_mg,
        n_patients=phase3_n,
        seed=seed,
        null_efficacy_rate=null_efficacy_rate,
        alpha=alpha,
    )

    overall_passed = phase_i.passed and phase_ii.passed and phase_iii.passed
    # Geometric-ish blend so one hard failure tanks the overall score.
    probs = [
        phase_i.success_probability,
        phase_ii.success_probability,
        phase_iii.success_probability,
    ]
    if any(p <= 0.0 for p in probs):
        overall_p = 0.0
    else:
        overall_p = math.exp(sum(math.log(max(p, 1e-12)) for p in probs) / len(probs))

    rb = phase_iii.risk_benefit_ratio if phase_iii.dose_mg is not None else 0.0
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tid = trial_id or f"flux-trial-{seed}-{generated.replace(':', '')}"

    return TrialReport(
        trial_id=tid,
        generated_at=generated,
        seed=seed,
        overall_passed=overall_passed,
        overall_success_probability=overall_p,
        recommended_phase3_dose_mg=phase_iii.dose_mg,
        risk_benefit_ratio=rb,
        phase_i=phase_i,
        phase_ii=phase_ii,
        phase_iii=phase_iii,
        benchmark={
            "module": "trial_outcomes",
            "depends_on": ["virtual_cohort", "cellular_model"],
            "endpoints": {
                "phase_i": "mtd_mg",
                "phase_ii": "recommended_dose_mg / therapeutic_rate",
                "phase_iii": "efficacy_ci_95 / z_test / risk_benefit_ratio",
            },
            "optimization_hint": (
                "Maximize overall_success_probability and risk_benefit_ratio "
                "while keeping phases.*.passed true."
            ),
        },
    )


# ---------------------------------------------------------------------------
# CLI / self-test
# ---------------------------------------------------------------------------


def print_summary(report: TrialReport) -> None:
    print(f"\nTrial {report.trial_id}")
    print("=" * 60)
    print(
        f"Overall: passed={report.overall_passed}  "
        f"P(success)={report.overall_success_probability:.3f}  "
        f"risk_benefit={report.risk_benefit_ratio:.2f}"
    )
    print(
        f"Phase I : passed={report.phase_i.passed}  "
        f"MTD={report.phase_i.mtd_mg}  "
        f"P={report.phase_i.success_probability:.3f}"
    )
    print(f"         {report.phase_i.notes}")
    print(
        f"Phase II: passed={report.phase_ii.passed}  "
        f"dose={report.phase_ii.recommended_dose_mg}  "
        f"P={report.phase_ii.success_probability:.3f}"
    )
    print(f"         {report.phase_ii.notes}")
    print(
        f"Phase III: passed={report.phase_iii.passed}  "
        f"sig={report.phase_iii.statistically_significant}  "
        f"P={report.phase_iii.success_probability:.3f}"
    )
    print(f"         {report.phase_iii.notes}")
    print("=" * 60)


def run_self_test() -> int:
    # Wilson known edge: 0/10 → lower 0, upper > 0
    p, lo, hi = wilson_interval(0, 10)
    assert p == 0.0 and lo == 0.0 and hi > 0.0
    p, lo, hi = wilson_interval(10, 10)
    assert p == 1.0 and hi == 1.0 and lo < 1.0

    z = one_sided_binomial_z_test(80, 100, null_rate=0.3)
    assert z["p_value"] < 0.05

    report = run_trial_pipeline(seed=7, phase1_n=10, phase2_n=30, phase3_n=120)
    payload = report.as_dict()
    required_top = {
        "schema_version",
        "trial_id",
        "overall_passed",
        "overall_success_probability",
        "risk_benefit_ratio",
        "phases",
        "benchmark",
    }
    missing = required_top - set(payload)
    if missing:
        print(f"FAIL: report missing keys {sorted(missing)}", file=sys.stderr)
        return 1
    for key in ("phase_i", "phase_ii", "phase_iii"):
        if key not in payload["phases"]:
            print(f"FAIL: missing phases.{key}", file=sys.stderr)
            return 1
    if report.phase_i.mtd_mg is None:
        print("FAIL: expected an MTD for seed=7 defaults", file=sys.stderr)
        return 1
    if report.phase_ii.recommended_dose_mg is None:
        print("FAIL: expected Phase II recommendation", file=sys.stderr)
        return 1
    if report.phase_iii.efficacy_ci_95["lower"] > report.phase_iii.efficacy_rate:
        print("FAIL: CI lower > point estimate", file=sys.stderr)
        return 1
    if report.risk_benefit_ratio <= 0:
        print("FAIL: expected positive risk-benefit", file=sys.stderr)
        return 1

    # JSON round-trip
    loaded = json.loads(report.to_json())
    assert loaded["trial_id"] == report.trial_id

    print("trial_outcomes self-test: ok")
    print(
        f"  MTD={report.phase_i.mtd_mg}  "
        f"P2_dose={report.phase_ii.recommended_dose_mg}  "
        f"overall_P={report.overall_success_probability:.3f}  "
        f"passed={report.overall_passed}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--phase1-n", type=int, default=12)
    parser.add_argument("--phase2-n", type=int, default=40)
    parser.add_argument("--phase3-n", type=int, default=200)
    parser.add_argument("--dlt-threshold", type=float, default=0.33)
    parser.add_argument("--null-efficacy", type=float, default=0.30)
    parser.add_argument("--alpha", type=float, default=0.05)
    parser.add_argument(
        "--doses",
        type=str,
        default="50,100,150,200,250,300,400,500",
        help="Comma-separated Phase I escalation doses (mg)",
    )
    parser.add_argument("--json", action="store_true", help="Print full trial JSON")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write JSON report to this path",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()

    doses = [float(x.strip()) for x in args.doses.split(",") if x.strip()]
    report = run_trial_pipeline(
        seed=args.seed,
        phase1_doses_mg=doses,
        phase1_n=args.phase1_n,
        phase2_n=args.phase2_n,
        phase3_n=args.phase3_n,
        dlt_threshold=args.dlt_threshold,
        null_efficacy_rate=args.null_efficacy,
        alpha=args.alpha,
    )

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report.to_json() + "\n", encoding="utf-8")
        print(f"Wrote {args.out}", flush=True)

    if args.json:
        print(report.to_json())
    else:
        print_summary(report)
    return 0 if report.overall_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
