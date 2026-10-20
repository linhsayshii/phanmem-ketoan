export interface FormRef { formNo: string; issuedBy: string }
const ISSUED: Record<string, string> = {
  TT99: 'Ban hành theo Thông tư số 99/2025/TT-BTC ngày 27/10/2025 của Bộ Tài chính',
  TT133: 'Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính',
  TT200: 'Ban hành theo Thông tư số 200/2014/TT-BTC ngày 22/12/2014 của Bộ Tài chính',
};
// Mẫu số theo phụ lục: DN = TT99/TT200, DNN = TT133. Phiếu kế toán không có mẫu bắt buộc: dùng số nội bộ "PKT".
// Các mã TT133 (S38/S20-DNN, S06/S04-DNN) phải đối chiếu lại với Phụ lục 4 TT 133/2016 trước khi phát hành; sửa bảng này là đủ, không sửa mã in.
const FORMS: Record<string, Record<string, string>> = {
  PKT: { TT99: 'PKT', TT133: 'PKT', TT200: 'PKT' },
  S03a: { TT99: 'S03a-DN', TT133: 'S03a-DNN', TT200: 'S03a-DN' },
  S03b: { TT99: 'S03b-DN', TT133: 'S03b-DNN', TT200: 'S03b-DN' },
  S38: { TT99: 'S38-DN', TT133: 'S20-DNN', TT200: 'S38-DN' },
  S06: { TT99: 'S06-DN', TT133: 'S06-DNN', TT200: 'S06-DN' },
  B01: { TT99: 'B01-DN', TT133: 'B01a-DNN', TT200: 'B01-DN' },
  B02: { TT99: 'B02-DN', TT133: 'B02-DNN', TT200: 'B02-DN' },
  B03: { TT99: 'B03-DN', TT133: 'B03-DNN', TT200: 'B03-DN' },
  // Chứng từ tiền mặt: chép từ mẫu trong văn bản gốc của TT 133/2016 và TT 99/2025 (~/legal-docs); TT200 và TT58 chưa có văn bản gốc đối chiếu nên không có mục (xem voucherFormFor).
  // Sổ quỹ tiền mặt và Sổ tiền gửi ngân hàng: TT133 mẫu S04a-DNN, S05-DNN (Phụ lục 4); TT99 mẫu S07-DN, S08-DN (danh mục sổ). TT200 và TT58 chưa có văn bản gốc đối chiếu nên không có mục (xem bookFormFor).
  'so-quy': { TT99: 'S07-DN', TT133: 'S04a-DNN' },
  'so-tien-gui': { TT99: 'S08-DN', TT133: 'S05-DNN' },
  '01-TT': { TT99: '01 - TT', TT133: '01 - TT' },
  '02-TT': { TT99: '02 - TT', TT133: '02 - TT' },
  // Bảng kiểm kê quỹ: 08a - TT (VND) và 08b - TT (ngoại tệ), có trong văn bản gốc của cả TT 133/2016 và TT 99/2025.
  '08a-TT': { TT99: '08a - TT', TT133: '08a - TT' },
  '08b-TT': { TT99: '08b - TT', TT133: '08b - TT' },
};
// Chú thích dưới "Mẫu số" của chứng từ, đúng chữ trên mẫu (khác chú thích của sổ: TT99 ghi "Kèm theo", TT133 ghi "Ban hành theo").
const VOUCHER_LEGEND: Record<string, string> = {
  TT99: '(Kèm theo Thông tư số 99/2025/TT-BTC ngày 27 tháng 10 năm 2025 của Bộ trưởng Bộ Tài chính)',
  TT133: '(Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính)',
};
export function formNoFor(regime: string, key: string): FormRef {
  return { formNo: FORMS[key]?.[regime] ?? key, issuedBy: ISSUED[regime] ?? '' };
}

// Mẫu chứng từ có trong văn bản gốc của chế độ; null thì in không có dòng "Mẫu số" (mẫu nội bộ như Giấy báo, Ủy nhiệm chi, hoặc chế độ chưa có văn bản gốc).
export function voucherFormFor(regime: string, key: string): FormRef | null {
  const formNo = Object.hasOwn(FORMS, key) ? FORMS[key]![regime] : undefined;
  return formNo && VOUCHER_LEGEND[regime] ? { formNo, issuedBy: VOUCHER_LEGEND[regime] } : null;
}

// Mẫu sổ có trong văn bản gốc của chế độ; null thì sổ in không có dòng "Mẫu số" (không dùng mã khóa nội bộ làm số mẫu).
export function bookFormFor(regime: string, key: string): FormRef | null {
  const formNo = Object.hasOwn(FORMS, key) ? FORMS[key]![regime] : undefined;
  return formNo && ISSUED[regime] ? { formNo, issuedBy: ISSUED[regime] } : null;
}
