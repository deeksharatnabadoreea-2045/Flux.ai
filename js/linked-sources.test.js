import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  validateSourceInput,
  egressDomainsFromConfig,
} from "./linked-sources.js";

test("normalizeUrl accepts bare hostnames", () => {
  assert.equal(normalizeUrl("clinicaltrials.gov"), "https://clinicaltrials.gov/");
});

test("validateSourceInput rejects bad urls", () => {
  assert.equal(validateSourceInput({ url: "not a url" }).ok, false);
});

test("egressDomainsFromConfig lists hostnames", () => {
  const hosts = egressDomainsFromConfig({
    version: 1,
    sources: [{ url: "https://www.fda.gov/foo", id: "a", label: "FDA" }],
  });
  assert.deepEqual(hosts, ["www.fda.gov"]);
});
