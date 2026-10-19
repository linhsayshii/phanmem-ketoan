import './env.js';
import { createDb, createPool } from '@kt/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = createDb(createPool(config.DATABASE_URL));
const app = await buildApp({ db, config });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
