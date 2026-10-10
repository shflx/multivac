import type { IncomingMessage, ServerResponse } from 'node:http';
import { open, type FileHandle } from 'node:fs/promises';
import { ReadingError } from './book-import.js';

import { pdfByteRange } from './pdf-byte-range.js';

export async function sendPdfFile(request: IncomingMessage, response: ServerResponse, path: string, mime = 'application/pdf') {
  let file: FileHandle;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ReadingError('原始 PDF 或阅读资源缺失，请恢复原文件后重试。历史记录仍保留。', 404); throw error; }
  try {
    const size = (await file.stat()).size;
    let range: ReturnType<typeof pdfByteRange>;
    try { range = pdfByteRange(request.headers.range, size); }
    catch (error) { response.setHeader('content-range', `bytes */${size}`); throw new ReadingError((error as Error).message, 416); }
    const start = range?.start ?? 0, end = range?.end ?? size - 1;
    response.writeHead(range ? 206 : 200, {
      'content-type': mime, 'content-length': end - start + 1, 'accept-ranges': 'bytes',
      'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === 'HEAD') { response.end(); return; }
    // 不把大文件拼接到内存；每次最多一个 64 KiB 缓冲区，尊重 HTTP 背压。
    const stream = file.createReadStream({ start, end, autoClose: false, highWaterMark: 65536 });
    await new Promise<void>((resolve, reject) => {
      const close = () => { stream.destroy(); resolve(); };
      response.once('close', close);
      stream.once('error', reject);
      stream.once('end', () => { response.off('close', close); resolve(); });
      stream.pipe(response);
    });
  } catch (error) { if (response.headersSent) response.destroy(); else throw error; }
  finally { await file.close(); }
}
