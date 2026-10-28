# Đại tu giao diện web — Kế hoạch thực hiện

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Mục tiêu:** Làm lại toàn bộ giao diện `apps/web` theo gu "dày đặc dữ liệu": hệ token chung cho Ant Design 5 và AG Grid, khung app mới (sidebar nhóm, có icon, có ô tìm), mẫu trang dùng chung, rồi đưa mọi màn hình (~100 trang) về mẫu đó. Thứ tự ưu tiên: Chứng từ, Trang chủ, Sổ sách và báo cáo, Danh mục.

**Kiến trúc:** Token và thành phần dùng chung đặt ở `packages/ui`: `theme.ts`, `PageHeader`, `FilterBar`, `RowActions`, `EmptyState`, `CommandPalette`. Khung app nằm ở `apps/web/src/layout`; cấu trúc menu tách khỏi `router.tsx` sang `layout/menu.tsx`. Mỗi màn hình chỉ ráp các thành phần này, không tự đặt style riêng. Bảng danh sách giữ `antd Table`, lưới nhập liệu và báo cáo lớn giữ AG Grid. Hai loại bảng dùng chung token: cao dòng, nền tiêu đề, viền, cỡ chữ.

**Tech stack:** React 18, Vite, Ant Design 5 (`ConfigProvider` theme token), AG Grid 33 (`themeQuartz.withParams`), `@ant-design/icons`, TanStack Router và Query, Vitest + Testing Library, Playwright.

**Đặc tả:** `CLAUDE.md` mục Giao diện. Báo cáo soi UI ở mục "Hiện trạng" dưới đây. Đặc tả nghiệp vụ: `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md`.

## Hướng đã chốt với người dùng (29/10/2026)

| Câu hỏi | Người dùng chọn |
|---|---|
| Phạm vi | **Toàn bộ mọi màn** (~100 trang), không chỉ làm khung |
| Gu | **Dày đặc dữ liệu**: chữ 13px, dòng 28–32px, viền rõ, bo góc nhỏ (4px), mỗi màn thấy được nhiều dòng; gần thói quen MISA/Fast |
| Điều hướng | **Sidebar nhóm + icon + ô tìm**: khoảng 15 phân hệ có icon, tự mở nhóm theo route, tìm chức năng bằng Ctrl+K, thu gọn được |
| Màn làm sâu | **Chứng từ** (danh sách và form), **Trang chủ / tổng quan**, **Sổ sách và báo cáo**, **Danh mục** |
| Quy trình | Phần khung và token (Giai đoạn A) dựng thẳng. Với B–E, người dùng chốt (29/10/2026): **"cứ theo wireframe được khuyên dùng"**. Cổng wireframe của B–E không chờ người dùng chọn: dựng thẳng theo phương án khuyên dùng ở bảng dưới (lối "dựng luôn" của `evon:ui-ux`), lúc giao báo một dòng còn phương án nào khác. |

### Phương án khuyên dùng cho B–E (đã được người dùng chấp nhận)

| Giai đoạn | Phương án | Lý do |
|---|---|---|
| B Chứng từ | **(b)**: đầu form là một dải ngang 4–6 cột (ngày, số, đối tượng, loại tiền…). Ngay dưới là tab Hạch toán/Thuế/Hóa đơn. Thanh tổng tiền dính ở đáy form. Số chứng từ và trạng thái nằm trên hàng tiêu đề của `PageHeader`. | Lưới thấy được nhiều dòng nhất, hợp gu dày đặc. Tổng luôn trong tầm mắt khi nhập. |
| C Trang chủ | Hàng thẻ số liệu (tiền, phải thu, phải trả, doanh thu và lợi nhuận lũy kế). Dưới là hai cột: trái "Việc cần làm" (chờ duyệt, bước cuối kỳ chưa chạy, HĐĐT lỗi), phải "Lối tắt" tới các chứng từ hay dùng. | Mở app là thấy ngay việc phải làm. Chỉ dùng API sẵn có. |
| D Báo cáo | Thanh tham số ở hàng bộ lọc. In/Xuất căn phải. Bảng có dòng tổng ghim. **Số âm trong ngoặc đơn**. Từ khoảng 200 dòng thì dùng `DataGrid`. | Ngoặc đơn là quy ước trình bày báo cáo kế toán, in đen trắng vẫn đọc được. |
| E Danh mục | **(a)**: danh sách cộng `Drawer` sửa bên phải. Hành động dòng dùng `RowActions`. Cờ Khách hàng/NCC/Nhân viên hiện bằng thẻ nhỏ. | Vẫn thấy danh sách khi sửa. Esc đóng, Ctrl+S lưu. |

## Hiện trạng (soi ngày 29/10/2026, khổ 1440, công ty ABC)

Ảnh chụp lưu ngoài repo: `/private/tmp/claude-501/-Users-linhsayshii-Documents-PetProject-phanmem-ketoan/82f6fd86-705c-44b8-8615-79b9e9382a37/scratchpad/ui-soi/shots/`. Script chụp nằm cùng thư mục cha, tên `shoot.mjs`.

| # | Chỗ | Vấn đề | Giải ở |
|---|---|---|---|
| 1 | Menu trái | 27 mục cấp 1, không icon, không ô tìm. Nhóm chứa trang đang mở vẫn đóng: không có `openKeys`. Khóa nhóm trùng khóa mục con (nhóm Kho `to: '/kho/vat-tu'` trùng mục Vật tư; nhóm Bán hàng `to: '/chung-tu/HDB'` trùng mục HDB). Đơn vị tính nằm ở hai nhóm. Khế ước, Hợp đồng nằm lẻ ở cấp 1. | A2, A3 |
| 2 | Header | Không có breadcrumb, không có lối đổi công ty, không có menu người dùng. Tên công ty nằm lệch trong sider. | A4 |
| 3 | Trang chủ | Chỉ có dòng chữ "Chọn chức năng ở menu trái." | C |
| 4 | Bảng | 66 trang dùng `antd Table`, 40 trang dùng AG Grid, hai kiểu khác nhau. Dòng cao khoảng 42px nên một màn chỉ thấy khoảng 14 dòng. | A1 |
| 5 | Lưới rỗng | AG Grid hiện "No Rows To Show" bằng tiếng Anh. | A1 |
| 6 | Form chứng từ | Ô nhập xếp thưa. Tiêu đề cột lưới bị cắt ("TK doanh thu …", "% chiết k…", một cột chỉ còn "["). Giá trị bị cắt ("VND - Đồng Việt N…", "Chọn thời đi…"). Số chứng từ và tổng tiền không nổi bật. | B |
| 7 | Danh mục | Mỗi dòng lặp ba link "Sửa / Ngưng dùng / Xóa", chữ Xóa đỏ ở mọi dòng. Cột mã số thuế bị cắt. | A5, E |
| 8 | Thanh công cụ | Tiêu đề, bộ lọc và nút dồn trên một hàng, xuống dòng tùy trang (ví dụ màn BCTC). | A5 |
| 9 | Hệ thị giác | Không có token. Có 886 `style={{…}}` inline và màu viết cứng (`#cf1322`, `#d46b08`, `#667085`, `#999`…). | A1, F |
| 10 | Nhỏ | Biểu đồ dùng dấu chấm thập phân ("845.8 tr"). Nhãn nút kèm phím tắt ("Thêm (Insert)") ở mọi trang. | D, A5 |

## Global Constraints

- Giữ Ant Design 5 và AG Grid 33. Không thêm Tailwind, không thêm thư viện UI khác. `@ant-design/icons` đã có trong `apps/web`.
- Nhập liệu bằng bàn phím là cốt lõi: Enter/Tab, F4, Ctrl+S, F9, Insert, Delete trên lưới chung `KeyboardGrid` phải giữ nguyên hành vi. Không đổi `gridKeyAction` trong `@kt/domain`.
- Thành phần dùng chung đặt ở `packages/ui`, xuất qua `packages/ui/src/index.ts`. Trang không tự viết lại.
- Giao diện, nhãn, thông báo dùng tiếng Việt kế toán chuẩn. Mã, tên biến dùng tiếng Anh như hiện có.
- Tiền là chuỗi thập phân. Hiển thị số theo kiểu Việt Nam (`1.234.567`, thập phân dùng dấu phẩy) qua hàm có sẵn trong `@kt/domain`. Không đổi logic định dạng trong đợt này, trừ mục D.
- Cờ nhạy cảm (`view_salary`, `view_cost`…) vẫn lọc menu qua `visibleMenu`. API vẫn chặn như cũ.
- Không dark mode (dự án chưa có, `M20`).
- Mỗi màn làm lại có ít nhất một kiểm thử Playwright cho luồng chính. Spec hiện có phải xanh sau mỗi đợt.
- Chỉ một chỗ đổi thương hiệu: `packages/ui/src/theme.ts` (màu nhấn, font, cỡ chữ).
- Commit nhỏ theo Conventional Commits, mô tả tiếng Việt, trailer `Co-Authored-By` của model viết commit.

## Điều kiện trước khi bắt đầu viết mã

- [ ] `git status`: không còn thay đổi chưa commit của phiên sửa lỗi E2E trong `apps/web`, `packages/ui`, `docs/TIEP-THEO.md`. Nếu còn, hỏi người dùng, không tự commit hay stash.
- [ ] Không có bộ E2E hay kiểm thử bất biến nào khác đang chạy.
- [ ] DB phát triển Mac: Postgres container `ketoan-gd7-pg` cổng 5441 (không phải 5432). Server chạy bằng `preview_start` tên `api` rồi `web`, cấu hình trong `.claude/launch.json`.

## Cấu trúc tệp

| Tệp | Trách nhiệm |
|---|---|
| `packages/ui/src/theme.ts` (mới) | `appTheme` (ThemeConfig của antd), `gridTheme` (theme AG Grid), `GRID_LOCALE_VI`. Chỗ duy nhất chứa màu nhấn, font, cỡ chữ, cao dòng |
| `packages/ui/src/KeyboardGrid.tsx` | Dùng `gridTheme` và `GRID_LOCALE_VI` thay cho `themeQuartz` trần |
| `packages/ui/src/DataGrid.tsx` (mới) | AG Grid chỉ đọc cho báo cáo lớn, cùng theme và locale |
| `packages/ui/src/PageHeader.tsx` (mới) | Đầu trang: tiêu đề, thẻ trạng thái, nút bên phải; hàng bộ lọc riêng bên dưới |
| `packages/ui/src/RowActions.tsx` (mới) | Hành động dòng: một hành động chính, các hành động khác gom vào nút "⋯" |
| `packages/ui/src/EmptyState.tsx` (mới) | Trạng thái rỗng thống nhất |
| `packages/ui/src/CommandPalette.tsx` (mới) | Hộp tìm chức năng (Ctrl+K), không biết gì về router |
| `packages/ui/src/menuSearch.ts` (mới) | Hàm thuần: bỏ dấu tiếng Việt, khớp từ khóa |
| `apps/web/src/layout/menu.tsx` (mới) | `MENU` đã nhóm lại kèm icon (chuyển từ `router.tsx`), `openKeysFor`, `selectedKeyFor`, `flattenMenu`, `breadcrumbFor` |
| `apps/web/src/layout/AppLayout.tsx` | Sider thu gọn được, header mới (breadcrumb, công ty, người dùng), gắn `CommandPalette` |
| `apps/web/src/main.tsx` | `ConfigProvider theme={appTheme}` |
| `apps/web/src/router.tsx` | Import `MENU` từ `layout/menu.tsx`; route `/` trỏ trang Tổng quan |

---

## Giai đoạn A — Hệ token và khung app (dựng thẳng, hướng đã chốt)

### Task A1: Token dày đặc cho antd và AG Grid, lưới rỗng tiếng Việt

**Files:**
- Create: `packages/ui/src/theme.ts`
- Modify: `packages/ui/src/KeyboardGrid.tsx` (dòng import `themeQuartz` và prop `theme={themeQuartz}`)
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `packages/ui/test/theme.test.ts`, `packages/ui/test/KeyboardGrid.test.tsx`

**Interfaces:**
- Produces: `appTheme: ThemeConfig`, `gridTheme` (kết quả `themeQuartz.withParams`), `GRID_LOCALE_VI: Record<string, string>`, `DENSITY = { fontSize: 13, controlHeight: 28, rowHeight: 28, headerHeight: 30, radius: 4 }`.

- [ ] **Step 1: Viết kiểm thử hỏng**

```ts
// packages/ui/test/theme.test.ts
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
```

Thêm vào `packages/ui/test/KeyboardGrid.test.tsx`:

```tsx
it('lưới rỗng hiện chữ tiếng Việt', async () => {
  const { findByText } = render(<Harness initial={[]} />);
  expect(await findByText('Không có dữ liệu')).toBeInTheDocument();
});
```

- [ ] **Step 2: Chạy, thấy hỏng**

Run: `pnpm -F @kt/ui test -- test/theme.test.ts test/KeyboardGrid.test.tsx`
Expected: FAIL, "Cannot find module '../src/theme.js'" và không tìm thấy "Không có dữ liệu".

- [ ] **Step 3: Viết mã**

```ts
// packages/ui/src/theme.ts
import type { ThemeConfig } from 'antd';
import { themeQuartz } from 'ag-grid-community';

// Chỗ duy nhất đổi thương hiệu và mật độ: màu nhấn, font, cỡ chữ, cao dòng. Gu "dày đặc dữ liệu" (đã chốt 29/10/2026).
export const DENSITY = { fontSize: 13, controlHeight: 28, rowHeight: 28, headerHeight: 30, radius: 4 } as const;
const PRIMARY = '#1677ff'; // giữ xanh mặc định của antd; đổi màu nhấn ở đây
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const HEADER_BG = '#f5f6f7'; const BORDER = '#e5e7eb';

export const appTheme: ThemeConfig = {
  token: { colorPrimary: PRIMARY, fontFamily: FONT, fontSize: DENSITY.fontSize, controlHeight: DENSITY.controlHeight, borderRadius: DENSITY.radius, colorBorderSecondary: BORDER, colorBgLayout: '#f3f4f6' },
  components: {
    Layout: { headerHeight: 48, headerPadding: '0 16px', headerBg: '#fff', siderBg: '#fff' },
    Menu: { itemHeight: 32, itemMarginBlock: 0, subMenuItemBg: '#fff' },
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
```

Trong `KeyboardGrid.tsx`: bỏ `themeQuartz` khỏi import `ag-grid-community`, thêm `import { gridTheme, GRID_LOCALE_VI } from './theme.js';`, đổi `theme={themeQuartz}` thành `theme={gridTheme} localeText={GRID_LOCALE_VI}`.

`packages/ui/src/index.ts` thêm `export * from './theme.js';`.

`apps/web/src/main.tsx`: `import { appTheme } from '@kt/ui';` và `<ConfigProvider locale={viVN} theme={appTheme}>`.

- [ ] **Step 4: Chạy, thấy đạt**

Run: `pnpm -F @kt/ui test && pnpm -F @kt/web test && pnpm typecheck`
Expected: PASS. Nếu có kiểm thử trong `apps/web/test` đo theo "No Rows To Show", đổi sang "Không có dữ liệu".

- [ ] **Step 5: Kiểm bằng mắt**

Chạy `node <scratchpad>/ui-soi/shoot.mjs <thư mục mới>`. So `08-so-sach.png` và `06-danh-muc-doi-tuong.png` với ảnh cũ. Tiêu chí: thấy ít nhất 22 dòng ở khổ 900px cao, tiêu đề bảng antd và AG Grid cùng nền và cùng cao.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/theme.ts packages/ui/src/KeyboardGrid.tsx packages/ui/src/index.ts packages/ui/test/theme.test.ts packages/ui/test/KeyboardGrid.test.tsx apps/web/src/main.tsx
git commit -m "feat(ui): token dày đặc chung cho antd và AG Grid, lưới rỗng tiếng Việt"
```

### Task A2: Nhóm lại menu thành phân hệ có icon, khóa không trùng

**Files:**
- Create: `apps/web/src/layout/menu.tsx`
- Modify: `apps/web/src/router.tsx` (bỏ `VOUCHER_MENU_TYPES`, `voucherItem`, `MENU` ở dòng 85–227, import từ `./layout/menu.js`)
- Modify: `apps/web/src/layout/AppLayout.tsx` (`MenuItem` thêm `icon?`)
- Test: `apps/web/test/menu.test.ts`

**Interfaces:**
- Produces: `MENU: MenuItem[]`; `MenuItem` có thêm `icon?: React.ReactNode`. Quy ước: khóa của antd Menu cho nhóm là `group:<key>`, cho mục là `to`.

Nhóm đề xuất. Nhãn mục con giữ nguyên chữ hiện có, để `bang-ke-thue.spec.ts` và `cong-no.spec.ts` (bấm `menuitem` "Thuế", "Bảng kê hóa đơn", "Công nợ", "Báo cáo công nợ") vẫn chạy.

| Phân hệ (icon) | Mục |
|---|---|
| Tổng quan (`HomeOutlined`) | `/` (mục lá) |
| Tiền mặt, ngân hàng (`WalletOutlined`) | PT, PC, BC, BN, CT; Kiểm kê quỹ; Giao dịch ngân hàng; Kết nối ngân hàng |
| Mua hàng (`ShoppingCartOutlined`) | như nhóm Mua hàng hiện tại |
| Bán hàng (`ShopOutlined`) | như nhóm Bán hàng hiện tại |
| Hóa đơn điện tử (`FileTextOutlined`) | như hiện tại |
| Kho (`InboxOutlined`) | như hiện tại, bỏ Đơn vị tính (đã có ở Danh mục) |
| Tài sản (`DesktopOutlined`) | như hiện tại |
| Lương (`TeamOutlined`) | như hiện tại |
| Giá thành (`CalculatorOutlined`) | như hiện tại |
| Hợp đồng, khế ước (`SolutionOutlined`) | Khế ước vay; Hợp đồng; Báo cáo hợp đồng, vụ việc; Phân bổ chi phí vào vụ việc |
| Công nợ (`SwapOutlined`) | như hiện tại, thêm Bù trừ công nợ (BT) |
| Thuế (`PercentageOutlined`) | như hiện tại |
| Tổng hợp (`BookOutlined`) | Phiếu kế toán (PKT); Quyết toán tạm ứng (QTU); Nhập chứng từ từ Excel; các mục của nhóm Sổ cái hiện tại |
| Báo cáo (`BarChartOutlined`) | như hiện tại; Phân tích tài chính; Ngân sách; Sổ HKD, siêu nhỏ |
| Phê duyệt (`AuditOutlined`) | như hiện tại |
| Danh mục (`DatabaseOutlined`) | như hiện tại |
| Hệ thống (`SettingOutlined`) | các mục Hệ thống hiện tại; các mục Tiện ích; Trợ lý |

- [ ] **Step 1: Viết kiểm thử hỏng**

```ts
// apps/web/test/menu.test.ts
import { describe, expect, it } from 'vitest';
import { MENU } from '../src/layout/menu.js';
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
  it('giữ các mục then chốt sau khi nhóm lại (đối chiếu đủ danh sách cũ ở Step 3)', () => {
    const tos = new Set(leaves(MENU).map((i) => i.to));
    for (const to of ['/chung-tu/PT', '/chung-tu/PKT', '/so-cai/cuoi-ky', '/bao-cao/so-sach', '/danh-muc/uom', '/luong/bang-luong', '/thue/bang-ke-hoa-don', '/cong-no/bao-cao', '/tro-ly', '/so-hkd']) expect(tos.has(to), to).toBe(true);
  });
  it('nhãn mà E2E bấm vẫn còn', () => {
    const labels = new Set([...MENU.map((g) => g.label), ...leaves(MENU).map((i) => i.label)]);
    for (const l of ['Thuế', 'Bảng kê hóa đơn', 'Công nợ', 'Báo cáo công nợ']) expect(labels.has(l), l).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy, thấy hỏng**

Run: `pnpm -F @kt/web test -- test/menu.test.ts`
Expected: FAIL, "Cannot find module '../src/layout/menu.js'".

- [ ] **Step 3: Viết mã**

Chuyển nguyên `VOUCHER_MENU_TYPES`, `voucherItem`, `MENU` sang `layout/menu.tsx`, sắp lại theo bảng trên, thêm `icon: <XOutlined />` cho từng phân hệ. Trước khi bỏ khỏi `router.tsx`, chép danh sách `to` cũ bằng `grep -o "to: '[^']*'" apps/web/src/router.tsx | sort -u > /tmp/menu-cu.txt`. Sau khi chuyển, so với `MENU` mới: chỉ được thiếu `/danh-muc/uom` bản lặp ở nhóm Kho. `router.tsx` dùng `import { MENU } from './layout/menu.js';`.

- [ ] **Step 4: Chạy, thấy đạt**

Run: `pnpm -F @kt/web test -- test/menu.test.ts test/AppLayout.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/layout/menu.tsx apps/web/src/layout/AppLayout.tsx apps/web/src/router.tsx apps/web/test/menu.test.ts
git commit -m "refactor(web): nhóm menu thành phân hệ có icon, tách khỏi router"
```

### Task A3: Sidebar tự mở theo route, thu gọn được

**Files:**
- Modify: `apps/web/src/layout/menu.tsx` (thêm hàm)
- Modify: `apps/web/src/layout/AppLayout.tsx`
- Test: `apps/web/test/menu.test.ts`

**Interfaces:**
- Produces: `selectedKeyFor(items: MenuItem[], path: string): string | undefined`. Hàm trả `to` khớp dài nhất, khớp khi `path === to` hoặc `path.startsWith(to + '/')`.
- Produces: `openKeysFor(items: MenuItem[], path: string): string[]`. Hàm trả `group:<key>` của các nhóm chứa mục được chọn.
- Produces: `breadcrumbFor(items: MenuItem[], path: string): string[]`, ví dụ `['Tiền mặt, ngân hàng', 'Phiếu thu']`.

- [ ] **Step 1: Viết kiểm thử hỏng** (thêm vào `menu.test.ts`)

```ts
import { breadcrumbFor, openKeysFor, selectedKeyFor } from '../src/layout/menu.js';

const m: MenuItem[] = [
  { key: 'tien', label: 'Tiền', to: '/tien', children: [{ key: 'pt', label: 'Phiếu thu', to: '/chung-tu/PT' }, { key: 'pt2', label: 'Phiếu thu khác', to: '/chung-tu/PT2' }] },
  { key: 'home', label: 'Tổng quan', to: '/' },
];
describe('menu theo route', () => {
  it('trang con của chứng từ chọn đúng mục danh sách', () => {
    expect(selectedKeyFor(m, '/chung-tu/PT/moi')).toBe('/chung-tu/PT');
    expect(selectedKeyFor(m, '/chung-tu/PT2')).toBe('/chung-tu/PT2'); // không khớp nhầm tiền tố "/chung-tu/PT"
    expect(selectedKeyFor(m, '/')).toBe('/');
  });
  it('mở nhóm chứa mục đang chọn', () => {
    expect(openKeysFor(m, '/chung-tu/PT/123')).toEqual(['group:tien']);
    expect(openKeysFor(m, '/')).toEqual([]);
  });
  it('breadcrumb theo phân hệ và mục', () => {
    expect(breadcrumbFor(m, '/chung-tu/PT/moi')).toEqual(['Tiền', 'Phiếu thu']);
  });
});
```

- [ ] **Step 2: Chạy, thấy hỏng.** Run: `pnpm -F @kt/web test -- test/menu.test.ts`. Expected: FAIL, export không tồn tại.

- [ ] **Step 3: Viết mã**

```ts
// trong apps/web/src/layout/menu.tsx
const matches = (path: string, to: string) => path === to || (to !== '/' && path.startsWith(to + '/'));
const trail = (items: MenuItem[], path: string, parents: MenuItem[] = []): MenuItem[] | undefined => {
  let best: MenuItem[] | undefined;
  for (const i of items) {
    const t = i.children ? trail(i.children, path, [...parents, i]) : matches(path, i.to) ? [...parents, i] : undefined;
    if (t && (!best || t[t.length - 1]!.to.length > best[best.length - 1]!.to.length)) best = t;
  }
  return best;
};
export const selectedKeyFor = (items: MenuItem[], path: string) => trail(items, path)?.at(-1)?.to;
export const openKeysFor = (items: MenuItem[], path: string) => (trail(items, path) ?? []).slice(0, -1).map((g) => `group:${g.key}`);
export const breadcrumbFor = (items: MenuItem[], path: string) => (trail(items, path) ?? []).map((i) => i.label);
```

Trong `AppLayout.tsx`:
- `toAntd` dùng `key: i.children ? \`group:${i.key}\` : i.to` và `icon: i.icon`.
- Menu dùng `selectedKeys={[selectedKeyFor(menu, path) ?? path]}` và `openKeys` có điều khiển. Khởi tạo bằng `openKeysFor`; khi `path` đổi thì gộp thêm nhóm mới; khi người dùng bấm thì cập nhật qua `onOpenChange`.
- `Layout.Sider` thêm `collapsible`, `collapsedWidth={56}`, `width={232}`. Giữ trạng thái thu gọn trong `localStorage` khóa `kt.sider.collapsed`, đọc và ghi đều bọc `try/catch`.
- Khối đầu sider là tên công ty, cao 48px, cùng hàng với header.

- [ ] **Step 4: Chạy, thấy đạt.** Run: `pnpm -F @kt/web test && pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: E2E khung app**

```ts
// apps/web/e2e/khung-app.spec.ts
import { expect, test, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy (như các spec khác): pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
async function login(page: Page) {
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('vào thẳng phiếu thu mới thì menu mở đúng phân hệ và tô đúng mục', async ({ page }) => {
  await login(page);
  await page.goto('/chung-tu/PT/moi');
  await expect(page.getByRole('menuitem', { name: 'Phiếu thu' })).toBeVisible();
  await expect(page.locator('.ant-menu-item-selected')).toContainText('Phiếu thu');
});
```

Run: `pnpm -F @kt/web e2e -- e2e/khung-app.spec.ts` (chỉ khi không có bộ E2E khác đang chạy). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/layout apps/web/test/menu.test.ts apps/web/e2e/khung-app.spec.ts
git commit -m "feat(web): sidebar tự mở theo route, thu gọn còn icon"
```

### Task A4: Header mới: breadcrumb, công ty, người dùng

**Files:**
- Modify: `apps/web/src/layout/AppLayout.tsx`
- Test: `apps/web/test/AppLayout.test.ts` chỉ kiểm hàm thuần; luồng kiểm bằng `apps/web/e2e/khung-app.spec.ts`

Bố cục header, cao 48px, từ trái sang phải:
- Breadcrumb (`breadcrumbFor`), chữ phụ màu `colorTextSecondary`.
- Khoảng giãn.
- Nút "Tìm chức năng (Ctrl+K)" (Task A6).
- `ApprovalBadge`.
- Tên công ty kèm link "Đổi công ty" tới `/chon-cong-ty`.
- `Dropdown` người dùng (`username`), mục "Đăng xuất" giữ nguyên handler cũ.

- [ ] **Step 1:** Thêm vào `khung-app.spec.ts`:

```ts
test('header có breadcrumb và menu người dùng', async ({ page }) => {
  await login(page);
  await page.goto('/bao-cao/so-sach');
  await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('Sổ sách kế toán');
  await page.getByRole('button', { name: 'e2e' }).click();
  await expect(page.getByRole('menuitem', { name: 'Đăng xuất' })).toBeVisible();
});
```

- [ ] **Step 2:** Chạy, thấy hỏng. Run: `pnpm -F @kt/web e2e -- e2e/khung-app.spec.ts`
- [ ] **Step 3:** Viết header theo bố cục trên. `Breadcrumb` của antd có `aria-label="breadcrumb"` trên thẻ `nav`. Nút người dùng là `<Button type="text">{me?.username}</Button>` bọc trong `Dropdown menu={{ items: [{ key: 'logout', label: 'Đăng xuất', onClick }] }}`.
- [ ] **Step 4:** Chạy, thấy đạt. Kiểm lại toàn bộ spec dùng link "Đăng xuất": `grep -l "Đăng xuất" apps/web/e2e/*.ts`, sửa chúng mở dropdown trước khi bấm.
- [ ] **Step 5:** Commit `feat(web): header có breadcrumb, đổi công ty, menu người dùng`.

### Task A5: Thành phần trang dùng chung: PageHeader, FilterBar, RowActions, EmptyState

**Files:**
- Create: `packages/ui/src/PageHeader.tsx`, `packages/ui/src/RowActions.tsx`, `packages/ui/src/EmptyState.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/PageHeader.test.tsx`, `packages/ui/test/RowActions.test.tsx`

**Interfaces:**
- Lưu ý E2E: nhiều spec tìm `getByRole('heading', { name: '<tên trang>' })`. `PageHeader` render tiêu đề là heading nên vẫn khớp; không đổi chữ tiêu đề trang.
- Produces: `PageHeader({ title, status?, actions?, filters? })`. Hàng 1 là tiêu đề (cỡ 16, đậm 600), thẻ trạng thái, nút căn phải. Hàng 2 là `filters`, chỉ hiện khi có. Không bao giờ dồn bộ lọc và nút vào một hàng.
- Produces: `RowActions({ primary?: Action, more?: Action[] })` với `Action = { key: string; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }`. `primary` là link chữ. `more` gom vào `Dropdown` mở bằng nút "⋯" (`aria-label="Thao tác khác"`). Mục `danger` chỉ đỏ trong menu thả xuống, không đỏ trên dòng.
- Produces: `EmptyState({ title, hint?, action? })`.
- Produces: `hotkeyHint(label: string, key: string)`. Hàm hiện phím tắt bằng `Tooltip` và thẻ `<kbd>` nhỏ cạnh nhãn, không nhét vào chữ nút. E2E đang bấm theo tên nút có phím (ví dụ `'Thêm (Insert)'`) thì giữ `aria-label` cũ đến khi spec được sửa ở giai đoạn của màn đó.

- [ ] **Step 1: Viết kiểm thử hỏng**

```tsx
// packages/ui/test/RowActions.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowActions } from '../src/RowActions.js';

describe('RowActions', () => {
  it('chỉ hiện hành động chính trên dòng, các hành động khác nằm trong menu ⋯', async () => {
    const del = vi.fn();
    render(<RowActions primary={{ key: 'edit', label: 'Sửa', onClick: vi.fn() }} more={[{ key: 'off', label: 'Ngưng dùng', onClick: vi.fn() }, { key: 'del', label: 'Xóa', onClick: del, danger: true }]} />);
    expect(screen.getByText('Sửa')).toBeVisible();
    expect(screen.queryByText('Xóa')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác khác' }));
    await userEvent.click(await screen.findByText('Xóa'));
    expect(del).toHaveBeenCalledOnce();
  });
});
```

```tsx
// packages/ui/test/PageHeader.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '../src/PageHeader.js';

describe('PageHeader', () => {
  it('tiêu đề là heading cấp 1, bộ lọc nằm ở hàng riêng', () => {
    render(<PageHeader title="Phiếu thu" actions={<button>Thêm</button>} filters={<input aria-label="Tìm" />} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Phiếu thu' })).toBeInTheDocument();
    expect(screen.getByRole('search')).toContainElement(screen.getByLabelText('Tìm'));
  });
});
```

- [ ] **Step 2:** Run `pnpm -F @kt/ui test -- test/RowActions.test.tsx test/PageHeader.test.tsx`. Expected: FAIL, module không tồn tại.

- [ ] **Step 3: Viết mã**

```tsx
// packages/ui/src/RowActions.tsx
import { Button, Dropdown, Space, Typography } from 'antd';

export interface Action { key: string; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }

// Hành động trên dòng bảng: một hành động chính bằng chữ, phần còn lại trong menu "⋯" để dòng không nhiễu (không lặp chữ Xóa đỏ ở mọi dòng).
export function RowActions({ primary, more = [] }: { primary?: Action; more?: Action[] }) {
  return (
    <Space size={4}>
      {primary && <Typography.Link disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</Typography.Link>}
      {more.length > 0 && (
        <Dropdown trigger={['click']} menu={{ items: more.map((a) => ({ key: a.key, label: a.label, danger: a.danger, disabled: a.disabled })), onClick: ({ key }) => more.find((a) => a.key === key)?.onClick() }}>
          <Button type="text" size="small" aria-label="Thao tác khác">⋯</Button>
        </Dropdown>
      )}
    </Space>
  );
}
```

```tsx
// packages/ui/src/PageHeader.tsx
import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';

// Đầu trang thống nhất: hàng tiêu đề (trạng thái, nút bên phải) và hàng bộ lọc riêng, không dồn chung một hàng.
export function PageHeader({ title, status, actions, filters }: { title: ReactNode; status?: ReactNode; actions?: ReactNode; filters?: ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <Flex align="center" gap={8} style={{ minHeight: 32 }}>
        <Typography.Title level={1} style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{title}</Typography.Title>
        {status}
        <Flex gap={8} style={{ marginLeft: 'auto' }}>{actions}</Flex>
      </Flex>
      {filters && <Flex role="search" wrap gap={8} align="center" style={{ marginTop: 8 }}>{filters}</Flex>}
    </div>
  );
}
```

```tsx
// packages/ui/src/EmptyState.tsx
import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <Flex vertical align="center" gap={4} style={{ padding: '32px 16px' }}>
      <Typography.Text strong>{title}</Typography.Text>
      {hint && <Typography.Text type="secondary">{hint}</Typography.Text>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </Flex>
  );
}
```

`index.ts` thêm ba dòng `export *`.

- [ ] **Step 4:** Run `pnpm -F @kt/ui test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ui): PageHeader, RowActions, EmptyState dùng chung`.

### Task A6: Tìm chức năng Ctrl+K

**Files:**
- Create: `packages/ui/src/menuSearch.ts`, `packages/ui/src/CommandPalette.tsx`
- Modify: `apps/web/src/layout/menu.tsx` (thêm `flattenMenu`), `apps/web/src/layout/AppLayout.tsx`
- Test: `packages/ui/test/menuSearch.test.ts`, `packages/ui/test/CommandPalette.test.tsx`, `apps/web/e2e/khung-app.spec.ts`

**Interfaces:**
- Produces: `fold(s: string): string`. Hàm chuyển về chữ thường, bỏ dấu, đổi `đ` thành `d`.
- Produces: `searchItems<T extends { label: string; group?: string }>(items: T[], q: string): T[]`. Mọi từ trong `q` phải khớp với `label` hoặc `group` đã `fold`. Mục khớp từ đầu nhãn xếp trước.
- Produces: `CommandPalette({ open, onClose, items: { key: string; label: string; group?: string }[], onSelect: (key: string) => void })`. Lên/xuống để chọn, Enter để mở, Esc để đóng.
- Produces: `flattenMenu(items: MenuItem[]): { key: string; label: string; group?: string }[]`, trong đó `key` là `to`.

- [ ] **Step 1: Viết kiểm thử hỏng**

```ts
// packages/ui/test/menuSearch.test.ts
import { describe, expect, it } from 'vitest';
import { fold, searchItems } from '../src/menuSearch.js';

const items = [{ label: 'Phiếu thu', group: 'Tiền mặt, ngân hàng' }, { label: 'Đối tượng', group: 'Danh mục' }, { label: 'Bảng cân đối số phát sinh', group: 'Báo cáo' }];
describe('tìm chức năng', () => {
  it('gõ không dấu vẫn khớp', () => {
    expect(fold('Đối tượng')).toBe('doi tuong');
    expect(searchItems(items, 'doi tuong').map((i) => i.label)).toEqual(['Đối tượng']);
  });
  it('mọi từ phải khớp, tính cả tên nhóm', () => {
    expect(searchItems(items, 'phieu tien').map((i) => i.label)).toEqual(['Phiếu thu']);
    expect(searchItems(items, 'phieu bao')).toEqual([]);
  });
  it('chuỗi rỗng trả hết', () => { expect(searchItems(items, '  ')).toHaveLength(3); });
});
```

- [ ] **Step 2:** Run `pnpm -F @kt/ui test -- test/menuSearch.test.ts`. Expected: FAIL.

- [ ] **Step 3: Viết mã**

```ts
// packages/ui/src/menuSearch.ts
// Bỏ dấu tiếng Việt để gõ "doi tuong" tìm ra "Đối tượng".
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

export function searchItems<T extends { label: string; group?: string }>(items: T[], q: string): T[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored = items.map((i) => ({ i, l: fold(i.label), all: `${fold(i.label)} ${fold(i.group ?? '')}` }))
    .filter((x) => words.every((w) => x.all.includes(w)));
  return scored.sort((a, b) => Number(!a.l.startsWith(words[0]!)) - Number(!b.l.startsWith(words[0]!))).map((x) => x.i);
}
```

`CommandPalette.tsx` gồm `Modal` (không footer, `destroyOnHidden`) chứa `Input` tự focus và danh sách tối đa 12 kết quả. Mỗi dòng có nhãn và tên nhóm bằng chữ phụ. Dòng đang chọn tô nền `controlItemBgActive`. Kiểm thử Testing Library: gõ "doi", bấm ArrowDown rồi Enter, thì `onSelect` được gọi với đúng `key`.

Trong `AppLayout`: tự đăng ký `keydown` cho `Ctrl+K` / `Cmd+K`, không dùng `useHotkeys`. Lý do: `useHotkeys` bỏ qua phím khi tiêu điểm đang ở ô nhập, mà Ctrl+K phải mở được từ mọi chỗ. Bỏ qua khi đang soạn chữ (`isImeComposing`). `onSelect` gọi `navigate({ to: key })`. Danh sách lấy từ `flattenMenu(visibleMenu(...))`, nên mục không có quyền không hiện ra.

- [ ] **Step 4:** E2E thêm vào `khung-app.spec.ts`: bấm `ControlOrMeta+k`, gõ `bang can doi`, Enter, rồi kiểm URL là `/bao-cao/so-sach`. Run: `pnpm -F @kt/ui test && pnpm -F @kt/web e2e -- e2e/khung-app.spec.ts`.
- [ ] **Step 5:** Commit `feat(web): tìm chức năng bằng Ctrl+K, gõ không dấu`.

### Task A7: Nghiệm thu giai đoạn A

- [ ] `pnpm lint && pnpm typecheck && pnpm test` xanh.
- [ ] Chạy đủ bộ E2E một lần (`pnpm -F @kt/web e2e`), không chạy song song với bộ khác. Spec hỏng vì đổi cao dòng hay nhãn nút thì sửa spec. Hành vi phím mà hỏng thì đó là lỗi, phải sửa mã.
- [ ] Chụp lại 20 màn bằng `shoot.mjs`, đặt cạnh ảnh cũ trong một trang `so-sanh.html` ở scratchpad. Gửi người dùng xem.
- [ ] Ghi quyết định vào `docs/superpowers/plans/2026-10-29-dai-tu-giao-dien-quyet-dinh.md`.

---

## Giai đoạn B — Chứng từ: danh sách và form (qua cổng wireframe)

Phạm vi: `VoucherList.tsx`, `VoucherForm.tsx`, `InvoiceForm.tsx`, `StockVoucher.tsx`, `AssemblyVoucher.tsx`, `voucherCommon.tsx`, `VoucherBranchField.tsx`.

- [ ] **B0 — Cổng thiết kế (`evon:ui-ux` nhánh `U`).** Viết brief: việc chính của màn là nhập nhanh bằng bàn phím và ghi sổ. Dựng 2–3 wireframe tĩnh có dữ liệu thật của ABC cho form Phiếu chi và Hóa đơn bán. Các hướng:
  - (a) Đầu form gọn hai cột trái/phải, khối tổng tiền dính ở đáy.
  - (b) Đầu form một dải ngang 4–6 cột, tab Hạch toán/Thuế/Hóa đơn ngay dưới, tổng ở thanh trạng thái.
  - (c) Kiểu MISA: thanh công cụ trên (Thêm, Sửa, Lưu, Ghi sổ, In, Trước/Sau), số chứng từ và ngày ở góc phải.

  Người dùng chọn, rồi mới viết kế hoạch chi tiết `2026-xx-xx-dai-tu-chung-tu-chi-tiet.md` theo khuôn giai đoạn A.
- Việc phải có trong kế hoạch chi tiết:
  - Số chứng từ, trạng thái, tổng tiền nổi bật.
  - Cột lưới có `minWidth` và `headerTooltip` để tiêu đề không bị cắt vô nghĩa.
  - Select loại tiền chỉ hiện mã (`VND`), tên đầy đủ để trong tooltip.
  - Nút Lưu/Ghi sổ giữ `aria-label` có phím tắt.
  - Danh sách: dùng `PageHeader` và `FilterBar`, cột số căn phải, tổng ở chân bảng, mở chứng từ bằng Enter hoặc nhấp đúp.
  - Kỳ lọc mặc định phải ra dữ liệu: tháng hiện tại; nếu rỗng thì `EmptyState` gợi ý "Xem tháng trước".
- Nghiệm thu: mọi spec chứng từ, hóa đơn, kho hiện có xanh; thêm ít nhất một spec gõ trọn một phiếu chỉ bằng bàn phím trên form mới.

## Giai đoạn C — Trang chủ / Tổng quan (qua cổng wireframe)

- [ ] **C0 — Cổng thiết kế.** Hiện route `/` chỉ có một dòng chữ. Brief cho trang Tổng quan:
  - Thẻ số liệu: tiền, phải thu, phải trả, doanh thu và lợi nhuận lũy kế (dùng lại API của `Analytics.tsx`).
  - Việc cần làm: chờ duyệt, bước cuối kỳ chưa chạy (API `PeriodClose`), hóa đơn điện tử lỗi.
  - Lối tắt tới các chứng từ hay dùng.

  Dựng 2 wireframe, người dùng chọn. Thẻ và số liệu chỉ lấy từ API sẵn có, không thêm API mới nếu chưa bàn. Cờ nhạy cảm vẫn chặn ở API, thẻ nào bị chặn thì ẩn.
- Nghiệm thu: spec `tong-quan.spec.ts` đăng nhập vào là thấy thẻ số liệu của ABC; người dùng không có `report.view` thì không thấy thẻ báo cáo.

## Giai đoạn D — Sổ sách và báo cáo (qua cổng wireframe)

Phạm vi: `Ledgers.tsx`, `BookForms.tsx`, `CashBooks.tsx`, `Financial.tsx`, `ArapReports.tsx`, `StockReports.tsx`, `AssetReports.tsx`, `PayrollReports.tsx`, `CostReports.tsx`, `SalesPurchaseReports.tsx`, `ContractReports.tsx`, `InvoiceRegister.tsx`, `VatReturn.tsx`, `CitEstimate.tsx`, `CitReturn.tsx`, `Analytics.tsx`, `Budget.tsx`, `HkdBooks.tsx`, `charts.tsx`.

- [ ] **D0 — Cổng thiết kế.** Một mẫu "trang báo cáo" chung gồm:
  - Thanh tham số (kỳ, tài khoản, đối tượng, ngôn ngữ in) ở hàng bộ lọc của `PageHeader`.
  - Nút In PDF và Xuất Excel căn phải.
  - Bảng báo cáo dùng `DataGrid` chỉ đọc khi trên khoảng 200 dòng: dòng tổng ghim, nhóm theo tài khoản, số căn phải, số âm trong ngoặc hoặc màu đỏ (người dùng chọn ở wireframe).

  Dựng 2 wireframe trên Sổ cái và Bảng cân đối số phát sinh.
- Có trong kế hoạch chi tiết: sửa nhãn trục biểu đồ sang dấu phẩy thập phân (`845,8 tr`), dùng hàm định dạng của `@kt/domain`.
- Nghiệm thu: mọi spec báo cáo xanh; số liệu không đổi so với trước, so bằng kiểm thử hiện có của `apps/api`.

## Giai đoạn E — Danh mục (qua cổng wireframe)

Phạm vi: `Catalog.tsx` (mọi danh mục động), `Accounts.tsx`, `Items.tsx`, `PriceLists.tsx`, `Branches.tsx`, `Users.tsx`, `EnglishNames.tsx`.

- [ ] **E0 — Cổng thiết kế.** Hai hướng:
  - (a) Danh sách cộng `Drawer` sửa bên phải: danh sách vẫn thấy, Esc đóng.
  - (b) Danh sách cộng `Modal` như hiện tại, chỉ làm gọn.

  Cả hai dùng `RowActions` (Sửa ở dòng; Ngưng dùng, Xóa trong menu "⋯"), cột cờ Khách hàng/NCC/Nhân viên hiện bằng thẻ nhỏ thay cho checkbox, tìm và lọc trong `FilterBar`. Người dùng chọn.
- Nghiệm thu: `danh-muc.spec.ts` và các spec danh mục khác xanh; thêm/sửa/ngưng dùng làm trọn bằng bàn phím (Insert, Enter, Ctrl+S, Esc).

## Giai đoạn F — Các màn còn lại theo phân hệ

Sau B–E, đưa mọi trang còn lại về mẫu. Mỗi đợt là một phân hệ, có kế hoạch chi tiết riêng, dựng thẳng theo mẫu đã duyệt ở B–E (không cần cổng wireframe mới, trừ màn có bố cục chưa có mẫu):

| Đợt | Trang |
|---|---|
| F1 Tiền, ngân hàng | `BankTransactions`, `BankFeeds`, `CashCount` |
| F2 Mua, bán, đơn hàng | `Orders`, `LandedCost`, `PriceLists` |
| F3 Kho | `Stocktake`, `CostingRun`, `OpeningStock` |
| F4 Tài sản | `Assets`, `assetDialogs`, `AssetCount`, `AssetOpening` |
| F5 Lương | `PayrollProfiles`, `Attendance`, `PayrollRuns`, `PayrollRunImport`, `PayrollStructures`, `PayrollParams`, `PayrollPaymentFile`, `PayrollPaymentFormats`, `TncnReturns`, `payrollUi` |
| F6 Giá thành, hợp đồng | `CostObjects`, `CostNorms`, `CostRuns`, `Contracts`, `Loans`, `ProjectAlloc` |
| F7 Thuế, HĐĐT | `EInvoices`, `EInvoiceConfig`, `EInvoiceErrorNotice`, `InboundInvoices`, `DeclaredInvoices`, `SigningSetup` |
| F8 Tổng hợp, cuối kỳ | `PeriodClose`, `Periods`, `OpeningBalance`, `Closing`, `Amortization`, `Settlement`, `FxTools`, `SuggestEntry` |
| F9 Hệ thống, tiện ích | `Company`, `CompanyWizard`, `Login`, `SelectTenant`, `AuditLog`, `ApiKeys`, `Regimes`, `NumberingBranch`, `DataCheck`, `Dedupe`, `Export`, `ImportExcel`, `ImportVouchers`, `Approvals`, `ApprovalDelegations`, `Assistant` |

Mỗi trang của đợt phải làm đủ:
1. Thay khối tiêu đề và thanh công cụ bằng `PageHeader`.
2. Thay link hành động dòng bằng `RowActions`.
3. Thay "chưa có dữ liệu" tự viết bằng `EmptyState`.
4. Bỏ `style={{…}}` có màu hay khoảng cách viết cứng, chuyển sang token (`theme.useToken()`) hoặc prop antd.
5. Spec E2E của trang xanh; trang chưa có spec thì thêm một spec luồng chính.

Đo tiến độ bằng lệnh: `grep -rhoE "style=\{\{[^}]*\}\}" apps/web/src/pages | wc -l` (lúc đầu 886) và `grep -rhoE "#[0-9a-fA-F]{3,6}\b" apps/web/src | wc -l`. Mục tiêu cuối F: không còn mã hex ngoài `theme.ts`, số `style` inline giảm ít nhất 70%.

## Kết thúc đại tu

- [ ] Rà toàn nhánh bằng Opus/Fable (theo `CLAUDE.md`, mục Chọn model).
- [ ] `pnpm lint && pnpm typecheck && pnpm test`, kiểm thử bất biến và đủ bộ E2E đều xanh.
- [ ] Viết `docs/user/dai-tu-giao-dien.md`: menu mới, Ctrl+K, thu gọn sidebar, phím tắt.
- [ ] Cập nhật `docs/TIEP-THEO.md`, gắn tag `giao-dien-v2`, push.

## Self-Review

- **Phủ hướng đã chốt.** Toàn bộ màn: B–F. Dày đặc: A1. Sidebar nhóm, icon, tìm: A2, A3, A6. Ưu tiên chứng từ, trang chủ, báo cáo, danh mục: B, C, D, E, mỗi giai đoạn có cổng wireframe vì phiên này là phiên bàn trước.
- **Phủ 10 vấn đề hiện trạng.** Mỗi dòng ở bảng "Hiện trạng" có cột "Giải ở".
- **Placeholder.** Giai đoạn B–F cố ý chưa có mã chi tiết: bố cục chưa chọn thì viết mã trước là bịa. Mỗi giai đoạn có bước 0 sinh kế hoạch chi tiết theo khuôn A.
- **Khớp kiểu.** `MenuItem.icon` (A2) được dùng ở A3. `selectedKeyFor`, `openKeysFor`, `breadcrumbFor` (A3) được dùng ở A4. `flattenMenu` (A6) có `key = to`, khớp `navigate({ to: key })`. `Action` của `RowActions` (A5) được dùng ở E và F.
- **Rủi ro E2E.** Đổi cao dòng và cấu trúc menu: nhãn "Thuế", "Công nợ" và các mục con E2E bấm đã giữ nguyên (kiểm ở A2). Link "Đăng xuất" chuyển vào dropdown, sửa spec ở A4. Nút có nhãn phím tắt giữ `aria-label` (A5).
