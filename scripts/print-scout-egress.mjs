#!/usr/bin/env node
import { egressDomainsFromConfig } from "../js/linked-sources.js";
import { readLinkedSourcesConfig } from "../js/linked-sources-sync.mjs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = await readLinkedSourcesConfig(ROOT);
const domains = egressDomainsFromConfig(config);
console.log(JSON.stringify(domains, null, 2));
