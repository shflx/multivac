import { Copy } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import { parseMultivacObjectLink, type SessionFileReference } from '@multivac/contracts';
import { ObjectLink } from './object-links.js';
import { imageContentUrl, type MessageImageReference } from '@multivac/contracts';
import { ImageGallery } from './image-gallery.js';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

/** 保留解析后的代码内容与原始换行；高亮节点不作为复制数据源。 */
function preserveCode() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: MarkdownNode) => {
      if (node.type === 'code' && node.value !== undefined && node.position) {
        const start = node.position.start.offset ?? 0;
        const end = node.position.end.offset ?? source.length;
        let raw = source.slice(start, end);
        const opening = /^(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(raw);
        if (opening) {
          // 退容器时 AST 可能止于代码行尾；只有缺少内容行的结束符才从源位置补取。
          raw = raw.slice(opening[0].length);
          const lineCount = node.value.split(/\r\n|\n|\r/).length;
          const endingCount = (raw.match(/\r\n|\n|\r/g) ?? []).length;
          const ending = /^(?:\r\n|\n|\r)/.exec(source.slice(end));
          if (ending && endingCount < lineCount && (node.value !== '' || /^[\t >]*$/.test(raw))) {
            raw += ending[0];
          }
        } else if (/^(?:`{3,}|~{3,})[^\r\n]*$/.test(raw)) {
          raw = '';
        } else if (/^[\r\n]/.test(source.slice(end))) {
          raw += /^\r\n|^\n|^\r/.exec(source.slice(end))![0];
        }
        const endings = raw.match(/\r\n|\n|\r/g) ?? [];
        const code = node.value.split(/\r\n|\n|\r/).map((line, index) => line + (endings[index] ?? '')).join('');
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-raw-code': code } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

interface HtmlNode {
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
  position?: { start: { line: number }; end: { line: number } };
}

/** 文件预览按解析器原始行号定位，不把渲染后的行数误当成文件行号。 */
function sourceLinePositions() {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      if (node.properties && node.position) node.properties['data-line'] = node.position.start.line;
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** 脚注引用/目标由库加前缀；固定的标签 id 与描述关系也必须按正文隔离。 */
function scopeFootnoteLabel({ prefix }: { prefix: string }) {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      const properties = node.properties;
      if (properties?.id === 'footnote-label') properties.id = `${prefix}footnote-label`;
      if (Array.isArray(properties?.ariaDescribedBy)) {
        properties.ariaDescribedBy = properties.ariaDescribedBy.map((id) =>
          id === 'footnote-label' ? `${prefix}footnote-label` : id);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function safeUrl(url: string): string {
  // 只允许可导航的 Web/邮件地址和站内相对地址，图片也遵循同一边界。
  // Multivac 的对象链接（会话、项目）另行渲染为站内操作，不是可导航的地址。
  const compact = url.replace(/[\u0000-\u0020\u007f]/g, '');
  if (parseMultivacObjectLink(compact)) return compact;
  if (/^[a-z][a-z\d+.-]*:/i.test(compact) && !/^(?:https?|mailto):/i.test(compact)) return '';
  return url;
}

function linkAttributes(url: string) {
  return /^(?:https?:|mailto:|\/\/)/i.test(url)
    ? { target: '_blank', rel: 'noopener noreferrer' }
    : {};
}

function CodeBlock({ code, language, children }: {
  code: string;
  language: string;
  children: React.ReactNode;
}) {
  const [feedback, setFeedback] = useState('');
  const [copying, setCopying] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    version.current += 1;
    setFeedback('');
    setCopying(false);
    return () => { version.current += 1; };
  }, [code]);

  const copy = async () => {
    const current = version.current;
    setCopying(true);
    setFeedback('');
    try {
      await navigator.clipboard.writeText(code);
      if (current === version.current) setFeedback('已复制');
    } catch {
      if (current === version.current) setFeedback('复制失败，请重试');
    } finally {
      if (current === version.current) setCopying(false);
    }
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span title={language || '纯文本'}>{language || '纯文本'}</span>
        <span className="markdown-copy-feedback" role="status" aria-live="polite">{feedback}</span>
        <button type="button" aria-label="复制代码" title="复制代码" disabled={copying} onClick={() => void copy()}>
          <Copy aria-hidden="true" />
        </button>
      </div>
      <pre tabIndex={0} aria-label={`${language || '纯文本'}代码`}>{children}</pre>
    </div>
  );
}

function MarkdownLink({ href, children, ...properties }: React.ComponentProps<'a'>) {
    if (!href) return <span>{children}</span>;
    const object = parseMultivacObjectLink(href);
    if (object) return <ObjectLink target={object}>{children}</ObjectLink>;
    return <a {...properties} href={href} {...linkAttributes(href)}>{children}</a>;
}

const components: Components = {
  a: ({ node: _node, ...properties }) => <MarkdownLink {...properties} />,
  img: ({ src, alt }) => src && !parseMultivacObjectLink(src)
    ? <a href={src} {...linkAttributes(src)}>{alt || '图片链接'}</a>
    : <span>{alt || '图片链接不可用'}</span>,
  code: ({ className, children }) => <code className={className}>{children}</code>,
  pre: ({ node, children }) => {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
    const properties = code?.type === 'element' ? code.properties : {};
    const classNames = String(properties.className ?? '');
    const language = /language-([^\s,]+)/.exec(classNames)?.[1] ?? '';
    return <CodeBlock code={String(properties['data-raw-code'] ?? '')} language={language}>{children}</CodeBlock>;
  },
  table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表格"><table>{children}</table></div>,
};

const remarkPlugins = [remarkGfm, preserveCode];
const rehypePlugins: NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeHighlight, { detect: false }],
];

interface MarkdownBodyProps {
  imageSessionId?: string;
  imageReferences?: MessageImageReference[];
  text: string;
  identity: string;
  /** 引用来源标记按标量传入，memo 的浅比较才不会因每次新建对象而失效。 */
  quoteSessionId?: string;
  quoteEntryId?: string;
  quoteRole?: 'user' | 'assistant';
  sourceLines?: boolean;
  fileReferences?: SessionFileReference[];
  onOpenFileReference?: (reference: SessionFileReference) => void;
}

export const MarkdownBody = memo(function MarkdownBody({
  text, identity, quoteSessionId, quoteEntryId, quoteRole, sourceLines = false, fileReferences, onOpenFileReference, imageSessionId, imageReferences,
}: MarkdownBodyProps) {
  // 编码为无碰撞的 ASCII id，运行时消息身份在 stream 到 history 校准时保持不变。
  const prefix = `markdown-${Array.from(identity, (character) => character.codePointAt(0)!.toString(16)).join('-')}-`;
  const quoteSource = quoteSessionId && quoteEntryId && quoteRole
    ? {
        'data-quote-session-id': quoteSessionId,
        'data-quote-entry-id': quoteEntryId,
        'data-quote-role': quoteRole,
      }
    : {};
  const fileComponents: Components = fileReferences && onOpenFileReference ? { ...components, a: ({ href, children, node, ...properties }) => {
    const source = fileReferences.find((reference) => reference.href === href);
    if (source) return <button className="file-reference-link" title={`${source.root}/${source.path}`} onClick={() => onOpenFileReference(source)}>{children}</button>;
    return <MarkdownLink href={href} {...properties}>{children}</MarkdownLink>;
  } } : components;
  const imageComponents: Components = { ...fileComponents, img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} sessionId={imageSessionId} references={imageReferences} /> };
  return <div className="markdown-body" {...quoteSource}><Markdown skipHtml urlTransform={(url) => fileReferences?.some((reference) => reference.href === url) || imageReferences?.some(reference => reference.href === url) ? url : safeUrl(url)} remarkPlugins={remarkPlugins}
    remarkRehypeOptions={{ clobberPrefix: prefix }}
    rehypePlugins={[...rehypePlugins, [scopeFootnoteLabel, { prefix }], ...(sourceLines ? [sourceLinePositions] : [])]} components={imageComponents}>{text}</Markdown></div>;
});

function MarkdownImage({ src, alt, sessionId, references }: { src: string | Blob | undefined; alt: string | undefined; sessionId: string | undefined; references: MessageImageReference[] | undefined }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  if (typeof src !== 'string' || !src) return <span><span>{alt || '图片'}</span> <span>图片来源不可用</span></span>;
  const source = references?.find(reference => reference.href === src);
  if (source?.error) return <span role="alert">{source.error}</span>;
  if (source?.imageId && sessionId) return <ImageGallery sources={[{ url: imageContentUrl(sessionId, source.imageId), alt: alt || '回复图片' }]} />;
  const attachment = /^\/api\/sessions\/([^/]+)\/images\/([a-f0-9]{64})\/content$/u.exec(src);
  if (attachment && sessionId && decodeURIComponent(attachment[1]!) === sessionId) return <ImageGallery sources={[{ url: src, alt: alt || '回复图片' }]} />;
  if (src.startsWith('#')) return <a href={src}>{alt || '图片来源'}</a>;
  let external = false;
  try { const url = new URL(src); external = url.protocol === 'https:' && !url.username && !url.password; } catch { /* 相对路径必须有服务端来源快照。 */ }
  if (!external) return <span>图片来源不可用</span>;
  return <span className="external-image">{loaded === src ? <ImageGallery sources={[{ url: src, alt: alt || '外部图片' }]} /> : <button type="button" className="file-reference-link" onClick={() => setLoaded(src)}>加载外部图片</button>} <a href={src} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{alt || '图片来源'}</a></span>;
}
