#!/usr/bin/env python3
"""Virtual clinical cohort simulation for Flux.ai.

Generates a diverse digital-patient population with randomized physiological
parameters, runs each patient through ``cellular_model.simulate_dose``, and
aggregates multi-patient safety / efficacy metrics. This cohort benchmark is
the optimization target for future autonomous agent dose/protocol search.

Example::

    python3 scripts/virtual_cohort.py --n 100 --dose 300 --seed 7
    python3 scripts/virtual_cohort.py --self-test
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from cellular_model import (  # noqa: E402
    PhysiologicalParams,
    SimulationResult,
    default_time_grid,
    simulate_dose,
)


# ---------------------------------------------------------------------------
# Virtual patients
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VirtualPatient:
    """One digital patient with sampled physiology."""

    patient_id: str
    params: PhysiologicalParams
    covariates: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "patient_id": self.patient_id,
            "params": asdict(self.params),
            "covariates": dict(self.covariates),
        }


@dataclass(frozen=True)
class ParameterPriors:
    """Log-normal / clipped priors for physiological sampling."""

    clearance_mu: float = math.log(5.0)
    clearance_sigma: float = 0.35
    vd_mu: float = math.log(50.0)
    vd_sigma: float = 0.25
    sensitivity_mu: float = math.log(0.35)
    sensitivity_sigma: float = 0.40
    baseline_cells_mu: float = math.log(1.0e9)
    baseline_cells_sigma: float = 0.30
    growth_rate_mu: float = math.log(0.03)
    growth_rate_sigma: float = 0.25
    toxicity_threshold_mu: float = math.log(8.0)
    toxicity_threshold_sigma: float = 0.20
    efficacy_kill_fraction: float = 0.70


def _lognormal(rng: random.Random, mu: float, sigma: float, *, floor: float) -> float:
    value = math.exp(rng.gauss(mu, sigma))
    return max(floor, value)


def sample_physiological_params(
    rng: random.Random,
    priors: ParameterPriors | None = None,
) -> PhysiologicalParams:
    """Draw one patient's parameters from the prior distribution."""
    priors = priors or ParameterPriors()
    return PhysiologicalParams(
        clearance=_lognormal(
            rng, priors.clearance_mu, priors.clearance_sigma, floor=0.5
        ),
        volume_of_distribution=_lognormal(
            rng, priors.vd_mu, priors.vd_sigma, floor=5.0
        ),
        cell_sensitivity=_lognormal(
            rng, priors.sensitivity_mu, priors.sensitivity_sigma, floor=0.01
        ),
        baseline_cells=_lognormal(
            rng, priors.baseline_cells_mu, priors.baseline_cells_sigma, floor=1.0e6
        ),
        growth_rate=_lognormal(
            rng, priors.growth_rate_mu, priors.growth_rate_sigma, floor=0.001
        ),
        toxicity_threshold=_lognormal(
            rng,
            priors.toxicity_threshold_mu,
            priors.toxicity_threshold_sigma,
            floor=1.0,
        ),
        efficacy_kill_fraction=priors.efficacy_kill_fraction,
    )


def generate_cohort(
    n_patients: int,
    *,
    seed: int = 0,
    priors: ParameterPriors | None = None,
    id_prefix: str = "VP",
) -> list[VirtualPatient]:
    """Create a cohort of diverse digital patients."""
    if n_patients <= 0:
        raise ValueError("n_patients must be > 0")
    rng = random.Random(seed)
    priors = priors or ParameterPriors()
    cohort: list[VirtualPatient] = []
    for i in range(n_patients):
        params = sample_physiological_params(rng, priors)
        # Lightweight covariates for audit / stratification later.
        age = int(rng.gauss(55, 12))
        age = min(85, max(18, age))
        sex = "F" if rng.random() < 0.5 else "M"
        cohort.append(
            VirtualPatient(
                patient_id=f"{id_prefix}-{i + 1:04d}",
                params=params,
                covariates={"age": age, "sex": sex, "seed": seed},
            )
        )
    return cohort


# ---------------------------------------------------------------------------
# Cohort simulation + aggregate metrics
# ---------------------------------------------------------------------------


@dataclass
class PatientOutcome:
    patient_id: str
    result: SimulationResult

    def as_dict(self) -> dict[str, Any]:
        payload = self.result.as_dict()
        payload["patient_id"] = self.patient_id
        return payload


@dataclass
class CohortBenchmark:
    """Multi-patient safety / efficacy summary for agent optimization."""

    dose_mg: float
    n_patients: int
    seed: int
    success_rate: float
    toxicity_breach_rate: float
    therapeutic_success_rate: float  # efficacy without toxicity
    mean_cell_reduction: float
    median_cell_reduction: float
    mean_cmax: float
    mean_auc: float
    outcomes: list[PatientOutcome] = field(default_factory=list)

    def as_dict(self, *, include_patients: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "dose_mg": self.dose_mg,
            "n_patients": self.n_patients,
            "seed": self.seed,
            "success_rate": self.success_rate,
            "toxicity_breach_rate": self.toxicity_breach_rate,
            "therapeutic_success_rate": self.therapeutic_success_rate,
            "mean_cell_reduction": self.mean_cell_reduction,
            "median_cell_reduction": self.median_cell_reduction,
            "mean_cmax": self.mean_cmax,
            "mean_auc": self.mean_auc,
        }
        if include_patients:
            payload["patients"] = [outcome.as_dict() for outcome in self.outcomes]
        return payload


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def simulate_patient(
    patient: VirtualPatient,
    dose_mg: float,
    *,
    times_h: Sequence[float] | None = None,
) -> PatientOutcome:
    """Run the cellular_model baseline for one virtual patient."""
    result = simulate_dose(dose_mg, patient.params, times_h=times_h)
    return PatientOutcome(patient_id=patient.patient_id, result=result)


def run_cohort(
    dose_mg: float,
    cohort: Sequence[VirtualPatient],
    *,
    times_h: Sequence[float] | None = None,
    seed: int = 0,
) -> CohortBenchmark:
    """Simulate dose propagation across the full virtual population."""
    if dose_mg < 0:
        raise ValueError("dose_mg must be >= 0")
    if not cohort:
        raise ValueError("cohort must be non-empty")

    grid = list(times_h) if times_h is not None else default_time_grid()
    outcomes = [
        simulate_patient(patient, dose_mg, times_h=grid) for patient in cohort
    ]

    successes = [o for o in outcomes if o.result.efficacy_success]
    toxic = [o for o in outcomes if o.result.toxicity_breach]
    therapeutic = [
        o
        for o in outcomes
        if o.result.efficacy_success and not o.result.toxicity_breach
    ]
    reductions = [o.result.cell_reduction_fraction for o in outcomes]
    cmaxes = [o.result.cmax_mg_l for o in outcomes]
    aucs = [o.result.auc_mg_h_l for o in outcomes]
    n = len(outcomes)

    return CohortBenchmark(
        dose_mg=dose_mg,
        n_patients=n,
        seed=seed,
        success_rate=len(successes) / n,
        toxicity_breach_rate=len(toxic) / n,
        therapeutic_success_rate=len(therapeutic) / n,
        mean_cell_reduction=_mean(reductions),
        median_cell_reduction=_median(reductions),
        mean_cmax=_mean(cmaxes),
        mean_auc=_mean(aucs),
        outcomes=outcomes,
    )


def dose_sweep(
    doses_mg: Sequence[float],
    *,
    n_patients: int = 50,
    seed: int = 0,
) -> list[CohortBenchmark]:
    """Helper for agent optimization: evaluate multiple doses on one cohort."""
    cohort = generate_cohort(n_patients, seed=seed)
    return [run_cohort(dose, cohort, seed=seed) for dose in doses_mg]


# ---------------------------------------------------------------------------
# Reporting / CLI
# ---------------------------------------------------------------------------


def print_benchmark(benchmark: CohortBenchmark) -> None:
    print(
        f"\nVirtual cohort benchmark  (n={benchmark.n_patients}, "
        f"dose={benchmark.dose_mg} mg, seed={benchmark.seed})"
    )
    print("-" * 60)
    print(f"  success_rate              : {benchmark.success_rate:6.1%}")
    print(f"  toxicity_breach_rate      : {benchmark.toxicity_breach_rate:6.1%}")
    print(f"  therapeutic_success_rate  : {benchmark.therapeutic_success_rate:6.1%}")
    print(f"  mean_cell_reduction       : {benchmark.mean_cell_reduction:6.1%}")
    print(f"  median_cell_reduction     : {benchmark.median_cell_reduction:6.1%}")
    print(f"  mean_cmax (mg/L)          : {benchmark.mean_cmax:8.3f}")
    print(f"  mean_auc (mg·h/L)         : {benchmark.mean_auc:8.2f}")
    print("-" * 60)


def run_self_test() -> int:
    """Offline checks: diversity, monotonic dose response, metric bounds."""
    cohort = generate_cohort(40, seed=11)
    clearances = {p.params.clearance for p in cohort}
    if len(clearances) < 20:
        print("FAIL: cohort clearance diversity too low", file=sys.stderr)
        return 1

    low = run_cohort(80.0, cohort, seed=11)
    high = run_cohort(600.0, cohort, seed=11)
    if not (0.0 <= low.success_rate <= 1.0 and 0.0 <= high.toxicity_breach_rate <= 1.0):
        print("FAIL: rates out of [0, 1]", file=sys.stderr)
        return 1
    if high.mean_cmax <= low.mean_cmax:
        print("FAIL: expected higher Cmax at higher dose", file=sys.stderr)
        return 1
    if high.toxicity_breach_rate < low.toxicity_breach_rate:
        print("FAIL: toxicity should not drop when dose rises", file=sys.stderr)
        return 1
    if high.mean_cell_reduction < low.mean_cell_reduction:
        print("FAIL: expected more cell kill at higher dose", file=sys.stderr)
        return 1

    # Same seed → identical cohort params.
    again = generate_cohort(40, seed=11)
    if [p.params for p in again] != [p.params for p in cohort]:
        print("FAIL: generate_cohort not deterministic for fixed seed", file=sys.stderr)
        return 1

    sweep = dose_sweep([100.0, 300.0, 500.0], n_patients=20, seed=3)
    if len(sweep) != 3:
        print("FAIL: dose_sweep length", file=sys.stderr)
        return 1

    print("virtual_cohort self-test: ok")
    print(
        f"  low_dose success={low.success_rate:.2%} tox={low.toxicity_breach_rate:.2%} "
        f"| high_dose success={high.success_rate:.2%} tox={high.toxicity_breach_rate:.2%}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=100, help="Cohort size")
    parser.add_argument("--dose", type=float, default=250.0, help="IV bolus dose (mg)")
    parser.add_argument("--seed", type=int, default=0, help="RNG seed")
    parser.add_argument(
        "--horizon-h",
        type=float,
        default=48.0,
        help="Simulation horizon in hours",
    )
    parser.add_argument(
        "--step-h",
        type=float,
        default=0.5,
        help="Integration step in hours",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit CohortBenchmark JSON (aggregate only)",
    )
    parser.add_argument(
        "--json-full",
        action="store_true",
        help="Emit JSON including per-patient outcomes",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()

    cohort = generate_cohort(args.n, seed=args.seed)
    times = default_time_grid(horizon_h=args.horizon_h, step_h=args.step_h)
    benchmark = run_cohort(args.dose, cohort, times_h=times, seed=args.seed)

    if args.json or args.json_full:
        print(
            json.dumps(
                benchmark.as_dict(include_patients=args.json_full),
                indent=2,
            )
        )
    else:
        print_benchmark(benchmark)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
