This folder can optionally contain a small curated gold set for spatial relations.

File format: gold.json

{
"manifests": ["Alte_Donau.json", "USA_design.json"],
"options": {
"nearDistance": 40,
"minOverlapIoU": 0.05,
"minInsideRatio": 0.9
},
"relations": [
{ "subject": "region-2", "predicate": "near", "object": "region-3" },
{ "subject": "region-2", "predicate": "overlaps", "object": "region-3" }
]
}

- Use canonical region IRIs as produced in output/\*.json; you may also use simple region IDs like "region-2" for manifests where subjects are numeric IDs (the evaluator uses the stored `id` values).
- Predicates supported: contains, inside, overlaps, near.
- Keep the set small (10–50 relations) to validate logic without heavy annotation.
- Place the file at evaluation/spatial/gold.json to activate precision/recall in tests/eval-special-relations.mjs.

Optional fields:

- manifests: restrict evaluation to a subset of `output/*.json` manifests.
- options: pass predicate threshold overrides to the relation generator (keys: nearDistance, minOverlapIoU, minOverlapArea, minInsideRatio). Use to tune P/R trade-offs for specific datasets.
