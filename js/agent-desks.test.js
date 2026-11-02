import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_DESK_IDS,
  RUNTIME_ROOT,
  defaultAgentsConfig,
  defaultAgentDeskConfig,
  deskUsesLiveAgent,
} from "./agent-desks.js";

test("runtime root is always-on agents", () => {
  assert.equal(RUNTIME_ROOT, "agents24x7");
});

test("default desk config is live agent with recursive on", () => {
  const cfg = defaultAgentDeskConfig();
  assert.equal(cfg.mode, "agent");
  assert.equal(cfg.recursive, true);
});

test("every desk defaults to live agent mode", () => {
  const agents = defaultAgentsConfig();
  for (const id of AGENT_DESK_IDS) {
    assert.equal(agents[id].mode, "agent");
    assert.ok(deskUsesLiveAgent(agents, id));
  }
});
