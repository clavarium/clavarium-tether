/* ONE VERSION. The name lives in server/name.mjs with the version the command
   prints; package.json says it again for npm. They are the same, or nothing goes. */
import { readFileSync } from 'node:fs';
import { VERSION, PACKAGE } from '../server/name.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const bad = [];
if (pkg.version !== VERSION) bad.push(`package.json says ${pkg.version}, server/name.mjs says ${VERSION}`);
if (pkg.name !== PACKAGE) bad.push(`package.json is named ${pkg.name}, server/name.mjs says ${PACKAGE}`);
if (bad.length) { for (const b of bad) console.error(b); process.exit(1); }
console.log(`version: ${PACKAGE} ${VERSION}, said once`);
