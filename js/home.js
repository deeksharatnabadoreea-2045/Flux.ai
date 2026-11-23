import { HERO_MOLECULE_CID } from "./molecules-pubchem.js";
import { mountMoleculeViewer } from "./molecule-viewer.js";
import { initSiteChrome } from "./site-nav.js";
import { BIOLOGY_CATEGORIES } from "./molecules-pubchem.js";

initSiteChrome();

const stage = document.getElementById("hero-viewer");
if (stage) {
  mountMoleculeViewer(stage, {
    cid: HERO_MOLECULE_CID,
    autoRotate: true,
    interactive: false,
  });
}

const list = document.getElementById("biology-modules");
if (list) {
  for (const cat of BIOLOGY_CATEGORIES) {
    if (cat.availability === "available") {
      const a = document.createElement("a");
      a.href = cat.id === "molecules" ? "/explorer/molecules/" : `/explorer/${cat.id}/`;
      a.className = "module-row";
      a.innerHTML = `
        <div>
          <h3>${cat.label}</h3>
          <p class="muted">${cat.description}</p>
        </div>
        <span class="badge badge--live">${cat.statusLabel}</span>
      `;
      list.appendChild(a);
    } else {
      const div = document.createElement("div");
      div.className = "module-row module-row--muted";
      div.innerHTML = `
        <div>
          <h3>${cat.label}</h3>
          <p class="muted">${cat.description}</p>
        </div>
        <span class="badge">${cat.statusLabel}</span>
      `;
      list.appendChild(div);
    }
  }
}
