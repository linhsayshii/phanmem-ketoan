import { createHash, randomUUID, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { C14nCanonicalization, ExclusiveCanonicalization } from 'xml-crypto';
import { findAncestorNsForElement } from 'xml-crypto/lib/utils.js';
import { escapeXml } from '../tax/xml/index.js';

// Chữ ký XML dạng XAdES (QĐ 1233; xem docs/dev/tich-hop/xml-hoa-don.md mục chữ ký): RSA-SHA256, KeyInfo/X509Data (X509SubjectName + X509Certificate),
// SigningTime trong Object/QualifyingProperties/SignedProperties, Reference trỏ SignedProperties. Khóa riêng không bao giờ qua máy chủ:
// prepareEnveloped trả băm SHA-256 của SignedInfo (C14N 1.0) để bên ký (tiện ích, SmartCA) ký PKCS#1 v1.5, finish ghép chữ ký.
// verifyEnveloped kiểm cả XAdES lẫn DSig thuần (SigningTime ở SignatureProperties), Reference tới phần tử có Id ở bất kỳ đâu (dùng cho hóa đơn đầu vào: DSCKS là anh em của DLHDon).
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const XADES = 'http://uri.etsi.org/01903/v1.3.2#';
export const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = `${DS}enveloped-signature`;
const SIG_ALGS: Record<string, string> = { 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': 'sha384', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512' };
const DIGEST_ALGS: Record<string, string> = { 'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256', 'http://www.w3.org/2001/04/xmldsig-more#sha384': 'sha384', 'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512' };

// xmldom và xml-crypto dùng kiểu DOM khác nhau: ép kiểu tập trung ở đây.
type El = Element;
const parse = (xml: string): Document => {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('XML có DOCTYPE');
  return new DOMParser({ onError: (level, msg) => { if (level !== 'warning') throw new Error(msg); } }).parseFromString(xml, 'text/xml') as unknown as Document;
};
const children = (el: El, ns: string, local: string): El[] => Array.from(el.childNodes).filter((n): n is El => n.nodeType === 1 && (n as El).localName === local && (n as El).namespaceURI === ns);
const canon = (node: El, alg: string): string => {
  if (alg !== C14N && alg !== EXC_C14N) throw new Error(`Thuật toán chuẩn hóa không hỗ trợ: ${alg}`);
  const a = alg === C14N ? new C14nCanonicalization() : new ExclusiveCanonicalization();
  return a.process(node, { ancestorNamespaces: findAncestorNsForElement(node) }) as string;
};
const idOf = (el: El) => el.getAttribute('Id') ?? el.getAttribute('ID') ?? el.getAttribute('id');
const allById = (doc: Document, id: string): El[] => {
  const hits: El[] = [];
  const walk = (el: El) => { if (idOf(el) === id) hits.push(el); for (const c of Array.from(el.childNodes)) if (c.nodeType === 1) walk(c as El); };
  walk(doc.documentElement);
  return hits;
};
const byId = (doc: Document, id: string): El | null => allById(doc, id)[0] ?? null; // chỉ dùng khi KÝ tài liệu của ta; kiểm chữ ký dùng resolveRef (chặn Id trùng)
const digestOf = (target: El, transforms: string[], sig: El | null, hash: string): string => {
  const c14nAlg = transforms.find((t) => t === C14N || t === EXC_C14N) ?? C14N;
  const parent = sig?.parentNode ?? null; const next = sig?.nextSibling ?? null;
  const detach = transforms.includes(ENVELOPED) && sig !== null && parent !== null;
  if (detach) parent.removeChild(sig);
  try { return createHash(hash).update(canon(target, c14nAlg), 'utf8').digest('base64'); } finally { if (detach) parent.insertBefore(sig, next); }
};
const serialize = (doc: Document, original: string): string => {
  const s = new XMLSerializer().serializeToString(doc as never);
  const decl = /^\s*(<\?xml[^>]*\?>)/.exec(original)?.[1];
  return decl && !s.startsWith('<?xml') ? `${decl}\n${s}` : s;
};
const pathOf = (el: El): string => (el.parentNode?.nodeType === 1 ? pathOf(el.parentNode as El) : '') + `/${el.localName}`;
const subjectOf = (c: X509Certificate) => c.subject.split('\n').reverse().join(',');
const sha256b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

export interface Prepared { signedInfoC14n: string; digestB64: string; finish(signatureB64: string): string }

// refUri: '' hoặc bỏ trống = cả tài liệu (enveloped); '#id' = phần tử có thuộc tính Id. Chữ ký đặt cuối phần tử gốc.
// signatureId cố định (theo phiên) để dựng lại cùng SignedInfo khi ghép chữ ký.
export function prepareEnveloped(xml: string, cert: Buffer, opts: { refUri?: string; signingTime: string; signatureId?: string }): Prepared {
  const doc = parse(xml);
  const root = doc.documentElement;
  const refUri = opts.refUri ?? '';
  const target = refUri === '' ? root : refUri.startsWith('#') ? byId(doc, refUri.slice(1)) : null;
  if (!target) throw new Error(`Không tìm thấy phần tử tham chiếu "${refUri}" `);
  const x509 = new X509Certificate(cert);
  const sigId = opts.signatureId ?? `sig-${randomUUID()}`; const spId = `${sigId}-props`;
  const dataDigest = sha256b64(canon(target, C14N)); // băm trước khi chèn chữ ký
  const dataTransforms = `${target === root ? `<ds:Transform Algorithm="${ENVELOPED}"/>` : ''}<ds:Transform Algorithm="${C14N}"/>`;
  const reference = (type: string, uri: string, transforms: string, digest: string) =>
    `<ds:Reference${type ? ` Type="${type}"` : ''} URI="${escapeXml(uri)}"><ds:Transforms>${transforms}</ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference>`;
  const sigXml = `<ds:Signature xmlns:ds="${DS}" Id="${sigId}"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${C14N}"/>`
    + `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>${reference('', refUri, dataTransforms, dataDigest)}`
    + `${reference('http://uri.etsi.org/01903#SignedProperties', `#${spId}`, `<ds:Transform Algorithm="${C14N}"/>`, '')}</ds:SignedInfo><ds:SignatureValue></ds:SignatureValue>`
    + `<ds:KeyInfo><ds:X509Data><ds:X509SubjectName>${escapeXml(subjectOf(x509))}</ds:X509SubjectName><ds:X509Certificate>${cert.toString('base64')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`
    + `<ds:Object><xades:QualifyingProperties xmlns:xades="${XADES}" Target="#${sigId}"><xades:SignedProperties Id="${spId}"><xades:SignedSignatureProperties>`
    + `<xades:SigningTime>${escapeXml(opts.signingTime)}</xades:SigningTime></xades:SignedSignatureProperties></xades:SignedProperties></xades:QualifyingProperties></ds:Object></ds:Signature>`;
  const sig = doc.importNode(parse(sigXml).documentElement as never, true) as unknown as El;
  root.appendChild(sig as never);
  const signedInfo = children(sig, DS, 'SignedInfo')[0]!;
  const spDigest = children(children(signedInfo, DS, 'Reference')[1]!, DS, 'DigestValue')[0]!;
  spDigest.textContent = sha256b64(canon(byId(doc, spId)!, C14N));
  const signedInfoC14n = canon(signedInfo, C14N);
  return { signedInfoC14n, digestB64: sha256b64(signedInfoC14n), finish(signatureB64) {
    children(sig, DS, 'SignatureValue')[0]!.textContent = signatureB64;
    return serialize(doc, xml);
  } };
}

// signedPaths: đường dẫn tuyệt đối (vd '/HDon/DLHDon') của các phần tử dữ liệu được ký; hóa đơn đầu vào phải đòi đúng '/HDon/DLHDon'.
// covered: chính các phần tử được chữ ký phủ (ngoài ds:Signature); người gọi chỉ được đọc dữ liệu từ các nút này, không tra lại theo đường dẫn.
export interface Verified { valid: boolean; signedPaths: string[]; covered: El[]; certDer: Buffer | null; subject: string | null; signingTime: string | null; reason?: string }

export const MAX_XML_BYTES = 5 * 1024 * 1024;

// Reference '#id' → đúng MỘT phần tử. Có targets: chỉ xét phần tử có tên cục bộ trong targets (Id trùng ở phần tử ngoài targets, như MCCQT cùng Id="data" với DLHDon, không tính);
// phần tử nằm trong chính ds:Signature (SignedProperties) luôn phải là duy nhất toàn tài liệu. Không targets: bất kỳ Id nào xuất hiện hai lần đều bị từ chối. Chống signature wrapping.
function resolveRef(doc: Document, sig: El, uri: string, targets: string[] | undefined): El {
  if (uri === '') {
    const root = doc.documentElement;
    if (targets && !targets.includes(root.localName ?? '')) throw new Error('Reference trỏ cả tài liệu nhưng gốc không thuộc phần tử được phép ký');
    return root;
  }
  if (!uri.startsWith('#')) throw new Error(`Reference "${uri}" không trỏ tới phần tử nào`);
  const hits = allById(doc, uri.slice(1));
  const own = hits.filter((h) => sig.contains(h as never));
  const pool = own.length ? hits : targets ? hits.filter((h) => targets.includes(h.localName ?? '')) : hits;
  if (pool.length === 0) throw new Error(`Reference "${uri}" không trỏ tới phần tử nào${targets ? ` thuộc ${targets.join('/')}` : ''}`);
  if (pool.length > 1) throw new Error(`Id trùng "${uri.slice(1)}" trên ${pool.length} phần tử: nghi đánh tráo nội dung`);
  return pool[0]!;
}

// signaturePath: đường dẫn tên cục bộ từ phần tử gốc tới ds:Signature cần kiểm (vd ['DSCKS','NBan','Signature']); bỏ trống = ds:Signature đầu tiên.
// Chỉ kiểm mật mã (chữ ký, băm các Reference, ràng buộc SigningTime); hạn và chuỗi tin cậy của chứng thư do người gọi quyết định.
// targets: tên cục bộ các phần tử dữ liệu được phép làm đích Reference (vd ['DLHDon']); nên luôn truyền khi biết cấu trúc tài liệu.
export function verifyEnveloped(xml: string, opts: { signaturePath?: string[]; targets?: string[] } = {}): Verified {
  const fail = (reason: string): Verified => ({ valid: false, signedPaths: [], covered: [], certDer: null, subject: null, signingTime: null, reason });
  try {
    if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) return fail(`XML quá lớn (tối đa ${MAX_XML_BYTES / 1024 / 1024} MB)`);
    const doc = parse(xml);
    let sig: El | undefined;
    if (opts.signaturePath) {
      let cur: El | undefined = doc.documentElement;
      for (const name of opts.signaturePath) cur = cur && (Array.from(cur.childNodes).find((n) => n.nodeType === 1 && (n as El).localName === name) as El | undefined);
      sig = cur;
    } else sig = Array.from(doc.getElementsByTagNameNS(DS, 'Signature'))[0];
    if (!sig || sig.localName !== 'Signature' || sig.namespaceURI !== DS) return fail('Không có chữ ký');
    const signedInfo = children(sig, DS, 'SignedInfo')[0];
    const sigValue = children(sig, DS, 'SignatureValue')[0]?.textContent?.replace(/\s+/g, '');
    const certsB64 = children(children(children(sig, DS, 'KeyInfo')[0] ?? sig, DS, 'X509Data')[0] ?? sig, DS, 'X509Certificate').map((c) => (c.textContent ?? '').replace(/\s+/g, '')).filter(Boolean);
    if (!signedInfo || !sigValue || !certsB64.length) return fail('Chữ ký thiếu SignedInfo, SignatureValue hoặc chứng thư');
    const c14nAlg = children(signedInfo, DS, 'CanonicalizationMethod')[0]?.getAttribute('Algorithm') ?? '';
    const sigHash = SIG_ALGS[children(signedInfo, DS, 'SignatureMethod')[0]?.getAttribute('Algorithm') ?? ''];
    if (!sigHash) return fail('Thuật toán ký không hỗ trợ (chỉ RSA-SHA256/384/512)');
    const covered: El[] = [];
    for (const ref of children(signedInfo, DS, 'Reference')) {
      const uri = ref.getAttribute('URI') ?? '';
      const target = resolveRef(doc, sig, uri, opts.targets);
      const transforms = children(children(ref, DS, 'Transforms')[0] ?? ref, DS, 'Transform').map((t) => t.getAttribute('Algorithm') ?? '');
      if (transforms.some((t) => t !== ENVELOPED && t !== C14N && t !== EXC_C14N)) return fail('Transform không hỗ trợ');
      const hash = DIGEST_ALGS[children(ref, DS, 'DigestMethod')[0]?.getAttribute('Algorithm') ?? ''];
      if (!hash) return fail('Thuật toán băm Reference không hỗ trợ');
      if (digestOf(target, transforms, sig, hash) !== (children(ref, DS, 'DigestValue')[0]?.textContent ?? '').replace(/\s+/g, '')) return fail(`Băm của Reference "${uri}" không khớp: nội dung đã bị sửa`);
      covered.push(target);
    }
    if (!covered.some((t) => !sig.contains(t as never))) return fail('Chữ ký không phủ dữ liệu nào ngoài chính nó');
    // Nhiều chứng thư (chuỗi CA kèm theo): lấy chứng thư RSA có khóa kiểm được SignedInfo.
    const signedBytes = Buffer.from(canon(signedInfo, c14nAlg), 'utf8'); const sigBytes = Buffer.from(sigValue, 'base64');
    const cert = certsB64.map((b) => { try { return new X509Certificate(Buffer.from(b, 'base64')); } catch { return null; } })
      .find((c) => c?.publicKey.asymmetricKeyType === 'rsa' && cryptoVerify(sigHash, signedBytes, c.publicKey, sigBytes));
    if (!cert) return fail('Chữ ký không khớp chứng thư');
    // SigningTime chỉ tin khi nằm trong phần tử được ký (XAdES SignedProperties hoặc DSig SignatureProperties).
    const st = Array.from(sig.getElementsByTagNameNS('*', 'SigningTime')).find((e) => covered.some((c) => c.contains(e as never)));
    const data = covered.filter((t) => !sig.contains(t as never));
    return { valid: true, signedPaths: data.map(pathOf), covered: data, certDer: cert.raw, subject: subjectOf(cert), signingTime: st?.textContent?.trim() ?? null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
