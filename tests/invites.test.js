import { test, summary } from './harness.js';
import assert from 'assert';
import { createInvite, redeemInvite, INVITES_FROZEN } from '../src/invites.js';
import { memDb as memoryDb } from './memstore.js';

console.log('\n=== invites ===');
await test('frozen flag is on', () => assert.strictEqual(INVITES_FROZEN, true));
await test('create throws while frozen', async () => {
  await assert.rejects(() => createInvite(memoryDb(), { display_name: 'Alex' }), /off on this install/i);
});
await test('redeem refuses while frozen', async () => {
  const r = await redeemInvite(memoryDb(), 'anything');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'frozen');
});
summary('Invites Test Summary');
