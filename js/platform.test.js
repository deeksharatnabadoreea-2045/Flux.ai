import { test } from "node:test";
import assert from "node:assert/strict";
import { FOUNDING_MISSION, NORTH_STAR, PRODUCT, VALIDATION_LADDER } from "./platform.js";
import { routeBrief } from "./desks.js";

test("product is scientist co-pilot chatbot", () => {
  assert.match(PRODUCT.name, /co-pilot/i);
  assert.match(PRODUCT.surface, /chatbot/i);
});

test("founding mission ties co-pilot to in-silico engine", () => {
  assert.match(FOUNDING_MISSION, /co-pilot/i);
  assert.match(FOUNDING_MISSION, /in-silico human trials/i);
  assert.match(NORTH_STAR.target, /predict/i);
});

test("validation ladder has four stages", () => {
  assert.equal(VALIDATION_LADDER.length, 4);
  assert.match(VALIDATION_LADDER[3].stage, /L3/);
});

test("routeBrief sends simulation work to Maker", () => {
  assert.equal(routeBrief("Build the in-silico simulation pipeline for cohort enrollment"), "maker");
});

test("routeBrief sends trial accuracy work to Ledger", () => {
  assert.equal(routeBrief("Define primary endpoint accuracy and validation benchmark for phase 2"), "ledger");
});

test("routeBrief sends clinical evidence questions to Scout", () => {
  assert.equal(routeBrief("Research clinical biomarker evidence for this mechanism"), "scout");
});
