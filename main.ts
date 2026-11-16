// Fast Markdown — harness driver, written for this entry.
// Reads every case from /input/cases.json, renders each one with parse() from
// parse.js, and writes /output/html.json: the HTML strings in the cases' order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html = cases.map((c) => parse(c.markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
