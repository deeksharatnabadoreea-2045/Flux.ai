# Evidence: glucose (PubChem CID 5793)

_retrievedAt: 2026-11-20T12:19:54.761Z_  
_verifier: flux-science resume loop (official APIs only)_  
_status: verified curated-database + literature-linked claim — not an efficacy claim_

## Claim

Glucose has molecular formula **C6H12O6** and PubChem CID **5793**. Flux's human-molecule gate admits it when ChEBI/HMDB evidence supports human occurrence (fail-closed).

## Methods

1. PubChem PUG REST property lookup by name `glucose`
2. Human occurrence via `js/human-molecule.js` (ChEBI with retry + HMDB IDs from PubChem)
3. When ChEBI compound_origins cite a PubMed accession, verify that PMID via NCBI eutils (no fabricated ids)

## Observations (data in hand)

| Field | Value | Source |
| --- | --- | --- |
| CID | 5793 | https://pubchem.ncbi.nlm.nih.gov/compound/5793 |
| Formula | C6H12O6 | PubChem PUG REST |
| Molecular weight | 180.16 | PubChem PUG REST |
| occursInHumans | true | ChEBI/HMDB gate |
| reason | chebi_human_and_hmdb_mammalian_proxy | human-molecule |
| ChEBI | 17234, 17634, 4167 | PubChem synonyms |
| HMDB | HMDB0304632 | PubChem HMDB ID annotation |
| Human origin accessions | PubMed:21886157 (CHEBI:17234); DOI:10.1038/nbt.2488 (CHEBI:4167) | ChEBI compound_origins |
| PMID verify | ok=true; status=ok; title=Human metabolic individuality in biomedical and pharmaceutical research. | NCBI eutils |

## Inferences

Chemical identity matches PubChem for name “glucose”. Human-library admission follows the fail-closed ChEBI/HMDB gate. Any PubMed accession listed above was returned by ChEBI and re-checked via NCBI — not invented. No clinical efficacy claim is asserted.

## Uncertainty

Curated-database evidence ≠ primary clinical proof. ChEBI fetch failures are reported as `chebi_unavailable` (not absence of human occurrence). Stereoisomer naming (D-glucose vs glucose) may resolve to the same CID.

## Fake-science screening

Pass — no fabricated DOI/PMID; gate remains fail-closed; API outages are not treated as negative evidence.

## Provenance JSON

```json
{
  "pubchem": {
    "ok": true,
    "status": "ok",
    "name": "glucose",
    "cid": 5793,
    "formula": "C6H12O6",
    "molecularWeight": "180.16",
    "url": "https://pubchem.ncbi.nlm.nih.gov/compound/5793"
  },
  "human": {
    "occursInHumans": true,
    "reason": "chebi_human_and_hmdb_mammalian_proxy",
    "hmdbIds": [
      "HMDB0304632"
    ],
    "chebiIds": [
      "17234",
      "17634",
      "4167"
    ],
    "humanRoles": [
      "human metabolite"
    ],
    "proxyRoles": [
      "fundamental metabolite",
      "mouse metabolite"
    ],
    "humanOriginSources": [
      {
        "species": "Homo sapiens",
        "source": "PubMed",
        "sourceAccession": "21886157",
        "chebiId": "17234"
      },
      {
        "species": "Homo sapiens",
        "source": "DOI",
        "sourceAccession": "10.1038/nbt.2488",
        "chebiId": "4167"
      }
    ]
  },
  "pmidVerify": {
    "ok": true,
    "status": "ok",
    "pmid": "21886157",
    "title": "Human metabolic individuality in biomedical and pharmaceutical research.",
    "retracted": false,
    "url": "https://pubmed.ncbi.nlm.nih.gov/21886157/"
  },
  "retrievedAt": "2026-11-20T12:19:54.761Z"
}
```
