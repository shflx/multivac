import { zipSync, strToU8 } from 'fflate';

export type PdfBookmark = { title: string; pageIndex?: number; named?: boolean; external?: boolean; children?: PdfBookmark[] };

/** 最小但真实的 PDF：有页树、字体、内容流与正确字节偏移，不依赖解析器生成。 */
export function textPdf(pages = ['First PDF page.', 'Second PDF page.'], unusedBytes = 0, bookmarks: PdfBookmark[] = [], fontSize = 12): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const content = `BT /F1 ${fontSize} Tf 40 750 Td (${text.replace(/[\\()]/gu, '\\$&')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (unusedBytes) objects.push(`<< /Length ${unusedBytes} >>\nstream\n${'x'.repeat(unusedBytes)}\nendstream`);
  if (bookmarks.length) {
    const root = objects.push('');
    const names: string[] = [];
    const literal = (value: string) => `(${value.replace(/[\\()]/gu, '\\$&')})`;
    function siblings(parent: number, items: PdfBookmark[]): { first: number; last: number; count: number } {
      const ids = items.map(() => objects.push(''));
      let count = items.length;
      for (const [index, item] of items.entries()) {
        const id = ids[index]!;
        const title = Buffer.from('\uFEFF' + item.title, 'utf16le').swap16().toString('hex');
        const target = item.pageIndex === undefined ? '' : `[${item.pageIndex < pages.length ? `${4 + item.pageIndex * 2} 0 R` : item.pageIndex} /Fit]`;
        let destination = target ? `/Dest ${target}` : '';
        if (item.named && target) { const name = literal(`chapter-${id}`); names.push(`${name} ${target}`); destination = `/Dest ${name}`; }
        if (item.external) destination = '/A << /S /URI /URI (https://example.com/never-fetch) >>';
        let children = '';
        if (item.children?.length) {
          const nested = siblings(id, item.children); count += nested.count;
          children = `/First ${nested.first} 0 R /Last ${nested.last} 0 R /Count ${nested.count}`;
        }
        objects[id - 1] = `<< /Title <${title}> /Parent ${parent} 0 R ${index ? `/Prev ${ids[index - 1]} 0 R` : ''} ${index < ids.length - 1 ? `/Next ${ids[index + 1]} 0 R` : ''} ${destination} ${children} >>`;
      }
      return { first: ids[0]!, last: ids.at(-1)!, count };
    }
    const tree = siblings(root, bookmarks);
    objects[root - 1] = `<< /Type /Outlines /First ${tree.first} 0 R /Last ${tree.last} 0 R /Count ${tree.count} >>`;
    const dests = names.length ? objects.push(`<< /Names [${names.join(' ')}] >>`) : null;
    objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${root} 0 R ${dests ? `/Names << /Dests ${dests} 0 R >>` : ''} >>`;
  }
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

export function epubFiles(): Record<string, string> {
  return {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="second" href="second.xhtml" media-type="application/xhtml+xml"/><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>',
    'OPS/second.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1><p>第二章的正文。</p></body></html>',
    'OPS/first.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title><style>不要显示样式</style></head><body><h1>第一章</h1><p>第一章<strong>真实正文</strong>😀 &amp; 引用。</p><p>下一段。</p><script>不要执行脚本</script><img src="https://example.com/tracker.png"/></body></html>',
  };
}
export function epub(files: Record<string, string | Uint8Array> = epubFiles()): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]))));
}

/** 同时覆盖中文、无目标父目录、嵌套目录和命名目标。 */
export function outlinePdf(): Buffer {
  return textPdf(['Front matter.', 'Chapter one text.', 'Chapter two text.'], 0, [
    { title: '正文', children: [
      { title: '第一章', pageIndex: 1, named: true, children: [{ title: '第一节', pageIndex: 1 }] },
      { title: '第二章', pageIndex: 2, named: true },
    ] },
    { title: '外部资源', external: true },
    { title: '失效目录', pageIndex: 99 },
  ]);
}
