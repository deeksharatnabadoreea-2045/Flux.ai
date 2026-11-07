#!/usr/bin/env python3
"""Outer recursive meta-loop for Flux.ai SeedAgent self-improvement.

Coordinates:
  1. Read `seed_agent.py`
  2. Run `evaluate_agent.py` for PASS/FAIL + SCORE + logs
  3. On FAIL, ask OpenRouter for a full-file mutation that fixes the failure
  4. Apply the patch, re-evaluate, and retain the change only if the score
     improves or the harness PASSes; otherwise revert
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_SEED = SCRIPTS_DIR / "seed_agent.py"
DEFAULT_EVAL = SCRIPTS_DIR / "evaluate_agent.py"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")


@dataclass
class HarnessScore:
    passed: bool
    points: int
    max_points: int
    score: float
    logs: str
    returncode: int

    @property
    def result_label(self) -> str:
        return "PASS" if self.passed else "FAIL"


def read_seed_source(seed_path: Path) -> str:
    """Requirement (2): read the current source of seed_agent.py."""
    return seed_path.read_text(encoding="utf-8")


def run_evaluate_agent(
    eval_script: Path,
    *,
    cwd: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> HarnessScore:
    """Requirement (3): run evaluate_agent.py and parse PASS/FAIL + SCORE."""
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    # Ensure the eval process imports the seed_agent next to the eval script.
    scripts_dir = str(eval_script.resolve().parent)
    env["PYTHONPATH"] = os.pathsep.join(
        [scripts_dir, env["PYTHONPATH"]] if env.get("PYTHONPATH") else [scripts_dir]
    )

    completed = subprocess.run(
        [sys.executable, str(eval_script)],
        capture_output=True,
        text=True,
        cwd=str(cwd or eval_script.resolve().parent.parent),
        env=env,
        timeout=180,
    )
    output = (completed.stdout or "") + (
        f"\n----- stderr -----\n{completed.stderr}" if completed.stderr else ""
    )

    passed = bool(re.search(r"^RESULT:\s*PASS\s*$", output, re.M))
    failed = bool(re.search(r"^RESULT:\s*FAIL\s*$", output, re.M))
    if not passed and not failed:
        # Treat malformed/crash output as a hard fail.
        passed = False

    score_match = re.search(
        r"^SCORE:\s*(\d+)\s*/\s*(\d+)\s*\(([0-9.]+)\)\s*$", output, re.M
    )
    if score_match:
        points = int(score_match.group(1))
        max_points = int(score_match.group(2))
        score = float(score_match.group(3))
    else:
        points = 4 if passed else 0
        max_points = 4
        score = 1.0 if passed else 0.0

    return HarnessScore(
        passed=passed,
        points=points,
        max_points=max_points,
        score=score,
        logs=output,
        returncode=completed.returncode,
    )


def _parse_json_object(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def request_openrouter_mutation(
    *,
    source: str,
    eval_logs: str,
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
    api_base: str = OPENROUTER_URL,
) -> tuple[str, str]:
    """Requirement (4): ask OpenRouter for a repaired seed_agent.py source.

    Returns (rationale, updated_source).
    """
    key = api_key or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Export a key, or use --self-test / "
            "--mutator mock."
        )

    system = (
        "You repair a Python coding agent named SeedAgent. "
        "Respond with a single JSON object only — no markdown fences, no prose. "
        'Schema: {"rationale": string, "updated_source": string}. '
        "updated_source must be the COMPLETE new contents of seed_agent.py. "
        "Preserve the four tools (read_file, write_file, list_directory, run_python), "
        "SeedAgent, use_workspace, cellular_growth_planner_factory, and the CLI. "
        "Fix only what the evaluation failure requires."
    )
    user = (
        "The evaluation harness FAILED for the current seed_agent.py.\n\n"
        "----- evaluation logs -----\n"
        f"{eval_logs[-12000:]}\n\n"
        "----- current seed_agent.py -----\n"
        f"{source}\n"
    )
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        api_base,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/flux-ai",
            "X-Title": "Flux.ai SeedAgent meta-loop",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter HTTP {exc.code}: {detail}") from exc

    content = body["choices"][0]["message"]["content"]
    data = _parse_json_object(content)
    updated = data.get("updated_source")
    if not isinstance(updated, str) or not updated.strip():
        raise RuntimeError("OpenRouter response missing updated_source")
    rationale = str(data.get("rationale", "")).strip() or "(no rationale)"
    return rationale, updated


Mutator = Callable[[str, str], tuple[str, str]]


def apply_with_retention(
    seed_path: Path,
    mutated_source: str,
    *,
    baseline: HarnessScore,
    eval_script: Path,
    cwd: Path | None = None,
) -> tuple[bool, HarnessScore, str]:
    """Requirement (5): apply patch, re-eval, keep only if score improves/passes.

    Returns (retained, new_score, decision_message).
    """
    backup = seed_path.read_text(encoding="utf-8")
    seed_path.write_text(mutated_source, encoding="utf-8")
    try:
        # Bytecode can otherwise mask the on-disk mutation inside the same run.
        for stale in seed_path.parent.glob("__pycache__/seed_agent*.pyc"):
            stale.unlink(missing_ok=True)

        new_score = run_evaluate_agent(eval_script, cwd=cwd)
        improved = new_score.passed or new_score.score > baseline.score
        if improved:
            msg = (
                f"RETENTION: KEEP "
                f"(score {baseline.score:.2f} → {new_score.score:.2f}, "
                f"{new_score.result_label})"
            )
            return True, new_score, msg

        seed_path.write_text(backup, encoding="utf-8")
        msg = (
            f"RETENTION: REVERT "
            f"(score {baseline.score:.2f} → {new_score.score:.2f}, "
            f"{new_score.result_label})"
        )
        return False, new_score, msg
    except Exception:
        seed_path.write_text(backup, encoding="utf-8")
        raise


def meta_loop(
    *,
    seed_path: Path = DEFAULT_SEED,
    eval_script: Path = DEFAULT_EVAL,
    max_iters: int = 5,
    mutator: Mutator | None = None,
    model: str = DEFAULT_MODEL,
    cwd: Path | None = None,
) -> int:
    """Requirement (1): outer recursive loop coordinating SeedAgent + Evaluator."""
    if mutator is None:

        def mutator(source: str, logs: str) -> tuple[str, str]:
            return request_openrouter_mutation(
                source=source, eval_logs=logs, model=model
            )

    print("Flux.ai meta-loop")
    print(f"  seed: {seed_path}")
    print(f"  eval: {eval_script}")
    print(f"  max_iters: {max_iters}\n")

    for iteration in range(1, max_iters + 1):
        print(f"{'=' * 60}\nIteration {iteration}/{max_iters}\n{'=' * 60}")
        source = read_seed_source(seed_path)
        print(f"Read seed_agent.py ({len(source)} bytes)")

        score = run_evaluate_agent(eval_script, cwd=cwd)
        print(
            f"Evaluation: {score.result_label} "
            f"SCORE {score.points}/{score.max_points} ({score.score:.2f})"
        )
        print("----- evaluator output (truncated) -----")
        print(score.logs[-4000:])

        if score.passed:
            print("\nMeta-loop complete: evaluation PASS — no mutation needed.")
            return 0

        print("\nFAIL observed — requesting mutation…")
        rationale, mutated = mutator(source, score.logs)
        print(f"Mutation rationale: {rationale}")
        print(f"Mutated source size: {len(mutated)} bytes")

        retained, new_score, decision = apply_with_retention(
            seed_path,
            mutated,
            baseline=score,
            eval_script=eval_script,
            cwd=cwd,
        )
        print(decision)
        print(
            f"Post-mutation evaluation: {new_score.result_label} "
            f"SCORE {new_score.points}/{new_score.max_points} ({new_score.score:.2f})"
        )
        if retained and new_score.passed:
            print("\nMeta-loop complete: retained a passing mutation.")
            return 0

    print(f"\nMeta-loop stopped after {max_iters} iteration(s) without PASS.")
    return 1


# ---------------------------------------------------------------------------
# Offline self-test (no OpenRouter key required)
# ---------------------------------------------------------------------------

def _broken_seed_from(good_source: str) -> str:
    """Inject a deliberate planner bug that makes the cellular-growth eval fail."""
    old = (
        '"assert series == [1, 2, 4, 8, 16, 32], series\\n"\n'
        '                    "print(\'growth_ok\', series[-1])\\n"'
    )
    new = (
        '"assert series == [0, 0, 0], series\\n"\n'
        '                    "print(\'growth_bad\', series[-1])\\n"'
    )
    if old not in good_source:
        raise RuntimeError("cannot inject bug: expected planner assert block missing")
    broken = good_source.replace(old, new, 1)
    if broken == good_source:
        raise RuntimeError("bug injection failed to modify source")
    return broken


def run_self_test() -> int:
    """Exercise FAIL → mutate → retain/revert without calling OpenRouter."""
    good = read_seed_source(DEFAULT_SEED)
    broken = _broken_seed_from(good)

    with tempfile.TemporaryDirectory(prefix="flux-meta-loop-") as tmp:
        root = Path(tmp)
        scripts = root / "scripts"
        scripts.mkdir()
        shutil.copy2(DEFAULT_EVAL, scripts / "evaluate_agent.py")
        seed_path = scripts / "seed_agent.py"
        seed_path.write_text(broken, encoding="utf-8")
        # Shim so evaluate_agent's optional primitive_agent import path stays safe.
        (scripts / "primitive_agent.py").write_text(
            "from seed_agent import *  # noqa\n", encoding="utf-8"
        )

        print("Self-test A: mock mutator restores a fixing patch → expect KEEP/PASS")

        def fix_mutator(_source: str, _logs: str) -> tuple[str, str]:
            return "restore known-good seed_agent.py", good

        rc = meta_loop(
            seed_path=seed_path,
            eval_script=scripts / "evaluate_agent.py",
            max_iters=2,
            mutator=fix_mutator,
            cwd=root,
        )
        if rc != 0:
            print("self-test A failed: expected PASS after retention", file=sys.stderr)
            return 1
        if seed_path.read_text(encoding="utf-8") != good:
            print("self-test A failed: fixed source not retained", file=sys.stderr)
            return 1

        print("\nSelf-test B: mock mutator returns non-improving patch → expect REVERT")
        seed_path.write_text(broken, encoding="utf-8")
        baseline_before = seed_path.read_text(encoding="utf-8")

        def noop_mutator(source: str, _logs: str) -> tuple[str, str]:
            # Still broken — change a comment only so the file differs but score does not.
            return "noop", source + "\n# noop mutation\n"

        meta_loop(
            seed_path=seed_path,
            eval_script=scripts / "evaluate_agent.py",
            max_iters=1,
            mutator=noop_mutator,
            cwd=root,
        )
        if seed_path.read_text(encoding="utf-8") != baseline_before:
            print("self-test B failed: non-improving mutation was kept", file=sys.stderr)
            return 1

    print("\nmeta_loop self-test: ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--eval-script", type=Path, default=DEFAULT_EVAL)
    parser.add_argument("--max-iters", type=int, default=5)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run offline retention checks with a mock mutator (no API key)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        try:
            return run_self_test()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return 1
    try:
        return meta_loop(
            seed_path=args.seed,
            eval_script=args.eval_script,
            max_iters=args.max_iters,
            model=args.model,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"fatal: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
