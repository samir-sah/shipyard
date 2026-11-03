import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxClaimOverlap, summarize } from '../scripts/benchmark.js';

test('benchmark percentiles preserve inputs, handle no successes, and use nearest-rank p95', () => {
  const values = [50, 10, 40, 20, 30];
  assert.deepEqual(summarize(values), { samples: 5, median: 30, p95: 50 });
  assert.deepEqual(values, [50, 10, 40, 20, 30]);
  assert.deepEqual(summarize([8, 2]), { samples: 2, median: 5, p95: 8 });
  assert.deepEqual(summarize([]), { samples: 0, median: null, p95: null });
  assert.deepEqual(summarize(Array.from({ length: 20 }, (_, index) => index + 1)), { samples: 20, median: 10.5, p95: 19 });
  assert.throws(() => summarize([Number.NaN]));
  assert.throws(() => summarize([-1]));
});

test('benchmark claim overlap treats adjacent attempts as nonoverlapping and excludes zero-length intervals', () => {
  const interval = (start: number, finish: number) => ({ startedAt: new Date(start), finishedAt: new Date(finish) });
  assert.equal(maxClaimOverlap([]), 0);
  assert.equal(maxClaimOverlap([interval(0, 10), interval(10, 20), interval(10, 10)]), 1);
  assert.equal(maxClaimOverlap([interval(0, 10), interval(5, 20)]), 2);
  assert.throws(() => maxClaimOverlap([{ startedAt: new Date(0), finishedAt: null }]));
});
