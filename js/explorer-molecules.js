import { initSiteChrome } from "./site-nav.js";

initSiteChrome();

const input = document.getElementById("molecule-search");
const status = document.getElementById("search-status");
const resultsEl = document.getElementById("search-results");
const featuredEl = document.getElementById("featured-results");

let timer = null;

function rowHtml(m) {
  const img = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${m.cid}/PNG?image_size=128x128`;
  const meta = [m.formula, m.molecularWeight != null ? `${m.molecularWeight} g/mol` : null]
    .filter(Boolean)
    .join(" · ");
  return `
    <a class="molecule-row" href="/explorer/molecules/profile.html?cid=${m.cid}">
      <div class="molecule-row__preview">
        <img src="${img}" alt="" loading="lazy" width="64" height="64"
          onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'muted',textContent:'CID'}))" />
      </div>
      <div>
        <h3>${escapeHtml(m.name || `CID ${m.cid}`)}</h3>
        <p class="muted">${escapeHtml(meta || `CID ${m.cid}`)}</p>
      </div>
      <span class="molecule-row__cta">Open →</span>
    </a>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderList(el, molecules, emptyText) {
  if (!el) return;
  if (!molecules?.length) {
    el.innerHTML = `<p class="empty-state">${emptyText}</p>`;
    return;
  }
  el.innerHTML = molecules.map(rowHtml).join("");
}

async function loadFeatured() {
  try {
    const res = await fetch("/api/molecules-featured");
    const data = await res.json();
    renderList(featuredEl, data.results || [], "Featured molecules unavailable right now.");
  } catch {
    renderList(featuredEl, [], "Featured molecules unavailable right now.");
  }
}

async function runSearch(q) {
  if (!q) {
    if (status) status.textContent = "";
    renderList(resultsEl, [], "");
    resultsEl.innerHTML = "";
    return;
  }
  if (status) status.textContent = "Searching…";
  try {
    const res = await fetch(`/api/molecules-search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (status) status.textContent = data.results?.length ? `${data.results.length} results` : "No matches";
    renderList(resultsEl, data.results || [], "No PubChem matches for that name.");
  } catch {
    if (status) status.textContent = "Search failed";
    renderList(resultsEl, [], "Search failed. Try again shortly.");
  }
}

input?.addEventListener("input", () => {
  const q = input.value.trim();
  clearTimeout(timer);
  timer = setTimeout(() => runSearch(q), 280);
});

void loadFeatured();
