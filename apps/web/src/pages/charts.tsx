import { useState } from 'react';
import { formatVnNumber } from '@kt/domain';

// Biểu đồ SVG nhỏ (không thêm thư viện): cột nhóm hoặc đường, một trục, lưới nhạt, chú giải luôn hiện khi có từ 2 chuỗi, chú giải số khi rê chuột, kèm bảng số liệu.
// Màu chuỗi theo thứ tự cố định xanh, cam, ngọc (bảng màu dataviz đã kiểm: khác nhau với người mù màu).
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
export interface ChartSeries { name: string; values: (number | null)[] }
interface Props { title: string; labels: string[]; series: ChartSeries[]; kind: 'bar' | 'line'; height?: number; testId?: string }

const W = 720; const PAD = { l: 64, r: 12, t: 12, b: 28 };
const short = (n: number) => { const a = Math.abs(n); const s = a >= 1e9 ? `${+(a / 1e9).toFixed(1)} tỷ` : a >= 1e6 ? `${+(a / 1e6).toFixed(1)} tr` : a >= 1e3 ? `${+(a / 1e3).toFixed(0)} k` : String(Math.round(a)); return n < 0 ? `-${s}` : s; };
const full = (n: number | null) => (n === null ? 'Không có quyền xem' : formatVnNumber(String(Math.round(n))));

export function Chart({ title, labels, series, kind, height = 240, testId }: Props) {
  const [hover, setHover] = useState<number | null>(null); const [table, setTable] = useState(false);
  const vals = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = Math.max(0, ...vals); const min = Math.min(0, ...vals); const span = max - min || 1;
  const ih = height - PAD.t - PAD.b; const iw = W - PAD.l - PAD.r;
  const y = (v: number) => PAD.t + ih * (1 - (v - min) / span); const step = iw / Math.max(1, labels.length);
  const ticks = [0, 1, 2, 3, 4].map((i) => min + (span * i) / 4);
  const gw = step * 0.7; const bw = Math.max(2, (gw - 2 * (series.length - 1)) / Math.max(1, series.length));
  const cx = (i: number) => PAD.l + step * i + step / 2;
  return (
    <figure style={{ margin: 0 }} data-testid={testId}>
      <figcaption style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong>{title}</strong>
        <span>{series.length > 1 && series.map((s, i) => <span key={s.name} style={{ marginLeft: 12, fontSize: 12 }}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: SERIES_COLORS[i], marginRight: 4 }} />{s.name}</span>)}
          <button type="button" onClick={() => setTable(!table)} style={{ marginLeft: 12, fontSize: 12, border: 0, background: 'none', color: '#2a78d6', cursor: 'pointer' }}>{table ? 'Xem biểu đồ' : 'Xem bảng số'}</button></span>
      </figcaption>
      {table ? (
        <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', fontSize: 12 }}><thead><tr><th style={{ textAlign: 'left', padding: '2px 8px' }} /> {labels.map((l) => <th key={l} style={{ padding: '2px 8px', textAlign: 'right' }}>{l}</th>)}</tr></thead>
          <tbody>{series.map((s) => <tr key={s.name}><td style={{ padding: '2px 8px' }}>{s.name}</td>{s.values.map((v, i) => <td key={i} style={{ padding: '2px 8px', textAlign: 'right' }}>{v === null ? '' : full(v)}</td>)}</tr>)}</tbody></table></div>
      ) : (
        <div style={{ position: 'relative' }}>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => <g key={t}><line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#e4e3df" strokeWidth={1} /><text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#52514e">{short(t)}</text></g>)}
            {min < 0 && <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#52514e" strokeWidth={1} />}
            {labels.map((l, i) => <text key={l + i} x={cx(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="#52514e">{l}</text>)}
            {kind === 'bar' && series.map((s, si) => s.values.map((v, i) => v === null ? null : (
              <rect key={`${si}-${i}`} x={cx(i) - gw / 2 + si * (bw + 2)} width={bw} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={2} fill={SERIES_COLORS[si]} opacity={hover === null || hover === i ? 1 : 0.45} />)))}
            {kind === 'line' && series.map((s, si) => {
              const pts = s.values.map((v, i) => (v === null ? null : [cx(i), y(v)] as const));
              return <g key={si}><polyline fill="none" stroke={SERIES_COLORS[si]} strokeWidth={2} strokeLinejoin="round" points={pts.filter(Boolean).map((p) => p!.join(',')).join(' ')} />
                {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 3.5} fill={SERIES_COLORS[si]} stroke="#fcfcfb" strokeWidth={2} />)}</g>;
            })}
            {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="#52514e" strokeWidth={1} strokeDasharray="3 3" />}
            {labels.map((l, i) => <rect key={'h' + l + i} x={PAD.l + step * i} y={PAD.t} width={step} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${l}: ${series.map((s) => `${s.name} ${full(s.values[i] ?? null)}`).join(', ')}`} />)}
          </svg>
          {hover !== null && (
            <div role="tooltip" style={{ position: 'absolute', top: 4, left: `${Math.min(75, (cx(hover) / W) * 100 + 2)}%`, background: '#fcfcfb', border: '1px solid #d6d5d0', borderRadius: 6, padding: '6px 10px', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,.12)', pointerEvents: 'none' }}>
              <div style={{ fontWeight: 600 }}>{labels[hover]}</div>
              {series.map((s, i) => <div key={s.name}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: SERIES_COLORS[i], marginRight: 6 }} />{s.name}: {full(s.values[hover] ?? null)}</div>)}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
