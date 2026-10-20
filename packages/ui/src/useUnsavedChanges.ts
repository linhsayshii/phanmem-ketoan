import { useCallback, useEffect, useRef } from 'react';
import { Modal } from 'antd';

// Phần đang nhập chưa lưu: trình duyệt hỏi khi đóng/tải lại trang, và `confirmIfDirty(proceed)` hỏi trước khi làm việc sẽ bỏ phần đó
// (đổi ngày nạp lại dữ liệu, nhân bản sang chứng từ khác...). Không dính router: đổi trang trong ứng dụng do nơi gọi tự chặn bằng hàm này.
export function useUnsavedChanges(dirty: boolean): (proceed: () => void, message?: string) => void {
  const ref = useRef(dirty); ref.current = dirty;
  const asking = useRef(false); // ô chọn ngày của antd báo đổi giá trị hai lần (Enter rồi rời ô): không chồng hai hộp hỏi
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);
  return useCallback((proceed, message = 'Phần đang nhập chưa lưu sẽ bị mất.') => {
    if (!ref.current) { proceed(); return; }
    if (asking.current) return;
    asking.current = true;
    Modal.confirm({ title: 'Bỏ thay đổi chưa lưu?', content: message, okText: 'Tiếp tục', cancelText: 'Ở lại',
      onOk: () => { asking.current = false; proceed(); }, onCancel: () => { asking.current = false; } });
  }, []);
}
