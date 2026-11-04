import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESKS,
  foundingFiles,
  parseBrief,
  routeBrief,
  runPlaybook,
} from "./desks.js";

test("eight desks exist with codes", () => {
  assert.equal(DESKS.length, 8);
  assert.deepEqual(
    DESKS.map((desk) => desk.code),
    ["SCT", "MKR", "VOX", "FLR", "VLD", "LDG", "WRE", "FRG"],
  );
});

test("routeBrief sends validation audits to Validator", () => {
  assert.equal(routeBrief("Validate the in-silico trial architecture for overclaim"), "validator");
});

test("routeBrief sends evolution briefs to Forge", () => {
  assert.equal(routeBrief("Improve Scout architecture for self-improvement"), "forge");
});

test("routeBrief sends research to Scout", () => {
  assert.equal(routeBrief("Research the competitor landscape for company OS tools"), "scout");
});

test("routeBrief sends copy to Voice", () => {
  assert.equal(routeBrief("Write the manifesto and a landing headline"), "voice");
});

test("routeBrief sends a question with no verbs to Scout", () => {
  assert.equal(routeBrief("Is this worth doing at all?"), "scout");
});

test("routeBrief sends a bare imperative to Maker", () => {
  assert.equal(routeBrief("Put a second page on the site"), "maker");
});

test("routeBrief defaults empty input to Maker", () => {
  assert.equal(routeBrief("  "), "maker");
});

test("work desk files include recursive self-improvement section", () => {
  const scout = runPlaybook("scout", "Research widgets", { name: "Flux.ai" }, { applied: [] });
  assert.match(scout.body, /Recursive self-improvement/);
  assert.match(scout.body, /propose_evolution/);
});

test("every desk files a titled body with steps", () => {
  const brief = "Price the first year of Flux.ai and write the kill criteria.";
  for (const desk of DESKS) {
    const file = runPlaybook(
      desk.id,
      brief,
      {
        name: "Flux.ai",
        orchestrator: "Deeksharatna",
        mission: "A company of one.",
      },
      { applied: [] },
    );
    assert.ok(file.title.includes(desk.name), `${desk.id} title`);
    assert.ok(file.body.includes("Deeksharatna") || file.body.includes("Flux.ai"), `${desk.id} body`);
    assert.ok(file.steps.length >= 4, `${desk.id} steps`);
  }
});

test("founding files are three accepted desks", () => {
  const files = foundingFiles({
    name: "Flux.ai",
    orchestrator: "Deeksharatna",
    mission: "A company of one.",
  });
  assert.equal(files.length, 3);
  assert.deepEqual(
    files.map((file) => file.deskId),
    ["scout", "maker", "voice"],
  );
  assert.ok(files.every((file) => file.status === "accepted"));
});

test("parseBrief flags questions and subjects", () => {
  const parsed = parseBrief("Why should Flux.ai hire a researcher?");
  assert.equal(parsed.isQuestion, true);
  assert.ok(parsed.proper.includes("Flux.ai") || parsed.subject.length > 0);
});

test("parseBrief does not treat Write as the subject", () => {
  const parsed = parseBrief("Write a short homepage line for Flux.ai");
  assert.equal(parsed.subject, "Flux.ai");
});
