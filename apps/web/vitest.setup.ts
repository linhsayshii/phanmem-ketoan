import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
// globals: false nên RTL không tự dọn DOM sau mỗi test
afterEach(cleanup);
// findBy*/waitFor mặc định chờ 1 giây: máy bận (cả bộ kiểm thử chạy nối tiếp, DB lớn) làm các trang antd nặng dựng chậm hơn thế nên hay rớt giả.
configure({ asyncUtilTimeout: 5000 });
// Ant Design cần matchMedia trong jsdom
Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation((q: string) => ({ matches: false, media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
// jsdom chưa hỗ trợ getComputedStyle(elt, pseudoElt) mà rc-util (bảng/modal Ant Design) gọi để đo thanh cuộn.
// getComputedStyle của jsdom so khớp selector của MỌI luật CSS với phần tử (nwsapi), mà Ant Design chèn hàng nghìn luật: mỗi lần gọi (getByRole, user-event) tốn hàng chục ms
// và chiếm gần hết thời gian bộ kiểm thử. Chỉ giữ luật có thuộc tính mà thư viện kiểm thử hay hệ thống đọc (ẩn/hiện, pointer-events); phần còn lại không ai đọc trong jsdom.
type Rule = { style?: { length: number; [i: number]: string }; cssRules?: Rule[]; media?: unknown };
type Sheet = { cssRules: Rule[] };
const READ = new Set(['display', 'visibility', 'opacity', 'pointer-events']);
const keep = (r: Rule): boolean => (r.cssRules ? (r.cssRules = r.cssRules.filter(keep)).length > 0 : !!r.style && Array.from({ length: r.style.length }, (_, i) => r.style![i]!).some((p) => READ.has(p)));
const pruned = new WeakSet<object>();
const getComputedStyleOrig = window.getComputedStyle.bind(window);
window.getComputedStyle = (elt: Element) => {
  for (const sheet of Array.from(document.styleSheets) as unknown as Sheet[]) if (!pruned.has(sheet)) { pruned.add(sheet); sheet.cssRules = sheet.cssRules.filter(keep); }
  return getComputedStyleOrig(elt);
};
