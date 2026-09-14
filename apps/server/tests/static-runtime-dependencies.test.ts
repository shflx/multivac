import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serverRoot, '../..');

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

test('Pi SDK 依赖只存在于 server runtime executors 内部', async () => {
  const roots = [join(repositoryRoot, 'packages/contracts/src'), join(serverRoot, 'src')];
  const violations: string[] = [];

  for (const root of roots) {
    for (const file of await typescriptFiles(root)) {
      const source = await readFile(file, 'utf8');
      const importsPi = /(?:from\s+|import\s*(?:\(|))['"]@earendil-works\/pi-/u.test(source);
      const allowed = file.startsWith(join(serverRoot, 'src/runtime/executors/'));
      if (importsPi && !allowed) {
        violations.push(relative(repositoryRoot, file));
      }
    }
  }

  assert.deepEqual(violations, []);
});
