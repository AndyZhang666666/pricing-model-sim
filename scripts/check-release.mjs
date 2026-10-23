import assert from 'node:assert/strict';
import { simulateAll, DEFAULT_RETENTION } from '../lib/model.js';
for (const monthlyPrice of [12, 28, 40]) {
  const sim = simulateAll(DEFAULT_RETENTION, { subscription: { monthlyPrice } });
  const h = sim.results.hybrid.summary;
  assert.equal(sim.verdict.numbers.hybridUnlockCount, Number(h.expectedUnlocks.toFixed(1)));
  assert.equal(sim.verdict.numbers.hybridPaidMonths, Number(h.expectedPaidMonths.toFixed(1)));
  if (sim.verdict.winner === 'hybrid') {
    assert.ok(sim.verdict.reason.includes(h.expectedUnlocks.toFixed(1) + ' 集'));
    assert.ok(sim.verdict.reason.includes(h.expectedPaidMonths.toFixed(1) + ' 个月'));
  }
}
console.log('PASS: conclusion and summary use the same mechanism and denominator');
