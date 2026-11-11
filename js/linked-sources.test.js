import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  validateSourceInput,
  egressDomainsFromConfig,
  mergeSourcesConfig,
  isUnsafeLinkedHostname,
} from "./linked-sources.js";

test("normalizeUrl accepts bare hostnames", () => {
  assert.equal(normalizeUrl("clinicaltrials.gov"), "https://clinicaltrials.gov/");
});

test("validateSourceInput rejects bad urls", () => {
  assert.equal(validateSourceInput({ url: "not a url" }).ok, false);
});

test("normalizeUrl rejects private hosts and dangerous schemes", () => {
  assert.equal(normalizeUrl("http://127.0.0.1/secret"), null);
  assert.equal(normalizeUrl("http://169.254.169.254/latest"), null);
  assert.equal(normalizeUrl("http://localhost/admin"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("https://user:pass@example.com"), null);
  assert.equal(isUnsafeLinkedHostname("10.0.0.5"), true);
});

test("mergeSourcesConfig drops unsafe entries from API payloads", () => {
  const merged = mergeSourcesConfig(
    { version: 1, sources: [] },
    [
      { id: "src_ok_1", url: "https://clinicaltrials.gov", label: "CT" },
      { id: "src_bad_1", url: "http://127.0.0.1:8080", label: "local" },
      { id: "src_bad_2", url: "javascript:alert(1)", label: "xss" },
    ],
  );
  assert.equal(merged.sources.length, 1);
  assert.equal(merged.sources[0].url, "https://clinicaltrials.gov/");
});

test("egressDomainsFromConfig lists hostnames", () => {
  const hosts = egressDomainsFromConfig({
    version: 1,
    sources: [{ url: "https://www.fda.gov/foo", id: "a", label: "FDA" }],
  });
  assert.deepEqual(hosts, ["www.fda.gov"]);
});
