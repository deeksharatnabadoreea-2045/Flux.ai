# Evidence: water is H₂O (PubChem CID 962)

_retrievedAt: 2026-11-19T06:55:41.565Z_  
_verifier: flux-science MVP (official APIs only)_  
_status: verified curated-database claim — not a new efficacy claim_

## Claim

Water has molecular formula **H2O** and PubChem CID **962**, and has ChEBI/HMDB-backed evidence of natural occurrence in humans (human metabolite gate).

## Methods

1. PubChem PUG REST property lookup by name `water`
2. Human occurrence via `js/human-molecule.js` (ChEBI roles + HMDB IDs linked from PubChem)

## Observations (data in hand)

| Field | Value | Source |
| --- | --- | --- |
| CID | 962 | https://pubchem.ncbi.nlm.nih.gov/compound/962 |
| Formula | H2O | PubChem PUG REST |
| Molecular weight | 18.015 | PubChem PUG REST |
| occursInHumans | true | ChEBI/HMDB via PubChem |
| reason | chebi_human_and_hmdb_mammalian_proxy | human-molecule gate |
| ChEBI | 15377, 197504 | PubChem synonyms |
| HMDB | HMDB0002111 | PubChem HMDB ID annotation |
| Human origin DOI (from ChEBI, not invented) | 10.1038/nbt.2488 | ChEBI compound_origins |

## Inferences

Formula and CID match PubChem’s official record for water. Human-metabolite inclusion follows Flux’s fail-closed ChEBI/HMDB gate. No efficacy or trial claim is asserted.

## Uncertainty

PubChem/ChEBI/HMDB are curated databases — not primary clinical evidence. This report only confirms chemical identity + library admission criteria.

## Fake-science screening

Pass — no fabricated DOI/PMID; the only DOI listed is the accession returned by ChEBI compound_origins for Homo sapiens.

## Provenance JSON

```json
{
  "pubchem": {
    "ok": true,
    "status": "ok",
    "name": "water",
    "cid": 962,
    "formula": "H2O",
    "molecularWeight": "18.015",
    "url": "https://pubchem.ncbi.nlm.nih.gov/compound/962"
  },
  "humanEvidence": {
    "occursInHumans": true,
    "reason": "chebi_human_and_hmdb_mammalian_proxy",
    "hmdbIds": [
      "HMDB0002111"
    ],
    "chebiIds": [
      "15377",
      "197504"
    ],
    "humanRoles": [
      "human metabolite"
    ],
    "proxyRoles": [
      "mouse metabolite"
    ],
    "humanOriginSources": [
      {
        "species": "Homo sapiens",
        "source": "DOI",
        "sourceAccession": "10.1038/nbt.2488",
        "chebiId": "15377"
      }
    ]
  },
  "retrievedAt": "2026-11-19T06:55:41.565Z"
}
```
