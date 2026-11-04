import { test } from "node:test";
import assert from "node:assert/strict";
import {
  missingValidatorHeadings,
  validateScientificMethodReport,
  detectFakeScienceRhetoric,
} from "./scientific-method.js";

const minimalValidBody = `
## Scope
Review Maker cohort spec.

## Hypothesis under test
Digital cohort v0 matches registry inclusion criteria.

## Predictions
If true, parsed NCT fields align with schema arms.

## Methods and reproducibility
Replay harness on frozen snapshot id.

## Observations (data in hand)
No snapshot loaded in this smoke audit.

## Inferences (conclusions)
Cannot confirm alignment without data.

## Falsifiability
Disproved if arm counts contradict registry JSON in manifest snapshot.

## Uncertainty
High — no run artifact attached.

## Fake-science screening
No efficacy or replacement claim asserted.

## Validation ladder stage
L0 only.

## Code / platform findings
Schema requires dataLineage.

## Verdict
fix

## Required fixes
1. Attach snapshot id.

## Recommendation
wait
`;

test("missingValidatorHeadings catches incomplete audit", () => {
  assert.ok(missingValidatorHeadings("## Scope\nOnly scope").includes("Hypothesis under test"));
});

test("validateScientificMethodReport accepts structured audit", () => {
  const result = validateScientificMethodReport({
    bodyMarkdown: minimalValidBody,
    fakeScienceDetected: false,
    verdict: "fix",
  });
  assert.equal(result.ok, true);
});

test("fake science forces block verdict", () => {
  const result = validateScientificMethodReport({
    bodyMarkdown: minimalValidBody,
    fakeScienceDetected: true,
    verdict: "ship",
  });
  assert.ok(result.errors.some((e) => e.includes("verdict_must_be_block")));
});

test("detectFakeScienceRhetoric finds hype phrases", () => {
  assert.ok(detectFakeScienceRhetoric("This is 100% concordance guaranteed").length > 0);
});
