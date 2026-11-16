# Fast Markdown

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/uyekt1987/fast-markdown/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/uyekt1987/fast-markdown/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, fast Markdown renderer. `parse.js` exports `parse(markdown)`,
which returns exactly the HTML that marked 18.1.3's `marked.parse` returns with
default options (gfm on, breaks off) — byte for byte, on all 720 practice
cases — while running clearly faster than marked itself.

`main.ts` is the harness driver: it reads every case from `/input/cases.json`,
renders each with `parse`, and writes `/output/html.json`.

## Run

```sh
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts
```
