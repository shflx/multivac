import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scrypt, type KeyObject } from 'node:crypto';
import { NotesError } from './note.js';

/** 所有身份字段都参与认证，阻止把密文搬到另一篇笔记或另一类记录。 */
export interface NoteCipherContext { noteId: string; kind: string; identity: string }
export interface NoteCiphertext { format: 1; nonce: string; ciphertext: string; tag: string }
/**
 * 笔记密钥对：公钥明文保存，用于加密新笔记时封装逐篇密钥；私钥由密码保护，只在解锁时解出。
 * 私钥密文的认证数据绑定公钥指纹，解锁时可发现公钥被替换。
 */
export interface NotePasswordRecord {
  format: 2;
  revision: number;
  kdf: { algorithm: 'scrypt'; salt: string; N: 32768; r: 8; p: 1 };
  publicKey: string;
  privateKey: NoteCiphertext;
}
/** 封装给公钥的逐篇密钥：临时公钥与认证加密的密钥密文。 */
export interface NoteSealedKey { format: 2; ephemeral: string; payload: NoteCiphertext }
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
const fingerprint = (publicKey: string) => createHash('sha256').update(publicKey).digest('hex');
const privateContext = (revision: number, publicKey: string): NoteCipherContext => ({ noteId: '', kind: 'private-key', identity: `${revision}:${fingerprint(publicKey)}` });
const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' }).toString(encoding);

function checkRecord(record: NotePasswordRecord): void {
  if (record?.format !== 2 || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.publicKey !== 'string') throw failure();
}

/** 生成新的密钥对，并用密码保护私钥；返回的记录可直接保存。 */
export async function createNoteKeys(password: string, revision: number): Promise<NotePasswordRecord> {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  try { return await protectNotePrivateKey(password, der, spki(publicKey), revision); }
  finally { der.fill(0); }
}

/** 用密码保护私钥（PKCS#8 DER）；修改密码时沿用原公钥。 */
export async function protectNotePrivateKey(password: string, privateKey: Buffer, publicKey: string, revision: number): Promise<NotePasswordRecord> {
  const kdf: NotePasswordRecord['kdf'] = { algorithm: 'scrypt', salt: randomBytes(32).toString(encoding), N: 32768, r: 8, p: 1 };
  const key = await passwordKey(password, kdf);
  try { return { format: 2, revision, kdf, publicKey, privateKey: encryptNoteBytes(key, privateKey, privateContext(revision, publicKey)) }; }
  finally { key.fill(0); }
}

/** 用密码解出私钥，并核对它与记录中的公钥成对。 */
export async function unprotectNotePrivateKey(password: string, record: NotePasswordRecord): Promise<Buffer> {
  checkRecord(record);
  const key = await passwordKey(password, record.kdf);
  try {
    const der = decryptNoteBytes(key, record.privateKey, privateContext(record.revision, record.publicKey));
    try {
      if (spki(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))) !== record.publicKey) throw failure();
    } catch { der.fill(0); throw failure(); }
    return der;
  } finally { key.fill(0); }
}

const sealingKey = (shared: Buffer, ephemeral: string, recipient: string) =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.from(ephemeral + recipient), 'multivac-note-data-key', 32));
const dataKeyContext = (noteId: string): NoteCipherContext => ({ noteId, kind: 'data-key', identity: '2' });

/** 把逐篇密钥封装给公钥：只需公钥，不需要密码或私钥。 */
export function sealNoteDataKey(publicKey: string, noteId: string, dataKey: Buffer): NoteSealedKey {
  const recipient = createPublicKey({ key: Buffer.from(publicKey, encoding), format: 'der', type: 'spki' });
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralKey = spki(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = sealingKey(shared, ephemeralKey, publicKey);
  try { return { format: 2, ephemeral: ephemeralKey, payload: encryptNoteBytes(key, dataKey, dataKeyContext(noteId)) }; }
  finally { key.fill(0); shared.fill(0); }
}

/** 用私钥打开逐篇密钥；调用方负责清零返回值。 */
export function openNoteDataKey(privateKey: Buffer, publicKey: string, noteId: string, sealed: NoteSealedKey): Buffer {
  if (sealed?.format !== 2 || typeof sealed.ephemeral !== 'string') throw failure();
  let shared: Buffer | undefined, key: Buffer | undefined;
  try {
    const ephemeral = createPublicKey({ key: decode(sealed.ephemeral), format: 'der', type: 'spki' });
    shared = diffieHellman({ privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }), publicKey: ephemeral });
    key = sealingKey(shared, sealed.ephemeral, publicKey);
    const dataKey = decryptNoteBytes(key, sealed.payload, dataKeyContext(noteId));
    if (dataKey.length !== 32) { dataKey.fill(0); throw failure(); }
    return dataKey;
  } catch { throw failure(); }
  finally { key?.fill(0); shared?.fill(0); }
}
