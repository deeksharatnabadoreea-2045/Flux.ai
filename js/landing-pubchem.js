/** Landing compound search — PubChem PUG REST only. */

import { lookupMolecule } from "./pubchem.js";

function moleculeEls() {
  return {
    panel: document.getElementById("molecule-result"),
    status: document.getElementById("molecule-result-status"),
    name: document.getElementById("molecule-result-name"),
    props: document.getElementById("molecule-result-props"),
    formula: document.getElementById("molecule-result-formula"),
    weight: document.getElementById("molecule-result-weight"),
    error: document.getElementById("molecule-result-error"),
    submit: document.getElementById("composer-submit"),
    input: document.getElementById("composer-input"),
  };
}

function setMoleculePanel({ loading = false, molecule = null, error = "" } = {}) {
  const els = moleculeEls();
  if (!els.panel) return;

  els.panel.classList.remove("is-hidden");
  els.status?.classList.toggle("is-hidden", !loading);
  els.name?.classList.toggle("is-hidden", !molecule);
  els.props?.classList.toggle("is-hidden", !molecule);
  els.error?.classList.toggle("is-hidden", !error);

  if (els.status) els.status.textContent = loading ? "Looking up PubChem…" : "";
  if (els.name) els.name.textContent = molecule?.name ?? "";
  if (els.formula) els.formula.textContent = molecule?.formula ?? "";
  if (els.weight) els.weight.textContent = molecule?.molecularWeight ?? "";
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
        ? "Could not reach PubChem. Check your connection and try again."
        : err?.message || "PubChem lookup failed.";
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
