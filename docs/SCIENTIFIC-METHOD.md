# Scientific method — Validator rubric

Flux does not publish **fake science**. The **Validator** desk applies the scientific method to every audit before the orchestrator accepts a file, a model claim, or an evolution patch.

## Steps (required in every Validator file)

| Step | Section heading | What Validator must show |
| --- | --- | --- |
| 1 | **Scope** | What claim, file, or code path is under review |
| 2 | **Hypothesis under test** | One clear, testable statement — not marketing |
| 3 | **Predictions** | What data would look like if the hypothesis is true vs false (pre-register before looking when possible) |
| 4 | **Methods and reproducibility** | How to test; frozen inputs (snapshot ids, schema versions, commit refs) |
| 5 | **Observations (data in hand)** | Only facts tied to lineage — ingest snapshots, registry ids, code paths. **No invented trials or citations.** |
| 6 | **Inferences (conclusions)** | Logical conclusions **separate** from observations — label uncertainty |
| 7 | **Falsifiability** | What result would **disprove** the claim; name alternative explanations |
| 8 | **Uncertainty** | Intervals, missing data, and what would change the verdict |
| 9 | **Fake-science screening** | Explicit pass/fail on hype, unfalsifiable claims, scrape-as-proof, conflating simulation with human outcomes |
| 10 | **Validation ladder stage** | Flux L0–L3 (`js/platform.js`) |
| 11 | **Code / platform findings** | Architecture, lineage, evolution gates |
| 12 | **Verdict** | `ship` / `fix` / `block` |
| 13 | **Required fixes** | Numbered, actionable |
| 14 | **Recommendation** | `go` / `wait` / `ignore` |

## Automatic blocks

Validator must set `verdict: block` and `fakeScienceDetected: true` when any of the following appear **without** L1+ harness evidence:

- Efficacy or trial-**replacement** claims from ingest excerpts alone  
- “Proof”, “validated”, or high concordance **without** pre-registered replay artifacts  
- Fabricated study ids, urls, or statistics not present in observations  
- Unfalsifiable wording (“always works”, “no uncertainty”)  

Implementation: `js/scientific-method.js` and `file_validator_report` tool checks.

## Other desks

- **Scout** gathers leads — not proof.  
- **Maker** builds reproducible methods under `engine/`.  
- **Voice / Wire** must not outrun Validator + ladder stage.  

The orchestrator still accepts or kills every file; Validator is the scientific gate.
