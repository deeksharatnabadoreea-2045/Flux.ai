/** Landing molecule result panel — PubChem properties + human-occurrence evidence. */

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

export function formatEvidence(molecule) {
  if (molecule?.evidenceSummary) return molecule.evidenceSummary;
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

/**
 * Update the molecule properties card under the composer.
 * Used by conversational replies that include a PubChem hit.
 */
export function setMoleculePanel({ loading = false, molecule = null, error = "" } = {}) {
  const els = moleculeEls();
  if (!els.panel) return;

  const showError = Boolean(error) && !molecule && !loading;
  const showMolecule = Boolean(molecule) && !loading;

  if (!loading && !showMolecule && !showError) {
    els.panel.classList.add("is-hidden");
    return;
  }

  els.panel.classList.remove("is-hidden");
  els.status?.classList.toggle("is-hidden", !loading);
  els.name?.classList.toggle("is-hidden", !showMolecule);
  els.props?.classList.toggle("is-hidden", !showMolecule);
  els.error?.classList.toggle("is-hidden", !showError);

  if (els.status) {
    els.status.textContent = loading ? "Thinking…" : "";
  }
  if (els.name) els.name.textContent = molecule?.name ?? "";
  if (els.formula) els.formula.textContent = molecule?.formula ?? "";
  if (els.weight) els.weight.textContent = molecule?.molecularWeight ?? "";
  if (els.evidence) els.evidence.textContent = formatEvidence(molecule);
  if (els.error) els.error.textContent = error;

  if (els.submit) els.submit.disabled = loading;
  if (els.input) els.input.disabled = loading;
}
