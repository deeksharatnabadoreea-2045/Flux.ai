import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appliesToDesk,
  evolutionBlockForDesk,
  normalizeProposal,
  proposalFromForgeBody,
  renderAppendixMarkdown,
} from "./evolution.js";

test("normalizeProposal requires title change and patch", () => {
  assert.equal(normalizeProposal({ title: "x", change: "y" }), null);
  assert.ok(
    normalizeProposal({
      title: "Evolve scout",
      change: "Add metric",
      patch: "Do the new thing with enough chars ".repeat(3),
    }),
  );
});

test("proposalFromForgeBody parses forge sections", () => {
  const body = [
    "## Title",
    "Evolve scout routing",
    "## Target desk",
    "scout",
    "## Change kind",
    "routing",
    "## Hypothesis",
    "If we route X better, accepts go up.",
    "## Change",
    "Tweak routing verbs for clearer auto-route",
    "## Success metric",
    "Accept rate on scout files",
    "## Rollback",
    "Revert patch and re-run smoke eval",
    "## Patch text",
    "New routing rule here with enough detail to apply.",
  ].join("\n");
  const p = proposalFromForgeBody(body, { title: "Forge: test" });
  assert.equal(p.targetDesk, "scout");
  assert.equal(p.changeKind, "routing");
  assert.ok(p.patch.includes("routing rule"));
});

test("evolutionBlockForDesk filters by target", () => {
  const applied = [
    { targetDesk: "scout", title: "A", patch: "scout-only", changeKind: "instructions" },
    { targetDesk: "voice", title: "B", patch: "voice-only", changeKind: "instructions" },
  ];
  assert.ok(evolutionBlockForDesk(applied, "scout").includes("scout-only"));
  assert.ok(!evolutionBlockForDesk(applied, "scout").includes("voice-only"));
  assert.ok(appliesToDesk({ targetDesk: "all" }, "maker"));
});

test("renderAppendixMarkdown lists accepted changes", () => {
  const md = renderAppendixMarkdown([
    {
      title: "Test",
      targetDesk: "scout",
      changeKind: "instructions",
      patch: "Body",
      hypothesis: "",
      metric: "",
      rollback: "",
    },
  ]);
  assert.match(md, /Orchestrator-approved evolution/);
  assert.match(md, /Test/);
});
