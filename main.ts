// EMBERFALL's sibling: a fast Markdown renderer for the make.fun
// "Make Markdown rendering faster" bounty. The harness runs `node main.ts`
// (Node 22+). It reads every case from /input/cases.json (a JSON array of
// {id, markdown}), renders each one alone with parse() from parse.js, and
// writes /output/html.json: a JSON array of the HTML strings, one per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
