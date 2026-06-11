import { readFile } from 'node:fs/promises';

const files = ['dist/index.js', 'dist/index.cjs'];
const forbiddenRuntimeSpecifiers = [
    'http',
    'net',
    'fs',
    'stream',
    'buffer',
    'crypto',
    'process',
    'path',
    'os',
    'child_process',
];
const importPattern = new RegExp(
    `(?:from\\s*['"]|import\\s*['"]|require\\(['"])(?:node:)?(${forbiddenRuntimeSpecifiers.join('|')})(?:[/:'"]|\\b)`,
    'g',
);
let failed = false;

for (const file of files) {
    const contents = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const matches = [...contents.matchAll(importPattern)].map((match) => match[0]);
    if (matches.length > 0) {
        failed = true;
        console.error(`${file} imports Node-only runtime APIs: ${matches.join(', ')}`);
    }
}

if (failed) {
    process.exitCode = 1;
} else {
    console.log('Worker bundle check passed: no Node-only runtime imports found.');
}
