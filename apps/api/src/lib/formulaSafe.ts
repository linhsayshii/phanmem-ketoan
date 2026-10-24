// Chống chèn công thức (CSV/Excel injection): ô chữ bắt đầu bằng = + - @ tab hoặc CR được thêm dấu nháy đơn để Excel/LibreOffice không chạy như công thức.
// Chỉ áp cho ô chữ; ô tiền kiểu số (number) giữ nguyên. Giá trị không phải chuỗi trả nguyên.
// shortcut: chỉ kiểm ký tự đầu, không cắt khoảng trắng đầu ô; nâng cấp nếu cần chặn cả " =cmd".
export function formulaSafe<T>(v: T): T | string {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
