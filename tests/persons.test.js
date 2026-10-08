import { test, summary } from './harness.js';
import assert from 'assert';
import { slugPersonId, ensureOwnerPerson, resolveTokenSubject, currentClientId, actorStore } from '../src/persons.js';
import { memDb as memoryDb } from './memstore.js';

console.log('\n=== persons ===');
await test('slug is stable and lowercase', () => {
  assert.strictEqual(slugPersonId('Alex'), 'alex');
  assert.strictEqual(slugPersonId('Mary-Jane O\'Neil'), 'mary-jane-o-neil');
});
await test('empty name becomes owner', () => assert.strictEqual(slugPersonId(''), 'owner'));
await test('first ensure creates the owner', async () => {
  const db = memoryDb();
  const p = await ensureOwnerPerson(db, { display_name: 'Alex' });
  assert.strictEqual(p.person_id, 'alex');
  assert.strictEqual(p.role, 'owner');
  assert.strictEqual(db._rows.length, 1);
});
await test('second ensure does not duplicate', async () => {
  const db = memoryDb();
  await ensureOwnerPerson(db, { display_name: 'Alex' });
  const again = await ensureOwnerPerson(db, { display_name: 'Someone Else' });
  assert.strictEqual(again.person_id, 'alex');
  assert.strictEqual(db._rows.length, 1);
});
await test('resolve falls back to owner when the table is empty', async () => {
  assert.strictEqual(await resolveTokenSubject(memoryDb()), 'owner');
});
await test('resolve returns the owner person_id', async () => {
  const db = memoryDb();
  await ensureOwnerPerson(db, { display_name: 'Alex' });
  assert.strictEqual(await resolveTokenSubject(db), 'alex');
});

await test('a missing login stamps stdio', () => {
  assert.strictEqual(currentClientId(), 'stdio');
});
await test('the login client id is what a write would carry', async () => {
  await actorStore.run({ personId: 'alex', clientId: 'login-9' }, () => {
    assert.strictEqual(currentClientId(), 'login-9');
  });
});

summary('Persons Test Summary');
console.log('All tests passed!');
