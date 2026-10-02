import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileSyntaxLanguage, highlightFileLines } from '../src/features/workspace/file-syntax.js';

test('按扩展名和标准文件名识别常见语言，未知文本不自动猜测', () => {
  for (const [path, language] of [
    ['src/app.js', 'javascript'], ['App.jsx', 'javascript'], ['app.mjs', 'javascript'], ['app.tsx', 'typescript'], ['app.mts', 'typescript'],
    ['src/main.PY', 'python'], ['main.go', 'go'], ['main.rs', 'rust'], ['App.java', 'java'], ['main.c', 'c'], ['main.cpp', 'cpp'], ['App.cs', 'csharp'],
    ['main.php', 'php'], ['main.rb', 'ruby'], ['main.swift', 'swift'], ['main.kt', 'kotlin'], ['main.dart', 'dart'], ['main.scala', 'scala'],
    ['run.sh', 'bash'], ['query.sql', 'sql'], ['style.css', 'css'], ['style.scss', 'scss'], ['data.json', 'json'], ['config.yaml', 'yaml'], ['config.toml', 'ini'], ['page.xml', 'xml'], ['App.vue', 'xml'],
    ['Dockerfile', 'dockerfile'], ['docker/Dockerfile.dev', 'dockerfile'], ['Makefile', 'makefile'], ['CMakeLists.txt', 'cmake'], ['.env.local', 'ini'],
  ]) assert.equal(fileSyntaxLanguage(path!), language);
  assert.equal(fileSyntaxLanguage('notes.txt'), null);
  assert.equal(highlightFileLines('notes.txt', 'def main(): return 1'), null);
});

test('多行注释和字符串保持语法作用域，原文换行与空白逐字保留', () => {
  for (const [path, text, scope] of [
    ['source.js', '/* 注释开始\n  第二行注释\n*/\nconst value = 1;\n', 'hljs-comment'],
    ['source.ts', 'const text = `第一行\n  第二行字符串`;\n', 'hljs-string'],
    ['source.py', 'text = """第一行\n  第二行字符串\n"""\n', 'hljs-string'],
  ]) {
    const lines = highlightFileLines(path!, text!)!;
    assert.equal(lines.map((line) => line.map((part) => part.text).join('')).join('\n'), text);
    assert.ok(lines[1]?.some((part) => part.scopes.some((value) => value.includes(scope!))));
  }
});

test('常见语言实际产生高亮节点，代码标签仍是文本', () => {
  for (const [path, text] of [
    ['a.js', 'export const x = 1;'], ['a.py', 'def main():\n    return 1'], ['a.go', 'package main\nfunc main() {}'], ['a.rs', 'fn main() {}'],
    ['a.java', 'public class Main {}'], ['a.c', 'int main(void) { return 0; }'], ['a.cpp', 'class Main {};'], ['a.cs', 'public class Main {}'],
    ['a.php', '<?php echo "hello";'], ['a.rb', 'def main\n  puts "hi"\nend'], ['a.swift', 'let value = 1'], ['a.kt', 'fun main() {}'], ['a.dart', 'void main() {}'], ['a.scala', 'val value = 1'],
    ['a.sql', 'SELECT id FROM users;'], ['a.sh', 'echo "hello"'], ['a.css', 'body { color: red; }'], ['a.json', '{"value": 1}'], ['a.yaml', 'value: true'], ['Dockerfile', 'FROM node:22\nRUN npm install'],
  ]) {
    const lines = highlightFileLines(path!, text!)!;
    assert.ok(lines.flat().some((part) => part.scopes.length), path);
    assert.equal(lines.map((line) => line.map((part) => part.text).join('')).join('\n'), text);
  }
  const xml = '<script>alert("x")</script>';
  assert.equal(highlightFileLines('source.xml', xml)!.flat().map((part) => part.text).join(''), xml);
});
