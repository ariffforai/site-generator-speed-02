# sitegen: a faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ariffforai/site-generator-speed-02/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ariffforai/site-generator-speed-02/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Entry for the [make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122): a faster drop-in for make.fun's own makefun-site 1.0.0 static site generator, answering exactly as it does on every case.

## What it does

`solve.js` exports `run(input)`, which returns the output tree makefun-site 1.0.0's `build` returns for the same input: every path it writes (each page's `index.html`, the index and tag pages, `build-report.txt` and each static file) and that file's text, byte for byte. `main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`, answers each one alone with `run`, and writes `/output/answers.json`.

The entry re-implements makefun-site's own dialect from its README and reference behaviour: its front matter, template dialect, Markdown subset, slug rule and report. It is written for speed:

- hand-rolled scanners instead of per-line regular expressions (front matter, Markdown blocks, template tags);
- a single-pass inline renderer whose native scan finds the next character that needs work, so plain text runs are copied whole;
- a per-case slug cache, a link-resolution cache, and a whitespace table for word counts;
- templates compiled once per case into small render functions, so a render walks no node tree;
- Markdown lexing and rendering fused into one pass, with each line dispatched on its first character.

Node.js 22, standard library only. No network, no clock, no randomness: the answer is a function of the input alone, and nothing is kept from one case to the next.

## Verification

- Practice set: 3/3 cases identical to makefun-site 1.0.0 (kit scorer: `passed: 1, cases_passed: 3`).
- 9 further cases drawn fresh from the kit's own generator with other seeds: 9/9 identical.
- A hand-built edge suite of 190 cases (front-matter refusals, Markdown corners, template parse errors, slug collisions, link resolution, paging, shadowing): 190/190 identical to the reference.
- Two runs on the practice set produce byte-identical `answers.json`.
- Local timing on the practice set: about 1.35× the house baseline's total CPU time on this machine (run alone about 2× faster once warm).

## Usage

```sh
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.
