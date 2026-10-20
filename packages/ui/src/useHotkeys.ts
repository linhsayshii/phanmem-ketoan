import { useEffect, useRef } from 'react';
import { isImeComposing } from '@kt/domain';

// Tên phím theo sự kiện: 'Insert', 'F9', 'Ctrl+s', 'Ctrl+Shift+s' (Cmd trên Mac tính là Ctrl; phím chữ viết thường).
const nameOf = (e: KeyboardEvent): string => `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key.length === 1 ? e.key.toLowerCase() : e.key}`;
// Đang gõ trong ô nhập, hoặc tiêu điểm nằm trong hộp thoại: phím tắt của trang bên dưới không được kích hoạt.
const isTyping = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select, .ant-modal'));

// Phím tắt toàn trang (vd. Insert = Thêm). Bỏ qua khi đang soạn chữ bằng bộ gõ (Telex/VNI) và khi tiêu điểm ở ô nhập hoặc trong hộp thoại.
export function useHotkeys(map: Record<string, () => void>): void {
  const ref = useRef(map); ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const fn = ref.current[nameOf(e)];
      if (!fn || isImeComposing(e) || isTyping(e.target)) return;
      e.preventDefault(); fn();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
}
