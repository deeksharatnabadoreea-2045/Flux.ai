import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDois,
  extractPmids,
  checkIdentifierProvenance,
  isWellFormedDoi,
  isWellFormedPmid,
  verifyOpenAlexDoi,
  verifyPubchemName,
} from "./literature-verify.js";

function headingPresent(body, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Titles may end with ")" — use lookahead, not \\b (non-word → non-word).
  return new RegExp(`(^|\\n)#+\\s*${escaped}(?=\\s|$)`, "i").test(body);
}

function extractSection(body, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:#+\\s*${escaped})\\s*([\\s\\S]*?)(?=\\n#+\\s|$)`, "i");
  const m = body.match(re);
  return m ? m[1] : "";
}

test("extractDois finds well-formed DOIs", () => {
  const dois = extractDois("See 10.1038/nbt.2488 and https://doi.org/10.1000/182.");
  assert.ok(dois.includes("10.1038/nbt.2488"));
  assert.ok(dois.some((d) => d.startsWith("10.1000/")));
});

test("extractPmids finds PMID labels and pubmed URLs", () => {
  const pmids = extractPmids("PMID: 1234567 and https://pubmed.ncbi.nlm.nih.gov/7654321/");
  assert.deepEqual(pmids.sort(), ["1234567", "7654321"]);
});

test("isWellFormedDoi / isWellFormedPmid reject junk", () => {
  assert.equal(isWellFormedDoi("not-a-doi"), false);
  assert.equal(isWellFormedPmid("abc"), false);
  assert.equal(isWellFormedDoi("10.1038/nbt.2488"), true);
  assert.equal(isWellFormedPmid("12345"), true);
});

test("checkIdentifierProvenance flags DOIs outside Observations", () => {
  const body = `
## Observations (data in hand)
No identifiers here.

## Inferences (conclusions)
Claim supported by 10.9999/fake.doi.123
`;
  const result = checkIdentifierProvenance(body, extractSection, headingPresent);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unverified_doi_outside_observations")));
});

test("checkIdentifierProvenance accepts DOI listed in Observations", () => {
  const body = `
## Observations (data in hand)
Registry snapshot cites doi.org/10.1038/nbt.2488 from ChEBI compound_origins.

## Inferences (conclusions)
Human origin source DOI 10.1038/nbt.2488 is lineage-tied.
`;
  const result = checkIdentifierProvenance(body, extractSection, headingPresent);
  assert.equal(result.ok, true);
});

test("verifyPubchemName returns water CID 962 via official API", async () => {
  const result = await verifyPubchemName("water");
  assert.equal(result.ok, true);
  assert.equal(result.cid, 962);
  assert.equal(result.formula, "H2O");
});

test("verifyOpenAlexDoi rejects malformed DOIs without inventing hits", async () => {
  const result = await verifyOpenAlexDoi("not-a-doi");
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
});

test("heading-style DOI provenance still passes when listed in Observations", () => {
  const body = `
## Observations (data in hand)
ChEBI compound_origins cites PubMed 21886157 (not a fabricated id).

## Inferences (conclusions)
Human origin accession PubMed 21886157 is lineage-tied.
`;
  // PMID form
  const pmidBody = body.replaceAll("21886157", "PMID: 21886157");
  const result = checkIdentifierProvenance(pmidBody, extractSection, headingPresent);
  assert.equal(result.ok, true);
});
