import { useMemo, useState } from 'react';
import { Alert, Button, InputNumber, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NO_SALARY, PayrollErrorAlert } from './payrollUi.js';

// Thuế TNCN: bảng kê khấu trừ theo quý/tháng, quyết toán năm thay cho người lao động, tờ khai 05/KK-TNCN, 05/QTT-TNCN (lưu bảng kê; mẫu TT 89/2026 chưa có),
// chứng từ khấu trừ cấp cho cá nhân. Số liệu do API tính từ bảng lương đã hạch toán.
type Row = Record<string, unknown>;
type Kind = 'quarter' | 'month' | 'settlement';
interface Data { label: string; rows: Row[]; others?: Row[]; totals: Record<string, string | number>; warnings: string[]; intro: string[] }
interface Ret { id: number; formCode: string; periodKind: string; period: number; year: number; revision: number; status: 'draft' | 'final'; values: { totals: Record<string, string> }; finalizedAt: string | null }

const fmt = (v: unknown) => (typeof v === 'string' && !/^-?0+$/.test(v) ? formatVnNumber(v, 0) : '');
const money = (field: string, headerName: string): ColDef<Row> => ({ field, headerName, width: 140, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header', valueFormatter: (p) => fmt(p.value) });
const RES: Record<string, string> = { resident: 'Cư trú', non_resident: 'Không cư trú' };
const CT: Record<string, string> = { long: 'HĐ từ 3 tháng', short: 'HĐ dưới 3 tháng', none: 'Không HĐ' };
const head: ColDef<Row>[] = [{ field: 'code', headerName: 'Mã NV', width: 100, pinned: 'left' }, { field: 'name', headerName: 'Họ và tên', width: 200, pinned: 'left' }, { field: 'taxCode', headerName: 'Mã số thuế', width: 120 }];
const DEDUCTIONS = [money('deductionSelf', 'Giảm trừ bản thân'), money('deductionDependents', 'Giảm trừ người phụ thuộc'), money('deductionSi', 'Bảo hiểm bắt buộc'), money('deductionOther', 'Giảm trừ khác'), money('pitBase', 'Thu nhập tính thuế')];
const WITHHOLDING: ColDef<Row>[] = [...head, { headerName: 'Cư trú, hợp đồng', width: 170, valueGetter: (p) => (p.data?.residency ? `${RES[p.data.residency as string]}, ${CT[p.data.contractType as string]}` : '') },
  money('taxableIncome', 'Thu nhập chịu thuế'), money('exemptIncome', 'Thu nhập miễn thuế'), ...DEDUCTIONS, money('pit', 'Thuế TNCN đã khấu trừ')];
const SETTLEMENT: ColDef<Row>[] = [...head, { field: 'excludeReason', headerName: 'Không quyết toán thay', width: 300, tooltipField: 'excludeReason' }, money('taxableIncome', 'Thu nhập chịu thuế'), ...DEDUCTIONS,
  money('pitDue', 'Thuế phải nộp cả năm'), money('pitWithheld', 'Thuế đã khấu trừ'), money('difference', 'Còn phải nộp (+) / nộp thừa (-)')];
const FORM: Record<Kind, string> = { quarter: '05/KK-TNCN', month: '05/KK-TNCN', settlement: '05/QTT-TNCN' };
const periodText = (r: Pick<Ret, 'periodKind' | 'period' | 'year'>) => (r.periodKind === 'year' ? `Năm ${r.year}` : r.periodKind === 'quarter' ? `Quý ${r.period}/${r.year}` : `Tháng ${r.period}/${r.year}`);

export default function TncnReturnsPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const now = dayjs();
  const [f, setF] = useRememberedFilter('tncn-returns', { year: now.year(), kind: 'quarter' as Kind, quarter: Math.ceil((now.month() + 1) / 3), month: now.month() + 1 }, `${me?.tenantId}:${me?.userId}`);
  const [err, setErr] = useState<unknown>(null);
  const url = f.kind === 'settlement' ? `/api/tncn/settlement?year=${f.year}` : `/api/tncn/withholding?year=${f.year}&${f.kind === 'quarter' ? `quarter=${f.quarter}` : `month=${f.month}`}`;
  const data = useQuery({ queryKey: ['tncn', url], queryFn: () => api<Data>(url), retry: false, enabled: !!me?.sensitive.includes('view_salary') });
  const canReturns = can('tax_return.view');
  const returns = useQuery({ queryKey: ['tncn-returns', f.year], queryFn: () => api<Ret[]>(`/api/tncn/returns?year=${f.year}`), enabled: canReturns && !!me?.sensitive.includes('view_salary') });
  const done = (msg: string) => { setErr(null); void message.success(msg); void qc.invalidateQueries({ queryKey: ['tncn-returns'] }); };
  const create = useMutation({
    mutationFn: () => api<Ret>('/api/tncn/returns', { method: 'POST', json: { formCode: FORM[f.kind], year: f.year, periodKind: f.kind === 'settlement' ? 'year' : f.kind, period: f.kind === 'settlement' ? 1 : f.kind === 'quarter' ? f.quarter : f.month } }),
    onError: setErr, onSuccess: (r) => done(`Đã lập tờ khai ${r.formCode} ${periodText(r)}${r.revision ? ` bổ sung lần ${r.revision}` : ''}`),
  });
  const act = useMutation({
    mutationFn: ({ id, op }: { id: number; op: 'refresh' | 'finalize' | 'delete' }) =>
      api(op === 'finalize' ? `/api/tncn/returns/${id}/finalize` : `/api/tncn/returns/${id}`, { method: op === 'finalize' ? 'POST' : op === 'refresh' ? 'PUT' : 'DELETE' }).then(() => op),
    onError: setErr, onSuccess: (op) => done(op === 'finalize' ? 'Đã chốt tờ khai' : op === 'refresh' ? 'Đã tính lại tờ khai theo bảng lương hiện tại' : 'Đã xóa tờ khai nháp'),
  });

  const d = data.data;
  const total = useMemo<Row[]>(() => (d ? [{ name: 'Cộng', ...d.totals }] : []), [d]);
  if (!me?.sensitive.includes('view_salary')) return NO_SALARY;
  const open = (u: string) => window.open(u, '_blank');
  const settle = f.kind === 'settlement';

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Thuế thu nhập cá nhân</h2>
        <InputNumber aria-label="Năm" addonBefore="Năm" min={2000} max={2100} value={f.year} onChange={(v) => setF({ ...f, year: v ?? f.year })} style={{ width: 130 }} />
        <Select aria-label="Loại kỳ" value={f.kind} style={{ width: 190 }} onChange={(kind) => setF({ ...f, kind })}
          options={[{ value: 'quarter', label: 'Khấu trừ theo quý' }, { value: 'month', label: 'Khấu trừ theo tháng' }, { value: 'settlement', label: 'Quyết toán năm' }]} />
        {f.kind === 'quarter' && <Select aria-label="Quý" value={f.quarter} style={{ width: 90 }} onChange={(quarter) => setF({ ...f, quarter })} options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Quý ${q}` }))} />}
        {f.kind === 'month' && <Select aria-label="Tháng" value={f.month} style={{ width: 100 }} onChange={(month) => setF({ ...f, month })} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }))} />}
        {can('payroll.export') && <Button onClick={() => open(`${url}&format=xlsx`)}>Xuất bảng kê Excel</Button>}
        <Button onClick={() => open(`${url}&format=html`)}>In bảng kê</Button>
        <Button onClick={() => open(`/api/tncn/certificates?year=${f.year}&format=html`)}>In chứng từ khấu trừ năm {f.year}</Button>
        {can('tax_return.create') && <Button type="primary" loading={create.isPending} onClick={() => create.mutate()}>Lập tờ khai {FORM[f.kind]}</Button>}
      </Space>
      <Alert type="warning" showIcon message="Chưa có mẫu tờ khai theo TT 89/2026: xuất bảng kê Excel"
        description="Mẫu 05/KK-TNCN, 05/QTT-TNCN (TT 89/2026 Phụ lục I) chưa được nhập từ văn bản gốc. Tờ khai lưu và chốt bảng kê số liệu nguồn; chưa xuất XML, chưa ký số. Chứng từ khấu trừ in bản tổng hợp không có mẫu số, ký hiệu." />
      <PayrollErrorAlert error={err} onClose={() => setErr(null)} />
      {data.error ? <PayrollErrorAlert error={data.error} /> : !d ? <Alert type="info" message="Đang tải…" /> : <>
        {[...d.intro, ...d.warnings].map((t) => <Alert key={t} type="warning" showIcon message={t} />)}
        <div data-testid="tncn-summary">
          {settle ? <Space wrap><Tag>{d.totals.settled} người quyết toán thay</Tag><Tag>{d.totals.excluded} người tự quyết toán</Tag>
            <Tag color="red">Còn phải nộp {formatVnNumber(String(d.totals.payable), 0)}</Tag><Tag color="green">Nộp thừa {formatVnNumber(String(d.totals.refund), 0)}</Tag></Space>
            : <Space wrap><Tag>{d.totals.persons} người có thu nhập từ tiền lương, tiền công</Tag><Tag color="blue">Thuế khấu trừ từ lương {formatVnNumber(String(d.totals.pit), 0)}</Tag>
              {d.others?.length ? <Tag color="blue">Khấu trừ ngoài lương {formatVnNumber(String(d.totals.othersPit), 0)}</Tag> : null}<Tag color="geekblue">Cộng {formatVnNumber(String(d.totals.totalPit), 0)}</Tag></Space>}
        </div>
        <KeyboardGrid<Row> rows={d.rows} pinnedBottomRows={total} columns={settle ? SETTLEMENT : WITHHOLDING} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly lockRows animateRows={false} height="max(360px, calc(100vh - 460px))" />
        {!!d.others?.length && <Table size="small" rowKey={(r) => String(r.partyCode)} pagination={false} title={() => 'Thuế TNCN khấu trừ ngoài lương (hóa đơn mua dịch vụ của cá nhân)'} dataSource={d.others}
          columns={[{ dataIndex: 'partyCode', title: 'Mã đối tượng', width: 140 }, { dataIndex: 'partyName', title: 'Tên cá nhân' }, { dataIndex: 'taxCode', title: 'Mã số thuế', width: 140 },
            { dataIndex: 'pit', title: 'Thuế đã khấu trừ', align: 'right', width: 160, render: (v: string) => formatVnNumber(v, 0) }]} />}
      </>}
      {canReturns && <Table<Ret> data-testid="tncn-returns" size="small" rowKey="id" pagination={false} title={() => `Tờ khai thuế TNCN năm ${f.year}`} loading={returns.isLoading} dataSource={returns.data ?? []}
        locale={{ emptyText: 'Chưa lập tờ khai nào' }}
        columns={[{ dataIndex: 'formCode', title: 'Tờ khai', width: 130 }, { title: 'Kỳ', width: 120, render: (_, r) => periodText(r) },
          { title: 'Lần', width: 110, render: (_, r) => (r.revision ? `Bổ sung lần ${r.revision}` : 'Lần đầu') },
          { title: 'Trạng thái', width: 160, render: (_, r) => (r.status === 'final' ? <Tag color="green">Đã chốt {r.finalizedAt ? formatVnDate(r.finalizedAt.slice(0, 10)) : ''}</Tag> : <Tag>Nháp</Tag>) },
          { title: 'Số thuế', align: 'right', width: 160, render: (_, r) => formatVnNumber(r.values.totals.totalPit ?? r.values.totals.pitDue ?? '0', 0) },
          { title: '', render: (_, r) => r.status === 'draft' && <Space>
            {can('tax_return.update') && <Button size="small" onClick={() => act.mutate({ id: r.id, op: 'refresh' })}>Tính lại</Button>}
            {can('tax_return.finalize') && <Popconfirm title="Chốt tờ khai? Sau khi chốt chỉ lập được tờ khai bổ sung." okText="Chốt" cancelText="Không" onConfirm={() => act.mutate({ id: r.id, op: 'finalize' })}><Button size="small" type="primary">Chốt</Button></Popconfirm>}
            {can('tax_return.delete') && <Popconfirm title="Xóa tờ khai nháp?" okText="Xóa" cancelText="Không" onConfirm={() => act.mutate({ id: r.id, op: 'delete' })}><Button size="small" danger>Xóa</Button></Popconfirm>}
          </Space> }]} />}
    </Space>
  );
}
