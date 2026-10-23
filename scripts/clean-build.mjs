import { rmSync } from 'node:fs';

// Resolve from this script, independent of the caller's working directory.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
