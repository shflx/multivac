import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { NotesError } from './note.js';

/** 所有身份字段都参与认证，阻止把密文搬到另一篇笔记或另一类记录。 */
export interface NoteCipherContext { noteId: string; kind: string; identity: string }
export interface NoteCiphertext { format: 1; nonce: string; ciphertext: string; tag: string }
export interface NotePasswordRecord {
  format: 1;
  revision: number;
  kdf: { algorithm: 'scrypt'; salt: string; N: 32768; r: 8; p: 1 };
  master: NoteCiphertext;
}
const encoding = 'base64';
const failure = () => new NotesError('密码不正确，或加密记录已损坏。', 403);
const aad = (context: NoteCipherContext) => Buffer.from(JSON.stringify(['multivac-note', 1, context.noteId, context.kind, context.identity]));

function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw failure();
  const result = Buffer.from(value, encoding);
  if (length !== undefined && result.length !== length) throw failure();
  return result;
}

export function encryptNoteBytes(key: Buffer, plaintext: Uint8Array, context: NoteCipherContext): NoteCiphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(context));
  return { format: 1, nonce: nonce.toString(encoding), ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString(encoding), tag: cipher.getAuthTag().toString(encoding) };
}

export function decryptNoteBytes(key: Buffer, value: NoteCiphertext, context: NoteCipherContext): Buffer {
  try {
    if (!value || value.format !== 1 || Object.keys(value).sort().join(',') !== 'ciphertext,format,nonce,tag') throw failure();
    const decipher = createDecipheriv('aes-256-gcm', key, decode(value.nonce, 12));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(decode(value.tag, 16));
    return Buffer.concat([decipher.update(decode(value.ciphertext)), decipher.final()]);
  } catch { throw failure(); }
}

function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 1 || Buffer.byteLength(password) > 1024) throw new NotesError('请输入密码，密码最多为 1024 字节。');
}

async function passwordKey(password: string, kdf: NotePasswordRecord['kdf']): Promise<Buffer> {
  checkPassword(password);
  // 参数只接受本版本的固定值，损坏记录不能触发无界内存或 CPU 消耗。
  if (!kdf || kdf.algorithm !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1) throw failure();
  const salt = decode(kdf.salt, 32);
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
const masterContext = (revision: number): NoteCipherContext => ({ noteId: '', kind: 'master-key', identity: String(revision) });

export async function protectNoteMaster(password: string, master: Buffer, revision: number): Promise<NotePasswordRecord> {
  const kdf: NotePasswordRecord['kdf'] = { algorithm: 'scrypt', salt: randomBytes(32).toString(encoding), N: 32768, r: 8, p: 1 };
  const key = await passwordKey(password, kdf);
  try { return { format: 1, revision, kdf, master: encryptNoteBytes(key, master, masterContext(revision)) }; }
  finally { key.fill(0); }
}

export async function unprotectNoteMaster(password: string, record: NotePasswordRecord): Promise<Buffer> {
  if (record?.format !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1) throw failure();
  const key = await passwordKey(password, record.kdf);
  try {
    const master = decryptNoteBytes(key, record.master, masterContext(record.revision));
    if (master.length !== 32) { master.fill(0); throw failure(); }
    return master;
  } finally { key.fill(0); }
}
