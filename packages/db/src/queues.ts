export const QUEUES = { backup: 'backup', recomputeBalances: 'balance.recompute' } as const;
export interface RecomputeBalancesJob { tenantId: string }
