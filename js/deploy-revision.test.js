import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEPLOY_BASED_ON_MAIN,
  DEPLOY_STAMP,
  STATIC_CACHE_BUST,
} from "./deploy-revision.js";

const root = join(import.meta.dirname, "..");

function readPage(name) {
  return readFileSync(join(root, name), "utf8");
}

test("chat.html deploy meta, body sha, and cache bust match deploy-revision.js", () => {
  const html = readPage("chat.html");
  assert.match(
    html,
    new RegExp(
      `<meta name="flux-deploy-sha" content="${DEPLOY_BASED_ON_MAIN}">`,
    ),
  );
  assert.match(
    html,
    new RegExp(`<meta name="flux-deploy-stamp" content="${DEPLOY_STAMP}">`),
  );
  assert.match(html, new RegExp(`data-flux-deploy="${DEPLOY_BASED_ON_MAIN}"`));
  assert.match(
    html,
    new RegExp(`landing\\.css\\?v=${STATIC_CACHE_BUST}`),
  );
  assert.match(
    html,
    new RegExp(`landing\\.js\\?v=${STATIC_CACHE_BUST}`),
  );
  assert.match(html, new RegExp(`id="flux-deploy-release"`));
});

test("index.html (marketing home) deploy stamp and site.css cache bust", () => {
  const html = readPage("index.html");
  assert.match(
    html,
    new RegExp(`<meta name="flux-deploy-stamp" content="${DEPLOY_STAMP}">`),
  );
  assert.match(html, new RegExp(`site\\.css\\?v=${STATIC_CACHE_BUST}`));
  assert.match(html, /Where biology meets intelligence/);
});

test("hq.html viewport and cache bust match deploy-revision.js", () => {
  const html = readPage("hq.html");
  assert.match(html, /width=device-width/);
  assert.match(
    html,
    new RegExp(`hq\\.css\\?v=${STATIC_CACHE_BUST}`),
  );
  assert.match(html, new RegExp(`hq\\.js\\?v=${STATIC_CACHE_BUST}`));
  assert.match(
    html,
    new RegExp(`<meta name="flux-deploy-stamp" content="${DEPLOY_STAMP}">`),
  );
});

test("landing modules use the same STATIC_CACHE_BUST import suffix", () => {
  for (const rel of ["js/landing.js", "js/landing-chat.js"]) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.match(
      src,
      new RegExp(`\\?v=${STATIC_CACHE_BUST}`),
      `${rel} must cache-bust with STATIC_CACHE_BUST`,
    );
  }
});
