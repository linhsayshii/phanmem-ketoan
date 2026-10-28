import type { ThemeConfig } from 'antd';
import { themeQuartz } from 'ag-grid-community';

// Chỗ duy nhất đổi thương hiệu và mật độ: màu nhấn, font, cỡ chữ, cao dòng. Gu "dày đặc dữ liệu" (đã chốt 29/10/2026).
export const DENSITY = { fontSize: 13, controlHeight: 28, rowHeight: 28, headerHeight: 30, radius: 4 } as const;
export const LAYOUT = { headerHeight: 48, siderWidth: 240, padding: 16 } as const;
const PRIMARY = '#1677ff'; // giữ xanh mặc định của antd; đổi màu nhấn ở đây
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const HEADER_BG = '#f5f6f7';
export const BORDER = '#e5e7eb';
export const COLOR = { primary: PRIMARY, border: BORDER, bgLayout: '#f3f4f6', textSecondary: 'rgba(0, 0, 0, 0.55)', surface: '#fff' } as const;

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: PRIMARY,
    fontFamily: FONT,
    fontSize: DENSITY.fontSize,
    controlHeight: DENSITY.controlHeight,
    borderRadius: DENSITY.radius,
    colorBorderSecondary: BORDER,
    colorBgLayout: COLOR.bgLayout,
    colorTextSecondary: COLOR.textSecondary,
  },
  components: {
    Layout: { headerHeight: LAYOUT.headerHeight, headerPadding: '0 16px', headerBg: COLOR.surface, siderBg: COLOR.surface },
    Menu: {
      itemHeight: 32,
      itemMarginBlock: 0,
      subMenuItemBg: COLOR.surface,
      itemHoverBg: '#f3f4f6',
      itemSelectedBg: '#e5e7eb',
      itemSelectedColor: 'rgba(0, 0, 0, 0.88)',
    },
    Table: { cellPaddingBlock: 5, cellPaddingInline: 8, cellPaddingBlockSM: 4, headerBg: HEADER_BG, rowHoverBg: '#f0f5ff', borderColor: BORDER },
    Form: { itemMarginBottom: 12, verticalLabelPadding: '0 0 2px' },
    Tabs: { horizontalMargin: '0 0 8px 0' },
    Card: { paddingLG: 16 },
  },
};

export const gridTheme = themeQuartz.withParams({
  fontFamily: FONT, fontSize: DENSITY.fontSize, rowHeight: DENSITY.rowHeight, headerHeight: DENSITY.headerHeight, spacing: 4,
  borderRadius: DENSITY.radius, wrapperBorderRadius: DENSITY.radius, headerBackgroundColor: HEADER_BG, borderColor: BORDER, accentColor: PRIMARY,
  headerFontWeight: 600, rowHoverColor: '#f0f5ff',
});

export const GRID_LOCALE_VI: Record<string, string> = { noRowsToShow: 'Không có dữ liệu', loadingOoo: 'Đang tải…' };
