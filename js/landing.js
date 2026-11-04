const UPGRADE_DISMISS_KEY = "clonescript.upgrade.dismissed";

function greetingForHour(hour) {
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

function initGreeting() {
  const el = document.getElementById("hero-greeting");
  if (!el) return;
  const hour = new Date().getHours();
  el.textContent = `${greetingForHour(hour)}, Clone. What's on your mind?`;
}

function initExamples() {
  const input = document.getElementById("composer-input");
  document.querySelectorAll("[data-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.getAttribute("data-prompt");
      if (input && text) {
        input.value = text;
        input.focus();
      }
    });
  });
}

function initModePills() {
  const input = document.getElementById("composer-input");
  document.querySelectorAll(".pill[data-mode]").forEach((pill) => {
    pill.addEventListener("click", () => {
      const prefix = pill.getAttribute("data-mode");
      if (!input || !prefix) return;
      document.querySelectorAll(".pill[data-mode]").forEach((p) => p.classList.remove("is-active"));
      pill.classList.add("is-active");
      const trimmed = input.value.trim();
      if (!trimmed || trimmed.startsWith(prefix)) {
        input.value = `${prefix} `;
      }
      input.focus();
    });
  });
}

function initChatListToggle() {
  const toggle = document.getElementById("chat-list-toggle");
  const history = document.getElementById("chat-history");
  if (!toggle || !history) return;
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") !== "false";
    toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    history.classList.toggle("is-collapsed", expanded);
  });
}

function initUpgradeDismiss() {
  const card = document.getElementById("upgrade-card");
  const dismiss = document.getElementById("upgrade-dismiss");
  if (!card || !dismiss) return;
  if (localStorage.getItem(UPGRADE_DISMISS_KEY) === "1") {
    card.classList.add("is-hidden");
  }
  dismiss.addEventListener("click", () => {
    card.classList.add("is-hidden");
    localStorage.setItem(UPGRADE_DISMISS_KEY, "1");
  });
}

function initComposer() {
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  if (!form || !input) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    window.location.href = `./hq.html?brief=${encodeURIComponent(text)}`;
  });
}

initGreeting();
initExamples();
initModePills();
initChatListToggle();
initUpgradeDismiss();
initComposer();
