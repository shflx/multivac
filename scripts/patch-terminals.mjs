import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const check = process.argv.includes('--check');
const files = [
  ['lib/addon-serialize.js', '65d8dd7c2b3b37a77f583ea5e0d14a23bbcc846e4ae0d6bb534ae12a380aea0d'],
  ['lib/addon-serialize.mjs', '6c93dff90bef3b7aac8664fa4c1cb4026bf4b701f3014a1fb88edde943dab906'],
];
for (const [file, original] of files) {
  const path = `${root}node_modules/@xterm/addon-serialize/${file}`;
  const current = readFileSync(path, 'utf8');
  // 保留源码的其余内容；反向规范化后核对上游哈希，同时拒绝其他来源的包。
  const esm = file.endsWith('.mjs');
  const oldBold = 't.isBold()!==e.isBold()&&s.push(t.isBold()?1:22)';
  const newBold = '(t.isBold()!==e.isBold()||t.isDim()!==e.isDim())&&(s.push(22),t.isBold()&&s.push(1),t.isDim()&&s.push(2))';
  const oldDim = 't.isDim()!==e.isDim()&&s.push(t.isDim()?2:22),';
  const marker = '/* multivac-serialize-0.14.0 */';
  const alt = '\x1b[?1049h\x1b[H';
  const patchedAlt = '\x1b[0m\x1b[?1049h\x1b[0m\x1b[H';
  const originalBold = esm ? 'e.isBold()!==r.isBold()&&t.push(e.isBold()?1:22)' : oldBold;
  const patchedBold = esm ? '(e.isBold()!==r.isBold()||e.isDim()!==r.isDim())&&(t.push(22),e.isBold()&&t.push(1),e.isDim()&&t.push(2))' : newBold;
  const originalDim = esm ? 'e.isDim()!==r.isDim()&&t.push(e.isDim()?2:22),' : oldDim;
  const originalAlt = esm ? '\\x1B[?1049h\\x1B[H' : alt;
  const newAlt = esm ? '\\x1B[0m\\x1B[?1049h\\x1B[0m\\x1B[H' : patchedAlt;
  const normalized = current.replace(marker, '').replace(patchedBold, originalBold).replace('void 0/* dim handled with bold */,', originalDim).replace(newAlt, originalAlt);
  if (hash(normalized) !== original) throw new Error(`终端 serialize 上游哈希不匹配：${file}`);
  const patched = marker + normalized.replace(originalBold, patchedBold).replace(originalDim, 'void 0/* dim handled with bold */,').replace(originalAlt, newAlt);
  if (check && current !== patched) throw new Error(`终端补丁未应用：${file}`);
  if (!check && current !== patched) writeFileSync(path, patched);
  console.log(`${file} sha256 ${hash(patched)}`);
}
// xterm 6 的 DOM 渲染器合并相邻字符后用字距补偿宽度，字体测量和浏览器排版的
// 小数取整会逐列累积。每段最多合并 8 个字符，并按终端列坐标定位和分配宽度，
// 将局部取整误差限制在亚像素范围，避免累积到行尾；保留小段合并以控制 DOM 节点数量。
// 宽字符仍使用原单元宽度，颜色、光标、选区和字符连接沿用上游逻辑。
const domBuilds = [
  ['lib/xterm.js', '14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972', [
    ['e.style.overflow="hidden"', 'e.style.overflow="hidden",e.style.position="relative"'],
    ['if(y&&(W&&k', 'if(y&&y<8&&(W&&k'],
    ['w+=j,y++;continue', 'w+=j,b.style.width=`${(x+C)*c-parseFloat(b.style.left)}px`,y++;continue'],
    ['m.push(b),x=U', 'b.style.position="absolute",b.style.left=`${x*c}px`,b.style.width=`${C*c}px`,m.push(b),x=U'],
  ]],
  ['lib/xterm.mjs', 'b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59', [
    ['r.style.overflow="hidden"', 'r.style.overflow="hidden",r.style.position="relative"'],
    ['else if(A&&(N&&Pe', 'else if(A&&A<8&&(N&&Pe'],
    ['R+=ze,A++;continue', 'R+=ze,f.style.width=`${(y+T)*a-parseFloat(f.style.left)}px`,A++;continue'],
    ['d.push(f),y=E', 'f.style.position="absolute",f.style.left=`${y*a}px`,f.style.width=`${T*a}px`,d.push(f),y=E'],
  ]],
];
for (const [file, original, edits] of domBuilds) {
  const path = `${root}node_modules/@xterm/xterm/${file}`;
  const current = readFileSync(path, 'utf8');
  const marker = '/* multivac-xterm-dom-grid-6.0.0 */';
  const normalized = edits.reduce((text, [before, after]) => text.replace(after, before), current.replace(marker, ''));
  if (hash(normalized) !== original) throw new Error(`终端 DOM 上游哈希不匹配：${file}`);
  const patched = marker + edits.reduce((text, [before, after]) => {
    if (text.split(before).length !== 2) throw new Error(`终端 DOM 补丁位置不唯一：${file}`);
    return text.replace(before, after);
  }, normalized);
  if (check && current !== patched) throw new Error(`终端 DOM 补丁未应用：${file}`);
  if (!check && current !== patched) writeFileSync(path, patched);
  console.log(`${file} sha256 ${hash(patched)}`);
}
const headless = readFileSync(`${root}node_modules/@xterm/headless/lib-headless/xterm-headless.js`);
if (hash(headless) !== '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed') throw new Error('headless 私有解析兼容版本不匹配');
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const helper = `${root}node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`;
  if (!check) chmodSync(helper, statSync(helper).mode | 0o111);
  if (!(statSync(helper).mode & 0o111)) throw new Error('spawn-helper 缺少执行位');
}
