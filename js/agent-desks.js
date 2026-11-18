/** Desks that can run as Agent SDK agents (including Forge). */

/** Flux runs on always-on agents; playbooks are offline fallback only. */
export const RUNTIME_ROOT = "agents24x7";

export const AGENT_DESK_IDS = [
  "scout",
  "maker",
  "voice",
  "floor",
  "ledger",
  "wire",
  "forge",
];

export const AGENTS_BASE_PATH = "/agents";

export function defaultAgentsConfig() {
  return Object.fromEntries(
    AGENT_DESK_IDS.map((id) => [id, { mode: "agent", recursive: true }]),
  );
}

export function defaultAgentDeskConfig() {
  return { mode: "agent", recursive: true };
}

export function deskUsesLiveAgent(agents, deskId) {
  return agents?.[deskId]?.mode === "agent";
}

export function deskRecursiveEnabled(agents, deskId) {
  if (deskId === "forge") return true;
  return agents?.[deskId]?.recursive !== false;
}

/** Desk ids configured for live Agent SDK workers (parallel briefs fan out here). */
export function liveAgentDeskIds(agents, deskIds = AGENT_DESK_IDS) {
  return deskIds.filter((id) => deskUsesLiveAgent(agents, id));
}

export function agentChannelUrl(baseUrl, deskId) {
  return `${baseUrl.replace(/\/$/, "")}/${deskId}/v1/channels/floor/brief`;
}

export function fileToolName(deskId) {
  return `file_${deskId}_report`;
}
