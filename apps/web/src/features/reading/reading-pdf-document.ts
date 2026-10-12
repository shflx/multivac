import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** 每次读取使用独立 Worker；失败重试不继承 PDF.js 的备用 Worker 失败缓存。 */
export async function loadReadingPdfDocument(id: string, signal: AbortSignal, onError: (error: Error) => void): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist');
  signal.throwIfAborted();
  const port = new Worker(workerUrl, { type: 'module' });
  const worker = pdfjs.PDFWorker.create({ port });
  const loading = pdfjs.getDocument({
    url: `/api/reading/books/${encodeURIComponent(id)}/pdf/source`, worker,
    rangeChunkSize: 65536, disableStream: true, disableAutoFetch: true,
    cMapUrl: '/api/reading/pdf-assets/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/api/reading/pdf-assets/standard_fonts/', wasmUrl: '/api/reading/pdf-assets/wasm/',
    enableXfa: false, verbosity: 0,
  });
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  const dispose = () => {
    signal.removeEventListener('abort', aborted);
    port.removeEventListener('error', failed);
    void loading.destroy().catch(() => undefined);
    worker.destroy(); port.terminate();
  };
  const aborted = () => { rejectFailure(new DOMException('读取已取消', 'AbortError')); dispose(); };
  const failed = () => {
    const error = new Error('PDF 工作线程加载失败，请重试。');
    rejectFailure(error); onError(error); dispose();
  };
  signal.addEventListener('abort', aborted, { once: true });
  port.addEventListener('error', failed);
  try { return await Promise.race([loading.promise, failure]); }
  catch (error) { dispose(); throw error; }
}
