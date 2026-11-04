# Validation harness (v0 stub)

Target: **L1 retrospective replay** — blind comparison of emulated primary endpoints vs published/registry results for completed trials.

## Run locally

```bash
node engine/harness/replay-stub.mjs
```

The stub reads `.flux/source-snapshots/manifest.json` when present and emits a **replay packet** JSON to stdout. It does not compute concordance yet; Maker replaces this with real estimators.

Validator should treat any efficacy or replacement claim without a harness artifact as **block**.
