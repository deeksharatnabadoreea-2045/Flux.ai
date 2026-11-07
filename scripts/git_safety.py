#!/usr/bin/env python3
"""Git safety helpers for Flux.ai agent mutations.

Protects `seed_agent.py` (and related mutation targets) by:
  1. Inspecting git status before a mutation
  2. Creating a temporary checkpoint / stash
  3. Committing successful mutations
  4. Rolling back to the last known-good commit when evaluation fails
  5. Appending every attempt, test result, and rollback/commit to a history log

Typical usage from a meta-loop::

    safety = GitSafety()
    checkpoint = safety.create_checkpoint(reason="pre-mutation")
    # ... apply mutation, run evaluate_agent ...
    if evaluation_passed:
        safety.commit_mutation("Retain passing seed_agent mutation")
    else:
        safety.rollback_seed_agent(checkpoint=checkpoint, reason="eval FAIL")
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_REPO = SCRIPTS_DIR.parent
DEFAULT_SEED = SCRIPTS_DIR / "seed_agent.py"
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
            message = commit_message or f"agent mutation OK: {description}"
            sha = self.commit_mutation(message)
            return f"COMMIT {sha or '(noop — nothing staged)'}"
        restored = self.rollback_seed_agent(
            checkpoint=checkpoint,
            reason=f"eval FAIL for {attempt_id}",
        )
        return f"ROLLBACK to {restored}"

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

    # Default: show status summary so the script is useful without flags.
    status = safety.check_git_status()
    print(
        f"branch={status.branch} head={status.head_sha[:8]} "
        f"clean={status.clean} log={safety.logger.log_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
