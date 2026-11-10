import { ACCESS } from "./access-config.js";
import { initPubchemSearch } from "./landing-pubchem.js";

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

function initAccess() {
  const openBtn = document.getElementById("access-open");
  const dialog = document.getElementById("access-dialog");
  const pay = document.getElementById("access-pay");
  const price = document.getElementById("access-price");
  const offer = dialog?.querySelector(".access-offer");
  if (!openBtn || !dialog || !pay) return;

  if (price) price.textContent = ACCESS.priceText;
  if (offer) offer.textContent = ACCESS.whatYouGet;
  pay.href = ACCESS.payUrl;
  pay.setAttribute(
    "target",
    ACCESS.payUrl.startsWith("mailto:") ? "_self" : "_blank",
  );
  if (!ACCESS.payUrl.startsWith("mailto:")) {
    pay.setAttribute("rel", "noopener noreferrer");
  }

  openBtn.addEventListener("click", () => {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  });
}

initGreeting();
initChatListToggle();
initSidebar();
initAccess();
initPubchemSearch();
