import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BookIndex, BookUpload } from '@multivac/contracts';
import { ReadingError } from './book-import.js';
import type { PdfOutline } from './pdf-outline.js';

export type BookParserInput = { mode: 'outline'; path: string } | { mode?: 'import'; path: string; directory: string; metadata: BookUpload; version: string };

/** 原文件直接落盘；解析在有时间和内存预算的独立线程中运行。 */
export async function stageBookImport(directory: string, metadata: BookUpload, stream: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.import-'));
  const path = join(staging, 'source');
  try {
    const sourceHash = createHash('sha256');
    const versionHash = createHash('sha256').update(`${metadata.format}\n`);
    const file = await open(path, 'wx', 0o600);
    let bytes = 0, checked = -32 * 1024 * 1024;
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (bytes - checked >= 32 * 1024 * 1024) {
          const space = await statfs(directory);
          if (space.bavail * space.bsize < 64 * 1024 * 1024 + chunk.length) throw new ReadingError('磁盘剩余空间不足，请释放空间后重试。', 507);
          checked = bytes;
        }
        sourceHash.update(chunk); versionHash.update(chunk); bytes += chunk.length;
        let offset = 0;
        while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
    } finally { await file.close(); }
    if (!bytes) throw new ReadingError('书籍文件为空。');
    signal.throwIfAborted();
    const parsed = await parseFile<{ index: BookIndex; bytes: number }>({ path, directory: staging, metadata, version: versionHash.digest('hex') }, signal);
    return { index: parsed.index, blockBytes: parsed.bytes, path, directory: staging, sourceHash: sourceHash.digest('hex') };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
export async function readFilePdfOutline(path: string): Promise<PdfOutline> {
  const result = await parseFile<{ outline: PdfOutline }>({ mode: 'outline', path }, new AbortController().signal);
  return result.outline;
}

function parseFile<Result>(input: BookParserInput, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(source ? './book-import-worker.ts' : './book-import-worker.js', import.meta.url);
    const worker = source
      ? new Worker("const {workerData}=require('node:worker_threads'); import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry,workerData.base));", { eval: true, workerData: { ...input, entry: entry.href, base: import.meta.url }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } })
      : new Worker(entry, { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
    let settled = false;
    const finish = (error?: Error, result?: Result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      // 等待线程真正退出，再让调用方清理临时文件，避免取消后继续写入。
      void worker.terminate().finally(() => { if (error) reject(error); else resolve(result!); });
    };
    const abort = () => finish(new ReadingError('导入已取消。', 409));
    const timer = setTimeout(() => finish(new ReadingError('本次解析超过 2 分钟处理预算，请拆分书籍后重试。', 413)), 120000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.on('message', (result: Result & { error?: string; status?: number }) => finish(result.error ? new ReadingError(result.error, result.status ?? 400) : undefined, result));
    worker.on('error', () => finish(new ReadingError('解析进程未能完成，可能超过内存预算或文件结构异常。', 413)));
    worker.on('exit', () => { if (!settled) finish(new ReadingError('解析进程提前结束。', 500)); });
  });
}
