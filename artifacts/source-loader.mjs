// 仅供受控、无依赖验证：擦除目录内真实源码的类型，显式注入依赖。
// 不访问任务目录外文件，不派生进程，不修改被测源码。正常环境应优先运行正式测试。
const fs = process.getBuiltinModule('node:fs');
const { stripTypeScriptTypes } = process.getBuiltinModule('node:module');
export function sourceJavaScript(path) {
  return stripTypeScriptTypes(fs.readFileSync(path, 'utf8'), { mode: 'transform' })
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gmu, '')
    .replace(/^export\s*\{[\s\S]*?\}\s*from\s+['"][^'"]+['"];\s*$/gmu, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gmu, '')
    .replace(/\bexport (?=(?:async )?(?:class|function|const|let))/gu, '');
}
export function loadSource(path, bindings, names) {
  const javascript = sourceJavaScript(path);
  return new Function(...Object.keys(bindings), `${javascript}\nreturn {${names.join(',')}};`)(...Object.values(bindings));
}
