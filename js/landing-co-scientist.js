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

function moleculeEls() {
  return {
    panel: document.getElementById("molecule-result"),
    status: document.getElementById("molecule-result-status"),
    name: document.getElementById("molecule-result-name"),
    props: document.getElementById("molecule-result-props"),
    formula: document.getElementById("molecule-result-formula"),
    weight: document.getElementById("molecule-result-weight"),
    error: document.getElementById("molecule-result-error"),
    submit: document.getElementById("composer-submit"),
    input: document.getElementById("composer-input"),
  };
}

function setMoleculePanel({ loading = false, molecule = null, error = "" } = {}) {
  const els = moleculeEls();
  if (!els.panel) return;

  els.panel.classList.remove("is-hidden");
  els.status?.classList.toggle("is-hidden", !loading);
  els.name?.classList.toggle("is-hidden", !molecule);
  els.props?.classList.toggle("is-hidden", !molecule);
  els.error?.classList.toggle("is-hidden", !error);

  if (els.status) els.status.textContent = loading ? "Looking up PubChem…" : "";
  if (els.name) els.name.textContent = molecule?.name ?? "";
  if (els.formula) els.formula.textContent = molecule?.formula ?? "";
  if (els.weight) els.weight.textContent = molecule?.molecularWeight ?? "";
  if (els.error) els.error.textContent = error;

  if (els.submit) els.submit.disabled = loading;
  if (els.input) els.input.disabled = loading;
}

async function handleComposerSubmit(input) {
  const query = input.value.trim();
  if (!query) {
    setMoleculePanel({ error: "Enter a compound name to search." });
    return;
  }

  input.value = "";
  setMoleculePanel({ loading: true });

  try {
    const molecule = await lookupMolecule(query);
    setMoleculePanel({ molecule });
  } catch (err) {
    const message =
      err instanceof TypeError
        ? "Could not reach PubChem. Check your connection and try again."
        : err?.message || "PubChem lookup failed.";
    setMoleculePanel({ error: message });
  }
}

function bindComposer() {
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  if (!form || !input) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleComposerSubmit(input);
  });

  // Enter searches; Shift+Enter keeps a newline in the textarea.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || input.disabled) return;
    e.preventDefault();
    form.requestSubmit();
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
