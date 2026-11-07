#!/usr/bin/env python3
"""Flux.ai master execution script — recursive QC + mutation loop.

Coordinates the four workspace modules:

  * ``seed_agent``     — the agent under improvement
  * ``evaluate_agent`` — cellular-growth benchmark / QC harness
  * ``meta_loop``      — OpenRouter patch request + retention helpers
  * ``git_safety``     — pre-mutation checkpoints, commit, rollback

Orchestration per iteration
---------------------------
1. Create a pre-mutation Git checkpoint (``git_safety``).
2. Run the benchmark via ``evaluate_agent`` (subprocess through
   ``meta_loop.run_evaluate_agent`` so on-disk mutations are always loaded).
3. On FAIL: ask ``meta_loop`` for an OpenRouter (or mock) patch, apply it,
   re-QC, and ``git_safety.rollback_seed_agent`` if the patch does not help.
4. On PASS: commit the successful mutation (if any) and exit, or continue
   when ``--continue-on-pass`` is set.

Terminal status tags are flushed in real time, e.g. ``[ITERATION 1]``,
``[QC CHECK: FAIL]``, ``[ROLLBACK EXECUTED]``, ``[QC CHECK: PASS]``.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Callable

# Ensure sibling modules resolve when invoked as `python3 scripts/run_flux.py`.
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import evaluate_agent  # noqa: E402
import git_safety  # noqa: E402
import meta_loop  # noqa: E402
import seed_agent  # noqa: E402


REPO_ROOT = SCRIPTS_DIR.parent
DEFAULT_SEED = SCRIPTS_DIR / "seed_agent.py"
DEFAULT_EVAL = SCRIPTS_DIR / "evaluate_agent.py"
Mutator = Callable[[str, str], tuple[str, str]]


# ---------------------------------------------------------------------------
# Real-time terminal status
# ---------------------------------------------------------------------------


def emit(tag: str, detail: str = "") -> None:
    """Print a bracketed status line and flush immediately."""
    line = f"[{tag}]" if not detail else f"[{tag}] {detail}"
    print(line, flush=True)


def emit_banner(title: str) -> None:
    print(f"\n{'=' * 60}\n{title}\n{'=' * 60}", flush=True)


# ---------------------------------------------------------------------------
# Mutation apply + git-backed retention
# ---------------------------------------------------------------------------


def _clear_seed_bytecode(seed_path: Path) -> None:
    for stale in seed_path.parent.glob("__pycache__/seed_agent*.pyc"):
        stale.unlink(missing_ok=True)


def apply_patch_with_git_safety(
    *,
    safety: git_safety.GitSafety,
    seed_path: Path,
    mutated_source: str,
    baseline: meta_loop.HarnessScore,
    eval_script: Path,
    checkpoint: git_safety.Checkpoint,
    cwd: Path | None,
    attempt_id: str,
) -> tuple[bool, meta_loop.HarnessScore, str]:
    """Write a patch, re-QC, commit on improvement, else git rollback.

    Returns (retained, post_score, decision_tag_detail).
    """
    seed_path.write_text(mutated_source, encoding="utf-8")
    _clear_seed_bytecode(seed_path)
    emit("MUTATION APPLIED", f"{len(mutated_source)} bytes → {seed_path.name}")

    post = meta_loop.run_evaluate_agent(eval_script, cwd=cwd)
    emit(
        f"QC CHECK: {post.result_label}",
        f"SCORE {post.points}/{post.max_points} ({post.score:.2f}) [post-mutation]",
    )
    safety.record_test_result(
        attempt_id=attempt_id,
        passed=post.passed,
        score=post.score,
        details="post-mutation evaluation",
        extra={"points": post.points, "max_points": post.max_points},
    )

    improved = post.passed or post.score > baseline.score
    if improved:
        sha = safety.commit_mutation(
            f"flux: retain seed_agent mutation ({post.result_label} "
            f"{post.points}/{post.max_points})"
        )
        emit(
            "COMMIT SUCCESS",
            sha or "noop — working tree already matched HEAD",
        )
        return True, post, "KEEP"

    restored = safety.rollback_seed_agent(
        checkpoint=checkpoint,
        reason=f"post-mutation score did not improve ({baseline.score:.2f} → {post.score:.2f})",
    )
    emit("ROLLBACK EXECUTED", f"restored seed_agent.py from {restored[:8]}")
    return False, post, "REVERT"


# ---------------------------------------------------------------------------
# Master loop
# ---------------------------------------------------------------------------


def run_flux(
    *,
    seed_path: Path = DEFAULT_SEED,
    eval_script: Path = DEFAULT_EVAL,
    repo: Path = REPO_ROOT,
    max_iters: int = 5,
    model: str = meta_loop.DEFAULT_MODEL,
    mutator: Mutator | None = None,
    continue_on_pass: bool = False,
    cwd: Path | None = None,
    log_path: Path | None = None,
) -> int:
    """Run the recursive checkpoint → QC → mutate/rollback → commit loop."""
    # Touch imported modules so coordination is explicit and import-safe.
    _ = (
        seed_agent.SeedAgent,
        evaluate_agent.run_isolated_harness,
        meta_loop.run_evaluate_agent,
        git_safety.GitSafety,
    )

    work_cwd = cwd or repo
    safety = git_safety.GitSafety(
        repo=repo,
        seed_path=seed_path,
        log_path=log_path,
    )

    if mutator is None:

        def mutator(source: str, logs: str) -> tuple[str, str]:
            return meta_loop.request_openrouter_mutation(
                source=source,
                eval_logs=logs,
                model=model,
            )

    emit_banner("Flux.ai master loop")
    emit("MODULES", "seed_agent · evaluate_agent · meta_loop · git_safety")
    emit("SEED", str(seed_path))
    emit("EVAL", str(eval_script))
    emit("MAX ITERS", str(max_iters))

    status = safety.check_git_status()
    safety.mark_known_good(status.head_sha)
    emit("GIT", f"{status.branch} @ {status.head_sha[:8]} clean={status.clean}")

    for iteration in range(1, max_iters + 1):
        emit_banner(f"ITERATION {iteration}/{max_iters}")
        emit(f"ITERATION {iteration}")

        # Step 1 — pre-mutation checkpoint
        checkpoint = safety.create_checkpoint(
            reason=f"run_flux iteration {iteration}"
        )
        emit(
            "CHECKPOINT CREATED",
            f"{checkpoint.id} good={checkpoint.good_sha[:8]}"
            + (f" stash={checkpoint.stash_ref}" if checkpoint.stash_ref else ""),
        )

        # Step 2 — QC via evaluate_agent (subprocess loads on-disk seed)
        emit("QC CHECK", "running evaluate_agent benchmark…")
        score = meta_loop.run_evaluate_agent(eval_script, cwd=work_cwd)
        emit(
            f"QC CHECK: {score.result_label}",
            f"SCORE {score.points}/{score.max_points} ({score.score:.2f})",
        )
        safety.record_test_result(
            attempt_id=f"iter-{iteration}-pre",
            passed=score.passed,
            score=score.score,
            details="pre-mutation evaluation",
            extra={"points": score.points, "max_points": score.max_points},
        )

        # Step 4 path — already green: commit (if dirty) and exit / continue
        if score.passed:
            sha = safety.commit_mutation(
                f"flux: seed_agent QC PASS at iteration {iteration}",
            )
            if sha:
                emit("COMMIT SUCCESS", sha)
            else:
                emit("COMMIT SKIPPED", "tree clean — nothing new to commit")
            emit("LOOP COMPLETE", "evaluation PASS")
            if continue_on_pass and iteration < max_iters:
                emit("CONTINUE", " --continue-on-pass set; starting next iteration")
                continue
            return 0

        # Step 3 — FAIL → OpenRouter (or mock) patch via meta_loop
        emit("QC CHECK: FAIL", "requesting meta_loop patch…")
        source = meta_loop.read_seed_source(seed_path)
        attempt_id = f"iter-{iteration}-mutate"
        safety.record_mutation_attempt(
            attempt_id=attempt_id,
            description=f"OpenRouter/meta_loop patch for iteration {iteration}",
            extra={"baseline_score": score.score},
        )

        try:
            rationale, mutated = mutator(source, score.logs)
        except Exception as exc:  # noqa: BLE001
            emit("MUTATION ERROR", str(exc))
            restored = safety.rollback_seed_agent(
                checkpoint=checkpoint,
                reason=f"mutator error: {exc}",
            )
            emit("ROLLBACK EXECUTED", f"restored seed_agent.py from {restored[:8]}")
            continue

        emit("MUTATION RATIONALE", rationale)
        retained, post, decision = apply_patch_with_git_safety(
            safety=safety,
            seed_path=seed_path,
            mutated_source=mutated,
            baseline=score,
            eval_script=eval_script,
            checkpoint=checkpoint,
            cwd=work_cwd,
            attempt_id=attempt_id,
        )
        emit("RETENTION", decision)

        if retained and post.passed:
            emit("LOOP COMPLETE", "retained a passing mutation")
            if continue_on_pass and iteration < max_iters:
                emit("CONTINUE", "--continue-on-pass set; starting next iteration")
                continue
            return 0

    emit("LOOP STOPPED", f"no PASS after {max_iters} iteration(s)")
    return 1


# ---------------------------------------------------------------------------
# Offline self-test
# ---------------------------------------------------------------------------


def _broken_seed_from(good_source: str) -> str:
    """Reuse meta_loop's planner-bug injection for a deterministic FAIL."""
    return meta_loop._broken_seed_from(good_source)  # noqa: SLF001


def run_self_test() -> int:
    """Exercise PASS→commit and FAIL→rollback without OpenRouter."""
    good = meta_loop.read_seed_source(DEFAULT_SEED)
    broken = _broken_seed_from(good)

    with tempfile.TemporaryDirectory(prefix="flux-run-flux-") as tmp:
        root = Path(tmp)
        scripts = root / "scripts"
        scripts.mkdir()
        shutil.copy2(DEFAULT_EVAL, scripts / "evaluate_agent.py")
        shutil.copy2(SCRIPTS_DIR / "seed_agent.py", scripts / "seed_agent.py")
        # Keep evaluate_agent's optional shim import happy.
        (scripts / "primitive_agent.py").write_text(
            "from seed_agent import *  # noqa\n", encoding="utf-8"
        )

        # Init a real git repo so git_safety can checkpoint/commit/rollback.
        git_safety._run_git(root, ["init"])  # noqa: SLF001
        git_safety._run_git(  # noqa: SLF001
            root, ["config", "user.email", "run-flux@flux.ai"]
        )
        git_safety._run_git(  # noqa: SLF001
            root, ["config", "user.name", "Flux Run Flux"]
        )
        git_safety._run_git(root, ["checkout", "-b", "main"], check=False)  # noqa: SLF001
        # Start from the broken seed committed as HEAD so rollback has a
        # committed baseline; the fixing mutator should commit the good file.
        seed_path = scripts / "seed_agent.py"
        seed_path.write_text(broken, encoding="utf-8")
        git_safety._run_git(root, ["add", "scripts"])  # noqa: SLF001
        git_safety._run_git(  # noqa: SLF001
            root, ["commit", "-m", "self-test: broken seed baseline"]
        )
        baseline_sha = git_safety._run_git(  # noqa: SLF001
            root, ["rev-parse", "HEAD"]
        ).stdout.strip()

        log_path = root / ".flux" / "mutation_history.log"

        emit_banner("Self-test A: fixing mutator → expect COMMIT / PASS")

        def fix_mutator(_source: str, _logs: str) -> tuple[str, str]:
            return "restore known-good seed_agent.py", good

        rc = run_flux(
            seed_path=seed_path,
            eval_script=scripts / "evaluate_agent.py",
            repo=root,
            max_iters=2,
            mutator=fix_mutator,
            cwd=root,
            log_path=log_path,
        )
        if rc != 0:
            emit("SELF-TEST FAIL", "A: expected PASS after retention")
            return 1
        if seed_path.read_text(encoding="utf-8") != good:
            emit("SELF-TEST FAIL", "A: fixed source not retained on disk")
            return 1
        head = git_safety._run_git(root, ["rev-parse", "HEAD"]).stdout.strip()  # noqa: SLF001
        if head == baseline_sha:
            emit("SELF-TEST FAIL", "A: expected a new commit for the fix")
            return 1
        emit("SELF-TEST PASS", f"A committed {head[:8]}")

        emit_banner("Self-test B: non-improving mutator → expect ROLLBACK")
        seed_path.write_text(broken, encoding="utf-8")
        git_safety._run_git(root, ["add", "scripts/seed_agent.py"])  # noqa: SLF001
        git_safety._run_git(  # noqa: SLF001
            root, ["commit", "-m", "self-test: re-break seed"]
        )
        broken_sha = git_safety._run_git(  # noqa: SLF001
            root, ["rev-parse", "HEAD"]
        ).stdout.strip()
        before = seed_path.read_text(encoding="utf-8")

        def noop_mutator(source: str, _logs: str) -> tuple[str, str]:
            return "noop", source + "\n# noop mutation — still broken\n"

        rc = run_flux(
            seed_path=seed_path,
            eval_script=scripts / "evaluate_agent.py",
            repo=root,
            max_iters=1,
            mutator=noop_mutator,
            cwd=root,
            log_path=log_path,
        )
        if rc == 0:
            emit("SELF-TEST FAIL", "B: expected non-zero exit without PASS")
            return 1
        after = seed_path.read_text(encoding="utf-8")
        if after != before:
            # rollback checks out from broken_sha; content should match baseline
            # broken file (without the noop comment).
            if "# noop mutation" in after:
                emit("SELF-TEST FAIL", "B: noop mutation was kept")
                return 1
        if "# noop mutation" in seed_path.read_text(encoding="utf-8"):
            emit("SELF-TEST FAIL", "B: rollback did not drop noop mutation")
            return 1
        # Confirm file matches the committed broken baseline.
        restored = git_safety._run_git(  # noqa: SLF001
            root, ["show", f"{broken_sha}:scripts/seed_agent.py"]
        ).stdout
        if seed_path.read_text(encoding="utf-8") != restored:
            emit("SELF-TEST FAIL", "B: disk content != rolled-back commit blob")
            return 1
        emit("SELF-TEST PASS", f"B rolled back to {broken_sha[:8]}")

    emit("SELF-TEST", "ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--eval-script", type=Path, default=DEFAULT_EVAL)
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--max-iters", type=int, default=5)
    parser.add_argument("--model", default=meta_loop.DEFAULT_MODEL)
    parser.add_argument(
        "--continue-on-pass",
        action="store_true",
        help="After a PASS/commit, keep iterating until max-iters",
    )
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="Mutation history log (default: <repo>/.flux/mutation_history.log)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Offline PASS/ROLLBACK checks with a mock mutator (no API key)",
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
        return run_flux(
            seed_path=args.seed,
            eval_script=args.eval_script,
            repo=args.repo,
            max_iters=args.max_iters,
            model=args.model,
            continue_on_pass=args.continue_on_pass,
            log_path=args.log,
        )
    except Exception as exc:  # noqa: BLE001
        emit("FATAL", str(exc))
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
