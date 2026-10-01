/** HTML 仅用于静态阅读；同源沙箱供宿主定位、查找和读取选区，内容没有任何执行能力。 */
export function isolatedHtml(text: string): string {
  // template 的内容保持惰性，清理之前也不会加载图片或样式。
  const template = window.document.createElement('template');
  template.innerHTML = text;
  const fragment = template.content;
  fragment.querySelectorAll('script, iframe, frame, object, embed, base, meta, link, form, input, button, textarea, select').forEach((node) => node.remove());
  const cleanStyle = (style: CSSStyleDeclaration) => {
    for (const property of [...style]) if (/url\s*\(|image-set\s*\(|expression\s*\(/i.test(style.getPropertyValue(property)) || property.startsWith('--')) style.removeProperty(property);
  };
  fragment.querySelectorAll('style').forEach((node) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(node.textContent ?? '');
    const cleanRules = (rules: CSSRuleList): string => [...rules].map((rule) => {
      if (rule instanceof CSSStyleRule) { cleanStyle(rule.style); return rule.cssText; }
      if (rule instanceof CSSMediaRule) return `@media ${rule.conditionText}{${cleanRules(rule.cssRules)}}`;
      if (rule instanceof CSSSupportsRule) return `@supports ${rule.conditionText}{${cleanRules(rule.cssRules)}}`;
      return '';
    }).join('\n');
    node.textContent = cleanRules(sheet.cssRules);
  });
  fragment.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ['href', 'src', 'srcset', 'action', 'formaction', 'target', 'ping'].includes(attribute.localName.toLowerCase())) node.removeAttribute(attribute.name);
    }
    if (node instanceof HTMLElement || node instanceof SVGElement) cleanStyle(node.style);
  });
  const document = window.document.implementation.createHTMLDocument('文件预览');
  document.body.append(fragment);
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  document.head.prepend(policy);
  const theme = getComputedStyle(window.document.documentElement);
  const style = document.createElement('style');
  style.textContent = `::highlight(file-matches){background:${theme.getPropertyValue('--warn-soft')};color:${theme.getPropertyValue('--ink')}}::highlight(file-current){background:${theme.getPropertyValue('--warn-line')};color:${theme.getPropertyValue('--ink')}}`;
  document.head.append(style);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

export function findTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest('[aria-hidden="true"], script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const ranges: Range[] = [];
  const nodes: Array<{ node: Node; start: number; end: number }> = [];
  let text = '';
  let block: Element | null | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const nextBlock = node.parentElement?.closest('.content-line,p,li,h1,h2,h3,h4,h5,h6,pre,tr,div,section,article') ?? null;
    // 同一行内跨高亮/强调节点可以匹配，不把相邻行或段落拼成一个词。
    if (block !== undefined && nextBlock !== block) text += '\n';
    block = nextBlock;
    const start = text.length;
    text += node.textContent ?? '';
    nodes.push({ node, start, end: text.length });
  }
  const locate = (offset: number) => {
    let low = 0; let high = nodes.length - 1;
    while (low <= high) { const mid = (low + high) >>> 1; if (nodes[mid]!.end <= offset) low = mid + 1; else high = mid - 1; }
    return nodes[low];
  };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const first = locate(index);
    const last = locate(index + match[0].length - 1);
    if (!first || !last) break;
    const range = document.createRange(); range.setStart(first.node, index - first.start); range.setEnd(last.node, index + match[0].length - last.start);
    ranges.push(range);
    if (ranges.length >= 5000) break;
  }
  return ranges;
}

export function fileLocationElement(host: HTMLElement, target: { line?: number; section?: string }): HTMLElement | null {
  if (target.section) return [...host.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find((heading) => heading.textContent === target.section) ?? null;
  if (target.line && Number.isSafeInteger(target.line) && target.line > 0) {
    return [...host.querySelectorAll<HTMLElement>('[data-line]')].filter((element) => Number(element.dataset.line) <= target.line!).sort((a, b) => Number(b.dataset.line) - Number(a.dataset.line))[0] ?? null;
  }
  return null;
}
