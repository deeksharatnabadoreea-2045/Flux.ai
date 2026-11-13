import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  evaluateHumanOccurrence,
  extractChebiHumanSignals,
  fetchChebiIdsForCid,
  fetchHmdbIdsForCid,
  verifyHumanOccurrence,
} from "./human-molecule.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("evaluateHumanOccurrence accepts ChEBI human metabolite roles", () => {
  const result = evaluateHumanOccurrence({
    chebiIds: ["15377"],
    chebiSignals: [
      {
        humanRoles: ["human metabolite"],
        proxyRoles: [],
        humanOriginSources: [],
      },
    ],
  });
  assert.equal(result.occursInHumans, true);
  assert.equal(result.reason, "chebi_human");
});

test("evaluateHumanOccurrence accepts Homo sapiens compound origins", () => {
  const result = evaluateHumanOccurrence({
    chebiIds: ["15428"],
    chebiSignals: [
      {
        humanRoles: [],
        proxyRoles: [],
        humanOriginSources: [
          {
            species: "Homo sapiens",
            source: "PubMed",
            sourceAccession: "21886157",
            chebiId: "15428",
          },
        ],
      },
    ],
  });
  assert.equal(result.occursInHumans, true);
  assert.equal(result.reason, "chebi_human");
});

test("evaluateHumanOccurrence accepts HMDB + mammalian proxy when human role missing", () => {
  const result = evaluateHumanOccurrence({
    hmdbIds: ["HMDB0000538"],
    chebiIds: ["15422"],
    chebiSignals: [
      {
        humanRoles: [],
        proxyRoles: ["fundamental metabolite", "mouse metabolite"],
        humanOriginSources: [],
      },
    ],
  });
  assert.equal(result.occursInHumans, true);
  assert.equal(result.reason, "hmdb_and_mammalian_proxy");
});

test("evaluateHumanOccurrence rejects HMDB-only xenobiotics without metabolite roles", () => {
  const result = evaluateHumanOccurrence({
    hmdbIds: ["HMDB0001879"],
    chebiIds: ["15365"],
    chebiSignals: [
      {
        humanRoles: [],
        proxyRoles: [],
        humanOriginSources: [],
      },
    ],
  });
  assert.equal(result.occursInHumans, false);
  assert.equal(result.reason, "insufficient_evidence");
});

test("evaluateHumanOccurrence rejects empty evidence", () => {
  const result = evaluateHumanOccurrence({});
  assert.equal(result.occursInHumans, false);
});

test("extractChebiHumanSignals reads nested roles and Homo sapiens origins", () => {
  const signals = extractChebiHumanSignals(
    {
      roles_classification: {
        name: "role",
        children: [{ name: "human metabolite" }, { name: "plant metabolite" }],
      },
      compound_origins: [
        {
          species_text: "Homo sapiens",
          species_accession: "9606",
          source: "PubMed",
          source_accession: "1",
        },
        {
          species_text: "Escherichia coli",
          species_accession: "562",
          source: "PubMed",
          source_accession: "2",
        },
      ],
    },
    "15377",
  );
  assert.deepEqual(signals.humanRoles, ["human metabolite"]);
  assert.equal(signals.humanOriginSources.length, 1);
  assert.equal(signals.humanOriginSources[0].sourceAccession, "1");
});

test("fetchChebiIdsForCid extracts CHEBI synonyms from PubChem", async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/cid\/962\/synonyms\/JSON$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        InformationList: {
          Information: [
            { CID: 962, Synonym: ["water", "CHEBI:15377", "CHEBI:15377", "H2O"] },
          ],
        },
      }),
    };
  };
  assert.deepEqual(await fetchChebiIdsForCid(962), ["15377"]);
});

test("fetchHmdbIdsForCid reads HMDB ID annotation strings", async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /heading=HMDB%20ID/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        Record: {
          Section: [{ Information: [{ Value: { StringWithMarkup: [{ String: "HMDB0002111" }] } }] }],
        },
      }),
    };
  };
  assert.deepEqual(await fetchHmdbIdsForCid(962), ["HMDB0002111"]);
});

test("verifyHumanOccurrence combines PubChem links with ChEBI signals", async () => {
  globalThis.fetch = async (url) => {
    const href = String(url);
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
          Record: { Section: [{ Information: [{ Value: { StringWithMarkup: [{ String: "HMDB0002111" }] } }] }] },
        }),
      };
    }
    if (href.includes("/chebi/backend/api/public/compound/15377/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          roles_classification: { name: "human metabolite" },
          compound_origins: [],
        }),
      };
    }
    throw new Error(`Unexpected URL ${href}`);
  };

  const evidence = await verifyHumanOccurrence(962);
  assert.equal(evidence.occursInHumans, true);
  assert.deepEqual(evidence.hmdbIds, ["HMDB0002111"]);
  assert.deepEqual(evidence.chebiIds, ["15377"]);
  assert.ok(evidence.humanRoles.includes("human metabolite"));
});
