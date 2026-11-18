import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (Flux.ai), for shared rubric modules. */
export function fluxRepoRoot(): string {
  if (process.env.FLUX_REPO_ROOT) return process.env.FLUX_REPO_ROOT;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../..");
}
