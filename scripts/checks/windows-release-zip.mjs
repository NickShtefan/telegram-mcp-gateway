// Encode a Windows release ZIP with the repository encoder that draft releases use (requires npm run build).
// Fixture use only: reads the nine flat regular files; never signs, downloads or executes a payload.
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeReleaseZip, SIGNED_FILES } from '../../dist/install/releasePackage.js';
const [directory, output, ...extra] = process.argv.slice(2);
try {
  if (!directory || !output || extra.length) throw new Error('usage: windows-release-zip.mjs <directory> <output.zip>');
  const names = SIGNED_FILES.map(name => name === 'node' ? 'node.exe' : name);
  if (readdirSync(directory).sort().join('\n') !== [...names].sort().join('\n')) throw new Error('release fixture files mismatch');
  const files = new Map(names.map(name => {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw new Error('release fixture file is not regular');
    return [name, readFileSync(path)];
  }));
  writeFileSync(output, encodeReleaseZip(files), { flag: 'wx' });
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : 'release fixture failed'}\n`); process.exitCode = 1;
}
