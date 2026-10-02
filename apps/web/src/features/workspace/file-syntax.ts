import { common, createLowlight } from 'lowlight';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import scala from 'highlight.js/lib/languages/scala';

const syntax = createLowlight({ ...common, dockerfile, cmake, dart, scala });
const extensions: Readonly<Record<string, string>> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', pyi: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', dart: 'dart', scala: 'scala',
  c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', cs: 'csharp',
  go: 'go', rs: 'rust', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', m: 'objectivec', mm: 'objectivec',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  css: 'css', scss: 'scss', less: 'less', xml: 'xml', xsd: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  json: 'json', jsonc: 'json', json5: 'javascript', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', properties: 'ini',
  graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff', mk: 'makefile', mak: 'makefile', cmake: 'cmake', dockerfile: 'dockerfile',
};
const filenames: Readonly<Record<string, string>> = { makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', 'cmakelists.txt': 'cmake', '.bashrc': 'bash', '.zshrc': 'bash', '.bash_profile': 'bash', '.profile': 'bash', '.env': 'ini' };

export function fileSyntaxLanguage(path: string): string | null {
  const name = path.split('/').at(-1)!.toLowerCase();
  if (filenames[name]) return filenames[name]!;
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  if (name.startsWith('.env.')) return 'ini';
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  return extensions[extension] ?? null;
}

export interface SyntaxPart { text: string; scopes: string[] }

/** 按文本换行分配高亮节点，同时把跨行语法作用域带到下一行；不拆分 HTML 标签。 */
export function highlightFileLines(path: string, text: string): SyntaxPart[][] | null {
  const language = fileSyntaxLanguage(path);
  if (!language) return null;
  const tree = syntax.highlight(language, text);
  const lines: SyntaxPart[][] = [[]];
  type SyntaxNode = (typeof tree.children)[number];
  const visit = (node: SyntaxNode, scopes: string[]) => {
    if (node.type === 'text') {
      const pieces = node.value.split('\n');
      for (const [index, piece] of pieces.entries()) {
        if (index) lines.push([]);
        if (piece) lines.at(-1)!.push({ text: piece, scopes });
      }
    } else if (node.type === 'element') {
      const classes = node.properties.className;
      const next = Array.isArray(classes) && classes.length ? [...scopes, classes.join(' ')] : scopes;
      for (const child of node.children) visit(child, next);
    }
  };
  for (const child of tree.children) visit(child, []);
  return lines;
}
