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
  it('mục có cờ nhạy cảm chỉ hiện khi người dùng có cờ; không truyền hàm cờ thì không lọc theo cờ', () => {
    const m: MenuItem[] = [{ key: 'l', label: 'Lương', to: '/l', children: [{ key: 'l1', label: 'Hồ sơ lương', to: '/l/1', permission: 'payroll.view', flag: 'view_salary' }] }];
    expect(visibleMenu(m, () => true, () => false)).toEqual([]);
    expect(visibleMenu(m, () => true, (f) => f === 'view_salary').map((i) => i.key)).toEqual(['l']);
    expect(visibleMenu(m, () => true).map((i) => i.key)).toEqual(['l']);
  });
});
