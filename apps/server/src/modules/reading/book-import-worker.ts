import { workerData, parentPort } from 'node:worker_threads';
import { writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { BookUpload } from '@multivac/contracts';
import { BookIndexer } from './book-index.js';
import { fileBookChapters } from './file-book-import.js';
import { ReadingError } from './book-import.js';

const input = workerData as { path: string; directory: string; metadata: BookUpload; version: string };
async function run() {
  let bytes = 0, checked = -32 * 1024 * 1024;
  const builder = new BookIndexer((ordinal, chapters) => {
    const text = JSON.stringify(chapters);
    if (bytes - checked >= 32 * 1024 * 1024) {
      const space = statfsSync(input.directory);
      if (space.bavail * space.bsize < 64 * 1024 * 1024 + Buffer.byteLength(text)) throw new ReadingError('磁盘剩余空间不足，请释放空间后重试。', 507);
      checked = bytes;
    }
    bytes += Buffer.byteLength(text);
    writeFileSync(join(input.directory, `${ordinal}.json`), text, { mode: 0o600 });
  });
  for await (const chapter of fileBookChapters(input.path, input.metadata.format)) builder.add(chapter);
  const index = builder.finish({ id: `book-${input.version}`, version: input.version, format: input.metadata.format, title: input.metadata.title.trim(), author: input.metadata.author.trim(), createdAt: new Date().toISOString() });
  parentPort!.postMessage({ index, bytes });
}
void run().catch(error => parentPort!.postMessage({ error: (error as Error).message, status: error instanceof ReadingError ? error.status : 500 })).finally(() => parentPort!.close());
