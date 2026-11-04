---
name: scientific-method
description: Structure Validator audits with hypothesis, predictions, observations vs inferences, falsifiability, and fake-science screening.
---

# Scientific-method Validator audit

Use when filing any `file_validator_report`.

## Procedure

1. Restate the **testable hypothesis** — if the brief is only marketing, convert it to a hypothesis or block.
2. Write **predictions** before reconciling with data you already have.
3. In **Observations**, cite only: manifest snapshot ids, NCT/DOI/registry ids present in ingest, or repo paths. Write "not in data" instead of guessing.
4. Keep **Inferences** short and labeled; no new numbers not derived in Observations.
5. **Falsifiability** must name a concrete disproof, not "more research needed" alone.
6. **Fake-science screening**: fail if scrape text is treated as clinical proof, or concordance is claimed without L1 replay artifact.

## File

Call `file_validator_report` with full sections per `docs/SCIENTIFIC-METHOD.md` and honest attestation flags.
