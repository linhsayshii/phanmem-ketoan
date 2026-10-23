import { execFileSync } from 'node:child_process';
import { constants, createPrivateKey, privateEncrypt, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Khóa RSA + chứng thư tự ký sinh bằng openssl (chỉ cho kiểm thử).
export interface TestKey { keyPem: string; certPem: string; certDer: Buffer; cn: string; dir: string; keyFile: string; certFile: string }
export function makeKey(cn: string, days = 3650, uid?: string): TestKey {
  const dir = mkdtempSync(path.join(tmpdir(), 'kt-sign-'));
  const keyFile = path.join(dir, 'k.pem'); const certFile = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', `/C=VN/O=Cong ty ${cn}/CN=${cn}${uid ? `/UID=${uid}` : ''}`, '-days', String(days)], { stdio: 'pipe' });
  const certPem = readFileSync(certFile, 'utf8');
  return { keyPem: readFileSync(keyFile, 'utf8'), certPem, certDer: new X509Certificate(certPem).raw, cn, dir, keyFile, certFile };
}
export const dropKey = (k: TestKey) => rmSync(k.dir, { recursive: true, force: true });

// Bên ký ngoài: nhận băm SHA-256 của SignedInfo, trả chữ ký PKCS#1 v1.5 (DigestInfo + băm).
const SHA256_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');
export const signDigest = (keyPem: string, digestB64: string): string =>
  privateEncrypt({ key: createPrivateKey(keyPem), padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_PREFIX, Buffer.from(digestB64, 'base64')])).toString('base64');
