#!/usr/bin/env python3
"""Mechanistic toxicity and off-target prediction for Flux.ai.

Builds a predictive toxicology matrix over major clinical failure modes
(hERG cardiotoxicity, hepatotoxicity markers, structural tox alerts, plus
CYP-liability and Ames-like mutagenicity heuristics). Integrates with
``compound_engine`` so candidates are gated *before* they enter
``cellular_model`` / ``virtual_cohort``.

Emits a structured safety/toxicity index report the meta-agent can score
against, pushing chemical mutations toward higher safety profiles.

Toy / heuristic — not a validated QSAR or regulatory tox package.

Example::

    python3 scripts/toxicology_engine.py --smiles 'CC(=O)Oc1ccccc1C(=O)O'
    python3 scripts/toxicology_engine.py --self-test
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from compound_engine import (  # noqa: E402
    CompoundLogger,
    CompoundProfile,
    apply_compound_to_params,
    generate_candidates,
    profile_from_smiles,
    screened_for_cohort,
)
from cellular_model import PhysiologicalParams  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
DEFAULT_LOG = REPO_ROOT / ".flux" / "toxicology_history.log"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


# ---------------------------------------------------------------------------
# Endpoint definitions (predictive matrix)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ToxEndpoint:
    """One clinical failure-mode check."""

    endpoint_id: str
    name: str
    category: str  # cardiotoxicity | hepatotoxicity | structural | off_target | mutagenicity
    risk_score: float  # 0 = safe, 1 = high risk
    triggered: bool
    evidence: list[str] = field(default_factory=list)
    weight: float = 1.0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ToxicologyReport:
    """Safety/toxicity index for the meta-agent evaluation loop."""

    schema_version: str = "1.0"
    report_id: str = ""
    generated_at: str = ""
    compound_id: str = ""
    smiles: str = ""
    endpoints: list[ToxEndpoint] = field(default_factory=list)
    toxicity_index: float = 0.0  # 0 safe → 1 toxic
    safety_index: float = 1.0  # 1 safe → 0 toxic
    gate_passed: bool = False
    gate_reason: str = ""
    # Adjusted bridge fields for downstream PK/PD
    recommended_dose_mg: float = 0.0
    potency_scale: float = 1.0
    safety_scale: float = 1.0
    simulation_inputs: dict[str, Any] = field(default_factory=dict)
    meta_agent_feedback: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "report_id": self.report_id,
            "generated_at": self.generated_at,
            "compound_id": self.compound_id,
            "smiles": self.smiles,
            "toxicity_index": self.toxicity_index,
            "safety_index": self.safety_index,
            "gate_passed": self.gate_passed,
            "gate_reason": self.gate_reason,
            "recommended_dose_mg": self.recommended_dose_mg,
            "potency_scale": self.potency_scale,
            "safety_scale": self.safety_scale,
            "simulation_inputs": dict(self.simulation_inputs),
            "endpoints": [e.as_dict() for e in self.endpoints],
            "meta_agent_feedback": dict(self.meta_agent_feedback),
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.as_dict(), indent=indent, sort_keys=True)


# ---------------------------------------------------------------------------
# Endpoint scorers
# ---------------------------------------------------------------------------


def _score_herg(profile: CompoundProfile) -> ToxEndpoint:
    """hERG liability: basic amines + high lipophilicity + aromatic bulk."""
    props = profile.properties
    smiles = profile.smiles
    evidence: list[str] = []
    risk = 0.08

    has_basic_amine = bool(re.search(r"(?<![CN])N(?![C=O])|CCN|N\(C\)C|N1", smiles))
    # Prefer clearer patterns
    if re.search(r"CCN|N\(C\)C|CN\(|NCC|c1ccc\(cc1\)CCN", smiles):
        has_basic_amine = True
        evidence.append("basic/tertiary amine motif associated with hERG binders")
        risk += 0.35

    if props.logp > 3.5:
        evidence.append(f"logP={props.logp:.2f} > 3.5 (lipophilic hERG risk)")
        risk += 0.25
    elif props.logp > 2.5:
        evidence.append(f"logP={props.logp:.2f} moderately elevated")
        risk += 0.10

    if props.aromatic_rings >= 2:
        evidence.append(f"{props.aromatic_rings} aromatic rings (π-stacking / channel block)")
        risk += 0.20
    elif props.aromatic_rings == 1 and has_basic_amine:
        evidence.append("single aryl + amine pharmacophore")
        risk += 0.10

    if props.molecular_weight > 400 and has_basic_amine:
        evidence.append("MW>400 with basic center")
        risk += 0.08

    risk = _clamp01(risk)
    return ToxEndpoint(
        endpoint_id="herg_cardiotoxicity",
        name="hERG channel cardiotoxicity",
        category="cardiotoxicity",
        risk_score=round(risk, 4),
        triggered=risk >= 0.45,
        evidence=evidence or ["no strong hERG flags"],
        weight=1.4,
    )


def _score_hepatotoxicity(profile: CompoundProfile) -> ToxEndpoint:
    """Hepatotox markers: quinone/phenol oxidation, reactive motifs, high dose."""
    props = profile.properties
    smiles = profile.smiles
    evidence: list[str] = []
    risk = 0.05

    if re.search(r"c1ccc\(O\)|Oc1ccc|c\(O\)c", smiles):
        evidence.append("phenol/aniline oxidation liability")
        risk += 0.22
    if "N(=O)=O" in smiles or "[N+](=O)[O-]" in smiles:
        evidence.append("nitro bioreduction → reactive intermediates")
        risk += 0.30
    if re.search(r"C=CC\(=O\)", smiles):
        evidence.append("Michael acceptor (reactive metabolite risk)")
        risk += 0.28
    if re.search(r"C\(=S\)|C\(=O\)N.*Cl|ClCC", smiles):
        evidence.append("thio / halo structural hepatotox alert")
        risk += 0.18
    if props.logp > 4.0 and props.molecular_weight > 350:
        evidence.append("high lipophilicity + size (hepatic accumulation)")
        risk += 0.15
    if profile.recommended_dose_mg > 400:
        evidence.append(f"high projected dose {profile.recommended_dose_mg} mg")
        risk += 0.10

    # Acetaminophen-like scaffold note
    if "CC(=O)Nc1ccc(O)cc1" in smiles or "Nc1ccc(O)cc1" in smiles:
        evidence.append("para-aminophenol lineage (NAPQI-like concern at high dose)")
        risk += 0.12

    risk = _clamp01(risk)
    return ToxEndpoint(
        endpoint_id="hepatotoxicity",
        name="Hepatotoxicity risk markers",
        category="hepatotoxicity",
        risk_score=round(risk, 4),
        triggered=risk >= 0.40,
        evidence=evidence or ["no strong hepatotox flags"],
        weight=1.3,
    )


def _score_structural_alerts(profile: CompoundProfile) -> ToxEndpoint:
    """Reuse / extend compound_engine structural toxicity alerts."""
    alerts = list(profile.screen.toxicity_alerts)
    evidence = alerts[:] if alerts else ["no structural toxicophores matched"]
    risk = _clamp01(0.15 * len(alerts))
    if not profile.screen.lipinski_pass:
        evidence.append(
            "Lipinski violations: " + ", ".join(profile.screen.lipinski_violations)
        )
        risk = _clamp01(risk + 0.15)
    return ToxEndpoint(
        endpoint_id="structural_toxicity_alerts",
        name="Structural toxicity alerts",
        category="structural",
        risk_score=round(risk, 4),
        triggered=bool(alerts),
        evidence=evidence,
        weight=1.2,
    )


def _score_cyp_liability(profile: CompoundProfile) -> ToxEndpoint:
    """Crude CYP inhibition / DDI liability from lipophilicity + aromatics."""
    props = profile.properties
    evidence: list[str] = []
    risk = 0.05
    if props.logp > 3.0 and props.aromatic_rings >= 2:
        evidence.append("lipophilic polyaromatic CYP binder profile")
        risk += 0.35
    elif props.logp > 3.0:
        evidence.append("elevated logP CYP interaction risk")
        risk += 0.18
    if re.search(r"c1ccc2c\(c1\)|n1c|N1C=", profile.smiles):
        evidence.append("fused / heterocyclic nitrogen (CYP binding motif)")
        risk += 0.15
    if props.molecular_weight > 450:
        evidence.append("MW>450 increases nonspecific protein binding")
        risk += 0.10
    risk = _clamp01(risk)
    return ToxEndpoint(
        endpoint_id="cyp_off_target",
        name="CYP / off-target liability",
        category="off_target",
        risk_score=round(risk, 4),
        triggered=risk >= 0.40,
        evidence=evidence or ["low CYP liability flags"],
        weight=0.9,
    )


def _score_ames_mutagenicity(profile: CompoundProfile) -> ToxEndpoint:
    """Ames-like mutagenicity heuristics (aromatic nitro, epoxide, hydrazine)."""
    smiles = profile.smiles
    evidence: list[str] = []
    risk = 0.02
    if re.search(r"N\(=O\)=O|\[N\+\]\(=O\)\[O-\]", smiles):
        evidence.append("aromatic/aliphatic nitro (Ames positive class)")
        risk += 0.45
    if re.search(r"C1OC1", smiles):
        evidence.append("epoxide (DNA-reactive)")
        risk += 0.40
    if re.search(r"NN|N\(N", smiles):
        evidence.append("hydrazine (mutagenicity alert)")
        risk += 0.35
    if re.search(r"c1ccc\(cc1\)N(?!\(=O\))", smiles) and "N(=O)=O" not in smiles:
        evidence.append("primary aryl amine (potential mutagen after activation)")
        risk += 0.20
    risk = _clamp01(risk)
    return ToxEndpoint(
        endpoint_id="ames_mutagenicity",
        name="Ames-like mutagenicity",
        category="mutagenicity",
        risk_score=round(risk, 4),
        triggered=risk >= 0.35,
        evidence=evidence or ["no Ames-class alerts"],
        weight=1.5,
    )


def build_toxicology_matrix(profile: CompoundProfile) -> list[ToxEndpoint]:
    """Full predictive matrix across major clinical failure points."""
    return [
        _score_herg(profile),
        _score_hepatotoxicity(profile),
        _score_structural_alerts(profile),
        _score_cyp_liability(profile),
        _score_ames_mutagenicity(profile),
    ]


def _aggregate_indices(endpoints: Sequence[ToxEndpoint]) -> tuple[float, float]:
    """Weighted toxicity index and complementary safety index."""
    if not endpoints:
        return 0.0, 1.0
    num = sum(e.risk_score * e.weight for e in endpoints)
    den = sum(e.weight for e in endpoints)
    toxicity = _clamp01(num / den)
    # Soft-max triggered critical endpoints
    critical = [e for e in endpoints if e.triggered and e.weight >= 1.3]
    if critical:
        toxicity = _clamp01(max(toxicity, max(e.risk_score for e in critical)))
    return round(toxicity, 4), round(1.0 - toxicity, 4)


# ---------------------------------------------------------------------------
# Gate + report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GatePolicy:
    """Pass criteria before cellular_model / virtual_cohort."""

    max_toxicity_index: float = 0.55
    block_if_ames_triggered: bool = True
    block_if_structural_alerts: bool = False  # compound_engine already filters hard alerts
    min_safety_index: float = 0.40


def evaluate_compound(
    profile: CompoundProfile,
    *,
    policy: GatePolicy | None = None,
    logger: CompoundLogger | None = None,
) -> ToxicologyReport:
    """Run the tox matrix and produce a meta-agent safety report."""
    policy = policy or GatePolicy()
    endpoints = build_toxicology_matrix(profile)
    toxicity_index, safety_index = _aggregate_indices(endpoints)

    blocked: list[str] = []
    if toxicity_index > policy.max_toxicity_index:
        blocked.append(
            f"toxicity_index {toxicity_index:.3f} > max {policy.max_toxicity_index:.3f}"
        )
    if safety_index < policy.min_safety_index:
        blocked.append(
            f"safety_index {safety_index:.3f} < min {policy.min_safety_index:.3f}"
        )
    by_id = {e.endpoint_id: e for e in endpoints}
    if policy.block_if_ames_triggered and by_id["ames_mutagenicity"].triggered:
        blocked.append("Ames-like mutagenicity triggered")
    if policy.block_if_structural_alerts and by_id["structural_toxicity_alerts"].triggered:
        blocked.append("structural toxicity alerts present")

    gate_passed = not blocked
    gate_reason = "PASS: cleared toxicology gate" if gate_passed else "; ".join(blocked)

    # Tighten safety_scale for downstream PK when residual risk remains.
    adjusted_safety = profile.safety_scale * (0.55 + 0.45 * safety_index)
    if not gate_passed:
        adjusted_safety *= 0.5
    adjusted_safety = round(max(0.15, min(1.5, adjusted_safety)), 4)

    # Slightly lower dose when cardiotox / hepatotox elevated.
    dose = profile.recommended_dose_mg
    herg = by_id["herg_cardiotoxicity"].risk_score
    hep = by_id["hepatotoxicity"].risk_score
    dose *= 1.0 - 0.25 * max(herg, hep)
    dose = round(max(10.0, dose), 1)

    sim_inputs = {
        **profile.simulation_inputs(),
        "dose_mg": dose,
        "safety_scale": adjusted_safety,
        "toxicity_index": toxicity_index,
        "safety_index": safety_index,
        "tox_gate_passed": gate_passed,
    }

    # Feedback signal for the meta-agent mutation loop.
    triggered = [e.endpoint_id for e in endpoints if e.triggered]
    suggestions: list[str] = []
    if "herg_cardiotoxicity" in triggered:
        suggestions.append("reduce basicity / lipophilicity; remove aryl–amine motifs")
    if "hepatotoxicity" in triggered:
        suggestions.append("remove phenols/nitros/Michael acceptors; lower dose burden")
    if "ames_mutagenicity" in triggered:
        suggestions.append("eliminate nitro / epoxide / hydrazine structural classes")
    if "structural_toxicity_alerts" in triggered:
        suggestions.append("clear toxicophores flagged by compound_engine screen")
    if "cyp_off_target" in triggered:
        suggestions.append("lower logP / aromatic bulk to reduce CYP liability")
    if not suggestions:
        suggestions.append("maintain scaffold; favor mutations that raise safety_index")

    report = ToxicologyReport(
        report_id=f"tox-{profile.compound_id}-{_utc_now().replace(':', '')}",
        generated_at=_utc_now(),
        compound_id=profile.compound_id,
        smiles=profile.smiles,
        endpoints=endpoints,
        toxicity_index=toxicity_index,
        safety_index=safety_index,
        gate_passed=gate_passed,
        gate_reason=gate_reason,
        recommended_dose_mg=dose,
        potency_scale=profile.potency_scale,
        safety_scale=adjusted_safety,
        simulation_inputs=sim_inputs,
        meta_agent_feedback={
            "optimize_toward": "higher safety_index / lower toxicity_index",
            "triggered_endpoints": triggered,
            "mutation_suggestions": suggestions,
            "reward_hint": round(safety_index - toxicity_index, 4),
        },
    )

    if logger is not None:
        logger.record(
            "toxicology_eval",
            compound_id=profile.compound_id,
            smiles=profile.smiles,
            toxicity_index=toxicity_index,
            safety_index=safety_index,
            gate_passed=gate_passed,
            triggered_endpoints=triggered,
            recommended_dose_mg=dose,
            safety_scale=adjusted_safety,
        )
    return report


def gate_profiles_for_pipeline(
    profiles: Sequence[CompoundProfile],
    *,
    policy: GatePolicy | None = None,
    logger: CompoundLogger | None = None,
) -> tuple[list[tuple[CompoundProfile, ToxicologyReport]], list[ToxicologyReport]]:
    """Evaluate compounds; return (passed with reports, failed reports).

    Passed profiles should proceed into cellular_model / virtual_cohort using
    ``report.simulation_inputs``.
    """
    policy = policy or GatePolicy()
    passed: list[tuple[CompoundProfile, ToxicologyReport]] = []
    failed: list[ToxicologyReport] = []
    for profile in profiles:
        report = evaluate_compound(profile, policy=policy, logger=logger)
        if report.gate_passed:
            # Overlay tox-adjusted bridge fields onto a shallow copy-like profile
            # by mutating dataclass fields in a new CompoundProfile instance.
            adjusted = CompoundProfile(
                compound_id=profile.compound_id,
                smiles=profile.smiles,
                properties=profile.properties,
                screen=profile.screen,
                recommended_dose_mg=report.recommended_dose_mg,
                potency_scale=report.potency_scale,
                safety_scale=report.safety_scale,
                parent_id=profile.parent_id,
                mutation=profile.mutation,
                generation=profile.generation,
            )
            passed.append((adjusted, report))
        else:
            failed.append(report)
    return passed, failed


def apply_tox_report_to_params(
    params: PhysiologicalParams,
    report: ToxicologyReport,
) -> PhysiologicalParams:
    """Apply tox-adjusted safety/potency scales before simulate_dose."""
    return replace(
        params,
        cell_sensitivity=max(0.01, params.cell_sensitivity * report.potency_scale),
        toxicity_threshold=max(0.5, params.toxicity_threshold * report.safety_scale),
    )


# ---------------------------------------------------------------------------
# CLI / self-test
# ---------------------------------------------------------------------------


def print_report(report: ToxicologyReport) -> None:
    print(f"\nToxicology report  {report.compound_id}")
    print("=" * 64)
    print(f"SMILES          : {report.smiles}")
    print(f"toxicity_index  : {report.toxicity_index:.3f}")
    print(f"safety_index    : {report.safety_index:.3f}")
    print(f"gate            : {'PASS' if report.gate_passed else 'FAIL'} — {report.gate_reason}")
    print(f"dose / safety   : {report.recommended_dose_mg} mg / scale={report.safety_scale}")
    print("-" * 64)
    for ep in report.endpoints:
        flag = "HIT" if ep.triggered else "ok "
        print(
            f"  [{flag}] {ep.endpoint_id:28} risk={ep.risk_score:.2f}  "
            f"{ep.evidence[0] if ep.evidence else ''}"
        )
    print("-" * 64)
    fb = report.meta_agent_feedback
    print(f"reward_hint     : {fb.get('reward_hint')}")
    for tip in fb.get("mutation_suggestions", []):
        print(f"  → {tip}")


def run_self_test() -> int:
    from cellular_model import simulate_dose
    from virtual_cohort import VirtualPatient, generate_cohort, run_cohort

    log_path = Path("/tmp/flux-toxicology-engine-test.log")
    if log_path.exists():
        log_path.unlink()
    logger = CompoundLogger(log_path)

    aspirin = profile_from_smiles(
        "CC(=O)Oc1ccccc1C(=O)O", compound_id="TOX-ASA", logger=logger
    )
    nitro = profile_from_smiles(
        "c1ccc(cc1)N(=O)=O", compound_id="TOX-NO2", logger=logger
    )
    amine = profile_from_smiles(
        "c1ccc(cc1)CCN", compound_id="TOX-PEA", logger=logger
    )

    asa_report = evaluate_compound(aspirin, logger=logger)
    no2_report = evaluate_compound(nitro, logger=logger)
    pea_report = evaluate_compound(amine, logger=logger)

    if not asa_report.gate_passed:
        print("FAIL: aspirin-like should typically pass tox gate", file=sys.stderr)
        return 1
    if no2_report.gate_passed:
        print("FAIL: nitrobenzene should fail Ames/tox gate", file=sys.stderr)
        return 1
    if no2_report.toxicity_index <= asa_report.toxicity_index:
        print("FAIL: nitro should score higher toxicity than aspirin", file=sys.stderr)
        return 1
    if not any(e.endpoint_id == "herg_cardiotoxicity" for e in pea_report.endpoints):
        print("FAIL: missing hERG endpoint", file=sys.stderr)
        return 1

    # Matrix must include required clinical failure points
    required = {
        "herg_cardiotoxicity",
        "hepatotoxicity",
        "structural_toxicity_alerts",
        "cyp_off_target",
        "ames_mutagenicity",
    }
    have = {e.endpoint_id for e in asa_report.endpoints}
    if have != required:
        print(f"FAIL: endpoint set {have} != {required}", file=sys.stderr)
        return 1

    # Pipeline gate with compound_engine library
    library = generate_candidates(20, seed=5, logger=logger)
    pre = screened_for_cohort(library, require_lipinski=True, max_alerts=1)
    passed, failed = gate_profiles_for_pipeline(pre, logger=logger)
    if not passed and not failed:
        print("FAIL: gate produced no evaluations", file=sys.stderr)
        return 1

    # Feed a passed compound into cellular_model + virtual_cohort
    if passed:
        lead, tox = passed[0]
        params = apply_compound_to_params(
            PhysiologicalParams(), lead
        )
        # Further apply tox-adjusted safety already on lead.safety_scale
        sim = simulate_dose(lead.recommended_dose_mg, params)
        if sim.dose_mg != lead.recommended_dose_mg:
            print("FAIL: dose bridge after tox gate", file=sys.stderr)
            return 1
        cohort = generate_cohort(8, seed=2)
        adjusted = [
            VirtualPatient(
                patient_id=p.patient_id,
                params=apply_compound_to_params(p.params, lead),
                covariates={
                    **p.covariates,
                    "compound_id": lead.compound_id,
                    "toxicity_index": tox.toxicity_index,
                    "safety_index": tox.safety_index,
                },
            )
            for p in cohort
        ]
        bench = run_cohort(lead.recommended_dose_mg, adjusted, seed=2)
        logger.record(
            "trial_outcome_link",
            compound_id=lead.compound_id,
            toxicity_index=tox.toxicity_index,
            safety_index=tox.safety_index,
            therapeutic_success_rate=bench.therapeutic_success_rate,
            notes="post-tox-gate cohort smoke test",
        )
        if bench.n_patients != 8:
            print("FAIL: cohort size after tox gate", file=sys.stderr)
            return 1

    # JSON schema for meta-agent
    payload = json.loads(asa_report.to_json())
    for key in (
        "toxicity_index",
        "safety_index",
        "gate_passed",
        "endpoints",
        "meta_agent_feedback",
        "simulation_inputs",
    ):
        if key not in payload:
            print(f"FAIL: report missing {key}", file=sys.stderr)
            return 1

    entries = logger.read_entries()
    if not any(e.get("action") == "toxicology_eval" for e in entries):
        print("FAIL: missing toxicology_eval log entries", file=sys.stderr)
        return 1

    print("toxicology_engine self-test: ok")
    print(
        f"  asa_tox={asa_report.toxicity_index:.3f} "
        f"nitro_tox={no2_report.toxicity_index:.3f} "
        f"passed={len(passed)} failed={len(failed)} "
        f"log_entries={len(entries)}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smiles", type=str, default=None, help="Evaluate one SMILES")
    parser.add_argument("--compound-id", type=str, default="CLI-001")
    parser.add_argument(
        "--from-library",
        type=int,
        default=0,
        help="Generate N candidates via compound_engine then tox-gate",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--out", type=Path, default=None, help="Write JSON report(s)")
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="History log path (default: .flux/toxicology_history.log)",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()

    logger = CompoundLogger(args.log or DEFAULT_LOG)

    if args.from_library > 0:
        library = generate_candidates(args.from_library, seed=args.seed, logger=logger)
        pre = screened_for_cohort(library, require_lipinski=True, max_alerts=1)
        passed, failed = gate_profiles_for_pipeline(pre, logger=logger)
        payload = {
            "passed": [
                {"profile": p.as_dict(), "toxicology": r.as_dict()} for p, r in passed
            ],
            "failed": [r.as_dict() for r in failed],
            "n_passed": len(passed),
            "n_failed": len(failed),
        }
        text = json.dumps(payload, indent=2, sort_keys=True)
        if args.out:
            args.out.write_text(text + "\n", encoding="utf-8")
            print(f"Wrote {args.out}")
        if args.json:
            print(text)
        else:
            print(f"tox-gate: passed={len(passed)} failed={len(failed)}")
            for _, report in passed[:5]:
                print(
                    f"  PASS {report.compound_id} safety={report.safety_index:.2f} "
                    f"tox={report.toxicity_index:.2f}"
                )
            for report in failed[:5]:
                print(
                    f"  FAIL {report.compound_id} safety={report.safety_index:.2f} "
                    f"reason={report.gate_reason[:60]}"
                )
        return 0

    if not args.smiles:
        print("Provide --smiles or --from-library N (or --self-test)", file=sys.stderr)
        return 2

    profile = profile_from_smiles(
        args.smiles, compound_id=args.compound_id, logger=logger
    )
    report = evaluate_compound(profile, logger=logger)
    if args.out:
        args.out.write_text(report.to_json() + "\n", encoding="utf-8")
        print(f"Wrote {args.out}")
    if args.json:
        print(report.to_json())
    else:
        print_report(report)
    return 0 if report.gate_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
