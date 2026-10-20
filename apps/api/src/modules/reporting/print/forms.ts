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
};
export function formNoFor(regime: string, key: string): FormRef {
  return { formNo: FORMS[key]?.[regime] ?? key, issuedBy: ISSUED[regime] ?? '' };
}
