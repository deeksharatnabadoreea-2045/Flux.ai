import { initSiteChrome } from "./site-nav.js";
import { mountMoleculeViewer } from "./molecule-viewer.js";

initSiteChrome();

const params = new URLSearchParams(window.location.search);
const cid = Number(params.get("cid"));
const root = document.getElementById("profile-root");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function load() {
  if (!root) return;
  if (!Number.isInteger(cid) || cid <= 0) {
    root.innerHTML = `<p class="empty-state">Add a valid PubChem CID, e.g. <a href="?cid=2519">?cid=2519</a>.</p>`;
    return;
  }

  root.innerHTML = `<p class="muted">Loading molecule profile…</p>`;

  try {
    const res = await fetch(`/api/molecules-profile?cid=${cid}`);
    const data = await res.json();
    if (!res.ok || !data.profile) {
      root.innerHTML = `<p class="empty-state">${escapeHtml(data.error || "Molecule not found")}</p>`;
      return;
    }
    const p = data.profile;
    document.title = `${p.name} — Flux.ai`;

    const props = Object.entries(p.properties || {});
    root.innerHTML = `
      <div class="profile__header">
        <div>
          <p class="muted" style="margin:0 0 0.35rem">PubChem CID ${p.cid}</p>
          <h1 class="page-title">${escapeHtml(p.name)}</h1>
          <p class="muted">${escapeHtml([p.formula, p.molecularWeight != null ? `${p.molecularWeight} g/mol` : null].filter(Boolean).join(" · "))}</p>
        </div>
        <a class="btn btn--primary" href="/chat.html?q=${encodeURIComponent(`Tell me about ${p.name} (PubChem CID ${p.cid})`)}">Ask Flux</a>
      </div>
      <div class="profile__grid">
        <section class="panel">
          <h2>3D structure</h2>
          <div class="profile-viewer" id="profile-viewer"></div>
          <p class="muted" style="margin:0.75rem 0 0;font-size:0.85rem">Structure from PubChem SDF. Not fabricated.</p>
        </section>
        <section class="panel">
          <h2>Details</h2>
          <dl class="detail-list">
            <dt>IUPAC</dt><dd>${escapeHtml(p.iupacName || "—")}</dd>
            <dt>SMILES</dt><dd class="mono">${escapeHtml(p.smiles || "—")}</dd>
            <dt>InChIKey</dt><dd class="mono">${escapeHtml(p.inchiKey || "—")}</dd>
            <dt>Synonyms</dt><dd>${escapeHtml((p.synonyms || []).slice(0, 6).join(", ") || "—")}</dd>
          </dl>
        </section>
        ${
          p.description
            ? `<section class="panel panel--wide"><h2>Description</h2><p>${escapeHtml(p.description)}</p></section>`
            : ""
        }
        ${
          props.length
            ? `<section class="panel panel--wide"><h2>Properties</h2><dl class="prop-grid">${props
                .map(
                  ([k, v]) =>
                    `<div class="prop-item"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
                )
                .join("")}</dl></section>`
            : ""
        }
        <section class="panel panel--wide">
          <h2>References</h2>
          <ul class="ref-list">
            ${(p.references || [])
              .map(
                (r) =>
                  `<li><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.label)}</a></li>`,
              )
              .join("")}
          </ul>
        </section>
      </div>
    `;

    const viewer = document.getElementById("profile-viewer");
    if (viewer) {
      mountMoleculeViewer(viewer, { cid: p.cid, autoRotate: true, interactive: true });
    }
  } catch {
    root.innerHTML = `<p class="empty-state">Unable to load this molecule right now.</p>`;
  }
}

void load();
