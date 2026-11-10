import { lookupMolecule } from "./pubchem.js";

const FEEDBACK_KEY = "flux.co-scientist.feedback.v1";

let feedSnapshot = null;
let feedbackProfile = { verbosity: "balanced" };

function loadFeedbackState() {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY);
    if (!raw) return { profile: feedbackProfile, events: [] };
    return JSON.parse(raw);
  } catch {
    return { profile: feedbackProfile, events: [] };
  }
}

function saveFeedbackState(state) {
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(state));
  if (state.profile) feedbackProfile = state.profile;
}

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md) {
  const escaped = esc(md);
  return escaped
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/^\d+\. (.+)$/gm, "<p>$1</p>")
    .replace(/^_([^_]+)_$/gm, "<em>$1</em>")
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

/** Background refresh for chat context — no visible feed UI. */
async function prefetchFeed() {
  try {
    const res = await fetch("/api/co-scientist/feed");
    const data = await res.json();
    if (data.ok) feedSnapshot = data;
  } catch {
    /* chat still works; citations may be sparse */
  }
}

function showChat() {
  document.getElementById("cos-chat")?.classList.remove("is-hidden");
  document.querySelector(".hero")?.classList.add("is-compact");
}

function appendMessage(role, html, meta = {}) {
  const thread = document.getElementById("cos-chat-thread");
  if (!thread) return null;
  showChat();
  const id = meta.id ?? `msg_${Date.now()}`;
  const article = document.createElement("article");
  article.className = `cos-msg cos-msg--${role}`;
  article.dataset.messageId = id;
  article.innerHTML =
    role === "assistant"
      ? `<div class="cos-msg-body">${html}</div>
         <div class="cos-msg-actions">
           <button type="button" class="cos-feedback" data-rating="up" aria-label="Helpful">👍</button>
           <button type="button" class="cos-feedback" data-rating="down" aria-label="Not helpful">👎</button>
         </div>`
      : `<div class="cos-msg-body">${html}</div>`;
  thread.appendChild(article);
  thread.scrollTop = thread.scrollHeight;
  return article;
}

async function sendFeedback(messageId, rating, intents) {
  const local = loadFeedbackState();
  const res = await fetch("/api/co-scientist/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messageId,
      rating,
      intents,
      syncState: local,
    }),
  }).catch(() => null);

  let next = local;
  if (res?.ok) {
    const data = await res.json();
    if (data.state) next = data.state;
    if (data.profile) feedbackProfile = data.profile;
  } else {
    const { recordFeedback, profileFromFeedback } = await import("./co-scientist-feedback.mjs");
    next = recordFeedback(local, { messageId, rating, intents });
    feedbackProfile = profileFromFeedback(next);
  }
  saveFeedbackState({ ...next, profile: feedbackProfile });
}

async function sendChat(message) {
  const trimmed = message.trim();
  if (!trimmed) return;
  appendMessage("user", esc(trimmed));
  const pending = appendMessage("assistant", "<p>Thinking…</p>");

  if (!feedSnapshot?.items?.length) await prefetchFeed();

  try {
    const res = await fetch("/api/co-scientist/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: trimmed,
        feed: feedSnapshot,
        feedbackProfile,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "chat_failed");
    const html = renderMarkdown(data.reply.markdown);
    pending.querySelector(".cos-msg-body").innerHTML = html;
    pending.dataset.intents = JSON.stringify(data.reply.intents ?? []);
  } catch {
    pending.querySelector(".cos-msg-body").innerHTML =
      "<p>Could not reach the co-scientist API. Run <code>npm run dev</code> locally or deploy Netlify functions.</p>";
  }
}

function showMoleculeResult(molecule) {
  const panel = document.getElementById("molecule-result");
  const nameEl = document.getElementById("molecule-result-name");
  const metaEl = document.getElementById("molecule-result-meta");
  const errorEl = document.getElementById("molecule-result-error");
  if (!panel || !nameEl || !metaEl || !errorEl) return;

  panel.classList.remove("is-hidden");
  errorEl.classList.add("is-hidden");
  errorEl.textContent = "";
  nameEl.textContent = molecule.name;
  metaEl.textContent = `Formula ${molecule.formula} · Molecular weight ${molecule.molecularWeight}`;
  document.querySelector(".hero")?.classList.add("is-compact");
}

function showMoleculeError(message) {
  const panel = document.getElementById("molecule-result");
  const nameEl = document.getElementById("molecule-result-name");
  const metaEl = document.getElementById("molecule-result-meta");
  const errorEl = document.getElementById("molecule-result-error");
  if (!panel || !nameEl || !metaEl || !errorEl) return;

  panel.classList.remove("is-hidden");
  nameEl.textContent = "";
  metaEl.textContent = "";
  errorEl.textContent = message;
  errorEl.classList.remove("is-hidden");
  document.querySelector(".hero")?.classList.add("is-compact");
}

async function searchMolecule(name) {
  try {
    return await lookupMolecule(name);
  } catch {
    showMoleculeError("Could not reach PubChem. Check your connection and try again.");
    return "error";
  }
}

function bindComposer() {
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  if (!form || !input) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    const molecule = await searchMolecule(text);
    if (molecule === "error") return;
    if (molecule) {
      showMoleculeResult(molecule);
      return;
    }
    sendChat(text);
  });

  document.getElementById("cos-chat-thread")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".cos-feedback");
    if (!btn) return;
    const msg = btn.closest(".cos-msg");
    if (!msg) return;
    sendFeedback(
      msg.dataset.messageId,
      btn.getAttribute("data-rating"),
      JSON.parse(msg.dataset.intents || "[]"),
    );
    btn.closest(".cos-msg-actions")?.querySelectorAll(".cos-feedback").forEach((b) => {
      b.disabled = true;
    });
  });
}

export function initCoScientistLanding() {
  const fb = loadFeedbackState();
  if (fb.profile) feedbackProfile = fb.profile;
  bindComposer();
  prefetchFeed();
  setInterval(prefetchFeed, 15 * 60 * 1000);
}
