export type VoucherState = 'draft' | 'posted' | 'reversed' | 'cancelled';
export type VoucherAction = 'post' | 'unpost' | 'reverse' | 'discard';
const TRANSITIONS: Record<VoucherState, Partial<Record<VoucherAction, VoucherState>>> = {
  draft: { post: 'posted', discard: 'cancelled' },
  posted: { unpost: 'draft', reverse: 'reversed' },
  reversed: {}, cancelled: {},
};
export const canTransition = (state: VoucherState, action: VoucherAction): boolean => TRANSITIONS[state][action] !== undefined;
export const nextState = (state: VoucherState, action: VoucherAction): VoucherState | null => TRANSITIONS[state][action] ?? null;

export type EditDecision = 'in_place' | 'unpost_edit_post' | 'reverse_and_new' | 'adjust_in_open_period' | 'discard' | 'allowed' | 'forbidden';
export function decideEdit(i: { periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean; change: 'meta' | 'amount' | 'delete' | 'backdate'; canEditPosted: boolean; canBackdateLocked: boolean }): EditDecision {
  const locked = i.periodStatus === 'hard_locked' || i.hashed;
  switch (i.change) {
    case 'meta': return locked ? 'forbidden' : 'in_place';
    case 'amount':
      if (locked) return 'adjust_in_open_period';
      if (i.periodStatus === 'soft_locked') return 'reverse_and_new';
      return i.canEditPosted ? 'unpost_edit_post' : 'forbidden';
    case 'delete':
      if (locked) return 'forbidden';
      return i.periodStatus === 'soft_locked' ? 'reverse_and_new' : 'discard';
    case 'backdate':
      if (locked) return 'forbidden';
      return i.periodStatus === 'open' || i.canBackdateLocked ? 'allowed' : 'forbidden';
  }
}
