import type { CSSProperties, ReactNode } from 'react';
import { COLOR } from './theme.js';

// Khối rỗng gọn, không vẽ hình to, một câu hướng dẫn hoặc nút hành động
export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  testId?: string;
  style?: CSSProperties;
  className?: string;
}

export function EmptyState({ title, description, action, testId, style, className }: EmptyStateProps) {
  const divProps: React.HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string } = {
    className: className ? `kt-empty-state ${className}` : 'kt-empty-state',
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 16px',
      textAlign: 'center',
      ...style,
    },
  };
  if (testId) divProps['data-testid'] = testId;

  return (
    <div {...divProps}>
      <div style={{ fontSize: 14, fontWeight: 600, color: COLOR.text }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: 13, color: COLOR.textSecondary, marginTop: 4, maxWidth: 400 }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
