import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { lookupMolecule } from "./pubchem.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("lookupMolecule returns formula and weight from PubChem JSON", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      PropertyTable: {
        Properties: [
          { CID: 962, MolecularFormula: "H2O", MolecularWeight: "18.015" },
        ],
      },
    }),
  });

  const result = await lookupMolecule("water");
  assert.deepEqual(result, {
    name: "water",
    formula: "H2O",
    molecularWeight: "18.015",
    cid: 962,
  });
});

test("lookupMolecule returns null for PubChem 404", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  });

  assert.equal(await lookupMolecule("not-a-real-molecule-xyz"), null);
});

test("lookupMolecule returns null for blank names", async () => {
  assert.equal(await lookupMolecule("  "), null);
});
