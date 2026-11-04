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

function initUpgradeDismiss() {
  const card = document.getElementById("upgrade-card");
  const dismiss = document.getElementById("upgrade-dismiss");
  if (!card || !dismiss) return;
  dismiss.addEventListener("click", () => {
    card.classList.add("is-hidden");
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
initUpgradeDismiss();
initComposer();
