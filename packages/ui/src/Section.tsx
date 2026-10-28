import { Card, type CardProps } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { COLOR } from './theme.js';

// Khối nội dung bọc antd Card viền mảnh, không bóng
export interface SectionProps {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  loading?: boolean;
  testId?: string;
  bodyPadding?: number | string;
  style?: CSSProperties;
  className?: string;
}

export function Section({ title, extra, children, loading, testId, bodyPadding, style, className }: SectionProps) {
  const cardProps: CardProps & { 'data-testid'?: string } = {
    size: 'small',
    style: {
      border: `1px solid ${COLOR.border}`,
      borderRadius: 4,
      boxShadow: 'none',
      ...style,
    },
  };
  if (loading !== undefined) cardProps.loading = loading;
  if (testId) cardProps['data-testid'] = testId;
  if (className) cardProps.className = className;
  if (title) cardProps.title = <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>;
  if (extra) cardProps.extra = extra;
  if (bodyPadding !== undefined) cardProps.styles = { body: { padding: bodyPadding } };

  return <Card {...cardProps}>{children}</Card>;
}
