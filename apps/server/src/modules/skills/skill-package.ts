import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SkillManifest } from '@multivac/contracts';

export class SkillError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
export const skillHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type SkillFrontmatterParser = (text: string) => { frontmatter: Record<string, unknown> };
export interface SkillPackage {
  manifest: SkillManifest;
  files: Record<string, string>;
}
const MAX_FILES = 256;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_PACKAGE = 8 * 1024 * 1024;
export function skillPath(path: string): string {
  if (
    !path ||
    path.length > 240 ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.')) ||
    /[\x00-\x1f:]/u.test(path)
  )
    throw new SkillError('Skill 路径无效；不接受隐藏文件、绝对路径或目录穿越。');
  return path;
}

/** 使用 Pi 的 YAML 解析，登记校验比 Pi 的宽松发现更严格。包内字段永不授予工具权限。 */
export function parseSkillPackage(
  files: Record<string, string>,
  parseFrontmatter: SkillFrontmatterParser,
  directoryName?: string,
): SkillPackage {
  const paths = Object.keys(files).sort();
  if (!paths.includes('SKILL.md') || paths.length > MAX_FILES)
    throw new SkillError('需要 SKILL.md，包最多包含 256 个文件。');
  let size = 0;
  const entries = paths.map((path) => {
    skillPath(path);
    const data = Buffer.from(files[path]!, 'base64');
    if (data.toString('base64') !== files[path]) throw new SkillError('包文件编码无效。');
    size += data.length;
    if (data.length > MAX_FILE || size > MAX_PACKAGE)
      throw new SkillError('Skill 超过单文件 2 MiB 或总计 8 MiB 限制。', 413);
    return { path, bytes: data.length, hash: skillHash(data) };
  });
  const raw = Buffer.from(files['SKILL.md']!, 'base64');
  if (raw.length > 64 * 1024) throw new SkillError('SKILL.md 超过 64 KiB。', 413);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new SkillError('SKILL.md 必须为 UTF-8。');
  }
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.test(text))
    throw new SkillError('SKILL.md 需要完整 YAML frontmatter。');
  let metadata: Record<string, unknown>;
  try {
    metadata = parseFrontmatter(text).frontmatter;
  } catch {
    throw new SkillError('SKILL.md YAML 无效。');
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object')
    throw new SkillError('Skill 元数据必须为映射。');
  const { name, description, compatibility, license } = metadata;
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new SkillError('Skill name 必须为最多 64 字符的小写字母、数字及单连字符。');
  if (directoryName && name !== directoryName) throw new SkillError('Skill name 必须与包目录名一致。');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024)
    throw new SkillError('Skill description 必填，最多 1024 字符。');
  if (
    compatibility !== undefined &&
    (typeof compatibility !== 'string' || !compatibility.trim() || compatibility.length > 500)
  )
    throw new SkillError('compatibility 必须为最多 500 字符的非空文本。');
  if (license !== undefined && typeof license !== 'string') throw new SkillError('license 必须为文本。');
  if (
    metadata.metadata !== undefined &&
    (!metadata.metadata ||
      Array.isArray(metadata.metadata) ||
      typeof metadata.metadata !== 'object' ||
      Object.values(metadata.metadata).some((v) => typeof v !== 'string'))
  )
    throw new SkillError('metadata 必须为字符串映射。');
  const tools = metadata['allowed-tools'];
  if (tools !== undefined && typeof tools !== 'string') throw new SkillError('allowed-tools 必须为文本。');
  const standard = ['name', 'description', 'compatibility', 'license', 'metadata', 'allowed-tools'];
  const diagnostics = Object.keys(metadata)
    .filter((key) => !standard.includes(key))
    .map((key) => `宿主扩展 ${key} 仅保留，不授予能力。`);
  if (tools !== undefined) diagnostics.push('allowed-tools 仅作为依赖声明，不代表用户授权。');
  const version = skillHash(JSON.stringify(entries));
  return {
    manifest: {
      name,
      description,
      metadata,
      diagnostics,
      dependencies: {
        source: tools === undefined ? 'unknown' : 'declared',
        tools: typeof tools === 'string' ? tools.trim().split(/\s+/u).filter(Boolean) : [],
      },
      files: entries,
      version,
    },
    files: Object.fromEntries(paths.map((path) => [path, files[path]!])),
  };
}

/** 只读取用户明确给出的单包；拒绝符号/硬链接与特殊文件，不运行任何包代码。 */
export function readSkillDirectory(source: string, parseFrontmatter: SkillFrontmatterParser): SkillPackage {
  const root = resolve(source);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw new SkillError('Skill 来源必须为真实目录，不能经过符号链接。');
  const files: Record<string, string> = Object.create(null);
  let total = 0,
    count = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 8) throw new SkillError('Skill 目录层级超过限制。');
    for (const name of readdirSync(dir).sort()) {
      if (++count > 512) throw new SkillError('Skill 目录条目超过限制。');
      const path = skillPath(prefix + name),
        full = join(dir, name),
        stat = lstatSync(full);
      if (stat.isDirectory()) {
        walk(full, path + '/', depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new SkillError('Skill 不接受链接或特殊文件。');
      if (
        Object.keys(files).length >= MAX_FILES ||
        stat.size > MAX_FILE ||
        (total += stat.size) > MAX_PACKAGE
      )
        throw new SkillError('Skill 文件数量或大小超过限制。', 413);
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.size !== stat.size ||
          realpathSync(dirname(full)) !== dirname(full)
        )
          throw new SkillError('来源在预览期间发生变化。', 409);
        const bytes = readFileSync(fd);
        if (bytes.length !== stat.size) throw new SkillError('来源在预览期间发生变化。', 409);
        files[path] = bytes.toString('base64');
      } finally {
        closeSync(fd);
      }
    }
  };
  walk(root, '', 0);
  return parseSkillPackage(files, parseFrontmatter, basename(root));
}

/** 内容先原子落盘，再由数据库引用；失败最多留下无引用快照，不会发布半包。 */
export class SkillPackages {
  constructor(
    private readonly root: string,
    readonly parse: SkillFrontmatterParser,
  ) {
    mkdirSync(root, { recursive: true });
  }
  save(pkg: SkillPackage): void {
    const target = join(this.root, pkg.manifest.version + '.json');
    if (existsSync(target)) {
      this.read(pkg.manifest.version);
      return;
    }
    const temp = join(this.root, randomUUID() + '.tmp');
    try {
      writeFileSync(temp, JSON.stringify(pkg.files), { flag: 'wx', mode: 0o600, flush: true });
      try {
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.read(pkg.manifest.version);
      }
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  read(version: string): SkillPackage {
    if (!/^[a-f0-9]{64}$/u.test(version)) throw new SkillError('Skill 版本无效。');
    const pkg = parseSkillPackage(
      JSON.parse(readFileSync(join(this.root, version + '.json'), 'utf8')),
      this.parse,
    );
    if (pkg.manifest.version !== version) throw new SkillError('Skill 快照完整性校验失败。', 409);
    return pkg;
  }
}
