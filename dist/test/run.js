// Test runner that is Node-version-agnostic.
//
// We don't rely on `node --test <dir>` for discovery because its default
// file-matching pattern for .ts files is not stable across Node 20.x vs 22.x.
// Instead, we walk the `test/` directory ourselves and import each *.test.ts,
// letting node:test collect the tests via its side-effecting registration.
//
// tsx's --import hook handles the .ts transpilation.
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
async function walk(dir, out) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            await walk(full, out);
        }
        else if (e.isFile() && e.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
}
const root = resolve(process.cwd(), 'test');
const files = [];
await walk(root, files);
files.sort();
if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`no test files found under ${root}`);
    process.exit(1);
}
// Import each test file. node:test collects tests as a side effect of these imports.
for (const f of files) {
    await import(pathToFileURL(f).href);
}
//# sourceMappingURL=run.js.map