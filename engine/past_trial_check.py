#!/usr/bin/env python3
"""Past-trial match/miss checker for Flux (science engine).

Plain English
-------------
We keep finished real trials in fixture files (what really happened).
We run our computer-trial guess for each, then print MATCH or MISS and a
simple hit rate (matches / total).

This does **not** claim our guesses are good yet. It only proves we can
score guesses against real past results.

Example::

    python3 -m engine.past_trial_check --all
    python3 -m engine.past_trial_check --fixture engine/fixtures/past_trials/nct01642004.json
    python3 -m engine.past_trial_check --all --json
    python3 -m engine.past_trial_check --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

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


@dataclass(frozen=True)
class HitRateReport:
    """Simple matches / total across one or more fixtures."""

    total: int
    matches: int
    misses: int
    hit_rate: float
    results: list[CheckResult] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "matches": self.matches,
            "misses": self.misses,
            "hit_rate": self.hit_rate,
            "results": [r.as_dict() for r in self.results],
        }


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


def hit_rate(results: Sequence[CheckResult]) -> HitRateReport:
    """Compute matches / total from scored fixtures."""
    total = len(results)
    matches = sum(1 for r in results if r.score == "match")
    misses = total - matches
    rate = (matches / total) if total else 0.0
    return HitRateReport(
        total=total,
        matches=matches,
        misses=misses,
        hit_rate=rate,
        results=list(results),
    )


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


def check_fixtures(
    paths: Sequence[Path | str],
    *,
    guess_fn: GuessFn | None = None,
) -> HitRateReport:
    """Score many fixtures and return a hit-rate report."""
    results = [check_fixture(path, guess_fn=guess_fn) for path in paths]
    return hit_rate(results)


def print_result(result: CheckResult) -> None:
    """Human-readable MATCH / MISS report for one trial."""
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


def print_hit_rate(report: HitRateReport) -> None:
    """Print each result plus matches / total."""
    for result in report.results:
        print_result(result)
    pct = 100.0 * report.hit_rate
    print()
    print("Hit rate")
    print("=" * 56)
    print(f"matches   : {report.matches}")
    print(f"misses    : {report.misses}")
    print(f"total     : {report.total}")
    print(f"hit rate  : {report.matches}/{report.total} ({pct:.0f}%)")
    print("=" * 56)
    print(
        "We only claim these scores for these fixtures. "
        "We do not claim computer trials replace real ones."
    )
    print()


def run_self_test() -> int:
    """Verify fixtures + match/miss + hit rate without claiming accuracy."""
    failures: list[str] = []

    if score_guess("fail", "fail") != "match":
        failures.append("fail/fail should match")
    if score_guess("success", "fail") != "miss":
        failures.append("success/fail should miss")
    if score_guess("fail", "success") != "miss":
        failures.append("fail/success should miss")

    fixtures = list_fixtures()
    if len(fixtures) < 2:
        failures.append(f"expected ≥2 fixtures, found {len(fixtures)}")
        print("SELF-TEST FAIL:", "; ".join(failures))
        return 1

    by_id = {load_fixture(p)["trial_id"]: load_fixture(p) for p in fixtures}
    if "NCT00876395" not in by_id or by_id["NCT00876395"]["actual_outcome"] != "fail":
        failures.append("BOLERO-1 fixture should be actual_outcome=fail")
    if "NCT01642004" not in by_id or by_id["NCT01642004"]["actual_outcome"] != "success":
        failures.append("CheckMate 017 fixture should be actual_outcome=success")

    # Injected guesses: one match, one miss → hit rate 1/2
    def inject(fixture: Mapping[str, Any]) -> str:
        # Always guess "fail" → match BOLERO-1, miss CheckMate 017
        return "fail"

    injected = check_fixtures(fixtures, guess_fn=inject)
    if injected.total != len(fixtures):
        failures.append("injected report total mismatch")
    if injected.matches != 1 or injected.misses != 1:
        failures.append(
            f"injected hit rate expected 1/2, got {injected.matches}/{injected.total}"
        )
    if abs(injected.hit_rate - 0.5) > 1e-9:
        failures.append("injected hit_rate should be 0.5")

    matched = check_fixture(DEFAULT_FIXTURE, guess_fn=lambda _f: "fail")
    if matched.score != "match":
        failures.append("injected correct guess should MATCH")

    # Live pipeline across all fixtures — harness must score; accuracy not required.
    live = check_fixtures(fixtures)
    if live.total != len(fixtures):
        failures.append("live report total mismatch")
    if not (0 <= live.matches <= live.total):
        failures.append("live matches out of range")
    for result in live.results:
        if result.score not in {"match", "miss"}:
            failures.append(f"{result.trial_id} missing match|miss")
        if result.guessed_outcome not in ALLOWED_OUTCOMES:
            failures.append(f"{result.trial_id} bad guess label")
    print_hit_rate(live)

    if failures:
        print("SELF-TEST FAIL:")
        for item in failures:
            print(f"  - {item}")
        return 1

    print(
        f"SELF-TEST OK  fixtures={live.total}  "
        f"live_hit_rate={live.matches}/{live.total}  "
        f"(hit rate not required for pass)"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score computer-trial guesses against finished real trials."
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=None,
        help="score only this past-trial JSON (default: all fixtures + hit rate)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="score every fixture and print hit rate (default when --fixture omitted)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print JSON (CheckResult or HitRateReport)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run harness self-test",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test()

    # One fixture only when --fixture is set and --all is not.
    if args.fixture is not None and not args.all:
        result = check_fixture(args.fixture)
        if args.json:
            print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
        else:
            print_result(result)
            print(
                "We only claim this score for this fixture. "
                "We do not claim computer trials replace real ones."
            )
            print()
        return 0

    paths = list_fixtures()
    if not paths:
        print(f"No fixtures found under {FIXTURES_DIR}", file=sys.stderr)
        return 1
    report = check_fixtures(paths)
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    else:
        print_hit_rate(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
