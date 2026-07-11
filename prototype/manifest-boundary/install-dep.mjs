// install-dep.mjs — THROWAWAY spike (no-throw ticket #15).
//
// "Publish" @spike/mathkit into the consumer: copy EXACTLY what an npm pack
// would ship — package.json, dist/, nothrow.json. Deliberately NOT the source:
// the boundary stays honest, the manifest is the only color carrier.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const producerDir = resolve(here, 'producer');
const dest = resolve(here, 'consumer', 'node_modules', '@spike', 'mathkit');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(producerDir, 'package.json'), join(dest, 'package.json'));
cpSync(join(producerDir, 'nothrow.json'), join(dest, 'nothrow.json'));
cpSync(join(producerDir, 'dist'), join(dest, 'dist'), { recursive: true });

console.log(
  `\x1b[1m[2/3] installed\x1b[0m @spike/mathkit → consumer/node_modules \x1b[2m(package.json + dist + nothrow.json, no src)\x1b[0m\n`,
);
