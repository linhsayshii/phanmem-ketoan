import { describe, expect, it } from 'vitest';
import { visibleMenu, type MenuItem } from '../src/layout/AppLayout.js';

const menu: MenuItem[] = [
  { key: 'a', label: 'A', to: '/a', children: [{ key: 'a1', label: 'A1', to: '/a/1' }, { key: 'a2', label: 'A2', to: '/a/2', permission: 'x.view' }] },
  { key: 'b', label: 'B', to: '/b', children: [{ key: 'b1', label: 'B1', to: '/b/1', permission: 'period.view' }] },
];

describe('menu theo quyền', () => {
  it('ẩn nhóm khi không còn mục con nào hiện', () => {
    expect(visibleMenu(menu, () => false).map((i) => i.key)).toEqual(['a']);
    expect(visibleMenu(menu, () => false)[0]!.children!.map((i) => i.key)).toEqual(['a1']);
  });
  it('hiện nhóm khi còn ít nhất một mục con', () => {
    const v = visibleMenu(menu, (c) => c === 'period.view');
    expect(v.map((i) => i.key)).toEqual(['a', 'b']); expect(v[1]!.children!.map((i) => i.key)).toEqual(['b1']);
  });
});
