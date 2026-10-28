import type { CSSProperties, ReactNode } from 'react';
import { COLOR } from './theme.js';

// Đầu trang chung (PageHeader) và hàng lọc/công cụ (Toolbar)
export interface PageHeaderProps {
  title: ReactNode;
  /** Nhãn (vd. trạng thái chứng từ) đặt ngay cạnh h1, ngoài thẻ h1 */
  tags?: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function PageHeader({ title, tags, description, extra, children, style, className }: PageHeaderProps) {
  return (
    <header className={className} style={{ marginBottom: 16, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: children ? 12 : 0 }}>
        <div>
          {tags ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h1 className="kt-page-title" style={{ margin: 0 }}>{title}</h1>
              {tags}
            </div>
          ) : (
            <h1 className="kt-page-title" style={{ margin: 0 }}>{title}</h1>
          )}
          {description && (
            <div style={{ fontSize: 13, color: COLOR.textSecondary, marginTop: 2 }}>
              {description}
            </div>
          )}
        </div>
        {extra && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{extra}</div>}
      </div>
      {children && <div className="kt-page-header-children">{children}</div>}
    </header>
  );
}

export interface ToolbarProps {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Toolbar({ children, style, className }: ToolbarProps) {
  return (
    <div
      className={className ? `kt-toolbar ${className}` : 'kt-toolbar'}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', ...style }}
    >
      {children}
    </div>
  );
}
