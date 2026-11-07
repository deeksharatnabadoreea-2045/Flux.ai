#!/usr/bin/env python3
"""Minimal coding agent with four primitive tools and a ReAct-style loop.

Tools:
  - read_file(path)
  - write_file(path, content)
  - list_directory(path=".")
  - run_python(code)

The agent repeatedly: observes → chooses a tool (or finishes) → executes →
appends the observation → repeats until the task is done or max_steps is hit.

Requires OPENAI_API_KEY for live LLM planning. Use --demo for a deterministic
offline walkthrough that still exercises the same tool loop.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import traceback
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator


# ---------------------------------------------------------------------------
# Primitive tools
# ---------------------------------------------------------------------------

ROOT = Path.cwd().resolve()


@contextmanager
def use_workspace(path: str | Path) -> Iterator[Path]:
    """Temporarily run tools against an isolated workspace root."""
    global ROOT
    previous = ROOT
    ROOT = Path(path).resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    try:
        yield ROOT
    finally:
        ROOT = previous


def _resolve(path: str) -> Path:
    """Resolve a path under the working directory; reject escapes."""
    target = (ROOT / path).resolve()
    if not str(target).startswith(str(ROOT)):
        raise ValueError(f"path escapes workspace: {path!r}")
    return target


def read_file(path: str) -> str:
    """Read a UTF-8 text file and return its contents."""
    target = _resolve(path)
    if not target.is_file():
        raise FileNotFoundError(f"not a file: {path}")
    return target.read_text(encoding="utf-8")


def write_file(path: str, content: str) -> str:
    """Write UTF-8 text to a file, creating parents as needed."""
    target = _resolve(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"wrote {len(content)} bytes to {path}"


def list_directory(path: str = ".") -> str:
    """List entries in a directory (name + type)."""
    target = _resolve(path)
    if not target.is_dir():
        raise NotADirectoryError(f"not a directory: {path}")
    lines: list[str] = []
    for entry in sorted(target.iterdir(), key=lambda p: p.name.lower()):
        kind = "dir" if entry.is_dir() else "file"
        lines.append(f"{kind}\t{entry.name}")
    return "\n".join(lines) if lines else "(empty)"


def run_python(code: str) -> str:
    """Execute a Python snippet in a subprocess and return stdout/stderr."""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".py", encoding="utf-8", delete=False
    ) as handle:
        handle.write(code)
        script_path = handle.name
    try:
        completed = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(ROOT),
        )
    finally:
        Path(script_path).unlink(missing_ok=True)

    parts: list[str] = [f"exit_code={completed.returncode}"]
    if completed.stdout:
        parts.append(f"stdout:\n{completed.stdout.rstrip()}")
    if completed.stderr:
        parts.append(f"stderr:\n{completed.stderr.rstrip()}")
    return "\n".join(parts)


TOOL_SPECS: dict[str, dict[str, Any]] = {
    "read_file": {
        "fn": read_file,
        "args": {"path": "str"},
        "description": "Read a UTF-8 text file relative to the workspace.",
    },
    "write_file": {
        "fn": write_file,
        "args": {"path": "str", "content": "str"},
        "description": "Write UTF-8 text to a file (creates parent dirs).",
    },
    "list_directory": {
        "fn": list_directory,
        "args": {"path": "str"},
        "description": "List files and directories at a path (default '.').",
    },
    "run_python": {
        "fn": run_python,
        "args": {"code": "str"},
        "description": "Run a Python code string and return exit code + output.",
    },
}


def dispatch_tool(name: str, args: dict[str, Any]) -> str:
    """Invoke a registered tool by name with the given args."""
    if name not in TOOL_SPECS:
        raise KeyError(f"unknown tool: {name!r}")
    fn: Callable[..., str] = TOOL_SPECS[name]["fn"]
    return fn(**args)


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a coding agent with exactly four tools.
Complete the user's task by calling tools one at a time.

Tools (JSON schemas):
{tools}

Respond with a single JSON object only — no markdown fences, no prose.
Either call a tool:
  {{"thought": "...", "tool": "<name>", "args": {{...}}}}
Or finish:
  {{"thought": "...", "done": true, "answer": "..."}}
"""


def _tool_catalog() -> str:
    lines = []
    for name, spec in TOOL_SPECS.items():
        args = ", ".join(f"{k}: {v}" for k, v in spec["args"].items())
        lines.append(f"- {name}({args}): {spec['description']}")
    return "\n".join(lines)


@dataclass
class Step:
    thought: str
    tool: str | None = None
    args: dict[str, Any] = field(default_factory=dict)
    observation: str | None = None
    answer: str | None = None


@dataclass
class SeedAgent:
    """Coding agent that completes tasks via the four primitive tools."""

    task: str
    max_steps: int = 12
    model: str = "gpt-4o-mini"
    api_base: str = "https://api.openai.com/v1"
    history: list[Step] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)

    def log(self, message: str) -> None:
        self.logs.append(message)
        print(message)

    def run(
        self,
        planner: Callable[["SeedAgent"], dict[str, Any]] | None = None,
        workspace: str | Path | None = None,
    ) -> str:
        """Run the observe → decide → act loop until done or max_steps."""
        if workspace is not None:
            with use_workspace(workspace):
                return self._run_loop(planner)
        return self._run_loop(planner)

    def _run_loop(
        self, planner: Callable[["SeedAgent"], dict[str, Any]] | None
    ) -> str:
        decide = planner or self._llm_decide
        self.log(f"Task: {self.task}\n")

        for step_idx in range(1, self.max_steps + 1):
            self.log(f"--- step {step_idx}/{self.max_steps} ---")
            decision = decide(self)
            thought = str(decision.get("thought", "")).strip()
            if thought:
                self.log(f"thought: {thought}")

            if decision.get("done"):
                answer = str(decision.get("answer", "")).strip() or "(no answer)"
                self.history.append(Step(thought=thought, answer=answer))
                self.log(f"done: {answer}")
                return answer

            tool = decision.get("tool")
            args = decision.get("args") or {}
            if not isinstance(tool, str) or not isinstance(args, dict):
                observation = "error: decision must include tool+args or done=true"
                self.log(observation)
                self.history.append(
                    Step(thought=thought, tool=str(tool), args={}, observation=observation)
                )
                continue

            self.log(f"tool: {tool}({json.dumps(args, ensure_ascii=False)[:200]})")
            try:
                observation = dispatch_tool(tool, args)
            except Exception as exc:  # noqa: BLE001 — surface tool failures to the loop
                observation = f"error: {type(exc).__name__}: {exc}"
            self.log(f"observation:\n{observation}\n")
            self.history.append(
                Step(thought=thought, tool=tool, args=args, observation=observation)
            )

        final = "Stopped: reached max_steps without finishing."
        self.log(final)
        return final

    def _transcript(self) -> str:
        chunks: list[str] = [f"Task: {self.task}"]
        for i, step in enumerate(self.history, 1):
            chunks.append(f"\nStep {i}:")
            if step.thought:
                chunks.append(f"  thought: {step.thought}")
            if step.tool:
                chunks.append(f"  tool: {step.tool}({json.dumps(step.args)})")
                chunks.append(f"  observation: {step.observation}")
            if step.answer is not None:
                chunks.append(f"  answer: {step.answer}")
        return "\n".join(chunks)

    def _llm_decide(self, _self: "SeedAgent") -> dict[str, Any]:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is not set. Export a key, or pass --demo."
            )

        messages = [
            {
                "role": "system",
                "content": SYSTEM_PROMPT.format(tools=_tool_catalog()),
            },
            {
                "role": "user",
                "content": self._transcript()
                + "\n\nChoose the next JSON action to progress the task.",
            },
        ]
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": messages,
            "response_format": {"type": "json_object"},
        }
        request = urllib.request.Request(
            f"{self.api_base.rstrip('/')}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM HTTP {exc.code}: {detail}") from exc

        content = body["choices"][0]["message"]["content"]
        return _parse_decision(content)


# Back-compat alias
Agent = SeedAgent


def _parse_decision(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


# ---------------------------------------------------------------------------
# Deterministic demo planner (no API key required)
# ---------------------------------------------------------------------------

def demo_planner_factory(task: str) -> Callable[[SeedAgent], dict[str, Any]]:
    """Return a scripted planner that uses all four tools against a sample task."""
    out_path = "agent_workspace/hello.py"
    script = (
        '"""Generated by primitive_agent demo."""\n'
        "def greet(name: str = 'world') -> str:\n"
        "    return f'Hello, {name}!'\n"
        "\n"
        "if __name__ == '__main__':\n"
        "    print(greet('Flux'))\n"
    )
    plan = [
        {
            "thought": "See what is already in the workspace.",
            "tool": "list_directory",
            "args": {"path": "."},
        },
        {
            "thought": "Create a small Python module for the demo task.",
            "tool": "write_file",
            "args": {"path": out_path, "content": script},
        },
        {
            "thought": "Confirm the file contents.",
            "tool": "read_file",
            "args": {"path": out_path},
        },
        {
            "thought": "Execute the module to verify it works.",
            "tool": "run_python",
            "args": {
                "code": (
                    "from pathlib import Path\n"
                    f"code = Path({out_path!r}).read_text()\n"
                    "ns = {}\n"
                    "exec(compile(code, 'hello.py', 'exec'), ns)\n"
                    "print(ns['greet']('Flux'))\n"
                )
            },
        },
        {
            "thought": "Task complete: file written and executed.",
            "done": True,
            "answer": (
                f"Wrote {out_path}, verified contents, and ran greet('Flux'). "
                f"Original task was: {task}"
            ),
        },
    ]
    cursor = {"i": 0}

    def planner(_agent: SeedAgent) -> dict[str, Any]:
        if cursor["i"] >= len(plan):
            return {"done": True, "answer": "Demo plan exhausted.", "thought": ""}
        step = plan[cursor["i"]]
        cursor["i"] += 1
        return step

    return planner


def cellular_growth_planner_factory(
    out_path: str = "cellular_growth.py",
) -> Callable[[SeedAgent], dict[str, Any]]:
    """Scripted planner for the cellular-growth evaluation benchmark."""
    script = '''"""Mock exponential cellular growth model for Flux.ai evals."""

def simulate_growth(initial_cells: int, doublings: int) -> list[int]:
    """Return population after each doubling step."""
    if initial_cells < 1:
        raise ValueError("initial_cells must be >= 1")
    if doublings < 0:
        raise ValueError("doublings must be >= 0")
    population = [initial_cells]
    cells = initial_cells
    for _ in range(doublings):
        cells *= 2
        population.append(cells)
    return population


if __name__ == "__main__":
    series = simulate_growth(1, 5)
    assert series == [1, 2, 4, 8, 16, 32], series
    print("growth_ok", series[-1])
'''
    plan = [
        {
            "thought": "Inspect the isolated harness workspace before writing.",
            "tool": "list_directory",
            "args": {"path": "."},
        },
        {
            "thought": "Create the mock cellular growth script.",
            "tool": "write_file",
            "args": {"path": out_path, "content": script},
        },
        {
            "thought": "Read the script back to confirm it was written.",
            "tool": "read_file",
            "args": {"path": out_path},
        },
        {
            "thought": "Execute the growth script and verify assertions pass.",
            "tool": "run_python",
            "args": {
                "code": (
                    "from pathlib import Path\n"
                    f"src = Path({out_path!r}).read_text()\n"
                    "ns = {}\n"
                    "exec(compile(src, 'cellular_growth.py', 'exec'), ns)\n"
                    "series = ns['simulate_growth'](1, 5)\n"
                    "assert series == [1, 2, 4, 8, 16, 32], series\n"
                    "print('growth_ok', series[-1])\n"
                )
            },
        },
        {
            "thought": "Benchmark objective complete.",
            "done": True,
            "answer": f"Created and executed {out_path} without errors.",
        },
    ]
    cursor = {"i": 0}

    def planner(_agent: SeedAgent) -> dict[str, Any]:
        if cursor["i"] >= len(plan):
            return {"done": True, "answer": "Planner exhausted.", "thought": ""}
        step = plan[cursor["i"]]
        cursor["i"] += 1
        return step

    return planner


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "task",
        nargs="?",
        default="Create agent_workspace/hello.py with a greet() helper and run it.",
        help="Natural-language task for the agent",
    )
    parser.add_argument("--max-steps", type=int, default=12)
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
    parser.add_argument(
        "--api-base",
        default=os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1"),
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Run a scripted offline plan that exercises all four tools",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run unit checks on the four tools and exit",
    )
    return parser


def self_test() -> None:
    """Exercise each primitive tool in an isolated temp workspace."""
    global ROOT
    previous = ROOT
    with tempfile.TemporaryDirectory() as tmp:
        ROOT = Path(tmp).resolve()
        try:
            assert list_directory(".") == "(empty)"
            assert "bytes" in write_file("notes/a.txt", "alpha\n")
            assert read_file("notes/a.txt") == "alpha\n"
            listing = list_directory("notes")
            assert "a.txt" in listing
            result = run_python("print(2 + 2)")
            assert "exit_code=0" in result and "4" in result
            try:
                read_file("../escape.txt")
                raise AssertionError("path escape should have failed")
            except ValueError:
                pass
            print("self-test: ok")
        finally:
            ROOT = previous


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        try:
            self_test()
            return 0
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return 1

    agent = SeedAgent(
        task=args.task,
        max_steps=args.max_steps,
        model=args.model,
        api_base=args.api_base,
    )
    planner = demo_planner_factory(args.task) if args.demo else None
    try:
        agent.run(planner=planner)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"fatal: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
