/**
 * 输入框图片草稿的规则，与 dev 的 image-draft 一致：最多 4 张、单图 10 MiB、合计 20 MiB。
 * 原型没有上传接口，上传过程由界面层模拟；这里只放与界面无关、可单独测试的判断。
 */

export const IMAGE_LIMITS = { count: 4, bytes: 10 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 };
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

const COUNT_OR_TOTAL_ERROR = '最多 4 张图片，总大小不超过 20 MiB。';
const SINGLE_ERROR = '单图上限为 10 MiB。';

/**
 * 加入一批图片：数量或总大小超限时整批拒绝；单张超限时跳过该张、其余照常加入。
 * 返回可加入的文件与需要提示的错误（没有错误时为空字符串）。
 */
export function acceptImages(items, files) {
  const used = items.reduce((sum, item) => sum + (item.size || 0), 0);
  const incoming = files.reduce((sum, file) => sum + file.size, 0);
  if (items.length + files.length > IMAGE_LIMITS.count || used + incoming > IMAGE_LIMITS.totalBytes) return { accepted: [], error: COUNT_OR_TOTAL_ERROR };
  const accepted = files.filter((file) => file.size <= IMAGE_LIMITS.bytes);
  return { accepted, error: accepted.length < files.length ? SINGLE_ERROR : '' };
}

/** 草稿条目：粘贴的图片没有文件名时称为“剪贴板图片”。 */
export function draftImageOf(file, key, preview) {
  return { key, name: file.name || '剪贴板图片', size: file.size, preview, status: 'uploading', error: '' };
}

/** 全部上传完成才能发送；有图片时允许不写文字。 */
export function canSendWithImages(text, items) {
  return items.every((item) => item.status === 'ready') && (Boolean(text.trim()) || items.length > 0);
}

/** 发送后写入消息的图片：只带预览地址与名称。 */
export function sentImages(items) {
  return items.filter((item) => item.status === 'ready').map((item) => ({ url: item.preview, alt: item.name }));
}
