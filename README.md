[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/uyekt1987/fast-markdown/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/uyekt1987/fast-markdown/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# Fast Markdown

A dependency-free, single-pass Markdown renderer whose `parse(markdown)` returns byte-identical HTML to marked 18.1.3 (default options).

It passes 720/720 cases on the competition practice set and runs ~1.5x faster than marked on that set (~944 ms vs ~1504 ms warmed).

## Usage

```sh
node main.ts
```

`main.ts` reads `/input/cases.json` (or `MAKEFUN_INPUT_DIR`) and writes `/output/html.json` (or `MAKEFUN_OUTPUT_DIR`).

## License

MIT licensed.

Built for the make.fun "Make Markdown rendering faster" bounty (`markdown-render-speed-02`).
