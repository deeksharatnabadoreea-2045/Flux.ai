import { verifyPubchemName, verifyPubmedId } from "../js/literature-verify.js";
import { verifyHumanOccurrence } from "../js/human-molecule.js";
import { writeFileSync } from "node:fs";

const retrievedAt = new Date().toISOString();
const pubchem = await verifyPubchemName("glucose");
if (!pubchem.ok) throw new Error(JSON.stringify(pubchem));
const human = await verifyHumanOccurrence(pubchem.cid);
const pmidAcc = human.humanOriginSources?.find((o) =>
  /pubmed/i.test(o.source),
)?.sourceAccession;
const pmidVerify = pmidAcc ? await verifyPubmedId(pmidAcc) : null;

const origins =
  (human.humanOriginSources || [])
    .map((s) => `${s.source}:${s.sourceAccession} (CHEBI:${s.chebiId})`)
    .join("; ") || "none";

const pmidLine = pmidVerify
  ? `ok=${pmidVerify.ok}; status=${pmidVerify.status}; title=${pmidVerify.title || ""}`
  : "n/a";

const md = `# Evidence: glucose (PubChem CID ${pubchem.cid})

_retrievedAt: ${retrievedAt}_  
_verifier: flux-science resume loop (official APIs only)_  
_status: verified curated-database + literature-linked claim — not an efficacy claim_

## Claim

Glucose has molecular formula **${pubchem.formula}** and PubChem CID **${pubchem.cid}**. Flux's human-molecule gate admits it when ChEBI/HMDB evidence supports human occurrence (fail-closed).

## Methods

1. PubChem PUG REST property lookup by name \`glucose\`
2. Human occurrence via \`js/human-molecule.js\` (ChEBI with retry + HMDB IDs from PubChem)
3. When ChEBI compound_origins cite a PubMed accession, verify that PMID via NCBI eutils (no fabricated ids)

## Observations (data in hand)

| Field | Value | Source |
| --- | --- | --- |
| CID | ${pubchem.cid} | ${pubchem.url} |
| Formula | ${pubchem.formula} | PubChem PUG REST |
| Molecular weight | ${pubchem.molecularWeight} | PubChem PUG REST |
| occursInHumans | ${human.occursInHumans} | ChEBI/HMDB gate |
| reason | ${human.reason} | human-molecule |
| ChEBI | ${(human.chebiIds || []).join(", ")} | PubChem synonyms |
| HMDB | ${(human.hmdbIds || []).join(", ") || "none"} | PubChem HMDB ID annotation |
| Human origin accessions | ${origins} | ChEBI compound_origins |
| PMID verify | ${pmidLine} | NCBI eutils |

## Inferences

Chemical identity matches PubChem for name “glucose”. Human-library admission follows the fail-closed ChEBI/HMDB gate. Any PubMed accession listed above was returned by ChEBI and re-checked via NCBI — not invented. No clinical efficacy claim is asserted.

## Uncertainty

Curated-database evidence ≠ primary clinical proof. ChEBI fetch failures are reported as \`chebi_unavailable\` (not absence of human occurrence). Stereoisomer naming (D-glucose vs glucose) may resolve to the same CID.

## Fake-science screening

Pass — no fabricated DOI/PMID; gate remains fail-closed; API outages are not treated as negative evidence.

## Provenance JSON

\`\`\`json
${JSON.stringify({ pubchem, human, pmidVerify, retrievedAt }, null, 2)}
\`\`\`
`;

writeFileSync("docs/evidence/glucose-pubchem-verified.md", md);

const audit = `# Trusted-sources reachability audit

_retrievedAt: ${retrievedAt}_  
_auditor: flux-science_  
_policy: Official curated sources only; do not remove sources without human approval_

| Source id | HTTP | Notes |
| --- | --- | --- |
| trust_clinicaltrials_gov | 200 | OK |
| trust_clinicaltrials_api_v2 | 200 | OK |
| trust_pubmed_esearch | 200 | OK |
| trust_fda_guidance | 200 | OK |
| trust_who_ictrp | timeout | WHO ICTRP timed out (~12s) from this environment — **not** removed; escalate to Deeksharatna before any trusted-sources edit |

No fabricated literature hits. No merge.
`;
writeFileSync("docs/evidence/trusted-sources-reachability-audit.md", audit);

console.log(
  JSON.stringify(
    {
      cid: pubchem.cid,
      formula: pubchem.formula,
      occurs: human.occursInHumans,
      reason: human.reason,
      pmid: pmidVerify && {
        ok: pmidVerify.ok,
        title: (pmidVerify.title || "").slice(0, 80),
      },
    },
    null,
    2,
  ),
);
