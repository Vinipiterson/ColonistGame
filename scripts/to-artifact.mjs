// Converts the single-file Vite build (dist/index.html) into the body-only page format used for
// publishing on claude.ai (the host adds doctype/html/head/body). Output: dist/artifact.html
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
const styles = head.match(/<style[\s\S]*?<\/style>/g) ?? [];
const scripts = head.match(/<script[\s\S]*?<\/script>/g) ?? [];
const out = [title, ...styles, body.trim(), ...scripts].join('\n');
writeFileSync('dist/artifact.html', out);
console.log(`dist/artifact.html written (${(out.length / 1024).toFixed(1)} kB)`);
