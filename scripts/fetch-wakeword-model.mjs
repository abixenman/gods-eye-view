#!/usr/bin/env node
// Download the Porcupine wake-word model (Apache-2.0, Picovoice) into
// public/wakeword/. The npm package ships the engine and built-in keyword
// bytes but not the ~1.7 MB acoustic model, which must be served as a file.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'public', 'wakeword');
const file = path.join(dir, 'porcupine_params.pv');
const url =
  'https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv';

if (existsSync(file) && statSync(file).size > 1_000_000) {
  console.log(`wake word model present (${statSync(file).size} bytes)`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
const response = await fetch(url);
if (!response.ok) {
  console.error(`download failed: HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
writeFileSync(file, bytes);
console.log(`saved ${file} (${bytes.length} bytes)`);
