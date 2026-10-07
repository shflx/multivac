import { workerData, parentPort } from 'node:worker_threads';
import { writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { BookParserInput } from './stream-book-import.js';
import { openPdfFile, readPdfOutline, pdfToc, type PdfOutline } from './pdf-outline.js';
import { BookIndexer } from './book-index.js';
import { fileBookChapters } from './file-book-import.js';
import { ReadingError } from './book-import.js';

const input = workerData as BookParserInput;
async function run() {
  if (input.mode === 'outline') {
    const { document, destroy } = await openPdfFile(input.path);
    try { parentPort!.postMessage({ outline: await readPdfOutline(document) }); }
    finally { await destroy(); }
    return;
  }
  let outline: PdfOutline | undefined;
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
  for await (const chapter of fileBookChapters(input.path, input.metadata.format, value => { outline = value; })) builder.add(chapter);
  const index = builder.finish({ id: `book-${input.version}`, version: input.version, format: input.metadata.format, title: input.metadata.title.trim(), author: input.metadata.author.trim(), createdAt: new Date().toISOString() });
  if (outline) index.toc = pdfToc(outline, index.chapters);
  parentPort!.postMessage({ index, bytes });
}
void run().catch(error => parentPort!.postMessage({ error: (error as Error).message, status: error instanceof ReadingError ? error.status : 500 })).finally(() => parentPort!.close());
