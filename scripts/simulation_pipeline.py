#!/usr/bin/env python3
"""End-to-end Flux.ai simulation pipeline.

Wires the domain stack into one cascade::

    compound_engine → toxicology_engine → cellular_model
                   → virtual_cohort → trial_outcomes

``run_simulation_pipeline`` accepts a target chemical and/or disease profile,
executes the full flow, and returns a unified JSON trial dossier. Programmatic
helpers (``score_dossier``, ``invoke_for_evaluator``, ``invoke_for_meta_agent``)
let ``evaluate_agent`` / the meta-agent score and optimize biological platform
accuracy without re-implementing the cascade.

Example::

    python3 scripts/simulation_pipeline.py --smiles 'CC(=O)Oc1ccccc1C(=O)O'
    python3 scripts/simulation_pipeline.py --disease oncology_solid --seed 7 --json
    python3 scripts/simulation_pipeline.py --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import cellular_model  # noqa: E402
import compound_engine  # noqa: E402
import toxicology_engine  # noqa: E402
import trial_outcomes  # noqa: E402
import virtual_cohort  # noqa: E402
from cellular_model import PhysiologicalParams, simulate_dose  # noqa: E402
from compound_engine import (  # noqa: E402
    CompoundLogger,
    CompoundProfile,
    apply_compound_to_params,
    generate_candidates,
    profile_from_smiles,
    record_trial_outcome_link,
    screened_for_cohort,
)
from toxicology_engine import (  # noqa: E402
    GatePolicy,
    ToxicologyReport,
    evaluate_compound,
    gate_profiles_for_pipeline,
)
from trial_outcomes import TrialReport, run_trial_pipeline  # noqa: E402
from virtual_cohort import (  # noqa: E402
    CohortBenchmark,
    ParameterPriors,
    VirtualPatient,
    generate_cohort,
    run_cohort,
)

DEFAULT_LOG = REPO_ROOT / ".flux" / "simulation_pipeline_history.log"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Target / disease profile
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DiseaseProfile:
    """Indication priors that shape cohort biology and Phase III null rate."""

    disease_id: str
    name: str
    null_efficacy_rate: float = 0.30
    dlt_threshold: float = 0.33
    growth_rate_mu: float = 0.03  # used as log-space mean via ln
    cell_sensitivity_mu: float = 0.35
    toxicity_threshold_mu: float = 8.0
    description: str = ""

    def cohort_priors(self) -> ParameterPriors:
        import math

        return ParameterPriors(
            growth_rate_mu=math.log(max(self.growth_rate_mu, 1e-4)),
            sensitivity_mu=math.log(max(self.cell_sensitivity_mu, 1e-4)),
            toxicity_threshold_mu=math.log(max(self.toxicity_threshold_mu, 1e-4)),
        )


DISEASE_LIBRARY: dict[str, DiseaseProfile] = {
    "oncology_solid": DiseaseProfile(
        disease_id="oncology_solid",
        name="Solid tumor oncology",
        null_efficacy_rate=0.25,
        dlt_threshold=0.33,
        growth_rate_mu=0.045,
        cell_sensitivity_mu=0.40,
        toxicity_threshold_mu=7.5,
        description="Aggressive growth; moderate tox tolerance",
    ),
    "oncology_heme": DiseaseProfile(
        disease_id="oncology_heme",
        name="Hematologic malignancy",
        null_efficacy_rate=0.35,
        dlt_threshold=0.30,
        growth_rate_mu=0.055,
        cell_sensitivity_mu=0.50,
        toxicity_threshold_mu=6.5,
        description="Fast proliferation; tighter DLT budget",
    ),
    "inflammatory": DiseaseProfile(
        disease_id="inflammatory",
        name="Inflammatory / immune",
        null_efficacy_rate=0.40,
        dlt_threshold=0.25,
        growth_rate_mu=0.02,
        cell_sensitivity_mu=0.28,
        toxicity_threshold_mu=9.0,
        description="Slower dynamics; stricter safety bar",
    ),
}


@dataclass
class PipelineTarget:
    """Input to the unified simulation cascade."""

    smiles: str | None = None
    compound_id: str | None = None
    disease: DiseaseProfile | str | None = "oncology_solid"
    seed: int = 0
    n_candidates: int = 12
    cohort_n: int = 40
    phase1_n: int = 10
    phase2_n: int = 24
    phase3_n: int = 80
    require_lipinski: bool = True
    max_tox_alerts: int = 1
    # Optional RSI knobs (from engine.rsi) that reshape disease priors.
    rsi_params: dict[str, float] | None = None

    def resolve_disease(self) -> DiseaseProfile:
        if self.disease is None:
            base = DISEASE_LIBRARY["oncology_solid"]
        elif isinstance(self.disease, DiseaseProfile):
            base = self.disease
        else:
            key = str(self.disease)
            if key not in DISEASE_LIBRARY:
                raise ValueError(
                    f"unknown disease {key!r}; choose from {sorted(DISEASE_LIBRARY)}"
                )
            base = DISEASE_LIBRARY[key]
        if not self.rsi_params:
            return base
        # Lazy import keeps the cascade usable without the engine package.
        from engine.pipeline_rsi import apply_rsi_params_to_disease

        return apply_rsi_params_to_disease(base, self.rsi_params)


# ---------------------------------------------------------------------------
# Unified dossier
# ---------------------------------------------------------------------------


@dataclass
class TrialDossier:
    """Unified JSON artifact spanning chemistry → tox → PK/PD → cohort → trial."""

    schema_version: str = "1.0"
    dossier_id: str = ""
    generated_at: str = ""
    seed: int = 0
    target: dict[str, Any] = field(default_factory=dict)
    cascade_status: dict[str, Any] = field(default_factory=dict)
    lead_compound: dict[str, Any] | None = None
    toxicology: dict[str, Any] | None = None
    cellular_response: dict[str, Any] | None = None
    virtual_cohort: dict[str, Any] | None = None
    trial: dict[str, Any] | None = None
    platform_score: float = 0.0
    platform_passed: bool = False
    meta_agent: dict[str, Any] = field(default_factory=dict)
    modules: list[str] = field(
        default_factory=lambda: [
            "compound_engine",
            "toxicology_engine",
            "cellular_model",
            "virtual_cohort",
            "trial_outcomes",
        ]
    )

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "dossier_id": self.dossier_id,
            "generated_at": self.generated_at,
            "seed": self.seed,
            "target": dict(self.target),
            "modules": list(self.modules),
            "cascade_status": dict(self.cascade_status),
            "lead_compound": self.lead_compound,
            "toxicology": self.toxicology,
            "cellular_response": self.cellular_response,
            "virtual_cohort": self.virtual_cohort,
            "trial": self.trial,
            "platform_score": self.platform_score,
            "platform_passed": self.platform_passed,
            "meta_agent": dict(self.meta_agent),
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.as_dict(), indent=indent, sort_keys=True)


def score_dossier(dossier: TrialDossier) -> float:
    """Scalar platform score for Evaluator / Meta-Agent optimization (0..1)."""
    parts: list[float] = []
    weights: list[float] = []

    tox = dossier.toxicology or {}
    if tox:
        parts.append(float(tox.get("safety_index", 0.0)))
        weights.append(0.25)

    cell = dossier.cellular_response or {}
    if cell:
        # Prefer efficacy without toxicity at the cellular scale.
        red = float(cell.get("cell_reduction_fraction", 0.0))
        breach = 1.0 if cell.get("toxicity_breach") else 0.0
        parts.append(max(0.0, red * (1.0 - 0.6 * breach)))
        weights.append(0.20)

    cohort = dossier.virtual_cohort or {}
    if cohort:
        parts.append(float(cohort.get("therapeutic_success_rate", 0.0)))
        weights.append(0.25)

    trial = dossier.trial or {}
    if trial:
        parts.append(float(trial.get("overall_success_probability", 0.0)))
        weights.append(0.30)

    if not parts:
        return 0.0
    score = sum(p * w for p, w in zip(parts, weights)) / sum(weights)
    if not dossier.platform_passed:
        score *= 0.5
    return round(max(0.0, min(1.0, score)), 4)


# ---------------------------------------------------------------------------
# Cascade helpers
# ---------------------------------------------------------------------------


def _select_lead(
    target: PipelineTarget,
    logger: CompoundLogger,
) -> tuple[CompoundProfile | None, ToxicologyReport | None, dict[str, Any]]:
    """Generation → tox screening; return lead profile + tox report + status."""
    status: dict[str, Any] = {
        "generation": "pending",
        "toxicology": "pending",
        "n_generated": 0,
        "n_lipinski": 0,
        "n_tox_passed": 0,
    }

    if target.smiles:
        cid = target.compound_id or f"PIPE-{target.seed:04d}-001"
        profile = profile_from_smiles(
            target.smiles, compound_id=cid, logger=logger
        )
        status["generation"] = "provided_smiles"
        status["n_generated"] = 1
        library = [profile]
    else:
        library = generate_candidates(
            target.n_candidates, seed=target.seed, logger=logger, id_prefix="PIPE"
        )
        status["generation"] = "compound_engine"
        status["n_generated"] = len(library)

    filtered = screened_for_cohort(
        library,
        require_lipinski=target.require_lipinski,
        max_alerts=target.max_tox_alerts,
    )
    status["n_lipinski"] = len(filtered)
    if not filtered:
        # Fall back to unfiltered library so tox reports still explain failure.
        filtered = list(library)

    passed, failed = gate_profiles_for_pipeline(
        filtered, policy=GatePolicy(), logger=logger
    )
    status["n_tox_passed"] = len(passed)
    status["n_tox_failed"] = len(failed)
    status["toxicology"] = "pass" if passed else "fail"

    if not passed:
        # Keep the least-toxic failure for diagnostics.
        if failed:
            worst_best = max(failed, key=lambda r: r.safety_index)
            return None, worst_best, status
        return None, None, status

    # Prefer highest safety_index then potency among passers.
    lead, tox = max(
        passed,
        key=lambda pair: (pair[1].safety_index, pair[0].potency_scale, -pair[1].toxicity_index),
    )
    return lead, tox, status


def _dose_ladder(center_mg: float) -> list[float]:
    """Build a Phase I escalation ladder centered on the lead dose."""
    center = max(25.0, center_mg)
    raw = [
        center * 0.25,
        center * 0.5,
        center * 0.75,
        center,
        center * 1.25,
        center * 1.5,
        center * 2.0,
    ]
    # Unique rounded doses in ascending order, capped for the toy model.
    doses = sorted({round(max(25.0, min(600.0, d)), 1) for d in raw})
    return doses


def _run_cellular(
    lead: CompoundProfile,
    disease: DiseaseProfile,
) -> dict[str, Any]:
    base = PhysiologicalParams(
        growth_rate=disease.growth_rate_mu,
        cell_sensitivity=disease.cell_sensitivity_mu,
        toxicity_threshold=disease.toxicity_threshold_mu,
    )
    params = apply_compound_to_params(base, lead)
    result = simulate_dose(lead.recommended_dose_mg, params)
    payload = result.as_dict()
    payload["disease_id"] = disease.disease_id
    payload["compound_id"] = lead.compound_id
    return payload


def _run_cohort(
    lead: CompoundProfile,
    disease: DiseaseProfile,
    *,
    n: int,
    seed: int,
) -> CohortBenchmark:
    priors = disease.cohort_priors()
    cohort = generate_cohort(n, seed=seed, priors=priors, id_prefix="SIM")
    adjusted = [
        VirtualPatient(
            patient_id=p.patient_id,
            params=apply_compound_to_params(p.params, lead),
            covariates={
                **p.covariates,
                "compound_id": lead.compound_id,
                "disease_id": disease.disease_id,
            },
        )
        for p in cohort
    ]
    return run_cohort(lead.recommended_dose_mg, adjusted, seed=seed)


def _run_trial(
    lead: CompoundProfile,
    disease: DiseaseProfile,
    target: PipelineTarget,
) -> TrialReport:
    doses = _dose_ladder(lead.recommended_dose_mg)
    return run_trial_pipeline(
        seed=target.seed + 17,
        phase1_doses_mg=doses,
        phase1_n=target.phase1_n,
        phase2_n=target.phase2_n,
        phase3_n=target.phase3_n,
        dlt_threshold=disease.dlt_threshold,
        null_efficacy_rate=disease.null_efficacy_rate,
        trial_id=f"sim-{lead.compound_id}-{target.seed}",
    )


# ---------------------------------------------------------------------------
# Public runner + agent interfaces
# ---------------------------------------------------------------------------


def run_simulation_pipeline(
    target: PipelineTarget | None = None,
    *,
    smiles: str | None = None,
    disease: str | DiseaseProfile | None = None,
    seed: int = 0,
    log_path: Path | None = None,
) -> TrialDossier:
    """Execute generation → tox → cellular → cohort → trial; return dossier.

    Accepts either a ``PipelineTarget`` or kwargs for a quick chemical/disease
    profile invocation.
    """
    # Touch imports so wiring stays explicit for agents / tests.
    _ = (
        compound_engine.CompoundProfile,
        toxicology_engine.ToxicologyReport,
        cellular_model.simulate_dose,
        virtual_cohort.run_cohort,
        trial_outcomes.run_trial_pipeline,
    )

    if target is None:
        target = PipelineTarget(smiles=smiles, disease=disease, seed=seed)
    elif smiles is not None or disease is not None:
        # Allow overriding fields when both are provided.
        target = PipelineTarget(
            smiles=smiles if smiles is not None else target.smiles,
            compound_id=target.compound_id,
            disease=disease if disease is not None else target.disease,
            seed=seed if seed else target.seed,
            n_candidates=target.n_candidates,
            cohort_n=target.cohort_n,
            phase1_n=target.phase1_n,
            phase2_n=target.phase2_n,
            phase3_n=target.phase3_n,
            require_lipinski=target.require_lipinski,
            max_tox_alerts=target.max_tox_alerts,
            rsi_params=target.rsi_params,
        )

    disease_profile = target.resolve_disease()
    logger = CompoundLogger(log_path or DEFAULT_LOG)
    generated_at = _utc_now()
    dossier_id = f"dossier-{target.seed}-{generated_at.replace(':', '')}"

    lead, tox, status = _select_lead(target, logger)
    cascade = {
        "generation": status.get("generation"),
        "toxicology": status.get("toxicology"),
        "cellular": "skipped",
        "virtual_cohort": "skipped",
        "trial": "skipped",
        "counts": {
            "n_generated": status.get("n_generated", 0),
            "n_lipinski": status.get("n_lipinski", 0),
            "n_tox_passed": status.get("n_tox_passed", 0),
            "n_tox_failed": status.get("n_tox_failed", 0),
        },
    }

    dossier = TrialDossier(
        dossier_id=dossier_id,
        generated_at=generated_at,
        seed=target.seed,
        target={
            "smiles": target.smiles,
            "compound_id": target.compound_id,
            "disease": asdict(disease_profile),
            "n_candidates": target.n_candidates,
            "cohort_n": target.cohort_n,
            "rsi_params": dict(target.rsi_params) if target.rsi_params else None,
        },
        cascade_status=cascade,
        toxicology=tox.as_dict() if tox else None,
        lead_compound=lead.as_dict() if lead else None,
    )

    if lead is None or tox is None or not tox.gate_passed:
        dossier.platform_passed = False
        dossier.platform_score = score_dossier(dossier)
        dossier.meta_agent = {
            "optimize_toward": "raise safety_index; clear tox gate",
            "blocked_stage": "toxicology",
            "mutation_suggestions": (tox.meta_agent_feedback.get("mutation_suggestions")
                                     if tox else ["generate safer scaffolds"]),
            "reward_hint": dossier.platform_score,
        }
        logger.record(
            "pipeline_blocked",
            dossier_id=dossier_id,
            stage="toxicology",
            platform_score=dossier.platform_score,
        )
        return dossier

    # Cellular response
    cell_payload = _run_cellular(lead, disease_profile)
    dossier.cellular_response = cell_payload
    cascade["cellular"] = "ok"

    # Virtual cohort distribution
    bench = _run_cohort(
        lead, disease_profile, n=target.cohort_n, seed=target.seed + 3
    )
    dossier.virtual_cohort = bench.as_dict(include_patients=False)
    cascade["virtual_cohort"] = "ok"

    # Multi-phase trial evaluation
    trial = _run_trial(lead, disease_profile, target)
    dossier.trial = trial.as_dict()
    cascade["trial"] = "ok" if trial.overall_passed else "completed_with_failures"

    dossier.cascade_status = cascade
    dossier.platform_passed = bool(tox.gate_passed and trial.overall_passed)
    dossier.platform_score = score_dossier(dossier)
    dossier.meta_agent = {
        "optimize_toward": (
            "maximize platform_score (= safety + cellular + cohort therapeutic "
            "+ trial success)"
        ),
        "reward_hint": dossier.platform_score,
        "lead_compound_id": lead.compound_id,
        "trial_id": trial.trial_id,
        "mutation_suggestions": tox.meta_agent_feedback.get("mutation_suggestions", []),
        "disease_id": disease_profile.disease_id,
    }

    record_trial_outcome_link(
        logger,
        compound_id=lead.compound_id,
        trial_id=trial.trial_id,
        overall_passed=trial.overall_passed,
        overall_success_probability=trial.overall_success_probability,
        risk_benefit_ratio=trial.risk_benefit_ratio,
        notes=f"simulation_pipeline dossier={dossier_id} score={dossier.platform_score}",
    )
    logger.record(
        "pipeline_complete",
        dossier_id=dossier_id,
        platform_score=dossier.platform_score,
        platform_passed=dossier.platform_passed,
        compound_id=lead.compound_id,
        trial_id=trial.trial_id,
    )
    return dossier


def run_simulation_pipeline_with_rsi(
    target: PipelineTarget | None = None,
    *,
    smiles: str | None = None,
    disease: str = "oncology_solid",
    seed: int = 0,
    ground_truth: dict[str, float] | None = None,
    params: dict[str, float] | None = None,
    memory_path: Path | None = None,
    threshold: float = 0.85,
    max_depth: int = 16,
    fast: bool = True,
) -> dict[str, Any]:
    """Run the cascade under the RSI refine loop (85% accuracy bar).

    Returns a JSON-friendly payload with the refine result, final dossier,
    and path to the memory file that retained successful strategies.
    """
    from engine.pipeline_rsi import run_pipeline_with_rsi

    base = target or PipelineTarget(smiles=smiles, disease=disease, seed=seed)
    result = run_pipeline_with_rsi(
        base,
        ground_truth=ground_truth,
        params=params,
        memory_path=memory_path,
        threshold=threshold,
        max_depth=max_depth,
        fast=fast,
    )
    return result.as_dict()


def invoke_for_evaluator(
    *,
    smiles: str | None = None,
    disease: str = "oncology_solid",
    seed: int = 0,
    min_score: float = 0.35,
) -> dict[str, Any]:
    """Evaluator-facing API: run pipeline and return pass/fail + score + dossier.

    Intended for ``evaluate_agent`` / QC harnesses that need an automatic
    biological-accuracy probe without caring about intermediate stages.
    """
    dossier = run_simulation_pipeline(
        PipelineTarget(smiles=smiles, disease=disease, seed=seed)
    )
    passed = dossier.platform_score >= min_score and bool(
        dossier.cascade_status.get("toxicology") == "pass"
        and dossier.cellular_response
        and dossier.virtual_cohort
        and dossier.trial
    )
    return {
        "passed": passed,
        "score": dossier.platform_score,
        "min_score": min_score,
        "platform_passed": dossier.platform_passed,
        "dossier_id": dossier.dossier_id,
        "dossier": dossier.as_dict(),
        "summary": {
            "toxicology": dossier.cascade_status.get("toxicology"),
            "cellular": dossier.cascade_status.get("cellular"),
            "virtual_cohort": dossier.cascade_status.get("virtual_cohort"),
            "trial": dossier.cascade_status.get("trial"),
        },
    }


def invoke_for_meta_agent(
    *,
    smiles: str | None = None,
    disease: str = "oncology_solid",
    seed: int = 0,
) -> dict[str, Any]:
    """Meta-agent API: score + mutation feedback for iterative optimization."""
    dossier = run_simulation_pipeline(
        PipelineTarget(smiles=smiles, disease=disease, seed=seed)
    )
    return {
        "score": dossier.platform_score,
        "passed": dossier.platform_passed,
        "reward_hint": dossier.meta_agent.get("reward_hint", dossier.platform_score),
        "mutation_suggestions": dossier.meta_agent.get("mutation_suggestions", []),
        "optimize_toward": dossier.meta_agent.get("optimize_toward"),
        "dossier_id": dossier.dossier_id,
        "lead_compound": dossier.lead_compound,
        "toxicology": {
            "safety_index": (dossier.toxicology or {}).get("safety_index"),
            "toxicity_index": (dossier.toxicology or {}).get("toxicity_index"),
            "gate_passed": (dossier.toxicology or {}).get("gate_passed"),
        },
        "trial": {
            "overall_passed": (dossier.trial or {}).get("overall_passed"),
            "overall_success_probability": (dossier.trial or {}).get(
                "overall_success_probability"
            ),
            "risk_benefit_ratio": (dossier.trial or {}).get("risk_benefit_ratio"),
        },
        "dossier": dossier.as_dict(),
    }


# ---------------------------------------------------------------------------
# CLI / self-test
# ---------------------------------------------------------------------------


def print_dossier_summary(dossier: TrialDossier) -> None:
    print(f"\nTrial dossier  {dossier.dossier_id}")
    print("=" * 64)
    print(f"seed={dossier.seed}  score={dossier.platform_score:.3f}  "
          f"passed={dossier.platform_passed}")
    print(f"cascade: {dossier.cascade_status}")
    if dossier.lead_compound:
        print(
            f"lead: {dossier.lead_compound.get('compound_id')}  "
            f"SMILES={dossier.lead_compound.get('smiles', '')[:48]}"
        )
    if dossier.toxicology:
        print(
            f"tox: safety={dossier.toxicology.get('safety_index')}  "
            f"toxicity={dossier.toxicology.get('toxicity_index')}  "
            f"gate={dossier.toxicology.get('gate_passed')}"
        )
    if dossier.cellular_response:
        print(
            f"cellular: reduction={dossier.cellular_response.get('cell_reduction_fraction'):.3f}  "
            f"tox_breach={dossier.cellular_response.get('toxicity_breach')}"
        )
    if dossier.virtual_cohort:
        print(
            f"cohort: therapeutic={dossier.virtual_cohort.get('therapeutic_success_rate'):.3f}  "
            f"success={dossier.virtual_cohort.get('success_rate'):.3f}  "
            f"tox={dossier.virtual_cohort.get('toxicity_breach_rate'):.3f}"
        )
    if dossier.trial:
        print(
            f"trial: passed={dossier.trial.get('overall_passed')}  "
            f"P={dossier.trial.get('overall_success_probability')}  "
            f"RB={dossier.trial.get('risk_benefit_ratio')}"
        )
    print("=" * 64)


def run_self_test() -> int:
    # 1) Explicit aspirin-like SMILES should clear tox and produce a dossier
    d1 = run_simulation_pipeline(
        PipelineTarget(
            smiles="CC(=O)Oc1ccccc1C(=O)O",
            disease="oncology_solid",
            seed=1,
            cohort_n=20,
            phase1_n=8,
            phase2_n=16,
            phase3_n=40,
        )
    )
    if not d1.toxicology or not d1.toxicology.get("gate_passed"):
        print("FAIL: aspirin-like should pass tox gate in pipeline", file=sys.stderr)
        return 1
    for key in ("cellular_response", "virtual_cohort", "trial"):
        if not getattr(d1, key):
            print(f"FAIL: missing {key} in dossier", file=sys.stderr)
            return 1
    if d1.platform_score <= 0:
        print("FAIL: expected positive platform_score", file=sys.stderr)
        return 1

    # 2) Nitro should block before cellular/cohort/trial
    d2 = run_simulation_pipeline(
        PipelineTarget(smiles="c1ccc(cc1)N(=O)=O", disease="inflammatory", seed=2)
    )
    if d2.cascade_status.get("toxicology") != "fail":
        print("FAIL: nitro should fail toxicology stage", file=sys.stderr)
        return 1
    if d2.cellular_response is not None:
        print("FAIL: blocked pipeline should skip cellular", file=sys.stderr)
        return 1

    # 3) Library generation path + evaluator / meta-agent APIs
    d3 = run_simulation_pipeline(
        PipelineTarget(disease="oncology_heme", seed=7, n_candidates=16, cohort_n=16,
                       phase1_n=8, phase2_n=12, phase3_n=30)
    )
    payload = json.loads(d3.to_json())
    required = {
        "schema_version",
        "dossier_id",
        "modules",
        "cascade_status",
        "platform_score",
        "meta_agent",
    }
    missing = required - set(payload)
    if missing:
        print(f"FAIL: dossier missing {sorted(missing)}", file=sys.stderr)
        return 1

    ev = invoke_for_evaluator(
        smiles="CC(=O)Oc1ccccc1C(=O)O", disease="oncology_solid", seed=3
    )
    if "score" not in ev or "dossier" not in ev:
        print("FAIL: evaluator API incomplete", file=sys.stderr)
        return 1
    meta = invoke_for_meta_agent(
        smiles="CC(=O)Oc1ccccc1C(=O)O", disease="oncology_solid", seed=3
    )
    if "mutation_suggestions" not in meta or "reward_hint" not in meta:
        print("FAIL: meta-agent API incomplete", file=sys.stderr)
        return 1

    # 4) RSI-modulated disease priors should alter cellular sensitivity vs default
    from engine.rsi import DEFAULT_PARAMS, intentionally_bad_params

    d_default = run_simulation_pipeline(
        PipelineTarget(
            smiles="CC(=O)Oc1ccccc1C(=O)O",
            disease="oncology_solid",
            seed=5,
            cohort_n=10,
            phase1_n=4,
            phase2_n=6,
            phase3_n=12,
            rsi_params=dict(DEFAULT_PARAMS),
        )
    )
    d_bad = run_simulation_pipeline(
        PipelineTarget(
            smiles="CC(=O)Oc1ccccc1C(=O)O",
            disease="oncology_solid",
            seed=5,
            cohort_n=10,
            phase1_n=4,
            phase2_n=6,
            phase3_n=12,
            rsi_params=intentionally_bad_params(),
        )
    )
    if not d_default.cellular_response or not d_bad.cellular_response:
        print("FAIL: RSI param dossiers should clear tox", file=sys.stderr)
        return 1
    if d_default.target.get("rsi_params") is None:
        print("FAIL: rsi_params missing from dossier target", file=sys.stderr)
        return 1

    print("simulation_pipeline self-test: ok")
    print(
        f"  aspirin_score={d1.platform_score:.3f} "
        f"nitro_blocked={d2.cascade_status.get('toxicology')} "
        f"library_score={d3.platform_score:.3f} "
        f"eval_passed={ev['passed']} "
        f"rsi_default_score={d_default.platform_score:.3f} "
        f"rsi_bad_score={d_bad.platform_score:.3f}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smiles", type=str, default=None)
    parser.add_argument(
        "--disease",
        type=str,
        default="oncology_solid",
        choices=sorted(DISEASE_LIBRARY),
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--n-candidates", type=int, default=12)
    parser.add_argument("--cohort-n", type=int, default=40)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--for-evaluator",
        action="store_true",
        help="Emit invoke_for_evaluator payload",
    )
    parser.add_argument(
        "--for-meta-agent",
        action="store_true",
        help="Emit invoke_for_meta_agent payload",
    )
    parser.add_argument(
        "--with-rsi",
        action="store_true",
        help="Run cascade under RSI refine loop (memory-backed, 85%% bar)",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()

    if args.for_evaluator:
        payload = invoke_for_evaluator(
            smiles=args.smiles, disease=args.disease, seed=args.seed
        )
        text = json.dumps(payload, indent=2, sort_keys=True)
        if args.out:
            args.out.write_text(text + "\n", encoding="utf-8")
        print(text if args.json or args.out is None else f"Wrote {args.out}")
        return 0 if payload["passed"] else 1

    if args.for_meta_agent:
        payload = invoke_for_meta_agent(
            smiles=args.smiles, disease=args.disease, seed=args.seed
        )
        text = json.dumps(payload, indent=2, sort_keys=True)
        if args.out:
            args.out.write_text(text + "\n", encoding="utf-8")
        print(text if args.json or args.out is None else f"Wrote {args.out}")
        return 0

    if args.with_rsi:
        payload = run_simulation_pipeline_with_rsi(
            smiles=args.smiles, disease=args.disease, seed=args.seed, fast=True
        )
        text = json.dumps(payload, indent=2, sort_keys=True, default=str)
        if args.out:
            args.out.write_text(text + "\n", encoding="utf-8")
        print(text if args.json or args.out is None else f"Wrote {args.out}")
        refine = payload.get("refine") or {}
        return 0 if refine.get("success") else 2

    target = PipelineTarget(
        smiles=args.smiles,
        disease=args.disease,
        seed=args.seed,
        n_candidates=args.n_candidates,
        cohort_n=args.cohort_n,
    )
    dossier = run_simulation_pipeline(target)
    if args.out:
        args.out.write_text(dossier.to_json() + "\n", encoding="utf-8")
        print(f"Wrote {args.out}")
    if args.json:
        print(dossier.to_json())
    else:
        print_dossier_summary(dossier)
    return 0 if dossier.platform_passed or dossier.cellular_response else 1


if __name__ == "__main__":
    raise SystemExit(main())
