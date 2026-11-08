import { initCoScientistLanding } from "./landing-co-scientist.js";

function greetingForHour(hour) {
  if (hour < 12) return "Good Morning.";
  if (hour < 17) return "Good Afternoon.";
  return "Good Evening.";
}

function initGreeting() {
  const el = document.getElementById("hero-greeting");
  if (!el) return;
  el.textContent = greetingForHour(new Date().getHours());
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

function setSidebarOpen(open) {
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("sidebar-scrim");
  const toggle = document.getElementById("sidebar-toggle");
  if (!sidebar || !scrim || !toggle) return;
  sidebar.classList.toggle("is-open", open);
  scrim.classList.toggle("is-visible", open);
  document.body.classList.toggle("sidebar-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

function initSidebar() {
  const toggle = document.getElementById("sidebar-toggle");
  const close = document.getElementById("sidebar-close");
  const scrim = document.getElementById("sidebar-scrim");
  const sidebar = document.getElementById("sidebar");
  if (!toggle || !sidebar) return;

  toggle.addEventListener("click", () => {
    const open = !sidebar.classList.contains("is-open");
    setSidebarOpen(open);
  });
  close?.addEventListener("click", () => setSidebarOpen(false));
  scrim?.addEventListener("click", () => setSidebarOpen(false));

  sidebar.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => setSidebarOpen(false));
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setSidebarOpen(false);
  });
}

initGreeting();
initChatListToggle();
initSidebar();
initCoScientistLanding();
