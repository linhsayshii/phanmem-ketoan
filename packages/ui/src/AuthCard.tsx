import type { ReactNode } from 'react';
import { COLOR } from './theme.js';

// Thẻ giữa màn hình cho trang ngoài khung ứng dụng (đăng nhập, chọn công ty)
export interface AuthCardProps {
  title: ReactNode;
  children: ReactNode;
  /** Tên sản phẩm phía trên thẻ */
  product?: ReactNode;
  width?: number;
}

export function AuthCard({ title, children, product = 'Phần mềm kế toán', width = 380 }: AuthCardProps) {
  return (
    <div style={{ minHeight: '100vh', background: COLOR.bgLayout, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: width }}>
        <div style={{ textAlign: 'center', fontSize: 15, fontWeight: 600, color: COLOR.primary, marginBottom: 16, letterSpacing: 0.2 }}>{product}</div>
        <div style={{ background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 4, padding: 24 }}>
          <h1 className="kt-page-title" style={{ margin: '0 0 16px' }}>{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}
