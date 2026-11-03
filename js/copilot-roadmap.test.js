import { test } from "node:test";
import assert from "node:assert/strict";
import { COPILOT_ROADMAP, currentStage, BUILD_PACT } from "./copilot-roadmap.js";

test("roadmap starts at L0 live and L1 next", () => {
  assert.equal(COPILOT_ROADMAP[0].status, "live");
  assert.equal(currentStage().id, "L1");
});

test("build pact is defined", () => {
  assert.match(BUILD_PACT, /co-pilot/i);
});
