#!/usr/bin/env python3
"""OpenRouter-powered meta-brain for Flux.ai autonomous code evolution.

Sends a failed simulation dossier plus the current Python source to a frontier
model, prompting it as an expert computational biologist *and* software
engineer to return a minimal patch or full script replacement.

Outputs are structured for:
  * ``meta_loop.py`` — ``(rationale, updated_source)`` mutator contract
  * ``git_safety.py`` — checkpoint → apply → commit / rollback helpers
  * token-usage accounting for cost-aware agent loops

Example::

    python3 scripts/meta_brain.py --self-test
    python3 scripts/meta_brain.py --dossier /tmp/fail.json --script scripts/seed_agent.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import git_safety  # noqa: E402
import meta_loop  # noqa: E402

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
DEFAULT_LOG = SCRIPTS_DIR.parent / ".flux" / "meta_brain_history.log"

Mutator = Callable[[str, str], tuple[str, str]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    raw: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "raw": dict(self.raw),
        }

    def accumulate(self, other: "TokenUsage") -> "TokenUsage":
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.total_tokens += other.total_tokens
        return self


@dataclass
class MutationProposal:
    """Parsed LLM output ready for meta_loop + git_safety."""

    rationale: str
    mode: str  # "full_replacement" | "minimal_patch"
    updated_source: str | None = None
    patch_unified: str | None = None
    target_script: str = ""
    commit_message: str = ""
    model: str = ""
    usage: TokenUsage = field(default_factory=TokenUsage)
    raw_response: dict[str, Any] = field(default_factory=dict)
    dossier_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "rationale": self.rationale,
            "mode": self.mode,
            "updated_source": self.updated_source,
            "patch_unified": self.patch_unified,
            "target_script": self.target_script,
            "commit_message": self.commit_message,
            "model": self.model,
            "usage": self.usage.as_dict(),
            "dossier_id": self.dossier_id,
        }

    def for_meta_loop(self) -> tuple[str, str]:
        """meta_loop mutator contract: (rationale, updated_source)."""
        if not self.updated_source or not self.updated_source.strip():
            raise RuntimeError(
                "MutationProposal has no updated_source for meta_loop "
                f"(mode={self.mode!r})"
            )
        return self.rationale, self.updated_source


class MetaBrainError(RuntimeError):
    """Raised when the OpenRouter call or response parsing fails."""


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


class MetaBrainLogger:
    def __init__(self, log_path: Path = DEFAULT_LOG) -> None:
        self.log_path = Path(log_path)

    def record(self, action: str, **payload: Any) -> dict[str, Any]:
        entry = {"timestamp": _utc_now(), "action": action, **payload}
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True, default=str) + "\n")
        return entry


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


SYSTEM_PROMPT = """You are the autonomous system architect for flux.ai.
Respond with a SINGLE JSON object only — no markdown fences, no prose outside JSON.
Schema:
{
  "rationale": string,
  "mode": "full_replacement" | "minimal_patch",
  "updated_source": string | null,
  "patch_unified": string | null,
  "commit_message": string
}
If mode is minimal_patch you MUST still include updated_source (full file after patch).
"""


PRE_MUTATION_PROMPT_TEMPLATE = """
You are the autonomous system architect for flux.ai, an in silico clinical trial and cellular simulation engine.

### Current Mission:
Fix or optimize the target module based on the recent evaluation failure dossier. Your code must maintain strict numerical stability, scientific rigor (pharmacokinetics/toxicology kinetics), and clean Python syntax.

### Evaluation Feedback & Error Dossier:
{evaluation_error_report}

### Target File ({target_file_path}):
```python
{target_file_content}
```

### Constraints:
1. Prefer the smallest correct change that addresses the dossier root cause.
2. Preserve public APIs, CLI flags, and `--self-test` unless the failure requires changing them.
3. Use the Python standard library only — do not invent third-party dependencies.
4. Keep pharmacokinetics / toxicology / cohort numerics stable (no NaNs, no divide-by-zero, clamp where needed).
5. Do not claim clinical validation; stay consistent with Flux toy in-silico models.
6. Output MUST be a single JSON object (no markdown fences) with keys:
   `rationale`, `mode` (`full_replacement`|`minimal_patch`), `updated_source`,
   `patch_unified`, `commit_message`.
7. When `mode` is `minimal_patch`, still provide `updated_source` as the complete
   post-patch file so git_safety / meta_loop can apply it atomically.

### Extra Context:
{extra_context}
""".strip()


def build_user_prompt(
    *,
    dossier: Mapping[str, Any] | str,
    source: str,
    script_path: str,
    extra_context: str = "",
) -> str:
    """Render ``PRE_MUTATION_PROMPT_TEMPLATE`` for OpenRouter / meta_loop."""
    if isinstance(dossier, Mapping):
        dossier_text = json.dumps(dossier, indent=2, sort_keys=True, default=str)
    else:
        dossier_text = str(dossier)
    # Keep prompts bounded for token control.
    dossier_text = dossier_text[-14000:]
    source_text = source
    if len(source_text) > 60000:
        source_text = source_text[:60000] + "\n# ... truncated ...\n"

    # Manual substitution: target source often contains `{` / `}` which would
    # break str.format.
    return (
        PRE_MUTATION_PROMPT_TEMPLATE.replace(
            "{evaluation_error_report}", dossier_text
        )
        .replace("{target_file_path}", script_path)
        .replace("{target_file_content}", source_text)
        .replace("{extra_context}", extra_context.strip() or "(none)")
    )


# ---------------------------------------------------------------------------
# Response parsing + token usage
# ---------------------------------------------------------------------------


def parse_json_object(raw: str) -> dict[str, Any]:
    """Parse a JSON object from model content, tolerating markdown fences."""
    text = raw.strip()
    if not text:
        raise MetaBrainError("empty model content")
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
        # Handle trailing fence remnants
        if "```" in text:
            text = text.split("```", 1)[0].strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        # Last resort: extract outermost {...}
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise MetaBrainError(f"response is not JSON: {exc}") from exc
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc2:
            raise MetaBrainError(f"failed to parse JSON object: {exc2}") from exc2
    if not isinstance(data, dict):
        raise MetaBrainError("JSON root must be an object")
    return data


def extract_token_usage(body: Mapping[str, Any]) -> TokenUsage:
    usage = body.get("usage") or {}
    if not isinstance(usage, Mapping):
        usage = {}
    prompt = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    completion = int(
        usage.get("completion_tokens") or usage.get("output_tokens") or 0
    )
    total = int(usage.get("total_tokens") or (prompt + completion))
    return TokenUsage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        raw=dict(usage),
    )


def parse_mutation_response(
    body: Mapping[str, Any],
    *,
    target_script: str,
    model: str,
    dossier_id: str | None = None,
) -> MutationProposal:
    """Validate OpenRouter chat.completion payload into MutationProposal."""
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise MetaBrainError(f"malformed OpenRouter response: {exc}") from exc
    if not isinstance(content, str):
        raise MetaBrainError("model content is not a string")

    data = parse_json_object(content)
    rationale = str(data.get("rationale") or "").strip() or "(no rationale)"
    mode = str(data.get("mode") or "full_replacement").strip()
    if mode not in {"full_replacement", "minimal_patch"}:
        mode = "full_replacement"

    updated = data.get("updated_source")
    patch = data.get("patch_unified")
    if updated is not None and not isinstance(updated, str):
        raise MetaBrainError("updated_source must be a string or null")
    if patch is not None and not isinstance(patch, str):
        raise MetaBrainError("patch_unified must be a string or null")

    if mode == "full_replacement" and (not updated or not updated.strip()):
        raise MetaBrainError("full_replacement requires non-empty updated_source")
    if mode == "minimal_patch" and (not updated or not str(updated).strip()):
        # Enforce atomic apply path for git_safety / meta_loop.
        raise MetaBrainError(
            "minimal_patch must also include updated_source (full file after patch)"
        )

    commit_message = str(data.get("commit_message") or "").strip()
    if not commit_message:
        commit_message = f"meta-brain: evolve {Path(target_script).name}"

    return MutationProposal(
        rationale=rationale,
        mode=mode,
        updated_source=updated,
        patch_unified=patch,
        target_script=target_script,
        commit_message=commit_message,
        model=model,
        usage=extract_token_usage(body),
        raw_response=dict(body) if isinstance(body, dict) else {},
        dossier_id=dossier_id,
    )


# ---------------------------------------------------------------------------
# OpenRouter connector
# ---------------------------------------------------------------------------


@dataclass
class OpenRouterClient:
    """Thin OpenRouter Chat Completions client with usage tracking."""

    api_key: str | None = None
    api_base: str = OPENROUTER_URL
    model: str = DEFAULT_MODEL
    timeout_s: float = 120.0
    temperature: float = 0.2
    referer: str = "https://github.com/flux-ai"
    title: str = "Flux.ai meta-brain"
    cumulative_usage: TokenUsage = field(default_factory=TokenUsage)
    logger: MetaBrainLogger | None = None

    def _resolve_key(self) -> str:
        key = self.api_key or os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise MetaBrainError(
                "OPENROUTER_API_KEY is not set. Export a key, or use --self-test / "
                "a mock transport."
            )
        return key

    def chat(
        self,
        *,
        system: str,
        user: str,
        model: str | None = None,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        key = self._resolve_key()
        model_name = model or self.model
        payload = {
            "model": model_name,
            "temperature": self.temperature if temperature is None else temperature,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        request = urllib.request.Request(
            self.api_base,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "HTTP-Referer": self.referer,
                "X-Title": self.title,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if self.logger:
                self.logger.record(
                    "openrouter_http_error",
                    status=exc.code,
                    detail=detail[:2000],
                    model=model_name,
                )
            raise MetaBrainError(f"OpenRouter HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            if self.logger:
                self.logger.record("openrouter_url_error", error=str(exc), model=model_name)
            raise MetaBrainError(f"OpenRouter network error: {exc}") from exc
        except TimeoutError as exc:
            if self.logger:
                self.logger.record("openrouter_timeout", model=model_name)
            raise MetaBrainError(f"OpenRouter timeout after {self.timeout_s}s") from exc
        except json.JSONDecodeError as exc:
            raise MetaBrainError(f"OpenRouter returned non-JSON body: {exc}") from exc

        usage = extract_token_usage(body)
        self.cumulative_usage.accumulate(usage)
        if self.logger:
            self.logger.record(
                "openrouter_chat",
                model=model_name,
                usage=usage.as_dict(),
                cumulative=self.cumulative_usage.as_dict(),
            )
        return body


class MetaBrain:
    """High-level evolution brain: dossier + script → MutationProposal."""

    def __init__(
        self,
        *,
        client: OpenRouterClient | None = None,
        model: str = DEFAULT_MODEL,
        logger: MetaBrainLogger | None = None,
    ) -> None:
        self.logger = logger or MetaBrainLogger()
        self.client = client or OpenRouterClient(model=model, logger=self.logger)
        if model and self.client.model != model:
            self.client.model = model

    def propose_mutation(
        self,
        *,
        dossier: Mapping[str, Any] | str,
        source: str,
        script_path: str | Path,
        extra_context: str = "",
        model: str | None = None,
    ) -> MutationProposal:
        script_path_s = str(script_path)
        dossier_id = None
        if isinstance(dossier, Mapping):
            dossier_id = (
                dossier.get("dossier_id")
                or dossier.get("trial_id")
                or (dossier.get("trial") or {}).get("trial_id")
            )
        user = build_user_prompt(
            dossier=dossier,
            source=source,
            script_path=script_path_s,
            extra_context=extra_context,
        )
        try:
            body = self.client.chat(
                system=SYSTEM_PROMPT, user=user, model=model
            )
            proposal = parse_mutation_response(
                body,
                target_script=script_path_s,
                model=model or self.client.model,
                dossier_id=str(dossier_id) if dossier_id else None,
            )
        except MetaBrainError:
            self.logger.record(
                "propose_mutation_error",
                script_path=script_path_s,
                dossier_id=dossier_id,
                error=traceback.format_exc()[-1500:],
            )
            raise

        self.logger.record(
            "propose_mutation",
            script_path=script_path_s,
            dossier_id=dossier_id,
            mode=proposal.mode,
            usage=proposal.usage.as_dict(),
            commit_message=proposal.commit_message,
            rationale=proposal.rationale[:500],
        )
        return proposal

    def propose_from_paths(
        self,
        *,
        dossier_path: Path,
        script_path: Path,
        extra_context: str = "",
        model: str | None = None,
    ) -> MutationProposal:
        dossier = json.loads(Path(dossier_path).read_text(encoding="utf-8"))
        source = Path(script_path).read_text(encoding="utf-8")
        return self.propose_mutation(
            dossier=dossier,
            source=source,
            script_path=script_path,
            extra_context=extra_context,
            model=model,
        )

    def as_meta_loop_mutator(self, script_path: str | Path = "scripts/seed_agent.py") -> Mutator:
        """Return a mutator compatible with meta_loop.meta_loop(..., mutator=...).

        The mutator interprets ``eval_logs`` as either plain text or a JSON
        dossier string. When JSON parse fails, it wraps logs in a minimal
        dossier envelope.
        """

        path = str(script_path)

        def _mutator(source: str, eval_logs: str) -> tuple[str, str]:
            dossier: Mapping[str, Any] | str
            try:
                loaded = json.loads(eval_logs)
                dossier = loaded if isinstance(loaded, dict) else {"logs": eval_logs}
            except json.JSONDecodeError:
                dossier = {
                    "schema_version": "meta-brain-wrap/1",
                    "platform_passed": False,
                    "logs": eval_logs[-12000:],
                }
            proposal = self.propose_mutation(
                dossier=dossier, source=source, script_path=path
            )
            return proposal.for_meta_loop()

        return _mutator


def apply_proposal_with_git_safety(
    proposal: MutationProposal,
    *,
    safety: git_safety.GitSafety | None = None,
    repo: Path | None = None,
    evaluate: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Write updated_source under git_safety checkpoint / commit / rollback.

    If ``evaluate`` is provided and returns False, rolls back seed/target file
    to the checkpoint good SHA. Without evaluate, commits the mutation.
    """
    if not proposal.updated_source:
        raise MetaBrainError("cannot apply proposal without updated_source")

    target = Path(proposal.target_script)
    if not target.is_absolute():
        root = Path(repo) if repo else SCRIPTS_DIR.parent
        target = (root / target).resolve()

    safety = safety or git_safety.GitSafety(
        repo=repo or SCRIPTS_DIR.parent, seed_path=target
    )
    checkpoint = safety.create_checkpoint(
        reason=f"meta-brain:{Path(target).name}", paths=[target]
    )
    safety.record_mutation_attempt(
        attempt_id=f"meta-brain-{_utc_now()}",
        description=proposal.rationale[:200],
        extra={"mode": proposal.mode, "model": proposal.model},
    )

    target.write_text(proposal.updated_source, encoding="utf-8")
    passed = True if evaluate is None else bool(evaluate())
    safety.record_test_result(
        attempt_id=f"meta-brain-eval-{Path(target).name}",
        passed=passed,
        details=proposal.commit_message,
    )

    if passed:
        sha = safety.commit_mutation(
            proposal.commit_message or f"meta-brain: update {target.name}",
            paths=[target],
        )
        return {
            "decision": "COMMIT",
            "commit_sha": sha,
            "checkpoint": checkpoint.as_dict(),
            "passed": True,
        }

    restored = safety.rollback_seed_agent(
        checkpoint=checkpoint,
        reason="meta-brain evaluation failed after mutation",
    )
    return {
        "decision": "ROLLBACK",
        "restored_from": restored,
        "checkpoint": checkpoint.as_dict(),
        "passed": False,
    }


# Convenience: drop-in replacement surface for meta_loop.request_openrouter_mutation
def request_dossier_mutation(
    *,
    source: str,
    dossier: Mapping[str, Any] | str,
    script_path: str | Path = "scripts/seed_agent.py",
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
) -> tuple[str, str]:
    """Ask OpenRouter for a repaired script given a failed dossier.

    Returns ``(rationale, updated_source)`` for meta_loop retention flows.
    """
    brain = MetaBrain(
        client=OpenRouterClient(api_key=api_key, model=model),
        model=model,
    )
    proposal = brain.propose_mutation(
        dossier=dossier, source=source, script_path=script_path, model=model
    )
    return proposal.for_meta_loop()


# ---------------------------------------------------------------------------
# Self-test / CLI
# ---------------------------------------------------------------------------


def run_self_test() -> int:
    # Parsing + usage extraction without network
    fake_body = {
        "choices": [
            {
                "message": {
                    "content": json.dumps(
                        {
                            "rationale": "Raise safety_scale floor for phenol scaffolds.",
                            "mode": "full_replacement",
                            "updated_source": "print('evolved')\n",
                            "patch_unified": None,
                            "commit_message": "fix: harden phenol safety_scale",
                        }
                    )
                }
            }
        ],
        "usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 300,
            "total_tokens": 1500,
        },
    }
    proposal = parse_mutation_response(
        fake_body,
        target_script="scripts/toxicology_engine.py",
        model="test/model",
        dossier_id="dossier-test",
    )
    assert proposal.mode == "full_replacement"
    assert proposal.usage.total_tokens == 1500
    rationale, source = proposal.for_meta_loop()
    assert "phenol" in rationale or "safety" in rationale
    assert source.startswith("print")

    # Fence-tolerant parser
    fenced = parse_json_object(
        "```json\n{\"rationale\": \"x\", \"mode\": \"full_replacement\", "
        "\"updated_source\": \"y\\n\", \"commit_message\": \"z\"}\n```"
    )
    assert fenced["updated_source"] == "y\n"

    # Prompt contains dossier + source via PRE_MUTATION_PROMPT_TEMPLATE
    prompt = build_user_prompt(
        dossier={"dossier_id": "d1", "platform_passed": False, "platform_score": 0.1},
        source="def foo(x={1}):\n    return 1\n",  # braces must not break templating
        script_path="scripts/foo.py",
    )
    assert "d1" in prompt and "def foo" in prompt
    assert "autonomous system architect" in prompt.lower()
    assert "scripts/foo.py" in prompt
    assert "{1}" in prompt  # source braces preserved
    assert "autonomous system architect" in SYSTEM_PROMPT.lower()

    # Mock transport client (no network)
    class _MockClient(OpenRouterClient):
        def chat(self, *, system: str, user: str, model: str | None = None, temperature: float | None = None) -> dict[str, Any]:
            usage = TokenUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15)
            self.cumulative_usage.accumulate(usage)
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "rationale": "mock fix",
                                    "mode": "full_replacement",
                                    "updated_source": source_out,
                                    "commit_message": "test: mock evolution",
                                }
                            )
                        }
                    }
                ],
                "usage": usage.as_dict(),
            }

    source_out = "# evolved\nVALUE = 2\n"
    log_path = Path("/tmp/flux-meta-brain-test.log")
    if log_path.exists():
        log_path.unlink()
    brain = MetaBrain(
        client=_MockClient(api_key="test", logger=MetaBrainLogger(log_path)),
        logger=MetaBrainLogger(log_path),
    )
    prop = brain.propose_mutation(
        dossier={"dossier_id": "d-mock", "platform_passed": False},
        source="VALUE = 1\n",
        script_path="scripts/dummy.py",
    )
    assert prop.updated_source == source_out
    assert brain.client.cumulative_usage.total_tokens == 15

    mutator = brain.as_meta_loop_mutator("scripts/dummy.py")
    r, s = mutator("VALUE = 1\n", json.dumps({"dossier_id": "d2", "platform_passed": False}))
    assert s == source_out and r == "mock fix"

    # git_safety apply path in an isolated repo
    import tempfile
    import subprocess

    with tempfile.TemporaryDirectory(prefix="flux-meta-brain-git-") as tmp:
        root = Path(tmp)
        scripts = root / "scripts"
        scripts.mkdir()
        target = scripts / "dummy.py"
        target.write_text("VALUE = 1\n", encoding="utf-8")
        subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "meta-brain@flux.ai"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Flux Meta Brain"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "checkout", "-b", "main"],
            cwd=root,
            check=False,
            capture_output=True,
        )
        subprocess.run(["git", "add", "scripts/dummy.py"], cwd=root, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        safety = git_safety.GitSafety(repo=root, seed_path=target)
        prop2 = MutationProposal(
            rationale="bump value",
            mode="full_replacement",
            updated_source="VALUE = 99\n",
            target_script=str(target),
            commit_message="test: bump VALUE",
            model="mock",
        )
        result = apply_proposal_with_git_safety(
            prop2, safety=safety, repo=root, evaluate=lambda: True
        )
        assert result["decision"] == "COMMIT"
        assert target.read_text(encoding="utf-8") == "VALUE = 99\n"

        prop3 = MutationProposal(
            rationale="bad bump",
            mode="full_replacement",
            updated_source="VALUE = -1\n",
            target_script=str(target),
            commit_message="test: bad bump",
            model="mock",
        )
        result_bad = apply_proposal_with_git_safety(
            prop3, safety=safety, repo=root, evaluate=lambda: False
        )
        assert result_bad["decision"] == "ROLLBACK"
        assert "VALUE = 99" in target.read_text(encoding="utf-8")

    # meta_loop surface still importable / type-compatible
    assert callable(meta_loop.request_openrouter_mutation)

    print("meta_brain self-test: ok")
    print(
        f"  tokens={proposal.usage.total_tokens} "
        f"mock_cumulative={brain.client.cumulative_usage.total_tokens} "
        f"git_commit={result.get('commit_sha', '')[:8]}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dossier", type=Path, help="Failed simulation dossier JSON")
    parser.add_argument(
        "--script",
        type=Path,
        default=SCRIPTS_DIR / "seed_agent.py",
        help="Python script to evolve",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--json", action="store_true", help="Print MutationProposal JSON")
    parser.add_argument("--out", type=Path, help="Write proposal JSON to path")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply proposal via git_safety (commits without re-eval)",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        try:
            return run_self_test()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return 1

    if not args.dossier:
        print("Provide --dossier PATH (or --self-test)", file=sys.stderr)
        return 2

    try:
        brain = MetaBrain(model=args.model)
        proposal = brain.propose_from_paths(
            dossier_path=args.dossier, script_path=args.script, model=args.model
        )
    except MetaBrainError as exc:
        print(f"meta-brain error: {exc}", file=sys.stderr)
        return 1

    text = json.dumps(proposal.as_dict(), indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
        print(f"Wrote {args.out}")
    if args.json or not args.apply:
        print(text)

    if args.apply:
        result = apply_proposal_with_git_safety(proposal)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("passed") else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
