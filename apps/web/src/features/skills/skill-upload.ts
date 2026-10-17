import type { SkillUpload } from '@multivac/contracts';

/** 浏览器里选中的待上传 Skill 包：内容已读成 base64，可直接提交预览。 */
export interface SkillUploadPick {
  label: string;
  content: SkillUpload['content'];
  fileCount: number;
  bytes: number;
  /** 跳过的隐藏文件或目录数（如 .git、.DS_Store），服务端不接受隐藏文件。 */
  ignored: number;
}

/** 与服务端单包上限一致，超限时在读取前就提示，避免上传后才失败。 */
const MAX_PACKAGE = 8 * 1024 * 1024;
const MAX_FILES = 256;

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ''));
    reader.onerror = () => reject(reader.error ?? Error('文件读取失败。'));
    reader.readAsDataURL(file);
  });
}

function checkSize(bytes: number) {
  if (bytes > MAX_PACKAGE) throw Error('Skill 包总计不能超过 8 MiB。');
}

/** 按相对路径读取目录内文件：路径保留顶层目录名，由服务端统一去掉；隐藏文件不提交。 */
async function readDirectoryFiles(label: string, all: { path: string; file: File }[], skipped = 0): Promise<SkillUploadPick> {
  const files = all.filter(({ path }) => !path.split('/').some((part) => part.startsWith('.')));
  if (!files.length) throw Error('没有读取到目录内容。');
  if (files.length > MAX_FILES) throw Error('Skill 包最多包含 256 个文件。');
  const bytes = files.reduce((sum, { file }) => sum + file.size, 0);
  checkSize(bytes);

  const entries = await Promise.all(files.map(async ({ path, file }) => [path, await toBase64(file)] as const));
  return {
    label,
    content: { kind: 'files', files: Object.fromEntries(entries) },
    fileCount: files.length,
    bytes,
    ignored: all.length - files.length + skipped,
  };
}

/** 读取通过 webkitdirectory 选择的目录。浏览器会先弹出自带的上传确认，网页无法替换。 */
export function readSkillDirectoryPick(list: FileList): Promise<SkillUploadPick> {
  const all = Array.from(list, (file) => ({ path: file.webkitRelativePath, file }));
  return readDirectoryFiles(all[0]?.path.split('/')[0] ?? '', all);
}

/**
 * 读取拖入的目录：逐层遍历拖放条目，不触发浏览器的上传确认。
 * 条目须在 drop 事件内同步取出，之后的异步读取仍然有效。
 */
export async function readSkillDroppedDirectory(root: FileSystemDirectoryEntry): Promise<SkillUploadPick> {
  const all: { path: string; file: File }[] = [];
  let visited = 0,
    skipped = 0;
  const walk = async (directory: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = directory.createReader();
    // readEntries 每次只返回一批，直到返回空数组为止。
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) return;
      for (const entry of batch) {
        // 隐藏条目（如 .git）整体跳过，不进入遍历，也不计入条目上限。
        if (entry.name.startsWith('.')) {
          skipped++;
          continue;
        }
        if (++visited > 512) throw Error('Skill 目录条目超过限制。');
        const path = `${prefix}/${entry.name}`;
        if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, path);
        else all.push({ path, file: await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)) });
      }
    }
  };
  await walk(root, root.name);
  return readDirectoryFiles(root.name, all, skipped);
}

/** 读取 zip 包：原样提交，由服务端解压并按包规则校验。 */
export async function readSkillZipPick(file: File): Promise<SkillUploadPick> {
  if (!/\.zip$/iu.test(file.name)) throw Error('请选择 .zip 格式的 Skill 包。');
  checkSize(file.size);
  return { label: file.name, content: { kind: 'zip', data: await toBase64(file) }, fileCount: 0, bytes: file.size, ignored: 0 };
}
