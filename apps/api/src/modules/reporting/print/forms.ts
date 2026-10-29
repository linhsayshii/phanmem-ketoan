export interface FormRef { formNo: string; issuedBy: string }
const ISSUED: Record<string, string> = {
  TT99: 'Ban hành theo Thông tư số 99/2025/TT-BTC ngày 27/10/2025 của Bộ Tài chính',
  TT133: 'Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính',
  // TT200: chỉ báo cáo tài chính B01-DN, B02-DN, B03-DN có số mẫu và chú thích (Phụ lục 2, Công báo số 289 + 290, đã đối chiếu). Phụ lục 3 (chứng từ), Phụ lục 4 (sổ) không đăng Công báo nên chưa có bản gốc: chứng từ và sổ TT200 in không có "Mẫu số".
  TT200: 'Ban hành theo Thông tư số 200/2014/TT-BTC ngày 22/12/2014 của Bộ Tài chính',
};
// Mẫu số theo phụ lục: DN = TT99, DNN = TT133. Phiếu kế toán không có mẫu bắt buộc: dùng số nội bộ "PKT".
// CHỈ giữ mục đã đối chiếu văn bản gốc. Đã bỏ (chưa có bằng chứng, GĐ7 gói 2, quyết định 1350): Nhật ký chung S03a, Sổ Cái S03b, S38/S20-DNN, Bảng cân đối số phát sinh S06 (TT99 "S06-DN" và TT133 "S06-DNN" trùng sổ chi tiết vật liệu), S02a/S02b/S02c1 và mọi mục TT200.
// Không có mục thì sổ in không có "Mẫu số"; kiểm thử forms.test.ts chặn trùng số mẫu giữa các khóa trong cùng chế độ.
export const FORMS: Record<string, Record<string, string>> = {
  PKT: { TT99: 'PKT', TT133: 'PKT' },
  // B01/B02/B03: TT99 Phụ lục IV (B01-DN, B02-DN, B03-DN), TT133 Phụ lục 2 (B01a-DNN, B02-DNN, B03-DNN), TT200 Phụ lục 2 (B01-DN, B02-DN, B03-DN), cùng nguồn với packages/coa-data/data/reports/status.json.
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
  // Biên bản kiểm kê vật tư, công cụ, sản phẩm, hàng hóa (TT99: "Biên bản tổng hợp kiểm kê..."): "Mẫu số 05 - VT" có trong văn bản gốc của cả TT 133/2016 (Phụ lục 3) và TT 99/2025.
  // Phiếu nhập kho, phiếu xuất kho: "Mẫu số 01 - VT", "02 - VT" có trong văn bản gốc của cả TT 133/2016 và TT 99/2025; TT200 chưa có văn bản gốc nên không in số mẫu.
  '01-VT': { TT99: '01 - VT', TT133: '01 - VT' },
  '02-VT': { TT99: '02 - VT', TT133: '02 - VT' },
  '05-VT': { TT99: '05 - VT', TT133: '05 - VT' }, // TT200: chưa có văn bản gốc đối chiếu nên không in số mẫu
  // Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa: TT99 S10-DN, TT133 S06-DNN. Thẻ kho (Sổ kho): TT99 S12-DN, TT133 S08-DNN (đối chiếu ~/legal-docs; S10-DNN và S12-DNN của TT133 là sổ khác). TT200 chưa có văn bản gốc nên không in số mẫu.
  'stock-ledger': { TT99: 'S10-DN', TT133: 'S06-DNN' },
  'stock-card': { TT99: 'S12-DN', TT133: 'S08-DNN' },
  // Sổ tài sản cố định S21-DN / S09-DNN, Sổ theo dõi TSCĐ và CCDC tại nơi sử dụng S22-DN / S10-DNN, Thẻ TSCĐ S23-DN / S11-DNN, Bảng tính và phân bổ khấu hao TSCĐ "06 - TSCĐ": đối chiếu ~/legal-docs (tt99-full.txt dòng 1197, 18938-18942, 20674-20760, 2616; tt133-full.txt dòng 12248-12251, 12922-13010, 10625). TT200 chưa có văn bản gốc nên không in số mẫu.
  'asset-book': { TT99: 'S21-DN', TT133: 'S09-DNN' },
  'asset-location': { TT99: 'S22-DN', TT133: 'S10-DNN' },
  'asset-card': { TT99: 'S23-DN', TT133: 'S11-DNN' },
  '06-TSCĐ': { TT99: '06 - TSCĐ', TT133: '06 - TSCĐ' },
  // Biên bản giao nhận (01), thanh lý (02), đánh giá lại (03 không in), kiểm kê TSCĐ (05): có trong văn bản gốc của cả hai (tt99-full.txt dòng 1190-1197, 2347-2625; tt133-full.txt dòng 9366-9371, 10416-10610). TT200 chưa có văn bản gốc nên không in số mẫu.
  '01-TSCĐ': { TT99: '01 - TSCĐ', TT133: '01 - TSCĐ' },
  '02-TSCĐ': { TT99: '02 - TSCĐ', TT133: '02 - TSCĐ' },
  '04-TSCĐ': { TT99: '04 - TSCĐ', TT133: '04 - TSCĐ' },
  '05-TSCĐ': { TT99: '05 - TSCĐ', TT133: '05 - TSCĐ' },
};
// Chú thích dưới "Mẫu số" của chứng từ, đúng chữ trên mẫu (khác chú thích của sổ: TT99 ghi "Kèm theo", TT133 ghi "Ban hành theo").
const VOUCHER_LEGEND: Record<string, string> = {
  TT99: '(Kèm theo Thông tư số 99/2025/TT-BTC ngày 27 tháng 10 năm 2025 của Bộ trưởng Bộ Tài chính)',
  TT133: '(Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính)',
};
export function formNoFor(regime: string, key: string): FormRef {
  const formNo = Object.hasOwn(FORMS, key) ? FORMS[key]![regime] : undefined;
  // Không có số mẫu đã đối chiếu thì để trống cả "Ban hành theo": không dùng mã khóa nội bộ làm số mẫu.
  return formNo ? { formNo, issuedBy: ISSUED[regime] ?? '' } : { formNo: '', issuedBy: '' };
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
