import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 测试临时资料也保持在当前任务目录内，不使用系统临时目录。
process.env.TMPDIR = process.cwd();

// 在禁止派生子进程的任务环境中，用 TypeScript 的进程内转换运行针对性测试。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL && !existsSync(new URL(specifier, context.parentURL))) {
      for (const extension of ['.ts', '.tsx']) {
        const url = new URL(specifier.slice(0, -3) + extension, context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    // 服务端渲染测试只核对 DOM 标记；样式交由浏览器验收。
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
