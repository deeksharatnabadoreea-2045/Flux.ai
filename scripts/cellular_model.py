#!/usr/bin/env python3
"""Baseline one-compartment PK + cellular-response model for Flux.ai.

Provides the single-patient simulator that ``virtual_cohort.py`` sweeps across
a digital population. This is an *in-silico toy* for agent benchmarks — not a
validated clinical PK/PD engine.

Physiology
----------
* One-compartment IV bolus: ``C(t) = (Dose / Vd) * exp(-(CL/Vd) * t)``
* Exponential tumor/cell growth with drug kill proportional to concentration
  and patient ``cell_sensitivity``.
* Toxicity flag when peak concentration (``Cmax``) exceeds the patient's
  ``toxicity_threshold``.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass, field
from typing import Sequence


@dataclass(frozen=True)
class PhysiologicalParams:
    """Patient-level physiological / pharmacologic parameters."""

    clearance: float = 5.0  # L/h
    volume_of_distribution: float = 50.0  # L
    cell_sensitivity: float = 0.35  # 1/(mg/L) kill coefficient
    baseline_cells: float = 1.0e9
    growth_rate: float = 0.03  # 1/h net growth without drug
    toxicity_threshold: float = 8.0  # mg/L Cmax limit
    efficacy_kill_fraction: float = 0.70  # success if cells drop by this fraction

    def __post_init__(self) -> None:
        if self.clearance <= 0:
            raise ValueError("clearance must be > 0")
        if self.volume_of_distribution <= 0:
            raise ValueError("volume_of_distribution must be > 0")
        if self.baseline_cells <= 0:
            raise ValueError("baseline_cells must be > 0")
        if self.toxicity_threshold <= 0:
            raise ValueError("toxicity_threshold must be > 0")
        if not 0.0 < self.efficacy_kill_fraction < 1.0:
            raise ValueError("efficacy_kill_fraction must be in (0, 1)")

    @property
    def elimination_rate(self) -> float:
        return self.clearance / self.volume_of_distribution


@dataclass
class TimePoint:
    time_h: float
    concentration_mg_l: float
    cells: float


@dataclass
class SimulationResult:
    """Single-patient dose → exposure → cell trajectory."""

    dose_mg: float
    params: PhysiologicalParams
    trajectory: list[TimePoint] = field(default_factory=list)
    cmax_mg_l: float = 0.0
    auc_mg_h_l: float = 0.0
    final_cells: float = 0.0
    cell_reduction_fraction: float = 0.0
    toxicity_breach: bool = False
    efficacy_success: bool = False

    def as_dict(self) -> dict:
        return {
            "dose_mg": self.dose_mg,
            "params": asdict(self.params),
            "cmax_mg_l": self.cmax_mg_l,
            "auc_mg_h_l": self.auc_mg_h_l,
            "final_cells": self.final_cells,
            "cell_reduction_fraction": self.cell_reduction_fraction,
            "toxicity_breach": self.toxicity_breach,
            "efficacy_success": self.efficacy_success,
            "n_timepoints": len(self.trajectory),
        }


def default_time_grid(horizon_h: float = 48.0, step_h: float = 0.5) -> list[float]:
    """Inclusive-ish time grid from 0 to horizon at fixed step."""
    if horizon_h <= 0 or step_h <= 0:
        raise ValueError("horizon_h and step_h must be > 0")
    n = int(math.floor(horizon_h / step_h))
    times = [i * step_h for i in range(n + 1)]
    if times[-1] < horizon_h - 1e-12:
        times.append(horizon_h)
    return times


def concentration_at(time_h: float, dose_mg: float, params: PhysiologicalParams) -> float:
    """Plasma concentration at time t after an IV bolus."""
    if time_h < 0:
        raise ValueError("time_h must be >= 0")
    c0 = dose_mg / params.volume_of_distribution
    return c0 * math.exp(-params.elimination_rate * time_h)


def _trapz(times: Sequence[float], values: Sequence[float]) -> float:
    if len(times) != len(values):
        raise ValueError("times and values length mismatch")
    if len(times) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(times)):
        dt = times[i] - times[i - 1]
        total += 0.5 * (values[i] + values[i - 1]) * dt
    return total


def simulate_dose(
    dose_mg: float,
    params: PhysiologicalParams | None = None,
    *,
    times_h: Sequence[float] | None = None,
) -> SimulationResult:
    """Propagate a drug dose through PK and cellular dynamics for one patient.

    Cell update (Euler, per interval ``dt``)::

        dN/dt = growth_rate * N - cell_sensitivity * C(t) * N
    """
    if dose_mg < 0:
        raise ValueError("dose_mg must be >= 0")
    params = params or PhysiologicalParams()
    times = list(times_h) if times_h is not None else default_time_grid()
    if not times or times[0] != 0.0:
        raise ValueError("times_h must start at 0.0")

    cells = params.baseline_cells
    trajectory: list[TimePoint] = []
    concentrations: list[float] = []

    for i, t in enumerate(times):
        conc = concentration_at(t, dose_mg, params)
        concentrations.append(conc)
        if i > 0:
            dt = times[i] - times[i - 1]
            # Use mid-interval concentration for the kill term.
            c_mid = 0.5 * (concentrations[i - 1] + conc)
            growth = params.growth_rate * cells
            kill = params.cell_sensitivity * c_mid * cells
            cells = max(0.0, cells + (growth - kill) * dt)
        trajectory.append(TimePoint(time_h=t, concentration_mg_l=conc, cells=cells))

    cmax = max(concentrations) if concentrations else 0.0
    auc = _trapz(times, concentrations)
    reduction = 0.0
    if params.baseline_cells > 0:
        reduction = max(0.0, 1.0 - (cells / params.baseline_cells))

    return SimulationResult(
        dose_mg=dose_mg,
        params=params,
        trajectory=trajectory,
        cmax_mg_l=cmax,
        auc_mg_h_l=auc,
        final_cells=cells,
        cell_reduction_fraction=reduction,
        toxicity_breach=cmax > params.toxicity_threshold,
        efficacy_success=reduction >= params.efficacy_kill_fraction,
    )


def run_self_test() -> int:
    params = PhysiologicalParams()
    low = simulate_dose(50.0, params)
    high = simulate_dose(800.0, params)
    assert low.cmax_mg_l < high.cmax_mg_l
    assert low.auc_mg_h_l < high.auc_mg_h_l
    assert high.toxicity_breach or high.cell_reduction_fraction >= low.cell_reduction_fraction
    # Zero dose should not kill below baseline growth path aggressively.
    zero = simulate_dose(0.0, params)
    assert zero.cmax_mg_l == 0.0
    assert zero.final_cells >= params.baseline_cells
    print("cellular_model self-test: ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dose", type=float, default=250.0, help="IV bolus dose (mg)")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print SimulationResult JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()
    result = simulate_dose(args.dose)
    if args.json:
        print(json.dumps(result.as_dict(), indent=2))
    else:
        print(
            f"dose={result.dose_mg} mg  Cmax={result.cmax_mg_l:.3f} mg/L  "
            f"AUC={result.auc_mg_h_l:.2f}  reduction={result.cell_reduction_fraction:.3f}  "
            f"efficacy={result.efficacy_success}  toxicity={result.toxicity_breach}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
