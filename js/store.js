import { FOUNDING_MISSION, foundingFiles } from "./desks.js";
import { emptyEvolution } from "./evolution.js";
import { defaultAgentsConfig } from "./agent-desks.js";

export const STORAGE_KEY = "flux-os-v1";

export function defaultState() {
  const company = {
    name: "Flux.ai",
    mission: FOUNDING_MISSION,
    orchestrator: "Deeksharatna",
    recursiveSelfImprove: true,
  };
  const now = Date.now();
  const jobs = foundingFiles(company).map((job, index) => ({
    ...job,
    createdAt: now - (3 - index) * 60 * 60 * 1000,
    updatedAt: now - (3 - index) * 60 * 60 * 1000,
  }));
  return {
    version: 1,
    company,
    agents: defaultAgentsConfig(),
    evolution: emptyEvolution(),
    selectedDesk: "all",
    selectedJobId: jobs[2]?.id ?? jobs[0]?.id ?? null,
    jobs,
    log: [
      {
        id: "log_founding",
        at: now - 3 * 60 * 60 * 1000,
        text: "Company opened. Three founding files accepted onto the record.",
      },
    ],
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.company || !Array.isArray(parsed.jobs)) {
      return defaultState();
    }
    return {
      ...defaultState(),
      ...parsed,
      company: {
        ...defaultState().company,
        ...parsed.company,
        recursiveSelfImprove: parsed.company?.recursiveSelfImprove !== false,
      },
      agents: {
        ...defaultAgentsConfig(),
        ...parsed.agents,
      },
      evolution: {
        ...emptyEvolution(),
        ...parsed.evolution,
        applied: Array.isArray(parsed.evolution?.applied) ? parsed.evolution.applied : [],
      },
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState() {
  localStorage.removeItem(STORAGE_KEY);
  return defaultState();
}

export function newId(prefix) {
  const rand =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${rand}`;
}
