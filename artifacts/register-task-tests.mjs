import { registerHooks } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 原生任务内直接运行 TypeScript 测试，不启动 tsx/esbuild 或子进程。
const temporary = fileURLToPath(new URL('./.test-tmp/', import.meta.url));
mkdirSync(temporary, { recursive: true });
process.env.TMPDIR = temporary;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@multivac/contracts') return nextResolve(new URL('../packages/contracts/src/index.ts', import.meta.url).href, context);
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    throw error;
  }
} });
