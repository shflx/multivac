/**
 * 把一行命令拆成参数数组：按空白分隔，支持单引号、双引号与反斜杠转义，不做变量展开或通配。
 * 结果逐项交给服务端启动，不会再拼成 shell 文本。
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (char === '\\' && index + 1 < line.length && (quote === null || ['"', '\\', '$', '`'].includes(line[index + 1]!))) {
      current += line[index + 1]!;
      index += 1;
      started = true;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error('命令中的引号没有闭合。');
  if (started) args.push(current);
  return args;
}

/** 参数数组还原为便于阅读和编辑的一行命令；含空白或引号的参数加单引号。 */
export function joinCommandLine(args: readonly string[]): string {
  return args.map((arg) => (arg && !/[\s'"\\$`]/u.test(arg) ? arg : `'${arg.replace(/'/gu, `'\\''`)}'`)).join(' ');
}
