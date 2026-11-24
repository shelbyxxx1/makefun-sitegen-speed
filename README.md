[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/shelbyxxx1/makefun-sitegen-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/shelbyxxx1/makefun-sitegen-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Build a static site faster

Entry for the make.fun bounty
[Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122):
a faster drop-in replacement for makefun-site 1.0.0, make.fun's own
reference static site generator.

## What is here

- `solve.js` — a dependency-free ES module whose `run(input)` returns,
  for every case's input, exactly the output tree makefun-site 1.0.0's
  build returns: every page's `index.html`, the index and tag pages,
  `build-report.txt` and each static file, byte for byte.
- `main.ts` — the harness driver: it reads every case from
  `/input/cases.json`, answers each with `run()`, and writes
  `/output/answers.json`.

## How it is faster

- Templates are compiled once into generated functions (`new Function`)
  instead of being interpreted node by node.
- Hot paths use inline regular expressions and direct property access
  (no `hasOwn` guard in the field getter).
- Pages that never include a partial skip the scope-frame loop entirely.

Verified against the kit's practice set: all 3 cases byte-identical to
the reference output, at roughly 3x the house baseline's speed locally.
