#!/usr/bin/env node
import { egressDomainsFromSources } from "../js/trusted-sources.js";
import { readIngestSources } from "../js/linked-sources-sync.mjs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = await readIngestSources(ROOT);
const domains = egressDomainsFromSources(sources);
console.log(JSON.stringify(domains, null, 2));
