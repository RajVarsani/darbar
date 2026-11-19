import { expect, test } from 'bun:test';
import { bucketOf, checkQueue, stripPrefix, titleFor } from './pure';

const q = (id: string, text = id) => ({ queuedRunId: id, text });
const started = (...ids: string[]) => (id: string) => ids.includes(id);

test('title prefix is replaced, never stacked, and only ours is stripped', () => {
  expect(titleFor('Fix 80% of bugs', 35)).toBe('35% · Fix 80% of bugs');
  expect(titleFor('35% · Fix 80% of bugs', 40)).toBe('40% · Fix 80% of bugs');
  expect(stripPrefix('5% · a')).toBe('a');
  expect(stripPrefix('5%a')).toBe('5%a');
  expect(bucketOf(72.9, 5)).toBe(70);
  expect(bucketOf(4.9, 5)).toBe(0);
});

test('queue check accepts one insert ahead of the user runs', () => {
  expect(checkQueue([q('u1'), q('u2')], [q('h'), q('u1'), q('u2')], 'h', started())).toBeNull();
  expect(checkQueue([q('u1'), q('u2')], [q('h'), q('u1'), q('u2'), q('u3')], 'h', started())).toBeNull(); // user queued more
  expect(checkQueue([q('u1'), q('u2')], [q('u2')], 'h', started('u1'))).toBeNull(); // u1 started, ours already ran
  expect(checkQueue([], [], 'h', started())).toBeNull();
});

test('queue check fails closed', () => {
  expect(checkQueue([q('u1'), q('u2')], [q('h'), q('u1')], 'h', started())).toMatch(/vanished/);
  expect(checkQueue([q('u1', 'a')], [q('h'), q('u1', 'b')], 'h', started())).toMatch(/text changed/);
  expect(checkQueue([q('u1'), q('u2')], [q('h'), q('u2'), q('u1')], 'h', started())).toMatch(/out of order/);
  expect(checkQueue([q('u1')], [q('u1'), q('h')], 'h', started())).toMatch(/behind/);
});
