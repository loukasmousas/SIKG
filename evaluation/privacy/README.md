This folder optionally holds items for privacy blur evaluation.

- face_test_list.json (already referenced by tests): An array of entries with manifest path and face boxes.
  Example:
  [
  {
  "manifest": "output/barcelona.json",
  "faces": [ { "x": 100, "y": 80, "w": 48, "h": 48 } ]
  }
  ]

- To add IoU alignment (optional), include pre- and post-blur face detector boxes under a `detected` object:
  {
  "manifest": "output/barcelona.json",
  "faces": [ { "x": 100, "y": 80, "w": 48, "h": 48 } ],
  "detected": {
  "before": [ { "x": 100, "y": 80, "w": 48, "h": 48 } ],
  "after": [ { "x": 100, "y": 80, "w": 48, "h": 48 } ]
  }
  }

The evaluator will compute energy drop and (if boxes provided) IoU alignment.
