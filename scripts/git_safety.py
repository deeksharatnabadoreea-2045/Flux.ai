#!/usr/bin/env python3
"""Git safety automation for Flux.ai autonomous code evolution.

Programmatically guards agent mutations with:

  1. Temporary pre-mutation Git checkpoints (stash + known-good SHA)
  2. Monitoring of ``evaluate_agent.py`` results (syntax + biological benchmark)
  3. Automatic rollback to the last stable commit on failure
  4. Descriptive automated commits that preserve evolutionary history

Typical autonomous loop::

    safety = GitSafety()
    outcome = safety.apply_mutation_with_evaluation(
        mutated_source=new_code,
        description="meta-brain: improve cellular planner",
    )
    # outcome.decision is COMMIT or ROLLBACK
"""

from __future__ import annotations

import argparse
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence


SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_REPO = SCRIPTS_DIR.parent
DEFAULT_SEED = SCRIPTS_DIR / "seed_agent.py"
DEFAULT_EVAL = SCRIPTS_DIR / "evaluate_agent.py"
DEFAULT_LOG = DEFAULT_REPO / ".flux" / "mutation_history.log"
CHECKPOINT_STASH_PREFIX = "flux-agent-checkpoint"


class GitSafetyError(RuntimeError):
    """Raised when a git safety operation fails."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run_git(
    repo: Path,
    args: Sequence[str],
    *,
    check: bool = True,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        input=input_text,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise GitSafetyError(
            f"git {' '.join(args)} failed (rc={completed.returncode}): {detail}"
        )
    return completed


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


class MutationLogger:
    """Append-only JSONL history of mutation attempts and git safety actions."""

    def __init__(self, log_path: Path = DEFAULT_LOG) -> None:
        self.log_path = Path(log_path)

    def record(self, action: str, **payload: Any) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "timestamp": _utc_now(),
            "action": action,
            **payload,
        }
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
# Status / checkpoint / commit / rollback
# ---------------------------------------------------------------------------


@dataclass
class GitStatus:
    branch: str
    head_sha: str
    clean: bool
    staged: list[str] = field(default_factory=list)
    unstaged: list[str] = field(default_factory=list)
    untracked: list[str] = field(default_factory=list)
    porcelain: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Checkpoint:
    """Snapshot taken before an agent mutation."""

    id: str
    head_sha: str
    good_sha: str
    seed_path: str
    seed_sha_before: str | None
    stash_ref: str | None
    created_at: str
    reason: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EvaluateAgentResult:
    """Parsed outcome from running ``evaluate_agent.py``."""

    passed: bool
    score: float | None
    points: int | None
    max_points: int | None
    returncode: int
    syntax_ok: bool
    output: str
    error: str | None = None

    @property
    def result_label(self) -> str:
        if not self.syntax_ok:
            return "SYNTAX_ERROR"
        return "PASS" if self.passed else "FAIL"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MutationOutcome:
    """Result of a guarded mutate → evaluate → commit/rollback cycle."""

    decision: str  # COMMIT | ROLLBACK
    checkpoint: Checkpoint
    evaluation: EvaluateAgentResult | None
    commit_sha: str | None = None
    restored_from: str | None = None
    commit_message: str | None = None
    attempt_id: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "checkpoint": self.checkpoint.as_dict(),
            "evaluation": self.evaluation.as_dict() if self.evaluation else None,
            "commit_sha": self.commit_sha,
            "restored_from": self.restored_from,
            "commit_message": self.commit_message,
            "attempt_id": self.attempt_id,
        }


class GitSafety:
    """Coordinate git checkpoints, commits, and seed_agent rollbacks."""

    def __init__(
        self,
        repo: Path | None = None,
        *,
        seed_path: Path | None = None,
        log_path: Path | None = None,
        known_good_sha: str | None = None,
    ) -> None:
        self.repo = Path(repo or DEFAULT_REPO).resolve()
        self.seed_path = Path(seed_path or DEFAULT_SEED).resolve()
        self.logger = MutationLogger(log_path or (self.repo / ".flux" / "mutation_history.log"))
        self._known_good_sha = known_good_sha
        self._last_checkpoint: Checkpoint | None = None

    # -- status -------------------------------------------------------------

    def check_git_status(self) -> GitStatus:
        """Return a structured view of the current working tree."""
        self._ensure_repo()
        branch = _run_git(
            self.repo, ["rev-parse", "--abbrev-ref", "HEAD"]
        ).stdout.strip()
        head_sha = _run_git(self.repo, ["rev-parse", "HEAD"]).stdout.strip()
        porcelain = _run_git(
            self.repo, ["status", "--porcelain"]
        ).stdout
        staged: list[str] = []
        unstaged: list[str] = []
        untracked: list[str] = []
        for raw in porcelain.splitlines():
            if not raw:
                continue
            code = raw[:2]
            path = raw[3:]
            if code.startswith("??"):
                untracked.append(path)
            else:
                if code[0] not in (" ", "?"):
                    staged.append(path)
                if code[1] not in (" ", "?"):
                    unstaged.append(path)
        status = GitStatus(
            branch=branch,
            head_sha=head_sha,
            clean=not porcelain.strip(),
            staged=staged,
            unstaged=unstaged,
            untracked=untracked,
            porcelain=porcelain,
        )
        self.logger.record(
            "git_status",
            branch=status.branch,
            head_sha=status.head_sha,
            clean=status.clean,
            staged=status.staged,
            unstaged=status.unstaged,
            untracked=status.untracked,
        )
        return status

    # -- checkpoint ---------------------------------------------------------

    def create_checkpoint(
        self,
        *,
        reason: str = "pre-mutation",
        paths: Sequence[Path] | None = None,
        include_untracked: bool = True,
    ) -> Checkpoint:
        """Stash current work and record HEAD as a restore point.

        The stash is a temporary safety net for dirty trees. The authoritative
        rollback target for `seed_agent.py` is ``good_sha`` (last known good
        commit, defaulting to HEAD at checkpoint time).
        """
        status = self.check_git_status()
        good_sha = self._known_good_sha or status.head_sha
        seed_rel = self._rel(self.seed_path)
        seed_sha_before = self._blob_sha(seed_rel)

        stash_ref: str | None = None
        targets = list(paths) if paths is not None else [self.seed_path]
        rel_targets = [self._rel(path) for path in targets]

        # Only stash when there is something to protect for the target paths.
        needs_stash = self._paths_are_dirty(rel_targets, status)
        if needs_stash:
            message = f"{CHECKPOINT_STASH_PREFIX}:{_utc_now()}:{reason}"
            stash_args = ["stash", "push", "-m", message]
            if include_untracked:
                stash_args.append("--include-untracked")
            stash_args.append("--")
            stash_args.extend(rel_targets)
            result = _run_git(self.repo, stash_args, check=False)
            if result.returncode != 0:
                # Fall back to full-tree stash when pathspec stash is awkward
                # (e.g. brand-new untracked files on older git).
                fallback = ["stash", "push", "-u", "-m", message]
                _run_git(self.repo, fallback)
            stash_ref = self._latest_stash_ref(message)

        checkpoint = Checkpoint(
            id=f"ckpt-{status.head_sha[:8]}-{_utc_now().replace(':', '')}",
            head_sha=status.head_sha,
            good_sha=good_sha,
            seed_path=seed_rel,
            seed_sha_before=seed_sha_before,
            stash_ref=stash_ref,
            created_at=_utc_now(),
            reason=reason,
        )
        self._last_checkpoint = checkpoint
        self.logger.record(
            "checkpoint_created",
            reason=reason,
            checkpoint=checkpoint.as_dict(),
            status_clean=status.clean,
        )
        return checkpoint

    # -- commit -------------------------------------------------------------

    def commit_mutation(
        self,
        message: str,
        *,
        paths: Sequence[Path] | None = None,
        allow_empty: bool = False,
    ) -> str | None:
        """Stage and commit a successful mutation. Returns the new commit SHA."""
        targets = list(paths) if paths is not None else [self.seed_path]
        rels = [self._rel(path) for path in targets]
        for rel in rels:
            _run_git(self.repo, ["add", "--", rel])

        staged = _run_git(
            self.repo, ["diff", "--cached", "--name-only"]
        ).stdout.strip()
        if not staged and not allow_empty:
            self.logger.record(
                "commit_skipped",
                message=message,
                reason="nothing staged",
                paths=rels,
            )
            return None

        _run_git(self.repo, ["commit", "-m", message])
        sha = _run_git(self.repo, ["rev-parse", "HEAD"]).stdout.strip()
        self.mark_known_good(sha)
        self.logger.record(
            "commit_mutation",
            message=message,
            commit_sha=sha,
            paths=rels,
        )
        return sha

    def mark_known_good(self, sha: str | None = None) -> str:
        """Remember a commit SHA as the last known-good seed_agent state."""
        if sha is None:
            sha = _run_git(self.repo, ["rev-parse", "HEAD"]).stdout.strip()
        self._known_good_sha = sha
        self.logger.record("mark_known_good", commit_sha=sha)
        return sha

    # -- rollback -----------------------------------------------------------

    def rollback_seed_agent(
        self,
        *,
        checkpoint: Checkpoint | None = None,
        good_commit: str | None = None,
        reason: str = "evaluation failed",
        drop_stash: bool = True,
    ) -> str:
        """Revert ``seed_agent.py`` to the last known-good commit.

        Preference order for the restore SHA:
          1. explicit ``good_commit``
          2. ``checkpoint.good_sha``
          3. ``self._known_good_sha``
          4. HEAD
        """
        ckpt = checkpoint or self._last_checkpoint
        restore_sha = (
            good_commit
            or (ckpt.good_sha if ckpt else None)
            or self._known_good_sha
            or _run_git(self.repo, ["rev-parse", "HEAD"]).stdout.strip()
        )
        seed_rel = self._rel(self.seed_path)

        # Ensure the path exists in that commit before checking it out.
        probe = _run_git(
            self.repo,
            ["cat-file", "-e", f"{restore_sha}:{seed_rel}"],
            check=False,
        )
        if probe.returncode != 0:
            raise GitSafetyError(
                f"seed file {seed_rel!r} not found in commit {restore_sha}"
            )

        _run_git(self.repo, ["checkout", restore_sha, "--", seed_rel])

        if ckpt and ckpt.stash_ref and drop_stash:
            self._drop_stash(ckpt.stash_ref)

        self.logger.record(
            "rollback",
            reason=reason,
            restored_from=restore_sha,
            seed_path=seed_rel,
            checkpoint_id=ckpt.id if ckpt else None,
        )
        return restore_sha

    def record_mutation_attempt(
        self,
        *,
        attempt_id: str,
        description: str,
        mutated: bool = True,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "attempt_id": attempt_id,
            "description": description,
            "mutated": mutated,
        }
        if extra:
            payload.update(extra)
        return self.logger.record("mutation_attempt", **payload)

    def record_test_result(
        self,
        *,
        attempt_id: str,
        passed: bool,
        score: float | None = None,
        details: str = "",
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "attempt_id": attempt_id,
            "passed": passed,
            "result": "PASS" if passed else "FAIL",
            "score": score,
            "details": details,
        }
        if extra:
            payload.update(extra)
        return self.logger.record("test_result", **payload)

    def guard_mutation(
        self,
        *,
        attempt_id: str,
        description: str,
        evaluation_passed: bool,
        score: float | None = None,
        commit_message: str | None = None,
        details: str = "",
    ) -> str:
        """High-level helper: commit on PASS, rollback on FAIL, always log.

        Call this *after* a mutation has been applied and evaluated. Creates a
        checkpoint only if one was not already taken for this attempt.
        """
        checkpoint = self._last_checkpoint or self.create_checkpoint(
            reason=f"guard:{attempt_id}"
        )
        self.record_mutation_attempt(
            attempt_id=attempt_id,
            description=description,
        )
        self.record_test_result(
            attempt_id=attempt_id,
            passed=evaluation_passed,
            score=score,
            details=details,
        )
        if evaluation_passed:
            message = commit_message or format_evolution_commit_message(
                description=description,
                passed=True,
                score=score,
            )
            sha = self.commit_mutation(message)
            return f"COMMIT {sha or '(noop — nothing staged)'}"
        restored = self.rollback_seed_agent(
            checkpoint=checkpoint,
            reason=f"eval FAIL for {attempt_id}",
        )
        return f"ROLLBACK to {restored}"

    # -- pre-mutation checkpoint + evaluate_agent automation --------------

    def create_pre_mutation_checkpoint(
        self,
        *,
        reason: str = "pre-mutation",
        paths: Sequence[Path] | None = None,
    ) -> Checkpoint:
        """Create a temporary checkpoint *before* any agent code modification."""
        return self.create_checkpoint(reason=reason, paths=paths)

    @contextmanager
    def mutation_transaction(
        self,
        *,
        reason: str = "pre-mutation",
        paths: Sequence[Path] | None = None,
    ) -> Iterator[Checkpoint]:
        """Context manager that checkpoints before a mutation block.

        Does not auto-commit/rollback — callers should use
        ``apply_mutation_with_evaluation`` for the full automated loop, or
        call ``guard_mutation`` after evaluating inside the block.
        """
        checkpoint = self.create_pre_mutation_checkpoint(reason=reason, paths=paths)
        try:
            yield checkpoint
        except Exception as exc:
            self.rollback_seed_agent(
                checkpoint=checkpoint,
                reason=f"exception during mutation: {exc}",
            )
            raise

    def check_python_syntax(self, path: Path | None = None) -> tuple[bool, str | None]:
        """Return (ok, error_message) after ``py_compile`` on the target file."""
        target = Path(path or self.seed_path)
        try:
            py_compile.compile(str(target), doraise=True)
            self.logger.record("syntax_check", path=str(target), ok=True)
            return True, None
        except py_compile.PyCompileError as exc:
            detail = str(exc)
            self.logger.record(
                "syntax_check", path=str(target), ok=False, error=detail
            )
            return False, detail

    def run_evaluate_agent(
        self,
        *,
        eval_script: Path | None = None,
        cwd: Path | None = None,
        timeout_s: float = 180.0,
        check_syntax_first: bool = True,
    ) -> EvaluateAgentResult:
        """Run ``evaluate_agent.py`` and parse PASS/FAIL + SCORE.

        Always logs the result so evolutionary history stays auditable.
        """
        target = self.seed_path
        if check_syntax_first:
            ok, err = self.check_python_syntax(target)
            if not ok:
                result = EvaluateAgentResult(
                    passed=False,
                    score=0.0,
                    points=0,
                    max_points=4,
                    returncode=1,
                    syntax_ok=False,
                    output="",
                    error=err,
                )
                self.logger.record(
                    "evaluate_agent",
                    **result.as_dict(),
                    path=str(target),
                )
                return result

        script = Path(eval_script or DEFAULT_EVAL).resolve()
        workdir = Path(cwd or self.repo)
        env = os.environ.copy()
        scripts_dir = str(script.parent)
        env["PYTHONPATH"] = os.pathsep.join(
            [scripts_dir, env["PYTHONPATH"]] if env.get("PYTHONPATH") else [scripts_dir]
        )
        try:
            completed = subprocess.run(
                [sys.executable, str(script)],
                capture_output=True,
                text=True,
                cwd=str(workdir),
                env=env,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            result = EvaluateAgentResult(
                passed=False,
                score=0.0,
                points=0,
                max_points=4,
                returncode=124,
                syntax_ok=True,
                output=(exc.stdout or "") if isinstance(exc.stdout, str) else "",
                error=f"evaluate_agent timed out after {timeout_s}s",
            )
            self.logger.record("evaluate_agent", **result.as_dict())
            return result

        output = (completed.stdout or "") + (
            f"\n----- stderr -----\n{completed.stderr}" if completed.stderr else ""
        )
        passed = bool(re.search(r"^RESULT:\s*PASS\s*$", output, re.M))
        score = None
        points = None
        max_points = None
        score_match = re.search(
            r"^SCORE:\s*(\d+)\s*/\s*(\d+)\s*\(([0-9.]+)\)\s*$", output, re.M
        )
        if score_match:
            points = int(score_match.group(1))
            max_points = int(score_match.group(2))
            score = float(score_match.group(3))
        elif passed:
            score, points, max_points = 1.0, 4, 4
        else:
            score, points, max_points = 0.0, 0, 4

        result = EvaluateAgentResult(
            passed=passed,
            score=score,
            points=points,
            max_points=max_points,
            returncode=completed.returncode,
            syntax_ok=True,
            output=output,
            error=None if passed else "evaluate_agent reported FAIL",
        )
        self.logger.record(
            "evaluate_agent",
            passed=result.passed,
            score=result.score,
            points=result.points,
            max_points=result.max_points,
            returncode=result.returncode,
            syntax_ok=result.syntax_ok,
            result=result.result_label,
        )
        return result

    def apply_mutation_with_evaluation(
        self,
        mutated_source: str,
        *,
        description: str,
        attempt_id: str | None = None,
        eval_script: Path | None = None,
        cwd: Path | None = None,
        commit_message: str | None = None,
        skip_evaluate_agent: bool = False,
        evaluation_passed: bool | None = None,
        score: float | None = None,
    ) -> MutationOutcome:
        """Checkpoint → write mutation → syntax/eval monitor → commit or rollback.

        If ``skip_evaluate_agent`` is True, callers must pass ``evaluation_passed``
        (used by offline tests or external harnesses).
        """
        attempt = attempt_id or f"mut-{_utc_now().replace(':', '')}"
        checkpoint = self.create_pre_mutation_checkpoint(
            reason=f"pre-mutation:{attempt}",
            paths=[self.seed_path],
        )
        self.record_mutation_attempt(
            attempt_id=attempt,
            description=description,
            extra={"bytes": len(mutated_source)},
        )

        self.seed_path.write_text(mutated_source, encoding="utf-8")
        # Drop stale bytecode so evaluate_agent imports the new source.
        for stale in self.seed_path.parent.glob("__pycache__/seed_agent*.pyc"):
            stale.unlink(missing_ok=True)

        if skip_evaluate_agent:
            if evaluation_passed is None:
                raise GitSafetyError(
                    "skip_evaluate_agent requires evaluation_passed=True/False"
                )
            evaluation = EvaluateAgentResult(
                passed=bool(evaluation_passed),
                score=score,
                points=None,
                max_points=None,
                returncode=0 if evaluation_passed else 1,
                syntax_ok=True,
                output="(external evaluation)",
            )
        else:
            evaluation = self.run_evaluate_agent(
                eval_script=eval_script, cwd=cwd or self.repo
            )

        self.record_test_result(
            attempt_id=attempt,
            passed=evaluation.passed and evaluation.syntax_ok,
            score=evaluation.score,
            details=evaluation.result_label,
            extra={
                "syntax_ok": evaluation.syntax_ok,
                "returncode": evaluation.returncode,
                "error": evaluation.error,
            },
        )

        ok = bool(evaluation.syntax_ok and evaluation.passed)
        if ok:
            message = commit_message or format_evolution_commit_message(
                description=description,
                passed=True,
                score=evaluation.score,
                syntax_ok=evaluation.syntax_ok,
                attempt_id=attempt,
            )
            sha = self.commit_mutation(message, paths=[self.seed_path])
            if sha:
                self.mark_known_good(sha)
            outcome = MutationOutcome(
                decision="COMMIT",
                checkpoint=checkpoint,
                evaluation=evaluation,
                commit_sha=sha,
                commit_message=message,
                attempt_id=attempt,
            )
            self.logger.record("mutation_outcome", **outcome.as_dict())
            return outcome

        reason = (
            "syntax error after mutation"
            if not evaluation.syntax_ok
            else "evaluate_agent biological benchmark FAIL"
        )
        restored = self.rollback_seed_agent(checkpoint=checkpoint, reason=reason)
        outcome = MutationOutcome(
            decision="ROLLBACK",
            checkpoint=checkpoint,
            evaluation=evaluation,
            restored_from=restored,
            attempt_id=attempt,
        )
        self.logger.record("mutation_outcome", **outcome.as_dict())
        return outcome

    # -- internals ----------------------------------------------------------

    def _ensure_repo(self) -> None:
        probe = _run_git(
            self.repo, ["rev-parse", "--is-inside-work-tree"], check=False
        )
        if probe.returncode != 0 or probe.stdout.strip() != "true":
            raise GitSafetyError(f"not a git repository: {self.repo}")

    def _rel(self, path: Path) -> str:
        resolved = Path(path).resolve()
        try:
            return str(resolved.relative_to(self.repo))
        except ValueError as exc:
            raise GitSafetyError(
                f"path {resolved} is outside repo {self.repo}"
            ) from exc

    def _blob_sha(self, rel_path: str) -> str | None:
        result = _run_git(
            self.repo, ["hash-object", rel_path], check=False
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None

    def _paths_are_dirty(self, rels: Sequence[str], status: GitStatus) -> bool:
        dirty = set(status.staged + status.unstaged + status.untracked)
        for rel in rels:
            if rel in dirty:
                return True
            # Also catch directory prefixes / renames listed with quotes etc.
            for item in dirty:
                if item == rel or item.startswith(rel + "/"):
                    return True
        return False

    def _latest_stash_ref(self, message: str) -> str | None:
        listing = _run_git(
            self.repo, ["stash", "list", "--format=%gd\t%s"]
        ).stdout
        for line in listing.splitlines():
            if "\t" not in line:
                continue
            ref, subject = line.split("\t", 1)
            if message in subject:
                return ref.strip()
        # Fallback to stash@{0} if we just created one.
        if listing.strip():
            return "stash@{0}"
        return None

    def _drop_stash(self, stash_ref: str) -> None:
        result = _run_git(
            self.repo, ["stash", "drop", stash_ref], check=False
        )
        self.logger.record(
            "stash_dropped",
            stash_ref=stash_ref,
            ok=result.returncode == 0,
            detail=(result.stderr or result.stdout or "").strip(),
        )


def format_evolution_commit_message(
    *,
    description: str,
    passed: bool,
    score: float | None = None,
    syntax_ok: bool = True,
    attempt_id: str | None = None,
) -> str:
    """Descriptive automated commit message for evolutionary history."""
    status = "pass" if passed and syntax_ok else "fail"
    score_bit = f" score={score:.3f}" if score is not None else ""
    attempt_bit = f" [{attempt_id}]" if attempt_id else ""
    summary = description.strip().replace("\n", " ")
    if len(summary) > 72:
        summary = summary[:69] + "..."
    return f"evolve({status}): {summary}{score_bit}{attempt_bit}"


# ---------------------------------------------------------------------------
# Offline self-test (isolated temporary git repo)
# ---------------------------------------------------------------------------


def _init_temp_repo() -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
    tmp = tempfile.TemporaryDirectory(prefix="flux-git-safety-")
    root = Path(tmp.name)
    scripts = root / "scripts"
    scripts.mkdir()
    seed = scripts / "seed_agent.py"
    seed.write_text(
        "# known-good seed\ndef run():\n    return 'ok'\n",
        encoding="utf-8",
    )
    _run_git(root, ["init"])
    _run_git(root, ["config", "user.email", "git-safety@flux.ai"])
    _run_git(root, ["config", "user.name", "Flux Git Safety"])
    # Prefer a stable default branch name across git versions.
    _run_git(root, ["checkout", "-b", "main"], check=False)
    _run_git(root, ["add", "scripts/seed_agent.py"])
    _run_git(root, ["commit", "-m", "initial known-good seed"])
    return tmp, root, seed


def run_self_test() -> int:
    """Exercise status → checkpoint → commit / rollback → history log."""
    tmp, root, seed = _init_temp_repo()
    log_path = root / ".flux" / "mutation_history.log"
    try:
        safety = GitSafety(repo=root, seed_path=seed, log_path=log_path)

        print("Self-test 1: git status on clean tree")
        status = safety.check_git_status()
        if not status.clean:
            print("FAIL: expected clean status", file=sys.stderr)
            return 1
        good = status.head_sha
        safety.mark_known_good(good)
        print(f"  clean @ {good[:8]}")

        print("Self-test 2: checkpoint before mutation")
        checkpoint = safety.create_checkpoint(reason="self-test mutation")
        if checkpoint.good_sha != good:
            print("FAIL: checkpoint good_sha mismatch", file=sys.stderr)
            return 1
        print(f"  checkpoint {checkpoint.id}")

        print("Self-test 3: apply bad mutation → rollback on FAIL")
        seed.write_text("# broken mutation\nraise RuntimeError('boom')\n", encoding="utf-8")
        safety.record_mutation_attempt(
            attempt_id="t3",
            description="inject broken seed",
        )
        safety.record_test_result(
            attempt_id="t3",
            passed=False,
            score=0.0,
            details="simulated evaluation FAIL",
        )
        restored = safety.rollback_seed_agent(
            checkpoint=checkpoint,
            reason="self-test FAIL",
        )
        content = seed.read_text(encoding="utf-8")
        if "known-good seed" not in content:
            print("FAIL: rollback did not restore known-good seed", file=sys.stderr)
            return 1
        if restored != good:
            print(f"FAIL: restored {restored}, expected {good}", file=sys.stderr)
            return 1
        print(f"  rolled back to {restored[:8]}")

        print("Self-test 4: successful mutation → commit")
        seed.write_text(
            "# known-good seed\ndef run():\n    return 'ok-improved'\n",
            encoding="utf-8",
        )
        decision = safety.guard_mutation(
            attempt_id="t4",
            description="improve return value",
            evaluation_passed=True,
            score=1.0,
            commit_message="test: retain improved seed_agent",
            details="simulated evaluation PASS",
        )
        if not decision.startswith("COMMIT"):
            print(f"FAIL: expected COMMIT, got {decision}", file=sys.stderr)
            return 1
        head = _run_git(root, ["rev-parse", "HEAD"]).stdout.strip()
        if head == good:
            print("FAIL: successful mutation did not create a new commit", file=sys.stderr)
            return 1
        print(f"  {decision}")

        print("Self-test 5: history log contains required actions")
        entries = safety.logger.read_entries()
        actions = [entry["action"] for entry in entries]
        required = {
            "git_status",
            "mark_known_good",
            "checkpoint_created",
            "mutation_attempt",
            "test_result",
            "rollback",
            "commit_mutation",
        }
        missing = required - set(actions)
        if missing:
            print(f"FAIL: log missing actions {sorted(missing)}", file=sys.stderr)
            return 1
        print(f"  log entries: {len(entries)} @ {log_path}")

        print("Self-test 6: syntax failure → automatic ROLLBACK")
        broken_syntax = "def oops(:\n    return 1\n"
        outcome_syntax = safety.apply_mutation_with_evaluation(
            broken_syntax,
            description="inject syntax error",
            attempt_id="t6-syntax",
            # Force syntax path without needing a real evaluate_agent in temp repo.
            skip_evaluate_agent=False,
            eval_script=root / "scripts" / "missing_evaluate_agent.py",
        )
        # Missing eval script never reached if syntax fails first.
        if outcome_syntax.decision != "ROLLBACK":
            print(
                f"FAIL: expected ROLLBACK on syntax error, got {outcome_syntax.decision}",
                file=sys.stderr,
            )
            return 1
        if outcome_syntax.evaluation is None or outcome_syntax.evaluation.syntax_ok:
            print("FAIL: syntax_ok should be False", file=sys.stderr)
            return 1
        if "ok-improved" not in seed.read_text(encoding="utf-8"):
            # Last successful commit content should still be on disk after rollback
            # of the syntax mutation (rollback restores known-good from checkpoint
            # which was HEAD after test 4 commit = ok-improved).
            print("FAIL: syntax rollback lost last good content", file=sys.stderr)
            return 1
        print(f"  {outcome_syntax.decision} (syntax)")

        print("Self-test 7: apply_mutation_with_evaluation COMMIT path")
        # Mark current HEAD known-good then improve via external eval flag.
        safety.mark_known_good()
        outcome_ok = safety.apply_mutation_with_evaluation(
            "# known-good seed\ndef run():\n    return 'ok-evolved'\n",
            description="evolve return marker",
            attempt_id="t7-commit",
            skip_evaluate_agent=True,
            evaluation_passed=True,
            score=1.0,
        )
        if outcome_ok.decision != "COMMIT" or not outcome_ok.commit_sha:
            print(f"FAIL: expected COMMIT, got {outcome_ok.as_dict()}", file=sys.stderr)
            return 1
        if "ok-evolved" not in seed.read_text(encoding="utf-8"):
            print("FAIL: committed content missing", file=sys.stderr)
            return 1
        if not (outcome_ok.commit_message or "").startswith("evolve(pass):"):
            print(
                f"FAIL: unexpected commit message {outcome_ok.commit_message!r}",
                file=sys.stderr,
            )
            return 1
        print(f"  {outcome_ok.decision} {outcome_ok.commit_sha[:8]}")

        print("Self-test 8: biological benchmark FAIL → ROLLBACK")
        before = seed.read_text(encoding="utf-8")
        outcome_fail = safety.apply_mutation_with_evaluation(
            "# broken biology\ndef run():\n    raise RuntimeError('bad')\n",
            description="break biological benchmark",
            attempt_id="t8-fail",
            skip_evaluate_agent=True,
            evaluation_passed=False,
            score=0.0,
        )
        if outcome_fail.decision != "ROLLBACK":
            print(f"FAIL: expected ROLLBACK, got {outcome_fail.decision}", file=sys.stderr)
            return 1
        if seed.read_text(encoding="utf-8") != before:
            print("FAIL: benchmark FAIL did not restore prior content", file=sys.stderr)
            return 1
        print(f"  {outcome_fail.decision} → {outcome_fail.restored_from[:8]}")

        print("\ngit_safety self-test: ok")
        return 0
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return 1
    finally:
        tmp.cleanup()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo",
        type=Path,
        default=DEFAULT_REPO,
        help="Git repository root (default: Flux.ai workspace)",
    )
    parser.add_argument(
        "--seed",
        type=Path,
        default=DEFAULT_SEED,
        help="Path to seed_agent.py",
    )
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="Mutation history log path (default: <repo>/.flux/mutation_history.log)",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Print git status JSON and exit",
    )
    parser.add_argument(
        "--checkpoint",
        action="store_true",
        help="Create a pre-mutation checkpoint and print it as JSON",
    )
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="Run evaluate_agent.py against --seed and print the result JSON",
    )
    parser.add_argument(
        "--eval-script",
        type=Path,
        default=DEFAULT_EVAL,
        help="Path to evaluate_agent.py",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run offline safety checks in a temporary git repo",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()

    safety = GitSafety(repo=args.repo, seed_path=args.seed, log_path=args.log)
    if args.status:
        status = safety.check_git_status()
        print(json.dumps(status.as_dict(), indent=2))
        return 0
    if args.checkpoint:
        checkpoint = safety.create_pre_mutation_checkpoint(reason="cli-checkpoint")
        print(json.dumps(checkpoint.as_dict(), indent=2))
        return 0
    if args.evaluate:
        result = safety.run_evaluate_agent(eval_script=args.eval_script)
        print(json.dumps(result.as_dict(), indent=2))
        return 0 if result.passed and result.syntax_ok else 1

    # Default: show status summary so the script is useful without flags.
    status = safety.check_git_status()
    print(
        f"branch={status.branch} head={status.head_sha[:8]} "
        f"clean={status.clean} log={safety.logger.log_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
