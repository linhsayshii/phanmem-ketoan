import PgBoss from 'pg-boss';
export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({ connectionString, schema: 'pgboss', migrate: true, retryLimit: 3, retryDelay: 60, archiveCompletedAfterSeconds: 7 * 24 * 3600 });
}
