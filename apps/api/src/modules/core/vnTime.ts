import { sql } from 'kysely';

// Khoảng ngày tính theo giờ Việt Nam, không theo múi giờ của máy chủ DB: từ 00:00 ngày bắt đầu đến hết ngày kết thúc (so sánh `>= vnDayStart(from)` và `< vnDayEnd(to)`).
export const vnDayStart = (d: string) => sql<string>`(${d}::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
export const vnDayEnd = (d: string) => sql<string>`((${d}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
