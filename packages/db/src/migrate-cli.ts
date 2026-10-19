import './env.js';
import { migrate } from './migrate.js';
import { syncReferenceData } from './reference.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL');
const applied = await migrate(url);
console.log(applied.length ? `Đã áp dụng: ${applied.join(', ')}` : 'Không có migration mới');
await syncReferenceData(url);
console.log('Đã đồng bộ dữ liệu tham chiếu');
