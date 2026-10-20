import { describe, expect, it } from 'vitest';
import { canTransition, decideEdit } from '../src/voucherState.js';

describe('máy trạng thái chứng từ', () => {
  it('chuyển trạng thái hợp lệ theo mục 7.1', () => {
    expect(canTransition('draft', 'post')).toBe(true); expect(canTransition('posted', 'unpost')).toBe(true);
    expect(canTransition('posted', 'reverse')).toBe(true); expect(canTransition('draft', 'discard')).toBe(true);
    expect(canTransition('reversed', 'unpost')).toBe(false); expect(canTransition('cancelled', 'post')).toBe(false);
    expect(canTransition('draft', 'reverse')).toBe(false); expect(canTransition('posted', 'discard')).toBe(false);
  });
  it('bảng quyết định sửa chứng từ đã ghi sổ', () => {
    const base = { hashed: false, canEditPosted: true, canBackdateLocked: false };
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'meta' })).toBe('in_place');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'meta' })).toBe('in_place');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'meta' })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'amount' })).toBe('unpost_edit_post');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'amount', canEditPosted: false })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'amount' })).toBe('reverse_and_new');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'amount' })).toBe('adjust_in_open_period');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'amount', hashed: true })).toBe('adjust_in_open_period');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'delete' })).toBe('discard');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'delete' })).toBe('reverse_and_new');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'delete' })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'backdate' })).toBe('allowed');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'backdate' })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'backdate', canBackdateLocked: true })).toBe('allowed');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'backdate', canBackdateLocked: true })).toBe('forbidden');
  });
});
