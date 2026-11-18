/**
 * Scientific-method rubric for Validator audits — blocks fake science on Flux.
 * @see docs/SCIENTIFIC-METHOD.md
 */

/** Markdown section titles Validator must include (## or **Title**). */
export const VALIDATOR_SCIENCE_HEADINGS = [
  "Hypothesis under test",
  "Predictions",
  "Methods and reproducibility",
  "Observations (data in hand)",
  "Inferences (conclusions)",
  "Falsifiability",
  "Uncertainty",
  "Fake-science screening",
];

export const VALIDATOR_REPORT_HEADINGS = [
  "Scope",
  ...VALIDATOR_SCIENCE_HEADINGS,
  "Validation ladder stage",
  "Code / platform findings",
  "Verdict",
  "Required fixes",
  "Recommendation",
];

const HEADING_ALIASES = {
  "Observations (data in hand)": ["Observations", "Data in hand"],
  "Inferences (conclusions)": ["Inferences", "Conclusions drawn"],
  "Fake-science screening": ["Fake science screening", "Fake-science check"],
};

/** Rhetoric patterns that trigger block unless explicitly debunked in Observations. */
export const FAKE_SCIENCE_SIGNALS = [
  "proven to cure",
  "100% effective",
  "100% concordance",
  "miracle",
  "breakthrough with no uncertainty",
  "clinical proof from our scrape",
  "guaranteed outcome",
  "no side effects",
  "replaces all trials",
  "validated without data",
];

export function headingPresent(bodyMarkdown, title) {
  const text = String(bodyMarkdown ?? "");
  const variants = [title, ...(HEADING_ALIASES[title] ?? [])];
  return variants.some((v) => {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)#+\\s*${escaped}\\b|\\*\\*${escaped}\\*\\*`, "i");
    return re.test(text);
  });
}

export function missingValidatorHeadings(bodyMarkdown) {
  return VALIDATOR_REPORT_HEADINGS.filter((h) => !headingPresent(bodyMarkdown, h));
}

export function detectFakeScienceRhetoric(bodyMarkdown) {
  const lower = String(bodyMarkdown ?? "").toLowerCase();
  return FAKE_SCIENCE_SIGNALS.filter((phrase) => lower.includes(phrase));
}

/**
 * @param {object} input
 * @param {string} input.bodyMarkdown
 * @param {boolean} input.fakeScienceDetected
 * @param {"ship"|"fix"|"block"} input.verdict
 */
export function validateScientificMethodReport(input) {
  const errors = [];
  const missing = missingValidatorHeadings(input.bodyMarkdown);
  if (missing.length) {
    errors.push(`missing_sections:${missing.join(",")}`);
  }

  const rhetoricHits = detectFakeScienceRhetoric(input.bodyMarkdown);
  if (rhetoricHits.length && !input.fakeScienceDetected) {
    errors.push(`flag_fake_science_rhetoric:${rhetoricHits.join("|")}`);
  }

  if (input.fakeScienceDetected && input.verdict !== "block") {
    errors.push("verdict_must_be_block_when_fake_science_detected");
  }

  const obs = String(input.bodyMarkdown ?? "");
  if (headingPresent(obs, "Observations (data in hand)")) {
    const obsSection = extractSection(obs, "Observations (data in hand)");
    if (/https?:\/\//.test(obsSection) && !/snapshot|manifest|NCT|doi\.org|pubmed|registry/i.test(obsSection)) {
      errors.push("observations_need_lineage_not_bare_urls");
    }
  }

  return { ok: errors.length === 0, errors };
}

function extractSection(body, title) {
  const variants = [title, ...(HEADING_ALIASES[title] ?? [])];
  for (const v of variants) {
    const re = new RegExp(`(?:#+\\s*${v}|\\*\\*${v}\\*\\*)\\s*([\\s\\S]*?)(?=\\n#+\\s|\\n\\*\\*[A-Z]|$)`, "i");
    const m = body.match(re);
    if (m) return m[1];
  }
  return "";
}
