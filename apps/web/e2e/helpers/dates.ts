import { expect, type Locator, type Page } from '@playwright/test';

// Gõ ngày bằng phím thật như người dùng (bấm ô, chọn hết, gõ, Enter) rồi rời ô. `fill` đặt cả chuỗi trong một sự kiện, và khi chạy nhanh
// antd 5 đôi khi chưa chốt ngày lúc Enter (ô hiện chữ đã gõ nhưng giá trị vẫn cũ, hoặc RangePicker đảo hai đầu); rời ô thì antd chốt chữ đang có.
export async function typeDate(page: Page, input: Locator, text: string) {
  await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text); await page.keyboard.press('Enter');
  await input.blur();
  await expect(input).toHaveValue(text);
}

// RangePicker: Enter ở ô đầu chuyển sang ô cuối; kiểm cả hai đầu sau khi chốt.
export async function typeRange(page: Page, from: string, to: string, root: Page | Locator = page) {
  const range = root.locator('.ant-picker-range input');
  await range.nth(0).click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(from); await page.keyboard.press('Enter');
  await expect(range.nth(1)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(to); await page.keyboard.press('Enter');
  await range.nth(1).blur();
  await expect(range.nth(0)).toHaveValue(from); await expect(range.nth(1)).toHaveValue(to);
}
