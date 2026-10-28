import { describe, expect, it } from 'vitest';
import { MENU, matchMenuRoute } from '../src/layout/menu.js';
import type { MenuItem } from '../src/layout/AppLayout.js';

const leaves = (items: MenuItem[]): MenuItem[] => items.flatMap((i) => (i.children ? leaves(i.children) : [i]));

describe('cấu trúc menu', () => {
  it('mỗi phân hệ cấp 1 có icon, tối đa 18 phân hệ', () => {
    expect(MENU.length).toBeLessThanOrEqual(18);
    for (const g of MENU) expect(g.icon, g.label).toBeTruthy();
  });
  it('không có đường dẫn lá trùng nhau', () => {
    const tos = leaves(MENU).map((i) => i.to);
    expect(tos.filter((t, i) => tos.indexOf(t) !== i)).toEqual([]);
  });
  it('khóa nhóm không trùng nhau và không trùng đường dẫn lá', () => {
    const keys = MENU.map((g) => g.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const tos = new Set(leaves(MENU).map((i) => i.to));
    for (const g of MENU) expect(tos.has(g.key), g.key).toBe(false);
  });
  it('giữ các mục then chốt sau khi nhóm lại (đối chiếu đủ danh sách cũ ở Step 3)', () => {
    const tos = new Set(leaves(MENU).map((i) => i.to));
    for (const to of ['/chung-tu/PT', '/chung-tu/PKT', '/so-cai/cuoi-ky', '/bao-cao/so-sach', '/danh-muc/uom', '/luong/bang-luong', '/thue/bang-ke-hoa-don', '/cong-no/bao-cao', '/tro-ly', '/so-hkd']) expect(tos.has(to), to).toBe(true);
  });
  it('nhãn mà E2E bấm vẫn còn', () => {
    const labels = new Set([...MENU.map((g) => g.label), ...leaves(MENU).map((i) => i.label)]);
    for (const l of ['Thuế', 'Bảng kê hóa đơn', 'Công nợ', 'Báo cáo công nợ']) expect(labels.has(l), l).toBe(true);
  });
});

describe('matchMenuRoute (khớp đường dẫn menu)', () => {
  const sampleMenu: MenuItem[] = [
    { key: 'home', label: 'Tổng quan', to: '/' },
    {
      key: 'tien',
      label: 'Tiền mặt',
      to: '/quy',
      children: [
        { key: 'pt', label: 'Phiếu thu', to: '/chung-tu/PT' },
        { key: 'ct', label: 'Chứng từ chung', to: '/chung-tu' },
      ],
    },
  ];

  it('khớp chính xác trang chủ /', () => {
    const m = matchMenuRoute(sampleMenu, '/');
    expect(m.leaf?.to).toBe('/');
    expect(m.group).toBeNull();
    expect(m.selectedKey).toBe('/');
  });

  it('khớp tiền tố dài nhất khi có nhiều mục con khớp tiền tố', () => {
    const m = matchMenuRoute(sampleMenu, '/chung-tu/PT/moi');
    expect(m.leaf?.to).toBe('/chung-tu/PT');
    expect(m.group?.key).toBe('tien');
    expect(m.selectedKey).toBe('/chung-tu/PT');
  });

  it('khớp tiền tố ngắn hơn khi không khớp mục dài hơn', () => {
    const m = matchMenuRoute(sampleMenu, '/chung-tu/khac');
    expect(m.leaf?.to).toBe('/chung-tu');
    expect(m.group?.key).toBe('tien');
    expect(m.selectedKey).toBe('/chung-tu');
  });

  it('trả về đường dẫn gốc khi không khớp mục nào', () => {
    const m = matchMenuRoute(sampleMenu, '/khong-ton-tai');
    expect(m.leaf).toBeNull();
    expect(m.group).toBeNull();
    expect(m.selectedKey).toBe('/khong-ton-tai');
  });
});
