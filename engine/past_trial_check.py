#!/usr/bin/env python3
"""Past-trial match/miss checker for Flux (science engine, step 1).

Plain English
-------------
We keep one finished real trial in a fixture file (what really happened).
We run our computer-trial guess, then print MATCH or MISS.

This does **not** claim our guess is good yet. It only proves we can score
a guess against a real past result.

Example::

    python3 -m engine.past_trial_check
    python3 -m engine.past_trial_check --json
    python3 -m engine.past_trial_check --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "past_trials"
DEFAULT_FIXTURE = FIXTURES_DIR / "nct00876395.json"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

ALLOWED_OUTCOMES = frozenset({"success", "fail"})

# Optional injectable for tests: fixture → "success" | "fail"
GuessFn = Callable[[Mapping[str, Any]], str]


@dataclass(frozen=True)
class CheckResult:
    """One fixture scored: actual vs guess → match or miss."""

    trial_id: str
    title: str
    actual_outcome: str
    guessed_outcome: str
    score: str  # "match" | "miss"
    source_url: str
    primary_endpoint: str
    guess_method: str
    notes: str = ""
    dossier_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def load_fixture(path: Path | str) -> dict[str, Any]:
    """Load and validate a past-trial fixture JSON file."""
    fixture_path = Path(path)
    raw = json.loads(fixture_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"fixture must be a JSON object: {fixture_path}")
    for key in ("trial_id", "actual_outcome", "primary_endpoint"):
        if key not in raw:
            raise ValueError(f"fixture missing {key!r}: {fixture_path}")
    outcome = str(raw["actual_outcome"]).strip().lower()
    if outcome not in ALLOWED_OUTCOMES:
        raise ValueError(
            f"actual_outcome must be success|fail, got {raw['actual_outcome']!r}"
        )
    raw = dict(raw)
    raw["actual_outcome"] = outcome
    raw["_path"] = str(fixture_path.resolve())
    return raw


def list_fixtures(directory: Path | None = None) -> list[Path]:
    """All ``*.json`` fixtures under the past_trials folder."""
    root = directory or FIXTURES_DIR
    return sorted(root.glob("*.json"))


def score_guess(actual_outcome: str, guessed_outcome: str) -> str:
    """Return ``match`` or ``miss`` for two success|fail labels."""
    actual = str(actual_outcome).strip().lower()
    guessed = str(guessed_outcome).strip().lower()
    if actual not in ALLOWED_OUTCOMES or guessed not in ALLOWED_OUTCOMES:
        raise ValueError("outcomes must be success|fail")
    return "match" if actual == guessed else "miss"


def outcome_from_dossier(dossier: Any) -> str:
    """Map a simulation dossier to success|fail.

    Uses the multi-phase trial ``overall_passed`` flag when present.
    If the cascade never reached a trial (for example tox blocked), that
    counts as fail — we did not clear a go path.
    """
    payload = dossier.as_dict() if hasattr(dossier, "as_dict") else dict(dossier)
    trial = payload.get("trial") or {}
    if trial.get("overall_passed") is True:
        return "success"
    return "fail"


def guess_with_simulation_pipeline(fixture: Mapping[str, Any]) -> tuple[str, str | None]:
    """Run the live simulation cascade and return (outcome, dossier_id)."""
    import simulation_pipeline as pipeline

    guess = dict(fixture.get("guess") or {})
    disease = str(guess.get("disease") or "oncology_solid")
    seed = int(guess.get("seed") or 0)
    target = pipeline.PipelineTarget(
        disease=disease,
        seed=seed,
        n_candidates=int(guess.get("n_candidates") or 6),
        cohort_n=int(guess.get("cohort_n") or 10),
        phase1_n=int(guess.get("phase1_n") or 4),
        phase2_n=int(guess.get("phase2_n") or 6),
        phase3_n=int(guess.get("phase3_n") or 12),
    )
    dossier = pipeline.run_simulation_pipeline(target)
    return outcome_from_dossier(dossier), getattr(dossier, "dossier_id", None)


def check_fixture(
    path: Path | str,
    *,
    guess_fn: GuessFn | None = None,
) -> CheckResult:
    """Score one fixture: load truth, guess, return match/miss."""
    fixture = load_fixture(path)
    dossier_id: str | None = None
    if guess_fn is not None:
        guessed = guess_fn(fixture)
        method = "injected"
    else:
        guessed, dossier_id = guess_with_simulation_pipeline(fixture)
        method = "simulation_pipeline"

    guessed = str(guessed).strip().lower()
    if guessed not in ALLOWED_OUTCOMES:
        raise ValueError(f"guess must be success|fail, got {guessed!r}")

    actual = fixture["actual_outcome"]
    return CheckResult(
        trial_id=str(fixture["trial_id"]),
        title=str(fixture.get("title") or fixture["trial_id"]),
        actual_outcome=actual,
        guessed_outcome=guessed,
        score=score_guess(actual, guessed),
        source_url=str(fixture.get("source_url") or ""),
        primary_endpoint=str(fixture["primary_endpoint"]),
        guess_method=method,
        notes=str(fixture.get("actual_notes") or fixture.get("notes") or ""),
        dossier_id=dossier_id,
    )


def print_result(result: CheckResult) -> None:
    """Human-readable MATCH / MISS report."""
    label = "MATCH" if result.score == "match" else "MISS"
    print()
    print(f"Past trial check  {result.trial_id}")
    print("=" * 56)
    print(f"title     : {result.title}")
    print(f"endpoint  : {result.primary_endpoint}")
    if result.source_url:
        print(f"source    : {result.source_url}")
    print(f"actual    : {result.actual_outcome}")
    print(f"guess     : {result.guessed_outcome}  ({result.guess_method})")
    if result.dossier_id:
        print(f"dossier   : {result.dossier_id}")
    print(f"score     : {label}")
    if result.notes:
        print(f"notes     : {result.notes}")
    print("=" * 56)
    print(
        "We only claim this score for this fixture. "
        "We do not claim computer trials replace real ones."
    )
    print()


def run_self_test() -> int:
    """Verify fixture load + match/miss scoring without claiming accuracy."""
    failures: list[str] = []

    if score_guess("fail", "fail") != "match":
        failures.append("fail/fail should match")
    if score_guess("success", "fail") != "miss":
        failures.append("success/fail should miss")
    if score_guess("fail", "success") != "miss":
        failures.append("fail/success should miss")

    fixture_path = DEFAULT_FIXTURE
    if not fixture_path.exists():
        failures.append(f"missing default fixture {fixture_path}")
        print("SELF-TEST FAIL:", "; ".join(failures))
        return 1

    fixture = load_fixture(fixture_path)
    if fixture["trial_id"] != "NCT00876395":
        failures.append("unexpected trial_id in default fixture")
    if fixture["actual_outcome"] != "fail":
        failures.append("BOLERO-1 fixture should be actual_outcome=fail")

    matched = check_fixture(
        fixture_path, guess_fn=lambda _f: "fail"
    )
    if matched.score != "match":
        failures.append("injected correct guess should MATCH")

    missed = check_fixture(
        fixture_path, guess_fn=lambda _f: "success"
    )
    if missed.score != "miss":
        failures.append("injected wrong guess should MISS")

    # Live pipeline once — harness must return a score; accuracy not required.
    live = check_fixture(fixture_path)
    if live.score not in {"match", "miss"}:
        failures.append("live check must return match|miss")
    if live.guessed_outcome not in ALLOWED_OUTCOMES:
        failures.append("live guess must be success|fail")
    print_result(live)

    if failures:
        print("SELF-TEST FAIL:")
        for item in failures:
            print(f"  - {item}")
        return 1

    print(
        f"SELF-TEST OK  fixture={fixture['trial_id']}  "
        f"live_score={live.score.upper()}  "
        f"(match not required for pass)"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score a computer-trial guess against one finished real trial."
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=DEFAULT_FIXTURE,
        help=f"past-trial JSON (default: {DEFAULT_FIXTURE.name})",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print CheckResult as JSON",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run harness self-test",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test()

    result = check_fixture(args.fixture)
    if args.json:
        print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
    else:
        print_result(result)
    # Exit 0 whenever the harness ran; MATCH/MISS is the report, not a crash.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
