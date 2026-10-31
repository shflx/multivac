import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function platformPath(platform: NodeJS.Platform = process.platform) { return platform === 'win32' ? win32 : posix; }
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

/** Windows 仅支持本地盘符绝对路径或普通相对路径；不能借 NTFS 别名改变已核对的目标。 */
export function assertWindowsLocalPath(value: string, absolute = false): void {
  if (value.includes('\0') || /^[\\/]/u.test(value) || /^[a-z]:(?![\\/])/iu.test(value)) throw new Error('不支持 UNC、设备、当前盘根或盘符相对路径。');
  if (absolute && !/^[a-z]:[\\/]/iu.test(value)) throw new Error('Windows 目录必须使用本地盘符绝对路径。');
  const tail = value.replace(/^[a-z]:/iu, '');
  for (const segment of tail.split(/[\\/]/u).filter(Boolean)) {
    if (segment === '.' || segment === '..') continue;
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment) || reserved.test(segment)) throw new Error('Windows 路径包含保留名称、非法字符、ADS 或结尾点/空格。');
  }
}
export function windowsFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/u, '');
  return reserved.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function resolveLocalInputPath(input: string, cwd: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platformPath(platform);
  let value = input;
  if (value === '~') value = home;
  else if (value.startsWith('~/') || platform === 'win32' && value.startsWith('~\\')) value = paths.join(home, value.slice(2));
  else if (/^file:\/\//u.test(value)) {
    if (platform === 'win32') {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash || /%2f|%5c/iu.test(url.pathname)) throw new Error('只支持本地盘符文件 URL。');
      value = decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/iu, '$1');
    } else value = fileURLToPath(value);
  }
  if (platform === 'win32') { assertWindowsLocalPath(cwd, true); assertWindowsLocalPath(value); }
  return paths.resolve(cwd, value);
}

/** 这里只做字面包含判定；调用方仍须 realpath 后复核，不能用大小写转换代替 junction/真实路径校验。 */
export function pathIsWithin(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platformPath(platform);
  const rel = paths.relative(parent, child);
  return rel === '' || (!paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${paths.sep}`));
}
