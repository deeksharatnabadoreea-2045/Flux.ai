#!/usr/bin/env python3
"""Evaluate SeedAgent on a Flux.ai coding benchmark.

Runs the agent in an isolated temporary workspace against a mock cellular
growth objective, then asserts that tools were used to create and execute the
script without errors. Prints a clear PASS or FAIL with execution logs.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import traceback
from dataclasses import dataclass, field
from pathlib import Path

# Allow `python3 scripts/evaluate_agent.py` from the repo root.
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from primitive_agent import (  # noqa: E402
    SeedAgent,
    cellular_growth_planner_factory,
)


CELLULAR_GROWTH_OBJECTIVE = (
    "Create cellular_growth.py implementing simulate_growth(initial_cells, "
    "doublings) for a mock exponential cellular growth model. Include a "
    "__main__ self-check that asserts simulate_growth(1, 5) == "
    "[1, 2, 4, 8, 16, 32], then execute the script with run_python and confirm "
    "it finishes without errors."
)

TARGET_FILE = "cellular_growth.py"


@dataclass
class AssertionResult:
    name: str
    passed: bool
    detail: str


@dataclass
class EvalResult:
    passed: bool
    assertions: list[AssertionResult] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)
    answer: str = ""
    error: str | None = None

    def summary_lines(self) -> list[str]:
        lines = ["", "=" * 60]
        for assertion in self.assertions:
            mark = "PASS" if assertion.passed else "FAIL"
            lines.append(f"  [{mark}] {assertion.name}: {assertion.detail}")
        lines.append("=" * 60)
        if self.error:
            lines.append(f"Harness error: {self.error}")
        lines.append(f"RESULT: {'PASS' if self.passed else 'FAIL'}")
        lines.append("=" * 60)
        return lines


def cellular_growth_benchmark() -> str:
    """Return the coding objective given to SeedAgent for this eval."""
    return CELLULAR_GROWTH_OBJECTIVE


def _assert_tool_used(agent: SeedAgent, tool_name: str) -> AssertionResult:
    used = [step for step in agent.history if step.tool == tool_name]
    if not used:
        return AssertionResult(
            name=f"used_{tool_name}",
            passed=False,
            detail=f"agent never called {tool_name}",
        )
    failed = [
        step
        for step in used
        if step.observation and step.observation.startswith("error:")
    ]
    if failed:
        return AssertionResult(
            name=f"used_{tool_name}",
            passed=False,
            detail=f"{tool_name} failed: {failed[-1].observation}",
        )
    return AssertionResult(
        name=f"used_{tool_name}",
        passed=True,
        detail=f"called {len(used)} time(s) without tool errors",
    )


def _assert_file_created(workspace: Path, relative_path: str) -> AssertionResult:
    target = workspace / relative_path
    if not target.is_file():
        return AssertionResult(
            name="file_created",
            passed=False,
            detail=f"expected file missing: {relative_path}",
        )
    size = target.stat().st_size
    if size == 0:
        return AssertionResult(
            name="file_created",
            passed=False,
            detail=f"{relative_path} exists but is empty",
        )
    text = target.read_text(encoding="utf-8")
    if "simulate_growth" not in text:
        return AssertionResult(
            name="file_created",
            passed=False,
            detail=f"{relative_path} missing simulate_growth()",
        )
    return AssertionResult(
        name="file_created",
        passed=True,
        detail=f"{relative_path} written ({size} bytes, contains simulate_growth)",
    )


def _assert_python_executed_cleanly(agent: SeedAgent) -> AssertionResult:
    runs = [step for step in agent.history if step.tool == "run_python"]
    if not runs:
        return AssertionResult(
            name="executed_without_errors",
            passed=False,
            detail="run_python was never called",
        )
    last = runs[-1]
    obs = last.observation or ""
    if "exit_code=0" not in obs:
        return AssertionResult(
            name="executed_without_errors",
            passed=False,
            detail=f"last run_python did not exit 0: {obs}",
        )
    if "error:" in obs.splitlines()[0]:
        return AssertionResult(
            name="executed_without_errors",
            passed=False,
            detail=obs,
        )
    if "growth_ok" not in obs:
        return AssertionResult(
            name="executed_without_errors",
            passed=False,
            detail=f"execution succeeded but missing growth_ok marker: {obs}",
        )
    return AssertionResult(
        name="executed_without_errors",
        passed=True,
        detail="run_python exited 0 and printed growth_ok",
    )


def run_isolated_harness(
    *,
    use_llm: bool = False,
    max_steps: int = 12,
) -> EvalResult:
    """Run SeedAgent in a temp workspace and score the cellular-growth task."""
    objective = cellular_growth_benchmark()
    agent = SeedAgent(task=objective, max_steps=max_steps)
    planner = None if use_llm else cellular_growth_planner_factory(TARGET_FILE)

    with tempfile.TemporaryDirectory(prefix="flux-seed-eval-") as tmp:
        workspace = Path(tmp)
        try:
            answer = agent.run(planner=planner, workspace=workspace)
        except Exception as exc:  # noqa: BLE001 — eval harness must not crash silently
            return EvalResult(
                passed=False,
                logs=list(agent.logs),
                error=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
            )

        assertions = [
            _assert_tool_used(agent, "write_file"),
            _assert_file_created(workspace, TARGET_FILE),
            _assert_tool_used(agent, "run_python"),
            _assert_python_executed_cleanly(agent),
        ]
        passed = all(item.passed for item in assertions)
        return EvalResult(
            passed=passed,
            assertions=assertions,
            logs=list(agent.logs),
            answer=answer,
        )


def print_report(result: EvalResult) -> None:
    print("\n----- execution logs -----")
    if result.logs:
        print("\n".join(result.logs))
    else:
        print("(no logs captured)")
    if result.answer:
        print(f"\nAgent answer: {result.answer}")
    print("\n".join(result.summary_lines()))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Use live OPENAI_API_KEY planning instead of the seed planner",
    )
    parser.add_argument("--max-steps", type=int, default=12)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print("Flux.ai SeedAgent evaluation")
    print(f"Benchmark objective:\n  {cellular_growth_benchmark()}\n")
    print(f"Planner: {'LLM' if args.llm else 'seed cellular_growth planner'}")
    print("Harness: isolated TemporaryDirectory workspace\n")

    result = run_isolated_harness(use_llm=args.llm, max_steps=args.max_steps)
    print_report(result)
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
