Gold set (optional) for NL2SPARQL evaluation

Place a file named gold.jsonl alongside queries.jsonl to enable exact-query scoring.

Format (one JSON object per line):

{ "utterance": "List all region class labels", "sparql": "PREFIX md: <http://example.org/metadata#> SELECT ?label WHERE { ?r md:classLabel ?label }" }

Notes

- utterance must match a line in queries.jsonl.
- Only exact string equality is checked for now (normalization can be added later).
- If gold.jsonl is absent, the evaluator will fallback to any gold_sparql fields embedded in queries.jsonl.
