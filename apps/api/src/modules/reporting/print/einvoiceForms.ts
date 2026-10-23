import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { formatVnDate } from '@kt/domain';
import { loadNotice } from '../../einvoice/errorNotice.js';
import { esc, printShell } from './voucherHtml.js';

// Mẫu số 04/SS-HĐĐT "Thông báo hóa đơn điện tử đã lập sai", Phụ lục III TT 91/2026/TT-BTC (tt91-full.txt dòng 1782-1820). Nhãn và ghi chú chép nguyên văn mẫu.
const COLS = ['STT', 'Mã CQT cấp', 'Ký hiệu mẫu hóa đơn', 'Ký hiệu hóa đơn', 'Số hóa đơn điện tử', 'Ngày lập hóa đơn', 'Loại hóa đơn điện tử', 'Thông báo/Giải trình', 'Lý do/Thông báo của CQT'];
const ACTION = { notice: 'Thông báo', explain: 'Giải trình' } as const;

export async function errorNoticeHtml(trx: Transaction<Database>, tenantId: string, id: number): Promise<{ html: string; name: string }> {
  const n = await loadNotice(trx, id);
  const t = await trx.selectFrom('tenant').select(['name', 'tax_code']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const rows = n.lines.map((l) => `<tr><td>${l.lineNo}</td><td>${esc(l.cqtCode)}</td><td>${esc(l.formNo)}</td><td>${esc(l.serial)}</td><td>${esc(l.invoiceNo)}</td><td>${formatVnDate(l.issueDate)}</td><td>${esc(l.invoiceType)}</td><td>${ACTION[l.action]}</td><td>${esc(l.reason)}</td></tr>`).join('');
  const [y, m, d] = n.noticeDate.split('-');
  const dateLine = `${n.place ? `${esc(n.place)}, ` : '…….., '}ngày ${d} tháng ${m} năm ${y}`;
  const basis = n.noticeKind === 'tax_notice' ? `<p>Theo thông báo số ${esc(n.taxNoticeNo)} ngày ${formatVnDate(n.taxNoticeDate!)} của cơ quan thuế (Mẫu số 01/TB-RSĐT).</p>` : '';
  const html = printShell('Thông báo hóa đơn điện tử đã lập sai', `
    <div style="text-align:right;font-size:10pt"><b>Mẫu số: 04/SS-HĐĐT</b><br>(Kèm theo Thông tư số 91/2026/TT-BTC ngày 30 tháng 6 năm 2026 của Bộ trưởng Bộ Tài chính)</div>
    <div style="text-align:center;margin-top:8px"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><br>-------------</div>
    <h1>THÔNG BÁO HÓA ĐƠN ĐIỆN TỬ ĐÃ LẬP SAI</h1><div class="sub"><b>Kính gửi: (Cơ quan thuế)</b></div>
    <p>Tên người nộp thuế: ${esc(t.name)}</p><p>Mã số thuế: ${esc(t.tax_code)}</p>${basis}
    <p>Người nộp thuế thông báo về việc hóa đơn điện tử đã lập sai như sau:</p>
    <table class="grid"><thead><tr>${COLS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr><tr>${COLS.map((_, i) => `<th>(${i + 1})</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <p style="font-size:10pt"><b>Ghi chú:</b><br>(2): Mã CQT cấp đối với hóa đơn có mã của CQT, hóa đơn không có mã của CQT để trống.<br>(8): Trường hợp hóa đơn điện tử đã lập sai và người bán thực hiện Thông báo/Trường hợp CQT thông báo thì người nộp thuế giải trình.</p>
    <p style="text-align:right"><i>${dateLine}</i></p>
    <div class="sign"><div><b>NGƯỜI MUA</b><i>(Chữ ký số của người mua nếu có)</i><div class="gap"></div></div><div><b>NGƯỜI NỘP THUẾ hoặc<br>ĐẠI DIỆN HỢP PHÁP CỦA NGƯỜI NỘP THUẾ</b><i>(Chữ ký số, chữ ký điện tử của người nộp thuế)</i><div class="gap"></div></div></div>`);
  return { html, name: `04-SS-HDDT-${n.id}` };
}
