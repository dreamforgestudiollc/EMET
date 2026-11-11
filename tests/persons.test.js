import { test, summary } from './harness.js';
import assert from 'assert';
import { slugPersonId, ensureOwnerPerson, resolveTokenSubject, currentClientId, actorStore } from '../src/persons.js';
import { memDb as memoryDb } from './memstore.js';

console.log('\n=== persons ===');
await test('slug is stable and lowercase', () => {
  assert.strictEqual(slugPersonId('Patron'), 'patron');
  assert.strictEqual(slugPersonId('Blue-Green O\'Ring'), 'blue-green-o-ring');
});
await test('empty name becomes owner', () => assert.strictEqual(slugPersonId(''), 'owner'));
await test('first ensure creates the owner', async () => {
  const db = memoryDb();
  const p = await ensureOwnerPerson(db, { display_name: 'Patron' });
  assert.strictEqual(p.person_id, 'patron');
  assert.strictEqual(p.role, 'owner');
  assert.strictEqual(db._rows.length, 1);
});
await test('second ensure does not duplicate', async () => {
  const db = memoryDb();
  await ensureOwnerPerson(db, { display_name: 'Patron' });
  const again = await ensureOwnerPerson(db, { display_name: 'Someone Else' });
  assert.strictEqual(again.person_id, 'patron');
  assert.strictEqual(db._rows.length, 1);
});
await test('resolve falls back to owner when the table is empty', async () => {
  assert.strictEqual(await resolveTokenSubject(memoryDb()), 'owner');
});
await test('resolve returns the owner person_id', async () => {
  const db = memoryDb();
  await ensureOwnerPerson(db, { display_name: 'Patron' });
  assert.strictEqual(await resolveTokenSubject(db), 'patron');
});

await test('a missing login stamps stdio', () => {
  assert.strictEqual(currentClientId(), 'stdio');
});
await test('the login client id is what a write would carry', async () => {
  await actorStore.run({ personId: 'patron', clientId: 'login-9' }, () => {
    assert.strictEqual(currentClientId(), 'login-9');
  });
});

summary('Persons Test Summary');
console.log('All tests passed!');
