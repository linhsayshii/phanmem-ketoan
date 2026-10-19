import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
// Ant Design cần matchMedia trong jsdom
Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation((q: string) => ({ matches: false, media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
// jsdom chưa hỗ trợ getComputedStyle(elt, pseudoElt) mà rc-util (bảng/modal Ant Design) gọi để đo thanh cuộn
const getComputedStyleOrig = window.getComputedStyle.bind(window);
window.getComputedStyle = (elt: Element) => getComputedStyleOrig(elt);
