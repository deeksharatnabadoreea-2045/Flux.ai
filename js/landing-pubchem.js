/** Landing compound search — PubChem properties + human-occurrence gate. */

import { lookupMolecule } from "./pubchem.js";

function moleculeEls() {
  return {
    panel: document.getElementById("molecule-result"),
    status: document.getElementById("molecule-result-status"),
    name: document.getElementById("molecule-result-name"),
    props: document.getElementById("molecule-result-props"),
    formula: document.getElementById("molecule-result-formula"),
    weight: document.getElementById("molecule-result-weight"),
    evidence: document.getElementById("molecule-result-evidence"),
    error: document.getElementById("molecule-result-error"),
    submit: document.getElementById("composer-submit"),
    input: document.getElementById("composer-input"),
  };
}

function formatEvidence(molecule) {
  const evidence = molecule?.humanEvidence;
  if (!evidence?.occursInHumans) return "";

  const parts = [];
  if (evidence.hmdbIds?.length) {
    parts.push(`HMDB ${evidence.hmdbIds.slice(0, 2).join(", ")}`);
  }
  if (evidence.chebiIds?.length) {
    parts.push(
      evidence.chebiIds
        .slice(0, 2)
        .map((id) => `ChEBI:${id}`)
        .join(", "),
    );
  }
  if (evidence.humanRoles?.length) {
    parts.push(evidence.humanRoles[0]);
  } else if (evidence.humanOriginSources?.length) {
    const origin = evidence.humanOriginSources[0];
    const cite = origin.sourceAccession
      ? `${origin.source} ${origin.sourceAccession}`
      : origin.source || "literature";
    parts.push(`Homo sapiens (${cite})`);
  } else if (evidence.proxyRoles?.length) {
    parts.push(evidence.proxyRoles[0]);
  }

  return parts.length ? parts.join(" · ") : "Verified via ChEBI/HMDB";
}

function setMoleculePanel({ loading = false, molecule = null, error = "" } = {}) {
  const els = moleculeEls();
  if (!els.panel) return;

  els.panel.classList.remove("is-hidden");
  els.status?.classList.toggle("is-hidden", !loading);
  els.name?.classList.toggle("is-hidden", !molecule);
  els.props?.classList.toggle("is-hidden", !molecule);
  els.error?.classList.toggle("is-hidden", !error);

  if (els.status) {
    els.status.textContent = loading
      ? "Looking up PubChem and verifying human occurrence…"
      : "";
  }
  if (els.name) els.name.textContent = molecule?.name ?? "";
  if (els.formula) els.formula.textContent = molecule?.formula ?? "";
  if (els.weight) els.weight.textContent = molecule?.molecularWeight ?? "";
  if (els.evidence) els.evidence.textContent = formatEvidence(molecule);
  if (els.error) els.error.textContent = error;

  if (els.submit) els.submit.disabled = loading;
  if (els.input) els.input.disabled = loading;
}

async function handleSearchSubmit(input) {
  const query = input.value.trim();
  if (!query) {
    setMoleculePanel({ error: "Enter a compound name to search." });
    return;
  }

  input.value = "";
  setMoleculePanel({ loading: true });

  try {
    const molecule = await lookupMolecule(query);
    setMoleculePanel({ molecule });
  } catch (err) {
    const message =
      err instanceof TypeError
        ? "Could not reach PubChem or evidence databases. Check your connection and try again."
        : err?.message || "Molecule lookup failed.";
    setMoleculePanel({ error: message });
  }
}

export function initPubchemSearch() {
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  if (!form || !input) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleSearchSubmit(input);
  });

  // Enter searches; Shift+Enter keeps a newline in the textarea.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || input.disabled) return;
    e.preventDefault();
    form.requestSubmit();
  });
}
