import { describe, expect, it } from 'vitest';
import { appTheme, DENSITY, GRID_LOCALE_VI } from '../src/theme.js';

describe('token dày đặc', () => {
  it('antd và AG Grid dùng chung cỡ chữ, cao control, bo góc', () => {
    expect(appTheme.token?.fontSize).toBe(DENSITY.fontSize);
    expect(appTheme.token?.controlHeight).toBe(DENSITY.controlHeight);
    expect(appTheme.token?.borderRadius).toBe(DENSITY.radius);
    expect(DENSITY.rowHeight).toBeLessThanOrEqual(32);
  });
  it('lưới rỗng nói tiếng Việt', () => {
    expect(GRID_LOCALE_VI.noRowsToShow).toBe('Không có dữ liệu');
    expect(GRID_LOCALE_VI.loadingOoo).toBe('Đang tải…');
  });
});
