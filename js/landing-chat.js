/** Landing conversational chat UI — calls /api/chat (Groq on the server). */

import { setMoleculePanel } from "./landing-pubchem.js?v=anon-rate-security-1";

const STORAGE_KEY = "flux.scienceChats.v1";
const MAX_CHATS = 20;

function els() {
  return {
    form: document.getElementById("composer-form"),
    input: document.getElementById("composer-input"),
    submit: document.getElementById("composer-submit"),
    thread: document.getElementById("chat-thread"),
    hero: document.querySelector(".hero"),
    history: document.getElementById("chat-history"),
    newChat: document.querySelector('.nav-item[href="./index.html"]'),
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { chats: [], activeId: null };
    const parsed = JSON.parse(raw);
    return {
      chats: Array.isArray(parsed.chats) ? parsed.chats : [],
      activeId: parsed.activeId ?? null,
    };
  } catch {
    return { chats: [], activeId: null };
  }
}

function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function newChatRecord() {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    conversationId: crypto.randomUUID(),
    messages: [],
    updatedAt: Date.now(),
  };
}

function ensureActiveChat(store) {
  if (store.activeId) {
    const found = store.chats.find((c) => c.id === store.activeId);
    if (found) return { store, chat: found };
  }
  const chat = newChatRecord();
  store.chats = [chat, ...store.chats].slice(0, MAX_CHATS);
  store.activeId = chat.id;
  return { store, chat };
}

function renderSidebar(store) {
  const { history } = els();
  if (!history) return;
  history.innerHTML = "";
  if (!store.chats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "No chats yet";
    history.appendChild(empty);
    return;
  }
  for (const chat of store.chats) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-history-item";
    if (chat.id === store.activeId) btn.classList.add("is-active");
    btn.textContent = chat.title || "Chat";
    btn.addEventListener("click", () => {
      store.activeId = chat.id;
      saveStore(store);
      renderSidebar(store);
      renderThread(chat);
      const lastMol = [...chat.messages].reverse().find((m) => m.molecule);
      if (lastMol?.molecule) setMoleculePanel({ molecule: lastMol.molecule });
      else document.getElementById("molecule-result")?.classList.add("is-hidden");
    });
    history.appendChild(btn);
  }
}

function appendBubble(thread, role, content) {
  const bubble = document.createElement("article");
  bubble.className = `chat-bubble chat-bubble-${role}`;
  const label = document.createElement("p");
  label.className = "chat-bubble-label";
  label.textContent = role === "user" ? "You" : "Flux";
  const body = document.createElement("p");
  body.className = "chat-bubble-body";
  body.textContent = content;
  bubble.append(label, body);
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

function renderThread(chat) {
  const { thread, hero } = els();
  if (!thread) return;
  thread.innerHTML = "";
  thread.classList.toggle("is-empty", chat.messages.length === 0);
  hero?.classList.toggle("is-compact", chat.messages.length > 0);
  for (const message of chat.messages) {
    appendBubble(thread, message.role, message.content);
  }
}

function friendlyChatError(status, data) {
  const code = String(data?.error || "");
  if (status === 429 || code === "rate_limited") {
    const wait = Number(data?.retryAfterSec) || 60;
    return `You are sending messages too quickly. Try again in about ${wait} seconds.`;
  }
  if (code === "origin_forbidden" || code === "origin_required") {
    return "This chat only works from the Flux website.";
  }
  if (code === "body_too_large" || code === "message_too_long" || code === "too_many_messages") {
    return "That message is too long. Shorten it and try again.";
  }
  if (code === "sign_in_required" || code === "unauthorized") {
    return "Chat is temporarily unavailable. Refresh the page and try again.";
  }
  if (typeof data?.reply === "string" && data.reply.trim()) return data.reply;
  if (code && !/gsk_|sk-|GROQ|api[_-]?key/i.test(code)) {
    return `Chat failed (${code}).`;
  }
  return `Chat failed (HTTP ${status}).`;
}

async function postChat(payload) {
  const endpoints = ["/api/chat", "/.netlify/functions/chat"];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) return data;
      if (res.status === 404) {
        lastError = new Error("chat_endpoint_missing");
        continue;
      }
      throw new Error(friendlyChatError(res.status, data));
    } catch (err) {
      lastError = err;
      if (err instanceof TypeError) continue;
      if (String(err?.message) === "chat_endpoint_missing") continue;
      throw err;
    }
  }
  throw lastError ?? new Error("Chat endpoint unavailable.");
}

function titleFromMessage(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 42 ? `${t.slice(0, 42)}…` : t || "New chat";
}

async function handleSubmit(event) {
  event.preventDefault();
  const { input, submit, thread, hero } = els();
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  let store = loadStore();
  ({ store } = ensureActiveChat(store));
  let chat = store.chats.find((c) => c.id === store.activeId);
  if (!chat) ({ store, chat } = ensureActiveChat(store));

  input.value = "";
  if (submit) submit.disabled = true;
  input.disabled = true;

  chat.messages.push({ role: "user", content: text });
  if (chat.title === "New chat") chat.title = titleFromMessage(text);
  chat.updatedAt = Date.now();
  saveStore(store);
  renderSidebar(store);
  hero?.classList.add("is-compact");
  thread?.classList.remove("is-empty");
  appendBubble(thread, "user", text);
  setMoleculePanel({ loading: true });

  try {
    const data = await postChat({
      conversationId: chat.conversationId,
      messages: chat.messages.map(({ role, content }) => ({ role, content })),
    });

    chat.conversationId = data.conversationId || chat.conversationId;
    chat.messages.push({
      role: "assistant",
      content: data.reply,
      molecule: data.molecule ?? null,
    });
    chat.updatedAt = Date.now();
    store.chats = [chat, ...store.chats.filter((c) => c.id !== chat.id)].slice(0, MAX_CHATS);
    saveStore(store);
    renderSidebar(store);
    appendBubble(thread, "assistant", data.reply);

    if (data.molecule) setMoleculePanel({ molecule: data.molecule });
    else {
      setMoleculePanel({});
      document.getElementById("molecule-result")?.classList.add("is-hidden");
    }
  } catch (err) {
    const raw = err?.message || "Chat failed.";
    const message =
      err instanceof TypeError
        ? "Could not reach the chat service. Refresh the page or try again in a moment."
        : /gsk_|sk-|GROQ_API_KEY|api key/i.test(String(raw))
          ? "Chat is temporarily unavailable. Try again shortly."
          : raw;
    chat.messages.push({ role: "assistant", content: message });
    saveStore(store);
    appendBubble(thread, "assistant", message);
    setMoleculePanel({ error: message });
  } finally {
    if (submit) submit.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function startNewChat(event) {
  if (event) event.preventDefault();
  const store = loadStore();
  const chat = newChatRecord();
  store.chats = [chat, ...store.chats].slice(0, MAX_CHATS);
  store.activeId = chat.id;
  saveStore(store);
  renderSidebar(store);
  renderThread(chat);
  document.getElementById("molecule-result")?.classList.add("is-hidden");
  els().input?.focus();
}

export function initLandingChat() {
  const { form, input, newChat } = els();
  if (!form || !input) return;

  let store = loadStore();
  ({ store } = ensureActiveChat(store));
  const chat = store.chats.find((c) => c.id === store.activeId);
  saveStore(store);
  renderSidebar(store);
  if (chat) renderThread(chat);

  form.addEventListener("submit", handleSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || input.disabled) return;
    e.preventDefault();
    form.requestSubmit();
  });
  newChat?.addEventListener("click", startNewChat);
}
