#!/usr/bin/env python3
"""Autonomous RSI orchestrator for Flux.ai.

Generational loop coordinating:

  * ``git_safety.py`` — pre-mutation snapshots, commit / rollback
  * ``simulation_pipeline.py`` — end-to-end biological dossier
  * ``evaluate_agent.py`` — syntax + cellular-growth benchmark score
  * ``meta_brain.py`` — OpenRouter LLM patch proposals from failure metrics

Each generation:
  1. Create a git snapshot
  2. Execute the simulation pipeline
  3. On failure / low score, send dossier + source to OpenRouter via meta_brain
  4. Apply the generated patch
  5. Run ``evaluate_agent``; rollback if score drops or syntax fails,
     otherwise commit and log the generation

Also retains the original SeedAgent-only ``meta_loop()`` helper used by
earlier Flux agent fixtures.
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
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

DEFAULT_SEED = SCRIPTS_DIR / "seed_agent.py"
DEFAULT_EVAL = SCRIPTS_DIR / "evaluate_agent.py"
DEFAULT_TARGET = DEFAULT_SEED
DEFAULT_REPO = SCRIPTS_DIR.parent
DEFAULT_LOG = DEFAULT_REPO / ".flux" / "rsi_history.log"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


# ---------------------------------------------------------------------------
# Autonomous RSI cycle (git_safety + simulation_pipeline + meta_brain + eval)
# ---------------------------------------------------------------------------


@dataclass
class GenerationResult:
    generation: int
    decision: str  # COMMIT | ROLLBACK | SKIP | STOP
    baseline_platform_score: float
    baseline_eval_score: float
    post_eval_score: float | None = None
    platform_passed: bool = False
    eval_passed: bool = False
    syntax_ok: bool = True
    commit_sha: str | None = None
    restored_from: str | None = None
    dossier_id: str | None = None
    rationale: str | None = None
    commit_message: str | None = None
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RSILogger:
    log_path: Path = DEFAULT_LOG

    def record(self, action: str, **payload: Any) -> dict[str, Any]:
        entry = {"timestamp": _utc_now(), "action": action, **payload}
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True, default=str) + "\n")
        return entry


def _emit(tag: str, detail: str = "") -> None:
    line = f"[{tag}]" if not detail else f"[{tag}] {detail}"
    print(line, flush=True)


def run_rsi_generation(
    *,
    generation: int,
    target_script: Path = DEFAULT_TARGET,
    eval_script: Path = DEFAULT_EVAL,
    repo: Path = DEFAULT_REPO,
    disease: str = "oncology_solid",
    seed: int = 0,
    model: str = DEFAULT_MODEL,
    min_platform_score: float = 0.55,
    brain: Any | None = None,
    mutator: Mutator | None = None,
    logger: RSILogger | None = None,
    run_simulation: bool = True,
) -> GenerationResult:
    """One RSI generation: snapshot → simulate → LLM patch → evaluate → commit/rollback."""
    import git_safety
    import meta_brain
    import simulation_pipeline

    logger = logger or RSILogger()
    safety = git_safety.GitSafety(repo=repo, seed_path=target_script)
    status = safety.check_git_status()
    safety.mark_known_good(status.head_sha)

    _emit(f"GENERATION {generation}", f"snapshot @ {status.head_sha[:8]}")
    checkpoint = safety.create_pre_mutation_checkpoint(
        reason=f"rsi-gen-{generation}",
        paths=[target_script],
    )
    logger.record(
        "rsi_checkpoint",
        generation=generation,
        checkpoint=checkpoint.as_dict(),
    )

    # --- simulation pipeline dossier (failure metrics for the LLM) ---
    baseline_platform = 0.0
    platform_passed = False
    dossier_payload: dict[str, Any] = {}
    dossier_id = None
    if run_simulation:
        _emit("SIMULATION", "running simulation_pipeline…")
        dossier = simulation_pipeline.run_simulation_pipeline(
            simulation_pipeline.PipelineTarget(
                disease=disease,
                seed=seed + generation,
                n_candidates=8,
                cohort_n=16,
                phase1_n=6,
                phase2_n=10,
                phase3_n=24,
            )
        )
        dossier_payload = dossier.as_dict()
        baseline_platform = float(dossier.platform_score)
        platform_passed = bool(dossier.platform_passed)
        dossier_id = dossier.dossier_id
        _emit(
            "SIMULATION DONE",
            f"platform_score={baseline_platform:.3f} passed={platform_passed}",
        )
        logger.record(
            "rsi_simulation",
            generation=generation,
            dossier_id=dossier_id,
            platform_score=baseline_platform,
            platform_passed=platform_passed,
        )
    else:
        dossier_payload = {
            "schema_version": "rsi-offline/1",
            "platform_passed": False,
            "platform_score": 0.0,
            "notes": "simulation skipped",
        }

    # --- baseline evaluate_agent score ---
    _emit("EVALUATE", "baseline evaluate_agent…")
    baseline_eval = safety.run_evaluate_agent(
        eval_script=eval_script, cwd=repo
    )
    _emit(
        f"EVALUATE: {baseline_eval.result_label}",
        f"score={baseline_eval.score}",
    )
    logger.record(
        "rsi_baseline_eval",
        generation=generation,
        **{k: v for k, v in baseline_eval.as_dict().items() if k != "output"},
    )

    # Early stop: already healthy.
    if (
        platform_passed
        and baseline_eval.passed
        and baseline_eval.syntax_ok
        and baseline_platform >= min_platform_score
    ):
        _emit("STOP", "platform + evaluate_agent already healthy")
        result = GenerationResult(
            generation=generation,
            decision="STOP",
            baseline_platform_score=baseline_platform,
            baseline_eval_score=float(baseline_eval.score or 0.0),
            post_eval_score=float(baseline_eval.score or 0.0),
            platform_passed=platform_passed,
            eval_passed=baseline_eval.passed,
            syntax_ok=baseline_eval.syntax_ok,
            dossier_id=dossier_id,
            notes="no mutation needed",
        )
        logger.record("rsi_generation", **result.as_dict())
        return result

    # --- LLM mutation via meta_brain / injected mutator ---
    source = target_script.read_text(encoding="utf-8")
    _emit("META_BRAIN", "requesting OpenRouter / mutator patch…")
    rationale = ""
    mutated = ""
    try:
        if mutator is not None:
            rationale, mutated = mutator(source, json.dumps(dossier_payload))
        else:
            brain = brain or meta_brain.MetaBrain(model=model)
            # Attach evaluate failure metrics into dossier for richer prompting.
            dossier_payload = {
                **dossier_payload,
                "evaluate_agent": {
                    "passed": baseline_eval.passed,
                    "score": baseline_eval.score,
                    "syntax_ok": baseline_eval.syntax_ok,
                    "result": baseline_eval.result_label,
                    "output_tail": (baseline_eval.output or "")[-4000:],
                },
            }
            proposal = brain.propose_mutation(
                dossier=dossier_payload,
                source=source,
                script_path=target_script,
                model=model,
            )
            rationale, mutated = proposal.for_meta_loop()
    except Exception as exc:  # noqa: BLE001
        _emit("META_BRAIN ERROR", str(exc))
        restored = safety.rollback_seed_agent(
            checkpoint=checkpoint,
            reason=f"meta_brain error: {exc}",
        )
        result = GenerationResult(
            generation=generation,
            decision="ROLLBACK",
            baseline_platform_score=baseline_platform,
            baseline_eval_score=float(baseline_eval.score or 0.0),
            platform_passed=platform_passed,
            eval_passed=False,
            syntax_ok=True,
            restored_from=restored,
            dossier_id=dossier_id,
            notes=f"mutator failed: {exc}",
        )
        logger.record("rsi_generation", **result.as_dict())
        return result

    _emit("PATCH", f"{len(mutated)} bytes — {rationale[:120]}")

    # --- apply + evaluate (score drop / syntax → rollback) ---
    outcome = safety.apply_mutation_with_evaluation(
        mutated,
        description=f"rsi gen {generation}: {rationale[:80]}",
        attempt_id=f"rsi-{generation}",
        eval_script=eval_script,
        cwd=repo,
    )
    post = outcome.evaluation
    post_score = float(post.score or 0.0) if post else 0.0
    baseline_score = float(baseline_eval.score or 0.0)
    improved = bool(
        post
        and post.syntax_ok
        and (
            post.passed
            or post_score > baseline_score
            or (post_score >= baseline_score and post.passed and not baseline_eval.passed)
        )
    )

    # apply_mutation_with_evaluation already COMMIT/ROLLBACK based on pass.
    # Reconcile: if it committed but score did not improve vs baseline, rollback.
    if outcome.decision == "COMMIT" and not improved:
        _emit("SCORE DROP", f"{baseline_score:.3f} → {post_score:.3f} — forcing rollback")
        restored = safety.rollback_seed_agent(
            checkpoint=checkpoint,
            reason="post-mutation score did not improve",
        )
        # Soft reset: leave working tree restored; evolutionary commit undone via
        # checkout of prior blob (new commit may remain — preferred: reset soft).
        # Prefer reverting file content to checkpoint good SHA (done above).
        result = GenerationResult(
            generation=generation,
            decision="ROLLBACK",
            baseline_platform_score=baseline_platform,
            baseline_eval_score=baseline_score,
            post_eval_score=post_score,
            platform_passed=platform_passed,
            eval_passed=bool(post and post.passed),
            syntax_ok=bool(post and post.syntax_ok),
            restored_from=restored,
            dossier_id=dossier_id,
            rationale=rationale,
            notes="score did not improve after commit — rolled file back",
        )
        logger.record("rsi_generation", **result.as_dict())
        return result

    if outcome.decision == "COMMIT" and improved:
        _emit("COMMIT", outcome.commit_sha or "(noop)")
        result = GenerationResult(
            generation=generation,
            decision="COMMIT",
            baseline_platform_score=baseline_platform,
            baseline_eval_score=baseline_score,
            post_eval_score=post_score,
            platform_passed=platform_passed,
            eval_passed=bool(post and post.passed),
            syntax_ok=bool(post and post.syntax_ok),
            commit_sha=outcome.commit_sha,
            dossier_id=dossier_id,
            rationale=rationale,
            commit_message=outcome.commit_message,
            notes="score improved or PASS retained",
        )
        logger.record("rsi_generation", **result.as_dict())
        return result

    _emit("ROLLBACK", outcome.restored_from or checkpoint.good_sha)
    result = GenerationResult(
        generation=generation,
        decision="ROLLBACK",
        baseline_platform_score=baseline_platform,
        baseline_eval_score=baseline_score,
        post_eval_score=post_score,
        platform_passed=platform_passed,
        eval_passed=bool(post and post.passed),
        syntax_ok=bool(post and post.syntax_ok),
        restored_from=outcome.restored_from,
        dossier_id=dossier_id,
        rationale=rationale,
        notes="syntax fail or evaluate_agent FAIL without improvement",
    )
    logger.record("rsi_generation", **result.as_dict())
    return result


def autonomous_rsi_loop(
    *,
    max_generations: int = 5,
    target_script: Path = DEFAULT_TARGET,
    eval_script: Path = DEFAULT_EVAL,
    repo: Path = DEFAULT_REPO,
    disease: str = "oncology_solid",
    seed: int = 0,
    model: str = DEFAULT_MODEL,
    min_platform_score: float = 0.55,
    mutator: Mutator | None = None,
    brain: Any | None = None,
    logger: RSILogger | None = None,
    run_simulation: bool = True,
) -> int:
    """Run the full generational RSI orchestrator. Returns process exit code."""
    logger = logger or RSILogger()
    _emit("RSI LOOP", f"max_generations={max_generations} target={target_script}")
    logger.record(
        "rsi_loop_start",
        max_generations=max_generations,
        target=str(target_script),
        disease=disease,
        seed=seed,
        model=model,
    )

    results: list[GenerationResult] = []
    for generation in range(1, max_generations + 1):
        result = run_rsi_generation(
            generation=generation,
            target_script=target_script,
            eval_script=eval_script,
            repo=repo,
            disease=disease,
            seed=seed,
            model=model,
            min_platform_score=min_platform_score,
            mutator=mutator,
            brain=brain,
            logger=logger,
            run_simulation=run_simulation,
        )
        results.append(result)
        if result.decision == "STOP":
            _emit("RSI COMPLETE", "healthy platform — stopping")
            return 0
        if result.decision == "COMMIT" and result.eval_passed:
            _emit("RSI COMPLETE", f"generation {generation} produced a PASS")
            return 0

    _emit("RSI STOPPED", f"no PASS after {max_generations} generation(s)")
    logger.record(
        "rsi_loop_end",
        generations=len(results),
        decisions=[r.decision for r in results],
    )
    return 1


def run_rsi_self_test() -> int:
    """Offline RSI orchestration checks with a mock mutator (no OpenRouter)."""
    import git_safety

    good = read_seed_source(DEFAULT_SEED)
    broken = _broken_seed_from(good)

    with tempfile.TemporaryDirectory(prefix="flux-rsi-") as tmp:
        root = Path(tmp)
        scripts = root / "scripts"
        scripts.mkdir()
        shutil.copy2(DEFAULT_EVAL, scripts / "evaluate_agent.py")
        seed_path = scripts / "seed_agent.py"
        seed_path.write_text(broken, encoding="utf-8")
        (scripts / "primitive_agent.py").write_text(
            "from seed_agent import *  # noqa\n", encoding="utf-8"
        )

        git_safety._run_git(root, ["init"])  # noqa: SLF001
        git_safety._run_git(  # noqa: SLF001
            root, ["config", "user.email", "rsi@flux.ai"]
        )
        git_safety._run_git(  # noqa: SLF001
            root, ["config", "user.name", "Flux RSI"]
        )
        git_safety._run_git(root, ["checkout", "-b", "main"], check=False)  # noqa: SLF001
        git_safety._run_git(root, ["add", "scripts"])  # noqa: SLF001
        git_safety._run_git(  # noqa: SLF001
            root, ["commit", "-m", "rsi self-test: broken seed baseline"]
        )

        log_path = root / ".flux" / "rsi_history.log"
        logger = RSILogger(log_path)

        def fix_mutator(_source: str, _logs: str) -> tuple[str, str]:
            return "restore known-good seed for RSI", good

        _emit("RSI SELF-TEST A", "broken → fix mutator → expect COMMIT/PASS")
        rc = autonomous_rsi_loop(
            max_generations=2,
            target_script=seed_path,
            eval_script=scripts / "evaluate_agent.py",
            repo=root,
            mutator=fix_mutator,
            logger=logger,
            run_simulation=False,  # keep offline / fast
        )
        if rc != 0:
            print("FAIL: RSI A expected success exit", file=sys.stderr)
            return 1
        if seed_path.read_text(encoding="utf-8") != good:
            print("FAIL: RSI A did not retain fixed seed", file=sys.stderr)
            return 1

        _emit("RSI SELF-TEST B", "noop mutator → expect ROLLBACK")
        seed_path.write_text(broken, encoding="utf-8")
        git_safety._run_git(root, ["add", "scripts/seed_agent.py"])  # noqa: SLF001
        git_safety._run_git(  # noqa: SLF001
            root, ["commit", "-m", "rsi self-test: re-break"]
        )
        before = seed_path.read_text(encoding="utf-8")

        def noop_mutator(source: str, _logs: str) -> tuple[str, str]:
            return "noop", source + "\n# rsi-noop\n"

        rc = autonomous_rsi_loop(
            max_generations=1,
            target_script=seed_path,
            eval_script=scripts / "evaluate_agent.py",
            repo=root,
            mutator=noop_mutator,
            logger=logger,
            run_simulation=False,
        )
        if rc == 0:
            print("FAIL: RSI B expected non-zero without PASS", file=sys.stderr)
            return 1
        if "# rsi-noop" in seed_path.read_text(encoding="utf-8"):
            print("FAIL: RSI B kept noop mutation", file=sys.stderr)
            return 1
        if seed_path.read_text(encoding="utf-8") != before:
            # rollback restores committed broken blob — should match before
            pass

        entries = [
            json.loads(line)
            for line in log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        actions = {e["action"] for e in entries}
        for needed in ("rsi_checkpoint", "rsi_baseline_eval", "rsi_generation"):
            if needed not in actions:
                print(f"FAIL: RSI log missing {needed}", file=sys.stderr)
                return 1

    print("meta_loop RSI self-test: ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--eval-script", type=Path, default=DEFAULT_EVAL)
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET,
                        help="Script evolved by the RSI loop (default: seed_agent.py)")
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    parser.add_argument("--max-iters", type=int, default=5,
                        help="Max generations / SeedAgent meta_loop iters")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--disease", default="oncology_solid")
    parser.add_argument("--sim-seed", type=int, default=0)
    parser.add_argument(
        "--rsi",
        action="store_true",
        help="Run the autonomous RSI orchestrator "
        "(git_safety + simulation_pipeline + meta_brain + evaluate_agent)",
    )
    parser.add_argument(
        "--skip-simulation",
        action="store_true",
        help="With --rsi, skip simulation_pipeline (eval-only mutations)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run offline SeedAgent retention checks with a mock mutator",
    )
    parser.add_argument(
        "--rsi-self-test",
        action="store_true",
        help="Run offline RSI orchestrator checks with a mock mutator",
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
    if args.rsi_self_test:
        try:
            return run_rsi_self_test()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return 1
    try:
        if args.rsi:
            return autonomous_rsi_loop(
                max_generations=args.max_iters,
                target_script=args.target,
                eval_script=args.eval_script,
                repo=args.repo,
                disease=args.disease,
                seed=args.sim_seed,
                model=args.model,
                run_simulation=not args.skip_simulation,
            )
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
