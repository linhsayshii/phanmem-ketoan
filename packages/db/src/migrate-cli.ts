import 'dotenv/config';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL');
const applied = await migrate(url);
console.log(applied.length ? `Đã áp dụng: ${applied.join(', ')}` : 'Không có migration mới');
