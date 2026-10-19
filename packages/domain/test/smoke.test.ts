import { describe, expect, it } from 'vitest';
import { DOMAIN_VERSION } from '../src/index.js';

describe('khói', () => {
  it('gói domain nạp được', () => {
    expect(DOMAIN_VERSION).toBe('0.0.1');
  });
});
