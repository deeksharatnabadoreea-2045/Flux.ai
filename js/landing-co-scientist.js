const FEEDBACK_KEY = "flux.co-scientist.feedback.v1";
const CHAT_KEY = "flux.co-scientist.chat.v1";

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

function sourceLabel(source) {
  if (source === "pubmed") return "PubMed";
  if (source === "uniprot") return "UniProt";
  if (source === "alphafold") return "AlphaFold";
  return source;
}

function renderFeed(items) {
  const track = document.getElementById("cos-feed-track");
  if (!track) return;
  if (!items?.length) {
    track.innerHTML = `<p class="cos-feed-empty">Feed offline — start with <code>npm run dev</code> or wait for Netlify functions.</p>`;
    return;
  }
  track.innerHTML = items
    .map(
      (item) => `
    <a class="cos-feed-card" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" data-feed-id="${esc(item.id)}">
      <span class="cos-feed-source cos-feed-source--${esc(item.source)}">${sourceLabel(item.source)}</span>
      <p class="cos-feed-title">${esc(item.title)}</p>
      <p class="cos-feed-summary">${esc(item.summary)}</p>
    </a>`,
    )
    .join("");
}

async function fetchFeed(refresh = false) {
  const status = document.getElementById("cos-feed-status");
  if (status) status.textContent = "Updating…";
  try {
    const url = refresh ? "/api/co-scientist/feed?refresh=1" : "/api/co-scientist/feed";
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "feed_error");
    feedSnapshot = data;
    renderFeed(data.items);
    if (status) {
      const when = new Date(data.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      status.textContent = data.cached ? `Cached · ${when}` : `Live · ${when}`;
    }
  } catch {
    renderFeed([]);
    if (status) status.textContent = "Offline";
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
    feedSnapshot = feedSnapshot ?? { items: [] };
    const html = renderMarkdown(data.reply.markdown);
    pending.querySelector(".cos-msg-body").innerHTML = html;
    pending.dataset.intents = JSON.stringify(data.reply.intents ?? []);
  } catch {
    pending.querySelector(".cos-msg-body").innerHTML =
      "<p>Could not reach the co-scientist API. Run <code>npm run dev</code> locally or deploy Netlify functions.</p>";
  }
}

function bindComposer() {
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  if (!form || !input) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendChat(text);
    input.value = "";
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

function bindFeedRefresh() {
  document.getElementById("cos-feed-refresh")?.addEventListener("click", () => fetchFeed(true));
}

export function initCoScientistLanding() {
  const fb = loadFeedbackState();
  if (fb.profile) feedbackProfile = fb.profile;
  bindComposer();
  bindFeedRefresh();
  fetchFeed(false);
  setInterval(() => fetchFeed(false), 15 * 60 * 1000);
}
