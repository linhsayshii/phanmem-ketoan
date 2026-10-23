import dayjs from 'dayjs';
import { D } from '@kt/domain';

export interface InstallmentRow { dueDate: string; principal: string; note: string }

// Sinh lịch trả gốc đều: `count` kỳ cách nhau `months` tháng từ ngày trả đầu tiên; gốc chia đều theo đồng, phần dư dồn vào kỳ cuối.
// Ngày tính từ ngày đầu mỗi lần (31/01 + 1 tháng = 28/02, kỳ sau lại 31/03), không cộng dồn từ kỳ trước.
export function evenSchedule(firstDue: string, count: number, months: number, total: string): InstallmentRow[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue) || !Number.isInteger(count) || count < 1 || count > 600 || !Number.isInteger(months) || months < 1 || !/^\d{1,16}$/.test(total)) return [];
  const each = D(total).div(count).floor();
  return Array.from({ length: count }, (_, i) => ({
    dueDate: dayjs(firstDue).add(i * months, 'month').format('YYYY-MM-DD'),
    principal: (i === count - 1 ? D(total).minus(each.times(count - 1)) : each).toFixed(0), note: '' }));
}
