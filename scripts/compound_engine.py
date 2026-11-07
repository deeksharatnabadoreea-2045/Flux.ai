#!/usr/bin/env python3
"""Molecular compound generation and screening for Flux.ai.

Produces candidate structures as simplified SMILES strings plus property
vectors, screens them for Lipinski Rule-of-Five drug-likeness and preliminary
toxicity alerts, and emits profiles that plug directly into
``cellular_model`` / ``virtual_cohort`` (dose + physiology modifiers).

Every generation, mutation, screen, and downstream trial hook is appended to a
JSONL log so the meta-agent can attribute safer / more effective outcomes to
specific chemical changes.

This is an *in-silico toy* — not a chemistry engine. Property estimates are
heuristic atom/fragment counts over SMILES text (no RDKit required).

Example::

    python3 scripts/compound_engine.py --n 20 --seed 7
    python3 scripts/compound_engine.py --self-test
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from cellular_model import PhysiologicalParams  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
DEFAULT_LOG = REPO_ROOT / ".flux" / "compound_mutation_history.log"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class CompoundLogger:
    """Append-only JSONL history of chemical mutations and screen results."""

    def __init__(self, log_path: Path = DEFAULT_LOG) -> None:
        self.log_path = Path(log_path)

    def record(self, action: str, **payload: Any) -> dict[str, Any]:
        entry = {"timestamp": _utc_now(), "action": action, **payload}
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")
        return entry

    def read_entries(self) -> list[dict[str, Any]]:
        if not self.log_path.is_file():
            return []
        entries: list[dict[str, Any]] = []
        for line in self.log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            entries.append(json.loads(line))
        return entries


# ---------------------------------------------------------------------------
# Simplified SMILES property estimation
# ---------------------------------------------------------------------------

# Very rough elemental masses used for MW estimates from SMILES tokens.
_ATOM_MASS = {
    "C": 12.01,
    "N": 14.01,
    "O": 16.00,
    "S": 32.06,
    "P": 30.97,
    "F": 19.00,
    "Cl": 35.45,
    "Br": 79.90,
    "I": 126.90,
    "H": 1.008,
    "B": 10.81,
}

# Fragment contributions for a crude cLogP estimate.
_LOGP_FRAG = {
    "C": 0.39,
    "N": -0.55,
    "O": -0.44,
    "S": 0.20,
    "F": 0.25,
    "Cl": 0.71,
    "Br": 0.86,
    "I": 1.12,
    "aromatic_ring": 0.15,
    "amide": -0.70,
    "nitro": -0.30,
}

# Substring / regex alerts (toy structural toxicophores).
_TOX_ALERTS: list[tuple[str, re.Pattern[str], str]] = [
    ("nitro_aromatic", re.compile(r"N\(=O\)=O|\[N\+\]\(=O\)\[O-\]"), "Nitro group"),
    ("aniline", re.compile(r"c1ccc\(N"), "Aniline-like aryl amine"),
    ("michael_acceptor", re.compile(r"C=CC\(=O\)"), "Michael acceptor (enone)"),
    ("alkyl_halide", re.compile(r"C(Cl|Br|I)|C\(Cl\)|C\(Br\)|C\(I\)"), "Reactive alkyl halide"),
    ("hydrazine", re.compile(r"NN|N\(N"), "Hydrazine motif"),
    ("epoxide", re.compile(r"C1OC1"), "Epoxide"),
    ("thiocarbonyl", re.compile(r"C\(=S\)"), "Thiocarbonyl"),
]


@dataclass(frozen=True)
class MolecularProperties:
    """Estimated physicochemical / structural property vector."""

    smiles: str
    molecular_weight: float
    logp: float
    hbd: int  # hydrogen-bond donors
    hba: int  # hydrogen-bond acceptors
    rotatable_bonds: int
    aromatic_rings: int
    atom_counts: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ScreenResult:
    lipinski_pass: bool
    lipinski_violations: list[str]
    toxicity_alerts: list[str]
    druglikeness_score: float  # 0..1
    safety_score: float  # 0..1

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _tokenize_atoms(smiles: str) -> list[str]:
    """Pull organic atom symbols from a simplified SMILES string."""
    # Bracket atoms first, then two-letter halogens, then singles.
    tokens: list[str] = []
    i = 0
    s = smiles
    while i < len(s):
        if s[i] == "[":
            end = s.find("]", i)
            if end < 0:
                break
            inner = re.sub(r"[^A-Za-z]", "", s[i + 1 : end])
            # Keep element letters only (drop isotope digits / charges already stripped).
            m = re.match(r"[A-Z][a-z]?", inner)
            if m:
                tokens.append(m.group(0))
            i = end + 1
            continue
        if s[i : i + 2] in ("Cl", "Br"):
            tokens.append(s[i : i + 2])
            i += 2
            continue
        if s[i] in "CNOPSFIBH":
            tokens.append(s[i])
            i += 1
            continue
        if s[i] in "cnops":  # aromatic lowercase
            tokens.append(s[i].upper())
            i += 1
            continue
        i += 1
    return tokens


def estimate_properties(smiles: str) -> MolecularProperties:
    """Heuristic property vector from a simplified SMILES string."""
    if not smiles or not smiles.strip():
        raise ValueError("smiles must be non-empty")
    atoms = _tokenize_atoms(smiles)
    counts: dict[str, int] = {}
    for atom in atoms:
        counts[atom] = counts.get(atom, 0) + 1

    mw = sum(_ATOM_MASS.get(a, 12.0) * n for a, n in counts.items())
    # Implicit hydrogens: very rough saturation pad for donor estimates.
    aromatic_rings = len(re.findall(r"c1", smiles)) + smiles.count("c1ccccc1") // 1
    # Prefer counting lowercase aromatic ring digits loosely.
    aromatic_rings = max(aromatic_rings, len(re.findall(r"[a-z]1", smiles)))

    logp = 0.0
    for atom, n in counts.items():
        logp += _LOGP_FRAG.get(atom, 0.0) * n
    logp += _LOGP_FRAG["aromatic_ring"] * aromatic_rings
    if "C(=O)N" in smiles or "NC(=O)" in smiles:
        logp += _LOGP_FRAG["amide"]
    if "N(=O)=O" in smiles or "[N+](=O)[O-]" in smiles:
        logp += _LOGP_FRAG["nitro"]

    # Donors: OH + NH patterns; acceptors: N + O counts.
    hbd = len(re.findall(r"O[H\)]|OH|N[H\)]|NH", smiles))
    # Fallback donor estimate from oxygen/nitrogen with explicit H hints.
    if hbd == 0:
        hbd = smiles.count("O")  # treat alcohols/phenols loosely when OH omitted
        hbd = min(hbd, counts.get("O", 0))
    hba = counts.get("N", 0) + counts.get("O", 0)
    rotatable = smiles.count("C")  # crude; penalize rings
    rotatable = max(0, rotatable - 4 * max(aromatic_rings, 1) // 1)
    rotatable = min(rotatable, 15)

    return MolecularProperties(
        smiles=smiles,
        molecular_weight=round(mw, 2),
        logp=round(logp, 3),
        hbd=int(hbd),
        hba=int(hba),
        rotatable_bonds=int(rotatable),
        aromatic_rings=int(aromatic_rings),
        atom_counts=counts,
    )


def screen_druglikeness(props: MolecularProperties) -> ScreenResult:
    """Lipinski Ro5 + preliminary toxicity alerts."""
    violations: list[str] = []
    if props.molecular_weight > 500:
        violations.append(f"MW>{500} ({props.molecular_weight:.1f})")
    if props.logp > 5:
        violations.append(f"logP>{5} ({props.logp:.2f})")
    if props.hbd > 5:
        violations.append(f"HBD>{5} ({props.hbd})")
    if props.hba > 10:
        violations.append(f"HBA>{10} ({props.hba})")

    alerts: list[str] = []
    for name, pattern, label in _TOX_ALERTS:
        if pattern.search(props.smiles):
            alerts.append(f"{name}:{label}")

    # Scores in [0, 1]
    druglikeness = max(0.0, 1.0 - 0.25 * len(violations))
    # Soft penalties for near-misses
    if props.molecular_weight > 450:
        druglikeness -= 0.05
    if props.logp > 4.5:
        druglikeness -= 0.05
    druglikeness = max(0.0, min(1.0, druglikeness))

    safety = max(0.0, 1.0 - 0.22 * len(alerts))
    return ScreenResult(
        lipinski_pass=len(violations) == 0,
        lipinski_violations=violations,
        toxicity_alerts=alerts,
        druglikeness_score=round(druglikeness, 4),
        safety_score=round(safety, 4),
    )


# ---------------------------------------------------------------------------
# Generator / mutations
# ---------------------------------------------------------------------------

# Scaffold library — simplified drug-like SMILES (toy structures).
_SCAFFOLDS = [
    "CCO",  # ethanol — too small, useful negative control
    "CC(=O)Oc1ccccc1C(=O)O",  # aspirin-like
    "CC(C)Cc1ccc(cc1)C(C)C(=O)O",  # ibuprofen-like
    "CN1C=NC2=C1C(=O)N(C(=O)N2C)C",  # caffeine-like
    "c1ccc(cc1)CCN",  # phenethylamine-like
    "CC(=O)Nc1ccc(O)cc1",  # acetaminophen-like
    "c1ccc2c(c1)cc(c(=O)o2)O",  # coumarin-like
    "NC(=O)c1ccccc1",  # benzamide
    "COc1ccc(CCN)cc1",  # methoxy-phenethylamine
    "CC1=C(C(=O)N)C=CC=C1",  # toluamide-like
    "c1ccc(cc1)N(=O)=O",  # nitrobenzene — tox alert
    "C=CC(=O)c1ccccc1",  # chalcone-like Michael acceptor
    "ClCCOc1ccccc1",  # alkyl halide tox alert
    "c1ccc(cc1)C(=O)NCc2ccccc2",  # benzamide-benzyl
    "CC(C)NCC(O)c1ccc(O)c(CO)c1",  # salbutamol-like
]

_MUTATIONS = [
    ("add_methyl", lambda s: s + "C"),
    ("add_hydroxy", lambda s: s + "O"),
    ("add_fluoro", lambda s: s.replace("c1ccccc1", "c1ccc(F)cc1", 1) if "c1ccccc1" in s else s + "F"),
    ("add_amide", lambda s: s + "C(=O)N"),
    ("add_nitro", lambda s: s + "N(=O)=O"),
    ("add_michael", lambda s: "C=CC(=O)" + s),
    ("strip_tail", lambda s: s[:-1] if len(s) > 6 else s),
]


@dataclass
class CompoundProfile:
    """Screened compound ready for cellular_model / virtual_cohort."""

    compound_id: str
    smiles: str
    properties: MolecularProperties
    screen: ScreenResult
    # Bridge fields consumed by PK/PD + cohort layers
    recommended_dose_mg: float
    potency_scale: float  # multiplies patient cell_sensitivity
    safety_scale: float  # multiplies patient toxicity_threshold
    parent_id: str | None = None
    mutation: str | None = None
    generation: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "compound_id": self.compound_id,
            "smiles": self.smiles,
            "properties": self.properties.as_dict(),
            "screen": self.screen.as_dict(),
            "recommended_dose_mg": self.recommended_dose_mg,
            "potency_scale": self.potency_scale,
            "safety_scale": self.safety_scale,
            "parent_id": self.parent_id,
            "mutation": self.mutation,
            "generation": self.generation,
            # Explicit bundle for virtual_cohort / trial_outcomes callers
            "simulation_inputs": self.simulation_inputs(),
        }

    def simulation_inputs(self) -> dict[str, Any]:
        """Payload automatically feedable into cellular_model / virtual_cohort."""
        return {
            "dose_mg": self.recommended_dose_mg,
            "potency_scale": self.potency_scale,
            "safety_scale": self.safety_scale,
            "compound_id": self.compound_id,
            "smiles": self.smiles,
            "lipinski_pass": self.screen.lipinski_pass,
            "toxicity_alert_count": len(self.screen.toxicity_alerts),
        }


def _dose_from_properties(props: MolecularProperties, screen: ScreenResult) -> float:
    """Map size / polarity to a starting IV bolus dose (mg)."""
    # Smaller / more potent-looking → lower dose; heavy / lipophilic → higher.
    base = 180.0
    base *= 250.0 / max(props.molecular_weight, 50.0)
    base *= 1.0 + max(0.0, props.logp) * 0.08
    if not screen.lipinski_pass:
        base *= 0.75
    return round(max(25.0, min(600.0, base)), 1)


def _scales_from_screen(props: MolecularProperties, screen: ScreenResult) -> tuple[float, float]:
    """Derive potency/safety multipliers for PhysiologicalParams."""
    # Potency: favor moderate MW + aromatic content + good druglikeness.
    potency = 0.65 + 0.35 * screen.druglikeness_score
    potency += min(0.25, 0.05 * props.aromatic_rings)
    if props.molecular_weight < 150:
        potency *= 0.7
    potency = max(0.25, min(1.8, potency))

    # Safety: penalize alerts and high logP / MW.
    safety = 0.55 + 0.45 * screen.safety_score
    if props.logp > 4:
        safety *= 0.9
    if props.molecular_weight > 450:
        safety *= 0.92
    safety = max(0.25, min(1.5, safety))
    return round(potency, 4), round(safety, 4)


def profile_from_smiles(
    smiles: str,
    *,
    compound_id: str,
    parent_id: str | None = None,
    mutation: str | None = None,
    generation: int = 0,
    logger: CompoundLogger | None = None,
) -> CompoundProfile:
    props = estimate_properties(smiles)
    screen = screen_druglikeness(props)
    dose = _dose_from_properties(props, screen)
    potency, safety = _scales_from_screen(props, screen)
    profile = CompoundProfile(
        compound_id=compound_id,
        smiles=smiles,
        properties=props,
        screen=screen,
        recommended_dose_mg=dose,
        potency_scale=potency,
        safety_scale=safety,
        parent_id=parent_id,
        mutation=mutation,
        generation=generation,
    )
    if logger is not None:
        logger.record(
            "screen",
            compound_id=compound_id,
            parent_id=parent_id,
            mutation=mutation,
            smiles=smiles,
            lipinski_pass=screen.lipinski_pass,
            toxicity_alerts=screen.toxicity_alerts,
            druglikeness_score=screen.druglikeness_score,
            safety_score=screen.safety_score,
            recommended_dose_mg=dose,
            potency_scale=potency,
            safety_scale=safety,
            generation=generation,
        )
    return profile


def generate_candidates(
    n: int,
    *,
    seed: int = 0,
    logger: CompoundLogger | None = None,
    id_prefix: str = "CMP",
) -> list[CompoundProfile]:
    """Produce ``n`` screened candidates from scaffolds + random mutations."""
    if n <= 0:
        raise ValueError("n must be > 0")
    rng = random.Random(seed)
    logger = logger or CompoundLogger()
    profiles: list[CompoundProfile] = []

    for i in range(n):
        smiles = rng.choice(_SCAFFOLDS)
        mutation_name = None
        parent_id = None
        generation = 0
        # ~60% of library are mutated offspring for chemical diversity.
        if rng.random() < 0.6:
            mutation_name, mut_fn = rng.choice(_MUTATIONS)
            parent_smiles = smiles
            smiles = mut_fn(smiles)
            parent_id = f"{id_prefix}-parent-{abs(hash(parent_smiles)) % 10_000:04d}"
            generation = 1
            logger.record(
                "mutate",
                parent_smiles=parent_smiles,
                child_smiles=smiles,
                mutation=mutation_name,
                parent_id=parent_id,
            )
        cid = f"{id_prefix}-{seed:04d}-{i + 1:03d}"
        logger.record("generate", compound_id=cid, smiles=smiles, seed=seed)
        profiles.append(
            profile_from_smiles(
                smiles,
                compound_id=cid,
                parent_id=parent_id,
                mutation=mutation_name,
                generation=generation,
                logger=logger,
            )
        )
    return profiles


def mutate_compound(
    profile: CompoundProfile,
    *,
    mutation_name: str | None = None,
    seed: int = 0,
    logger: CompoundLogger | None = None,
    id_prefix: str = "CMP",
) -> CompoundProfile:
    """Apply one chemical mutation and re-screen (meta-agent step)."""
    rng = random.Random(seed)
    logger = logger or CompoundLogger()
    if mutation_name is None:
        mutation_name, mut_fn = rng.choice(_MUTATIONS)
    else:
        lookup = {name: fn for name, fn in _MUTATIONS}
        if mutation_name not in lookup:
            raise ValueError(f"unknown mutation: {mutation_name}")
        mut_fn = lookup[mutation_name]
    child_smiles = mut_fn(profile.smiles)
    child_id = f"{id_prefix}-mut-{abs(hash(child_smiles + profile.compound_id)) % 100_000:05d}"
    logger.record(
        "mutate",
        parent_id=profile.compound_id,
        parent_smiles=profile.smiles,
        child_smiles=child_smiles,
        mutation=mutation_name,
        child_id=child_id,
    )
    return profile_from_smiles(
        child_smiles,
        compound_id=child_id,
        parent_id=profile.compound_id,
        mutation=mutation_name,
        generation=profile.generation + 1,
        logger=logger,
    )


# ---------------------------------------------------------------------------
# Bridge → cellular_model / virtual_cohort
# ---------------------------------------------------------------------------


def apply_compound_to_params(
    params: PhysiologicalParams,
    profile: CompoundProfile,
) -> PhysiologicalParams:
    """Return patient params modulated by compound potency / safety scales."""
    return replace(
        params,
        cell_sensitivity=max(0.01, params.cell_sensitivity * profile.potency_scale),
        toxicity_threshold=max(0.5, params.toxicity_threshold * profile.safety_scale),
    )


def screened_for_cohort(
    profiles: Sequence[CompoundProfile],
    *,
    require_lipinski: bool = True,
    max_alerts: int = 0,
) -> list[CompoundProfile]:
    """Filter profiles suitable as automatic virtual_cohort inputs."""
    kept: list[CompoundProfile] = []
    for profile in profiles:
        if require_lipinski and not profile.screen.lipinski_pass:
            continue
        if len(profile.screen.toxicity_alerts) > max_alerts:
            continue
        kept.append(profile)
    return kept


def record_trial_outcome_link(
    logger: CompoundLogger,
    *,
    compound_id: str,
    trial_id: str | None,
    overall_passed: bool | None,
    overall_success_probability: float | None,
    risk_benefit_ratio: float | None,
    notes: str = "",
) -> dict[str, Any]:
    """Log linkage from a chemical candidate to a trial_outcomes report."""
    return logger.record(
        "trial_outcome_link",
        compound_id=compound_id,
        trial_id=trial_id,
        overall_passed=overall_passed,
        overall_success_probability=overall_success_probability,
        risk_benefit_ratio=risk_benefit_ratio,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# CLI / self-test
# ---------------------------------------------------------------------------


def print_profiles(profiles: Sequence[CompoundProfile]) -> None:
    print(f"\nScreened compounds: {len(profiles)}")
    print("-" * 72)
    for p in profiles:
        alerts = len(p.screen.toxicity_alerts)
        print(
            f"{p.compound_id:18} lipinski={str(p.screen.lipinski_pass):5} "
            f"alerts={alerts} dose={p.recommended_dose_mg:6.1f} mg  "
            f"potency={p.potency_scale:.2f} safety={p.safety_scale:.2f}  "
            f"SMILES={p.smiles[:40]}"
        )
    print("-" * 72)


def run_self_test() -> int:
    from cellular_model import simulate_dose
    from virtual_cohort import generate_cohort, run_cohort

    log_path = Path("/tmp/flux-compound-engine-test.log")
    if log_path.exists():
        log_path.unlink()
    logger = CompoundLogger(log_path)

    # Aspirin-like should pass Lipinski; nitrobenzene should alert.
    aspirin = profile_from_smiles(
        "CC(=O)Oc1ccccc1C(=O)O",
        compound_id="TEST-ASA",
        logger=logger,
    )
    nitro = profile_from_smiles(
        "c1ccc(cc1)N(=O)=O",
        compound_id="TEST-NO2",
        logger=logger,
    )
    if not aspirin.screen.lipinski_pass:
        print("FAIL: aspirin-like should pass Lipinski", file=sys.stderr)
        return 1
    if not nitro.screen.toxicity_alerts:
        print("FAIL: nitrobenzene should raise toxicity alerts", file=sys.stderr)
        return 1

    # Generator + filter
    library = generate_candidates(24, seed=3, logger=logger)
    kept = screened_for_cohort(library, require_lipinski=True, max_alerts=0)
    if not library:
        print("FAIL: empty library", file=sys.stderr)
        return 1
    if any(not p.screen.lipinski_pass for p in kept):
        print("FAIL: filter leaked Lipinski failures", file=sys.stderr)
        return 1

    # Bridge into cellular_model
    base = PhysiologicalParams()
    modulated = apply_compound_to_params(base, aspirin)
    if modulated.cell_sensitivity == base.cell_sensitivity and aspirin.potency_scale != 1.0:
        print("FAIL: potency_scale did not modulate cell_sensitivity", file=sys.stderr)
        return 1
    sim = simulate_dose(aspirin.recommended_dose_mg, modulated)
    if sim.dose_mg != aspirin.recommended_dose_mg:
        print("FAIL: dose bridge mismatch", file=sys.stderr)
        return 1

    # Bridge into virtual_cohort with compound dose
    if kept:
        lead = kept[0]
        cohort = generate_cohort(12, seed=1)
        # Apply compound modifiers uniformly across the cohort.
        from virtual_cohort import VirtualPatient

        adjusted = [
            VirtualPatient(
                patient_id=p.patient_id,
                params=apply_compound_to_params(p.params, lead),
                covariates={**p.covariates, "compound_id": lead.compound_id},
            )
            for p in cohort
        ]
        bench = run_cohort(lead.recommended_dose_mg, adjusted, seed=1)
        record_trial_outcome_link(
            logger,
            compound_id=lead.compound_id,
            trial_id="self-test-cohort",
            overall_passed=bench.therapeutic_success_rate > 0.2,
            overall_success_probability=bench.therapeutic_success_rate,
            risk_benefit_ratio=bench.success_rate / (bench.toxicity_breach_rate + 0.05),
            notes="virtual_cohort bridge smoke test",
        )
        if bench.n_patients != 12:
            print("FAIL: cohort size", file=sys.stderr)
            return 1

    # Mutation tracking
    child = mutate_compound(aspirin, mutation_name="add_methyl", seed=0, logger=logger)
    if child.parent_id != aspirin.compound_id or child.mutation != "add_methyl":
        print("FAIL: mutation lineage not recorded on profile", file=sys.stderr)
        return 1

    entries = logger.read_entries()
    actions = {e["action"] for e in entries}
    required = {"generate", "screen", "mutate", "trial_outcome_link"}
    # generate may only appear from generate_candidates; ensure screen+mutate present
    if "screen" not in actions or "mutate" not in actions:
        print(f"FAIL: log missing actions, have={sorted(actions)}", file=sys.stderr)
        return 1
    if "trial_outcome_link" not in actions:
        print("FAIL: missing trial_outcome_link in log", file=sys.stderr)
        return 1

    print("compound_engine self-test: ok")
    print(
        f"  library={len(library)} kept={len(kept)} "
        f"asa_dose={aspirin.recommended_dose_mg} "
        f"log_entries={len(entries)} actions={sorted(actions)}"
    )
    # Silence unused warning if required partially unused in edge paths
    _ = required
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=16, help="Candidates to generate")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="Mutation history log (default: <repo>/.flux/compound_mutation_history.log)",
    )
    parser.add_argument(
        "--require-lipinski",
        action="store_true",
        help="Only print/keep Lipinski-passing compounds",
    )
    parser.add_argument(
        "--max-alerts",
        type=int,
        default=99,
        help="Max toxicity alerts allowed when filtering (with --require-lipinski)",
    )
    parser.add_argument("--json", action="store_true", help="Emit profiles as JSON")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()

    logger = CompoundLogger(args.log or DEFAULT_LOG)
    profiles = generate_candidates(args.n, seed=args.seed, logger=logger)
    if args.require_lipinski:
        profiles = screened_for_cohort(
            profiles,
            require_lipinski=True,
            max_alerts=args.max_alerts,
        )

    if args.json:
        print(json.dumps([p.as_dict() for p in profiles], indent=2, sort_keys=True))
    else:
        print_profiles(profiles)
        print(f"log: {logger.log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
