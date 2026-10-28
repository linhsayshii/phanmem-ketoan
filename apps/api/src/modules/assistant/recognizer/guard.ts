import { AppError } from '../../../plugins/errors.js';
import { MAX_INVOICE_XML_BYTES } from '../../inbound/parseXml.js';
import type { FileKind } from './types.js';

// Chặn tệp không tin cậy trước mọi bộ nhận diện: xác định loại theo nội dung (không tin đuôi tệp), giới hạn dung lượng, từ chối zip/nén lồng (zip bom, tệp Office),
// PDF có mã chủ động, ảnh có kích thước điểm ảnh quá lớn (bom giải nén). XML còn bị parseInvoiceXml từ chối DOCTYPE/ENTITY (XXE, billion laughs) và XML > 2 MB.
export const MAX_BINARY_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 50_000_000;
const reject = (code: string, message: string) => new AppError(code, message, 400);

export function sniffKind(buf: Buffer): FileKind | 'zip' | 'unknown' {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<')) return 'xml';
  return 'unknown';
}

function jpegPixels(buf: Buffer): number | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1]!;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return buf.readUInt16BE(i + 5) * buf.readUInt16BE(i + 7);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

export function guardFile(buf: Buffer, fileName: string): FileKind {
  if (buf.length === 0) throw reject('RECOGNIZE_EMPTY', 'Tệp rỗng');
  const kind = sniffKind(buf);
  if (kind === 'zip') throw reject('RECOGNIZE_ZIP', 'Không nhận tệp nén hoặc tệp Office (zip): tải riêng từng tệp XML, PDF hoặc ảnh; lô zip hóa đơn đầu vào dùng màn Hóa đơn đầu vào');
  if (kind === 'unknown') throw reject('RECOGNIZE_UNSUPPORTED', 'Chỉ nhận XML hóa đơn điện tử, PDF, ảnh PNG hoặc JPEG');
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1]?.toLowerCase();
  const want = { xml: ['xml'], pdf: ['pdf'], png: ['png'], jpeg: ['jpg', 'jpeg'] }[kind];
  if (ext && !want.includes(ext)) throw reject('RECOGNIZE_EXT_MISMATCH', `Đuôi tệp .${ext} không khớp nội dung (${kind.toUpperCase()}): từ chối`);
  if (kind === 'xml' && buf.length > MAX_INVOICE_XML_BYTES) throw reject('XML_TOO_LARGE', 'Tệp XML vượt 2 MB (giới hạn thông điệp theo QĐ 1233)');
  if (kind !== 'xml' && buf.length > MAX_BINARY_BYTES) throw reject('RECOGNIZE_TOO_LARGE', 'Tệp vượt 10 MB');
  if (kind === 'pdf') {
    const s = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia)\b/.test(s)) throw reject('RECOGNIZE_PDF_ACTIVE', 'PDF có mã chủ động hoặc tệp nhúng (JavaScript, Launch, EmbeddedFile): từ chối');
  }
  if (kind === 'png') {
    if (buf.length < 24 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw reject('RECOGNIZE_IMAGE_INVALID', 'Ảnh PNG hỏng');
    if (buf.readUInt32BE(16) * buf.readUInt32BE(20) > MAX_PIXELS) throw reject('RECOGNIZE_IMAGE_TOO_BIG', 'Ảnh có quá nhiều điểm ảnh (trên 50 triệu)');
  }
  if (kind === 'jpeg') {
    const px = jpegPixels(buf);
    if (px === null) throw reject('RECOGNIZE_IMAGE_INVALID', 'Ảnh JPEG hỏng hoặc không đọc được kích thước');
    if (px > MAX_PIXELS) throw reject('RECOGNIZE_IMAGE_TOO_BIG', 'Ảnh có quá nhiều điểm ảnh (trên 50 triệu)');
  }
  return kind;
}
