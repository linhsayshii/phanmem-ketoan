import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEnveloped } from '../../src/modules/signing/xmldsig.js';
import { signDigest, type TestKey } from '../signing/keys.js';

export const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/xml', name), 'utf8');

// Ký DLHDon (Id="data") của mẫu rồi đặt chữ ký đúng chỗ HDon/DSCKS/NBan/Signature (hoặc CQT).
export function signInvoice(xml: string, key: TestKey, who: 'NBan' | 'CQT' = 'NBan'): string {
  const prep = prepareEnveloped(xml, key.certDer, { refUri: '#data', signingTime: '2026-01-15T09:00:00' });
  const signed = prep.finish(signDigest(key.keyPem, prep.digestB64));
  const sig = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signed)![0];
  const bare = signed.replace(sig, '');
  const at = bare.lastIndexOf('</HDon>');
  return `${bare.slice(0, at)}<DSCKS><${who}>${sig}</${who}></DSCKS>${bare.slice(at)}`;
}
