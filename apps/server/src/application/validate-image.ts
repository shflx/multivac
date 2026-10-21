import sharp, { type Metadata } from 'sharp';
import { IMAGE_LIMITS } from '@multivac/contracts';

export class ImageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 完整解码真实内容；客户端扩展名与 MIME 不作为格式依据。 */
export async function validateImage(data: Buffer): Promise<Metadata> {
  if (!data.length || data.length > IMAGE_LIMITS.bytes) throw new ImageError(413, '单图上限为 10 MiB。');
  let metadata: Metadata;
  try {
    const decoder = sharp(data, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning' });
    metadata = await decoder.metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error();
    if (!metadata.width || !metadata.height || metadata.width > IMAGE_LIMITS.dimension || metadata.height > IMAGE_LIMITS.dimension) throw new Error();
    await decoder.raw().toBuffer();
  } catch { throw new ImageError(415, '图片无效；支持静态 PNG、JPEG、WebP、GIF，最多 1600 万像素、单边 8192 像素。'); }
  return metadata;
}
