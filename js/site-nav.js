/** Shared site header nav for marketing + explorer pages. */

import { BIOLOGY_CATEGORIES } from "./molecules-pubchem.js";
import { STATIC_CACHE_BUST } from "./deploy-revision.js";

const NAV = [
  { href: "/", label: "Home", match: "/" },
  { href: "/explorer/", label: "Explorer", match: "/explorer", hasChildren: true },
  { href: "/chat.html", label: "AI Assistant", match: "/chat" },
  { href: "/hq.html", label: "HQ", match: "/hq" },
];

function pathIsActive(match) {
  const path = window.location.pathname;
  if (match === "/") {
    return path === "/" || /\/index\.html$/.test(path) && !path.includes("/explorer");
  }
  return path.includes(match);
}

function explorerHref(cat) {
  // Absolute-from-root style paths for static hosting.
  if (cat.id === "molecules") return "/explorer/molecules/";
  return `/explorer/${cat.id}/`;
}

export function renderSiteHeader(mount) {
  if (!mount) return;

  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `
    <div class="site-header__inner">
      <a href="/" class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">Flux.ai</span>
      </a>
      <button type="button" class="nav-toggle" aria-expanded="false" aria-label="Toggle navigation">
        <span></span><span></span>
      </button>
      <nav class="site-nav" aria-label="Primary">
        <ul class="site-nav__list"></ul>
      </nav>
    </div>
  `;

  const list = header.querySelector(".site-nav__list");
  for (const item of NAV) {
    const li = document.createElement("li");
    if (item.hasChildren) {
      li.className = "has-submenu";
      li.innerHTML = `
        <div class="site-nav__explorer">
          <a class="site-nav__link ${pathIsActive(item.match) ? "is-active" : ""}" href="${item.href}">Explorer</a>
          <button type="button" class="site-nav__chevron" aria-expanded="false" aria-label="Explorer categories">▾</button>
        </div>
        <div class="submenu" role="menu"></div>
      `;
      const submenu = li.querySelector(".submenu");
      for (const cat of BIOLOGY_CATEGORIES) {
        if (cat.availability === "available") {
          const a = document.createElement("a");
          a.href = explorerHref(cat);
          a.className = "submenu__item";
          a.setAttribute("role", "menuitem");
          a.innerHTML = `<span>${cat.label}</span><span class="badge badge--live">${cat.statusLabel}</span>`;
          submenu.appendChild(a);
        } else {
          const span = document.createElement("span");
          span.className = "submenu__item submenu__item--disabled";
          span.setAttribute("role", "menuitem");
          span.setAttribute("aria-disabled", "true");
          span.innerHTML = `<span>${cat.label}</span><span class="badge">${cat.statusLabel}</span>`;
          submenu.appendChild(span);
        }
      }
      const chevron = li.querySelector(".site-nav__chevron");
      const openSub = (open) => {
        submenu.classList.toggle("is-open", open);
        chevron.setAttribute("aria-expanded", open ? "true" : "false");
      };
      li.addEventListener("mouseenter", () => openSub(true));
      li.addEventListener("mouseleave", () => openSub(false));
      chevron.addEventListener("click", () => openSub(!submenu.classList.contains("is-open")));
    } else {
      li.innerHTML = `<a class="site-nav__link ${pathIsActive(item.match) ? "is-active" : ""}" href="${item.href}">${item.label}</a>`;
    }
    list.appendChild(li);
  }

  const toggle = header.querySelector(".nav-toggle");
  const nav = header.querySelector(".site-nav");
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  mount.replaceWith(header);
}

export function renderSiteFooter(mount) {
  if (!mount) return;
  mount.innerHTML = `
    <div class="site-footer__inner">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">Flux.ai</span>
      </div>
      <div class="site-footer__links">
        <a href="/">Home</a>
        <a href="/explorer/">Explorer</a>
        <a href="/chat.html">AI Assistant</a>
        <a href="/hq.html">HQ</a>
        <a href="https://pubchem.ncbi.nlm.nih.gov/" rel="noopener noreferrer" target="_blank">PubChem</a>
      </div>
      <p class="muted" style="margin:0;font-size:0.85rem">
        Molecular data from PubChem. Release <span id="flux-deploy-release"></span>
        · <span class="mono">v=${STATIC_CACHE_BUST}</span>
      </p>
    </div>
  `;
  const meta = document.querySelector('meta[name="flux-deploy-stamp"]');
  const el = mount.querySelector("#flux-deploy-release");
  if (meta && el) el.textContent = meta.getAttribute("content") || "";
}

export function initSiteChrome() {
  const headerMount = document.getElementById("site-header-mount");
  const footerMount = document.getElementById("site-footer-mount");
  renderSiteHeader(headerMount);
  renderSiteFooter(footerMount);
}
