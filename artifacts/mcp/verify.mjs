// 在原生托管 Node 内编译和执行选定测试，不派生进程、不访问网络。
import ts from 'typescript';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

function compile(configPath, emit) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: !emit });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
    throw new Error(`${configPath}: ${diagnostics.length} diagnostic(s)`);
  }
  if (emit) program.emit();
  console.log(`PASS typecheck ${configPath}`);
}
compile('packages/contracts/tsconfig.json', true);
compile('apps/server/tsconfig.json', false);
compile('apps/web/tsconfig.json', false);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith('file:') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(source)) return next(source.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
for (const test of ['apps/server/tests/mcp-facts.test.ts', 'apps/server/tests/mcp-client.test.ts', 'apps/server/tests/mcp-accounts.test.ts', 'apps/server/tests/mcp-authorization.test.ts', 'apps/server/tests/inbox.test.ts']) await import(pathToFileURL(path.resolve(test)).href);
