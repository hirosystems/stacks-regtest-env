import { test, expect } from 'vitest';
import { burnBlockToRewardCycle } from '../common.js';

test('burnBlockToRewardCycle', () => {
  expect(burnBlockToRewardCycle(250)).toBe(13);
});