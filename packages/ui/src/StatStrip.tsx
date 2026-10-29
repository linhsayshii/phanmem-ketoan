import type { CSSProperties } from 'react';
import { COLOR } from './theme.js';

// Hàng số liệu chia ô bằng vạch dọc, hỗ trợ che quyền
export interface StatItem {
  label: string;
  value: string | null;
  hint?: string;
  testId?: string;
}

export interface StatStripProps {
  items: StatItem[];
  style?: CSSProperties;
  className?: string;
}

export function StatStrip({ items, style, className }: StatStripProps) {
  return (
    <div
      className={className ? `kt-stat-strip ${className}` : 'kt-stat-strip'}
      style={{
        display: 'flex',
        background: COLOR.surface,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 4,
        overflow: 'hidden',
        marginBottom: 16,
        ...style,
      }}
    >
      {items.map((item, index) => {
        const isNull = item.value === null;
        return (
          <div
            key={item.label}
            data-testid={item.testId}
            className="kt-stat-item"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '12px 16px',
              borderRight: index < items.length - 1 ? `1px solid ${COLOR.border}` : 'none',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: COLOR.textSecondary,
                marginBottom: 4,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {item.label}
            </div>
            {isNull ? (
              <div style={{ fontSize: 13, color: COLOR.textSecondary, lineHeight: '28px' }}>
                Không có quyền xem
              </div>
            ) : (
              <div
                className="kt-num"
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: COLOR.text,
                  lineHeight: '28px',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {item.value}
              </div>
            )}
            {item.hint && (
              <div style={{ fontSize: 11, color: COLOR.textSecondary, marginTop: 2 }}>
                {item.hint}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
