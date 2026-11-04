/**
 * Feedback-driven preference tuning (local file on server, JSON export for client).
 */

const DEFAULT_PROFILE = {
  version: 1,
  counts: { up: 0, down: 0 },
  signals: {
    concise: 0,
    detailed: 0,
  },
  lastUpdated: null,
};

export function emptyFeedbackState() {
  return {
    profile: { ...DEFAULT_PROFILE, signals: { ...DEFAULT_PROFILE.signals } },
    events: [],
  };
}

export function normalizeFeedbackState(raw) {
  if (!raw || typeof raw !== "object") return emptyFeedbackState();
  return {
    profile: {
      ...DEFAULT_PROFILE,
      ...raw.profile,
      signals: { ...DEFAULT_PROFILE.signals, ...(raw.profile?.signals ?? {}) },
    },
    events: Array.isArray(raw.events) ? raw.events.slice(-200) : [],
  };
}

export function recordFeedback(state, { messageId, rating, intents = [] }) {
  const next = normalizeFeedbackState(state);
  const r = rating === "down" ? "down" : "up";
  next.profile.counts[r] += 1;
  if (r === "down") next.profile.signals.concise += 1;
  else next.profile.signals.detailed += 1;
  next.profile.lastUpdated = new Date().toISOString();
  next.events.push({
    id: messageId ?? `fb_${Date.now()}`,
    at: next.profile.lastUpdated,
    rating: r,
    intents,
  });
  return next;
}

export function profileFromFeedback(state) {
  const s = normalizeFeedbackState(state);
  const { concise, detailed } = s.profile.signals;
  const verbosity = concise > detailed + 2 ? "concise" : "balanced";
  return { verbosity, tone: "direct", counts: s.profile.counts };
}
