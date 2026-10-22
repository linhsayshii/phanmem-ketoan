// Cấu hình loại chứng từ (khớp bảng voucher_type do seed_voucher_types sinh, migration 0025) và mục đích thu/chi của phiếu thu, phiếu chi, giấy báo.
import type { Regime } from './period.js';

export type HeaderField = 'party' | 'personName' | 'personAddress' | 'attachmentsCount' | 'bankAccount' | 'counterBankAccount' | 'partyBankAccount' | 'dueDate' | 'purpose' | 'currency';
// Nhãn tiếng Việt của trường tiêu đề, dùng cho thông báo thiếu trường bắt buộc và nhãn ô nhập.
export const HEADER_FIELD_LABELS: Record<HeaderField, string> = {
  party: 'Đối tượng', personName: 'Người nộp/nhận', personAddress: 'Địa chỉ', attachmentsCount: 'Số chứng từ gốc kèm theo', bankAccount: 'Tài khoản ngân hàng',
  counterBankAccount: 'Tài khoản ngân hàng nhận', partyBankAccount: 'Tài khoản ngân hàng của đối tượng', dueDate: 'Hạn thanh toán', purpose: 'Mục đích', currency: 'Loại tiền',
};
export interface VoucherTypeDef {
  code: string; name: string; module: 'general' | 'cash' | 'bank' | 'arap' | 'inventory'; manual: boolean; header: HeaderField[]; required: HeaderField[];
  cashSide?: 'in' | 'out'; moneyKind?: 'cash' | 'bank'; hasItems?: boolean; invoiceDirection?: 'purchase' | 'sale'; refund?: boolean; printForms: string[];
}

// Loại do hệ thống sinh, không lập tay qua route chung. PB không có ở đây: phân bổ lập tay vẫn được (như GĐ1), PB tự sinh mang source_doc_type riêng.
export const SYSTEM_VOUCHER_TYPES: readonly string[] = ['DK', 'KC', 'CL', 'DG', 'XQ', 'KTT'];

const def = (d: Omit<VoucherTypeDef, 'manual' | 'header' | 'required' | 'printForms'> & Partial<Pick<VoucherTypeDef, 'header' | 'required' | 'printForms'>>): [string, VoucherTypeDef] =>
  [d.code, { header: [], required: [], printForms: [], ...d, manual: !SYSTEM_VOUCHER_TYPES.includes(d.code) }];

const CASH_HEADER: HeaderField[] = ['party', 'personName', 'personAddress', 'attachmentsCount', 'purpose', 'currency'];
const BANK_HEADER: HeaderField[] = ['party', 'personName', 'personAddress', 'bankAccount', 'attachmentsCount', 'purpose', 'currency'];

export const VOUCHER_TYPES: Record<string, VoucherTypeDef> = Object.fromEntries([
  def({ code: 'PKT', name: 'Phiếu kế toán', module: 'general', header: ['party', 'attachmentsCount', 'currency'] }),
  def({ code: 'DK', name: 'Số dư đầu kỳ', module: 'general' }),
  def({ code: 'KC', name: 'Chứng từ kết chuyển', module: 'general' }),
  def({ code: 'PB', name: 'Chứng từ phân bổ', module: 'general' }),
  def({ code: 'PT', name: 'Phiếu thu', module: 'cash', cashSide: 'in', moneyKind: 'cash', header: CASH_HEADER, printForms: ['01-TT'] }),
  def({ code: 'PC', name: 'Phiếu chi', module: 'cash', cashSide: 'out', moneyKind: 'cash', header: CASH_HEADER, printForms: ['02-TT'] }),
  def({ code: 'BC', name: 'Giấy báo Có', module: 'bank', cashSide: 'in', moneyKind: 'bank', header: BANK_HEADER, required: ['bankAccount'], printForms: ['giay-bao'] }),
  // Ủy nhiệm chi là mẫu in của BN, không phải loại riêng.
  def({ code: 'BN', name: 'Giấy báo Nợ (in Ủy nhiệm chi)', module: 'bank', cashSide: 'out', moneyKind: 'bank', header: [...BANK_HEADER, 'partyBankAccount'], required: ['bankAccount'], printForms: ['giay-bao', 'unc'] }),
  def({ code: 'CT', name: 'Chuyển tiền nội bộ', module: 'bank', header: ['bankAccount', 'counterBankAccount', 'attachmentsCount', 'currency'] }),
  def({ code: 'QTU', name: 'Quyết toán tạm ứng', module: 'general', header: ['party', 'personName', 'attachmentsCount', 'currency'] }),
  def({ code: 'BT', name: 'Bù trừ công nợ', module: 'arap', header: ['party', 'currency'], required: ['party'] }),
  def({ code: 'HDB', name: 'Hóa đơn bán dịch vụ', module: 'arap', hasItems: true, invoiceDirection: 'sale', header: ['party', 'dueDate', 'currency'], required: ['party'] }),
  def({ code: 'HDM', name: 'Hóa đơn mua dịch vụ', module: 'arap', hasItems: true, invoiceDirection: 'purchase', header: ['party', 'dueDate', 'currency'], required: ['party'] }),
  def({ code: 'GGB', name: 'Giảm giá, trả lại dịch vụ bán', module: 'arap', hasItems: true, invoiceDirection: 'sale', refund: true, header: ['party', 'dueDate', 'currency'], required: ['party'] }),
  def({ code: 'GGM', name: 'Giảm giá, trả lại dịch vụ mua', module: 'arap', hasItems: true, invoiceDirection: 'purchase', refund: true, header: ['party', 'dueDate', 'currency'], required: ['party'] }),
  def({ code: 'CL', name: 'Chênh lệch tỷ giá đối trừ', module: 'arap' }),
  def({ code: 'DG', name: 'Đánh giá lại ngoại tệ', module: 'general' }),
  def({ code: 'XQ', name: 'Điều chỉnh tỷ giá xuất quỹ', module: 'general' }),
  def({ code: 'KTT', name: 'Khấu trừ thuế GTGT', module: 'general' }),
]);

// Tra theo mã người dùng nhập: Object.hasOwn để 'constructor', '__proto__'... không ra thành viên của Object.prototype.
export const voucherTypeDef = (code: string): VoucherTypeDef | undefined => (Object.hasOwn(VOUCHER_TYPES, code) ? VOUCHER_TYPES[code] : undefined);

type PurposeRegime = Extract<Regime, 'TT133' | 'TT99' | 'TT200'>;
export interface CashPurpose {
  code: string; label: string; types: ('PT' | 'PC' | 'BC' | 'BN')[]; counterAccounts: Record<PurposeRegime, string[]>; partyRequired: boolean;
}
const all = (...codes: string[]): CashPurpose['counterAccounts'] => ({ TT133: codes, TT99: codes, TT200: codes });
// Tài khoản đối ứng là tài khoản chi tiết có trong mẫu hệ thống tài khoản của chế độ (kiểm thử ở packages/coa-data/test/cashPurposes.test.ts). BHTN là 3385 ở TT133, 3386 ở TT99 và TT200.
const TAXES = ['33311', '33312', '3332', '3333', '3334', '3335', '3336', '3337', '33381', '33382', '3339'];
export const CASH_PURPOSES: readonly CashPurpose[] = [
  { code: 'thu_khach_hang', label: 'Thu tiền khách hàng', types: ['PT', 'BC'], counterAccounts: all('131'), partyRequired: true },
  { code: 'thu_hoan_ung', label: 'Thu hoàn ứng', types: ['PT', 'BC'], counterAccounts: all('141'), partyRequired: false },
  { code: 'thu_khac', label: 'Thu khác', types: ['PT', 'BC'], counterAccounts: all('711', '3388'), partyRequired: false },
  { code: 'chi_tra_ncc', label: 'Chi trả nhà cung cấp', types: ['PC', 'BN'], counterAccounts: all('331'), partyRequired: true },
  { code: 'chi_tam_ung', label: 'Chi tạm ứng', types: ['PC', 'BN'], counterAccounts: all('141'), partyRequired: false },
  { code: 'nop_thue', label: 'Nộp thuế và các khoản phải nộp Nhà nước', types: ['PC', 'BN'], counterAccounts: all(...TAXES), partyRequired: false },
  { code: 'nop_bao_hiem', label: 'Nộp BHXH, BHYT, BHTN, KPCĐ', types: ['PC', 'BN'],
    counterAccounts: { TT133: ['3382', '3383', '3384', '3385'], TT99: ['3382', '3383', '3384', '3386'], TT200: ['3382', '3383', '3384', '3386'] }, partyRequired: false },
  { code: 'chi_khac', label: 'Chi khác', types: ['PC', 'BN'], counterAccounts: all('811', '3388'), partyRequired: false },
];
