import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/** 固定构建目录的公开入口；不把任意 URL 当成文件路径或 SPA 路由。 */
export function createWebAssetsHandler(root: string) {
  const directory = resolve(root);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!['GET', 'HEAD'].includes(request.method ?? '') || url.searchParams.size !== 0) return false;
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!['/index.html', '/multivac.svg', '/favicon.ico'].includes(path) && !/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|png|woff2)$/u.test(path)) return false;
    const filename = join(directory, path.slice(1));
    if (!filename.startsWith(`${directory}${sep}`)) return false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const rootInfo = await lstat(directory);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
      let parent = directory;
      for (const segment of path.slice(1).split('/')) {
        parent = join(parent, segment);
        if ((await lstat(parent)).isSymbolicLink()) return false;
      }
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 10 * 1024 * 1024) return false;
      const data = request.method === 'HEAD' ? null : await handle.readFile();
      const extension = path.slice(path.lastIndexOf('.'));
      response.writeHead(200, { 'content-type': TYPES[extension] ?? 'application/octet-stream', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      response.end(data); return true;
    } catch { return false; }
    finally { await handle?.close(); }
  };
}
