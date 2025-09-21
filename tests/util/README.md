# Evaluation Helpers

This folder contains small helpers used by the evaluation scripts under `tests/`.

- `eval-helpers.mjs` provides manifest loading, region normalization, simple hashing, and utilities used across evaluation scripts.

## Running a Subset of Evaluation Suites

- Ensure you have generated manifests under `output/` (e.g., run the pipelines on a few images).
- You can run a specific evaluation script directly, e.g.:
  - `node tests/eval-performance.mjs` → writes `output/eval/performance_summary.json`
  - `node tests/eval-transformation-fidelity.mjs` → writes `output/eval/transformation_fidelity.json`
- Some scripts expect the viewer to be running (for `/global/*` or `/sparql` endpoints). Start it with:
  - `npm run viewer` (then re-run the eval script in another terminal)

Environment expectations

- Scripts write artifacts to `output/eval/`. Create the `output/` folder if it is missing.
- Performance logs are appended to `output/eval/performance_log.jsonl` by the running pipelines and summarized by `eval-performance.mjs`.
- No network is required except localhost access to the viewer when used by `eval-nl2sparql.mjs` or global registry tests.

References

- Percentiles overview (p50/p95): https://en.wikipedia.org/wiki/Percentile
- General ETL parity/integrity checks (background): best practices discussions on end-to-end data validations.
