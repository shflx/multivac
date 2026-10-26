import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 受控原生验证不能启动 esbuild 子进程。仅在本仓库内解析 TS 源码，不生成构建产物。
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
function inRepository(path) {
  return realpathSync(path).startsWith(`${root}${sep}`);
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@multivac/contracts') {
      return { url: pathToFileURL(resolve(root, 'packages/contracts/src/index.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const candidate = fileURLToPath(new URL(specifier.slice(0, -3) + '.ts', context.parentURL));
      if (!existsSync(candidate.slice(0, -3) + '.js') && existsSync(candidate) && inRepository(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const path = fileURLToPath(url);
      if (inRepository(path)) {
        return { format: 'module', source: stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'transform', disableExperimentalWarning: true }), shortCircuit: true };
      }
    }
    return nextLoad(url, context);
  },
});
