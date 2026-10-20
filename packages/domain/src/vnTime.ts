// Ngày hiện tại theo giờ Việt Nam (YYYY-MM-DD), không phụ thuộc múi giờ của máy chủ.
const VN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
export function todayVn(now: Date = new Date()): string {
  return VN_DAY.format(now);
}
