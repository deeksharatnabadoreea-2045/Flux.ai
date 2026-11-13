import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { lookupMolecule } from "./pubchem.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockHumanVerifiedFetch() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/property/MolecularFormula,MolecularWeight/json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          PropertyTable: {
            Properties: [
              { CID: 962, MolecularFormula: "H2O", MolecularWeight: "18.015" },
            ],
          },
        }),
      };
    }
    if (href.includes("/synonyms/JSON")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          InformationList: {
            Information: [{ CID: 962, Synonym: ["CHEBI:15377"] }],
          },
        }),
      };
    }
    if (href.includes("heading=HMDB%20ID")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Record: {
            Section: [
              {
                Information: [
                  { Value: { StringWithMarkup: [{ String: "HMDB0002111" }] } },
                ],
              },
            ],
          },
        }),
      };
    }
    if (href.includes("/chebi/backend/api/public/compound/15377/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          roles_classification: { name: "human metabolite" },
          compound_origins: [
            {
              species_text: "Homo sapiens",
              species_accession: "9606",
              source: "PubMed",
              source_accession: "21988831",
            },
          ],
        }),
      };
    }
    throw new Error(`Unexpected URL ${href}`);
  };
}

test("lookupMolecule returns formula, weight, and human evidence", async () => {
  mockHumanVerifiedFetch();

  const result = await lookupMolecule("water");
  assert.equal(result.name, "water");
  assert.equal(result.formula, "H2O");
  assert.equal(result.molecularWeight, "18.015");
  assert.equal(result.cid, 962);
  assert.equal(result.humanEvidence.occursInHumans, true);
  assert.ok(result.humanEvidence.hmdbIds.includes("HMDB0002111"));
});

test("lookupMolecule can skip the human gate when explicitly requested", async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/property\/MolecularFormula,MolecularWeight\/json$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        PropertyTable: {
          Properties: [
            { CID: 2244, MolecularFormula: "C9H8O4", MolecularWeight: "180.16" },
          ],
        },
      }),
    };
  };

  const result = await lookupMolecule("aspirin", { requireHumanOccurrence: false });
  assert.deepEqual(result, {
    name: "aspirin",
    formula: "C9H8O4",
    molecularWeight: "180.16",
    cid: 2244,
  });
});

test("lookupMolecule rejects compounds lacking human-occurrence evidence", async () => {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/property/MolecularFormula,MolecularWeight/json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          PropertyTable: {
            Properties: [
              { CID: 2244, MolecularFormula: "C9H8O4", MolecularWeight: "180.16" },
            ],
          },
        }),
      };
    }
    if (href.includes("/synonyms/JSON")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          InformationList: {
            Information: [{ CID: 2244, Synonym: ["CHEBI:15365"] }],
          },
        }),
      };
    }
    if (href.includes("heading=HMDB%20ID")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Record: {
            Section: [
              {
                Information: [
                  { Value: { StringWithMarkup: [{ String: "HMDB0001879" }] } },
                ],
              },
            ],
          },
        }),
      };
    }
    if (href.includes("/chebi/backend/api/public/compound/15365/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          roles_classification: { name: "non-steroidal anti-inflammatory drug" },
          compound_origins: [],
        }),
      };
    }
    throw new Error(`Unexpected URL ${href}`);
  };

  await assert.rejects(
    () => lookupMolecule("aspirin"),
    /not included in the human molecule library/,
  );
});

test("lookupMolecule throws for PubChem 404", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  });

  await assert.rejects(
    () => lookupMolecule("not-a-real-molecule-xyz"),
    /No PubChem compound found/,
  );
});

test("lookupMolecule throws for blank names", async () => {
  await assert.rejects(() => lookupMolecule("  "), /Enter a compound name/);
});
