import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBlockedIpv4,
  isBlockedHostname,
  parsePublicHttpUrl,
} from "./url-safety.mjs";

test("blocks private and link-local IPv4 ranges", () => {
  assert.equal(isBlockedIpv4("127.0.0.1"), true);
  assert.equal(isBlockedIpv4("10.1.2.3"), true);
  assert.equal(isBlockedIpv4("192.168.1.1"), true);
  assert.equal(isBlockedIpv4("169.254.169.254"), true);
  assert.equal(isBlockedIpv4("172.16.0.1"), true);
  assert.equal(isBlockedIpv4("8.8.8.8"), false);
});

test("parsePublicHttpUrl rejects metadata and credentials", () => {
  assert.throws(() => parsePublicHttpUrl("http://169.254.169.254/latest"), /blocked_host/);
  assert.throws(() => parsePublicHttpUrl("http://metadata.google.internal/"), /blocked_host/);
  assert.throws(() => parsePublicHttpUrl("https://user:x@example.com"), /credentials_forbidden/);
  assert.throws(() => parsePublicHttpUrl("ftp://example.com"), /invalid_scheme/);
  assert.equal(parsePublicHttpUrl("https://example.com/a").hostname, "example.com");
});

test("isBlockedHostname covers localhost variants", () => {
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("foo.localhost"), true);
  assert.equal(isBlockedHostname("clinicaltrials.gov"), false);
});
