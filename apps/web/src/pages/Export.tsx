import { useState } from 'react';
import { Alert, Button, DatePicker, Space, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader, Section, Toolbar } from '@kt/ui';
import { SENSITIVE_FLAGS_ALL } from '@kt/domain';
import { useAuth } from '../auth.js';

// Máy chủ trả một tệp zip (CSV + PDF sổ + bảng băm) cho khoảng ngày chọn; tải về thành tệp.
export default function ExportPage() {
  const { me } = useAuth();
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().startOf('year'), dayjs().endOf('month')]);
  const [busy, setBusy] = useState(false);
  const missing = SENSITIVE_FLAGS_ALL.filter((f) => !me?.sensitive.includes(f));
  const run = async () => {
    const from = range[0].format('YYYY-MM-DD'); const to = range[1].format('YYYY-MM-DD');
    setBusy(true);
    try {
      const res = await fetch('/api/export/authority', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) });
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(b?.error?.message ?? `Lỗi hệ thống (${res.status})`); }
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `xuat-du-lieu-${from}-${to}.zip` });
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 0); // thu hồi sau khi trình duyệt đã bắt đầu tải
    } catch (e) { void message.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader
        title="Xuất dữ liệu cho cơ quan thẩm quyền"
        description="Xuất gói dữ liệu phục vụ thanh tra, kiểm tra gồm tệp dữ liệu, sổ sách và mã băm toàn vẹn"
      >
        <Toolbar>
          <span>Khoảng ngày ghi sổ</span>
          <DatePicker.RangePicker allowClear={false} format="DD/MM/YYYY" value={range} onChange={(v) => { if (v?.[0] && v[1]) setRange([v[0], v[1]]); }} />
          <Button type="primary" loading={busy} disabled={missing.length > 0} onClick={() => void run()}>Xuất gói dữ liệu</Button>
        </Toolbar>
      </PageHeader>
      <Section>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message="Gói dữ liệu theo Điều 28 Thông tư 99/2025 (tệp zip)" description={<ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>Tệp CSV (UTF-8 có BOM, phân cách dấu ;) trong khoảng ngày chọn: chứng từ và dòng định khoản đã ghi sổ, nhật ký kiểm toán; kèm hệ thống tài khoản, đối tượng, kỳ kế toán.</li>
            <li>Tệp PDF của cả năm tài chính có kỳ chứa ngày kết thúc: Sổ Nhật ký chung, Sổ Cái, Bảng cân đối số phát sinh và báo cáo tài chính B01, B02, B03 (nếu công ty đã định nghĩa). Tệp PDF vượt 40.000 dòng bị bỏ khỏi gói và được ghi trong README.txt; hãy in riêng từng sổ theo khoảng ngày ngắn hơn.</li>
            <li>MANIFEST.sha256 ghi mã băm từng tệp để cơ quan nhận kiểm tra toàn vẹn; README.txt mô tả từng tệp và cột.</li></ul>} />
          {missing.length > 0 && <Alert type="warning" showIcon message={`Gói có Nhật ký chung và Sổ Cái nên cần đủ các cờ xem công nợ phải thu, phải trả và giá vốn (còn thiếu: ${missing.join(', ')}).`} />}
        </Space>
      </Section>
    </div>
  );
}
