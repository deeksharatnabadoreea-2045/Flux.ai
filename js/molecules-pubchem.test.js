import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURED_FALLBACK,
  FEATURED_MOLECULE_CIDS,
  HERO_MOLECULE_CID,
  parseCid,
  searchMolecules,
} from "./molecules-pubchem.js";

test("parseCid rejects invalid values", () => {
  assert.equal(parseCid(null), null);
  assert.equal(parseCid("abc"), null);
  assert.equal(parseCid("-1"), null);
  assert.equal(parseCid("0"), null);
  assert.equal(parseCid("2519"), 2519);
});

test("featured catalog uses real PubChem CIDs", () => {
  assert.equal(HERO_MOLECULE_CID, 2519);
  assert.ok(FEATURED_MOLECULE_CIDS.includes(2519));
  for (const m of FEATURED_FALLBACK) {
    assert.ok(Number.isInteger(m.cid) && m.cid > 0);
    assert.ok(m.name);
    assert.ok(m.formula);
  }
});

test("searchMolecules returns empty for blank query without network", async () => {
  assert.deepEqual(await searchMolecules("   "), []);
});
