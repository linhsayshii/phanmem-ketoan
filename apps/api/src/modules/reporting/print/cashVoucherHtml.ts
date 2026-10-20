import { D, formatVnNumber, voucherTypeDef, vndInWords } from '@kt/domain';
import type { VoucherDto } from '../../ledger/vouchers.service.js';
import { esc, printShell, type CompanyInfo } from './voucherHtml.js';

export interface BankInfo { accountNo: string; accountName: string | null; bankName: string; branch: string | null }
// form: mẫu trong printForms của loại chứng từ. Dòng "Mẫu số" in theo c.formNo/c.issuedBy (rỗng thì không in: mẫu nội bộ hoặc chế độ chưa có văn bản gốc).
export interface CashPrintOptions { form: string; regime: string; own?: BankInfo | null | undefined; party?: BankInfo | null | undefined }

const DOTS = '……………………………………';
const DOTS_SHORT = '………………………';
const val = (s: string | null | undefined) => (s ? `<b>${esc(s)}</b>` : DOTS);
const dateWords = (iso: string) => { const [y, m, d] = iso.split('-'); return `Ngày ${d} tháng ${m} năm ${y}`; };
// Tài khoản Nợ hoặc Có của chứng từ, mỗi tài khoản một lần (ghi ở góc phải trên phiếu thu, phiếu chi).
const accounts = (v: VoucherDto, side: 'debit' | 'credit') => [...new Set(v.lines.filter((l) => D(l[side]).gt(0)).map((l) => l.accountCode))].join(', ');
const bankText = (b: BankInfo | null | undefined) => (b ? `<b>${esc(b.bankName)}${b.branch ? ` – ${esc(b.branch)}` : ''}</b>` : DOTS);

const header = (c: CompanyInfo, withTax: boolean) => `<div class="head"><div>Đơn vị: <b>${esc(c.name)}</b><br>Địa chỉ: ${esc(c.address ?? '')}${withTax ? `<br>MST: ${esc(c.taxCode ?? '')}` : ''}</div>`
  + `${c.formNo ? `<div style="text-align:right"><b>Mẫu số ${esc(c.formNo)}</b><br>${esc(c.issuedBy)}</div>` : ''}</div>`;
const top = (title: string, v: VoucherDto, ref: string) => `<div class="cv-top"><div class="cv-mid"><h1>${title}</h1><div class="sub">${dateWords(v.postingDate)}</div></div><div class="cv-ref">${ref}</div></div>`;
const signs = (cols: { label: string; hint?: string; name?: string | null }[]) => `<div class="sign">${cols.map((s) => `<div><b>${s.label}</b><i>${s.hint ?? '(Ký, họ tên)'}</i><div class="gap"></div>${esc(s.name ?? '')}</div>`).join('')}</div>`;

// Phiếu thu 01-TT và phiếu chi 02-TT: bố cục, nhãn và thứ tự chữ ký chép từ mẫu trong TT 133/2016 và TT 99/2025 (hai thông tư giống nhau, khác chú thích ban hành và dòng tỷ giá).
function officialForm(v: VoucherDto, c: CompanyInfo, o: CashPrintOptions): [string, string] {
  const inbound = o.form === '01-TT';
  const [title, who, reason] = inbound ? ['PHIẾU THU', 'Họ và tên người nộp tiền', 'Lý do nộp'] : ['PHIẾU CHI', 'Họ và tên người nhận tiền', 'Lý do chi'];
  const gd = { label: 'Giám đốc', hint: '(Ký, họ tên, đóng dấu)', name: c.legalRep }; const kt = { label: 'Kế toán trưởng', name: c.chiefAccountant };
  const cols = inbound ? [gd, kt, { label: 'Người nộp tiền' }, { label: 'Người lập phiếu' }, { label: 'Thủ quỹ' }] : [gd, kt, { label: 'Thủ quỹ' }, { label: 'Người lập phiếu' }, { label: 'Người nhận tiền' }];
  const fx = v.currencyCode !== 'VND' && v.fxRate ? `<b>${formatVnNumber(v.fxRate, D(v.fxRate).decimalPlaces())} (${esc(v.currencyCode)})</b>` : DOTS;
  const vnd = `<b>${formatVnNumber(v.totalDebit)} đồng</b>`;
  return [title, `${header(c, false)}
    ${top(title, v, `Quyển số: ${DOTS_SHORT}<br>Số: ${val(v.voucherNo)}<br>Nợ: ${esc(accounts(v, 'debit'))}<br>Có: ${esc(accounts(v, 'credit'))}`)}
    <p>${who}: ${val(v.personName ?? v.partyName)}</p>
    <p>Địa chỉ: ${val(v.personAddress)}</p>
    <p>${reason}: ${val(v.description)}</p>
    <p>Số tiền: ${vnd} (Viết bằng chữ): <b>${esc(vndInWords(v.totalDebit))}</b></p>
    <p>Kèm theo: ${v.attachmentsCount === null || v.attachmentsCount === undefined ? DOTS : `<b>${v.attachmentsCount}</b>`} Chứng từ gốc: ${DOTS}</p>
    <div style="text-align:right">Ngày….. tháng….. năm……</div>
    ${signs(cols)}
    <p>Đã nhận đủ số tiền (viết bằng chữ): ${DOTS}${DOTS}</p>
    <p>+ Tỷ giá ngoại tệ${o.regime === 'TT99' ? ' (vàng bạc, đá quý)' : ''}: ${fx}</p>
    <p>+ Số tiền quy đổi: ${v.currencyCode !== 'VND' ? vnd : DOTS}</p>
    <p class="note">(Liên gửi ra ngoài phải đóng dấu)</p>`];
}

// Giấy báo Nợ/Có: mẫu nội bộ (ngân hàng gửi giấy báo riêng của họ; bản in này là chứng từ kế toán lập từ đó), không có số mẫu.
function bankNotice(v: VoucherDto, c: CompanyInfo, o: CashPrintOptions): [string, string] {
  const out = voucherTypeDef(v.voucherType)?.cashSide === 'out';
  const title = out ? 'GIẤY BÁO NỢ' : 'GIẤY BÁO CÓ';
  return [title, `${header(c, true)}
    ${top(title, v, `Số: ${val(v.voucherNo)}<br>Nợ: ${esc(accounts(v, 'debit'))}<br>Có: ${esc(accounts(v, 'credit'))}`)}
    <p>Tài khoản ngân hàng: ${val(o.own?.accountNo)} Tại ngân hàng: ${bankText(o.own)}</p>
    <p>${out ? 'Người nhận tiền' : 'Người nộp tiền'}: ${val(v.personName ?? v.partyName)}</p>
    <p>Địa chỉ: ${val(v.personAddress)}</p>
    <p>Nội dung: ${val(v.description)}</p>
    <p>Số tiền: <b>${formatVnNumber(v.totalDebit)} đồng</b> (Viết bằng chữ): <b>${esc(vndInWords(v.totalDebit))}</b></p>
    ${signs([{ label: 'Người lập phiếu' }, { label: 'Kế toán trưởng', name: c.chiefAccountant }, { label: 'Giám đốc', hint: '(Ký, họ tên, đóng dấu)', name: c.legalRep }])}`];
}

// Ủy nhiệm chi: một bố cục chung (mẫu giấy từng ngân hàng cần người dùng cung cấp, xem docs/TIEP-THEO.md); bên thụ hưởng theo tài khoản của đối tượng chọn trên Giấy báo Nợ.
function paymentOrder(v: VoucherDto, c: CompanyInfo, o: CashPrintOptions): [string, string] {
  const title = 'ỦY NHIỆM CHI';
  return [title, `${header(c, true)}
    ${top(title, v, `Số: ${val(v.voucherNo)}`)}
    <p>Đơn vị trả tiền: ${val(c.name)}</p>
    <p>Số tài khoản: ${val(o.own?.accountNo)} Tại ngân hàng: ${bankText(o.own)}</p>
    <p>Đơn vị thụ hưởng: ${val(o.party?.accountName ?? v.partyName ?? v.personName)}</p>
    <p>Số tài khoản: ${val(o.party?.accountNo ?? v.partyBankAccountNo)} Tại ngân hàng: ${bankText(o.party)}</p>
    <p>Số tiền bằng số: <b>${formatVnNumber(v.totalDebit)} đồng</b></p>
    <p>Số tiền bằng chữ: <b>${esc(vndInWords(v.totalDebit))}</b></p>
    <p>Nội dung thanh toán: ${val(v.description)}</p>
    ${signs([{ label: 'Người lập phiếu' }, { label: 'Kế toán trưởng', name: c.chiefAccountant }, { label: 'Chủ tài khoản', hint: '(Ký, họ tên, đóng dấu)', name: c.legalRep }])}`];
}

export function renderCashVoucherHtml(v: VoucherDto, c: CompanyInfo, o: CashPrintOptions): string {
  const build = o.form === '01-TT' || o.form === '02-TT' ? officialForm : o.form === 'giay-bao' ? bankNotice : o.form === 'unc' ? paymentOrder : null;
  if (!build) throw new Error(`Mẫu in không hỗ trợ: ${o.form}`);
  const [title, body] = build(v, c, o);
  return printShell(`${title} ${v.voucherNo ?? ''}`, `<div class="cv">${body}</div>`);
}
