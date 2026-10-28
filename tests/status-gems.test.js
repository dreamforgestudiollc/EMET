/**
 * emet_status `gems` at the dispatch level (GEM socket PR 4, Tester review of #43):
 * the fail-closed branch, the normal branch against seatGems, and no stderr.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const key of ['EMET_ACTIVE_GEMS', 'CASCADE_ACTIVE_GEMS', 'EMET_GEMS_ROOT']) delete process.env[key];

const { makeStore, withStore } = await import('./memstore.js');
const { dispatchTool, setStatusSeatForTests } = await import('../src/dispatch.js');
const { seatGems } = await import('../src/socket.js');

console.log('\n=== emet_status gems (dispatch) ===');

const SILENT = { warn() {}, info() {}, error() {} };

async function status() {
  const db = makeStore();
  const res = await withStore(db, () => dispatchTool('emet_status', {}, { dbManager: db, logger: null }));
  const text = res && res.content && res.content[0] ? res.content[0].text : JSON.stringify(res);
  const body = JSON.parse(text);
  return { text, data: body.data || body };
}

async function quietStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}

testGroup('emet_status gems', () => {
  test('a socket throw is reported as fail-closed, and the rest of the status survives', async () => {
    setStatusSeatForTests(async () => { const e = new Error('boom at /secret/path/gems'); e.stack = 'Error: boom\n    at /secret/path/socket.js:1:1'; throw e; });
    try {
      const { text, data } = await status();
      assert.deepStrictEqual(data.gems, { error: 'GEM socket failed closed', emet_code: 'EMET-GEM-042' });
      assert.ok('initialized' in data, 'setup fields still present');
      assert.ok('database' in data, 'database field still present');
      assert.ok('source_tag' in data, 'attribution fields still present');
      assert.ok(!text.includes('/secret/path'), 'no path text');
      assert.ok(!text.includes('boom'), 'no error message text');
      assert.ok(!/\n\s+at /.test(text) && !text.includes('socket.js:'), 'no stack text');
    } finally { setStatusSeatForTests(null); }
  });
  test('the normal case matches seatGems per GEM', async () => {
    const { data } = await status();
    const seated = await seatGems({ log: SILENT });
    assert.ok(data.gems && Array.isArray(data.gems.per_gem), 'gems present');
    assert.strictEqual(data.gems.installed, seated.gems_available.length);
    assert.ok(seated.gems_available.length >= 1, 'release ships at least one GEM');
    assert.deepStrictEqual(data.gems.per_gem.map((g) => [g.id, g.version, g.active, g.loadable, g.bytes]),
      seated.gems_available.map((g) => [g.id, g.version, g.active === true, g.loadable === true, g.bytes]));
  });
  test('a status call writes nothing about GEMs to stderr', async () => {
    const { lines } = await quietStderr(() => status());
    assert.deepStrictEqual(lines.filter((l) => /GEMs seated|GEM seated|GEM refused|GEM socket/.test(l)), []);
  });
  test('session_id reports open, closed, or absent, and a part id reads the base', async () => {
    const openId = '2026-10-27_status-open';
    const closedId = '2026-10-27_status-closed';
    const db = makeStore();
    db.col('emet_sessions').docs.push(
      { _id: openId, opened: true, closed: false },
      { _id: closedId, opened: true, closed: true }
    );
    const read = async (session_id) => {
      const res = await withStore(db, () => dispatchTool('emet_status', { session_id }, { dbManager: db, logger: null }));
      const body = JSON.parse(res.content[0].text);
      assert.ok(!res.isError, res.content[0].text.slice(0, 400));
      return body.data.session;
    };
    const bare = await withStore(db, () => dispatchTool('emet_status', {}, { dbManager: db, logger: null }));
    const bareBody = JSON.parse(bare.content[0].text);
    assert.strictEqual(bareBody.data.session, undefined);
    assert.deepStrictEqual(await read(openId), { session_id: openId, state: 'open' });
    assert.deepStrictEqual(await read(`${openId}_verbatim_part2`), { session_id: openId, state: 'open' });
    assert.deepStrictEqual(await read(closedId), { session_id: closedId, state: 'closed' });
    assert.deepStrictEqual(await read('2026-10-27_status-missing'), { session_id: '2026-10-27_status-missing', state: 'absent' });
  });
  test('a session lookup that cannot be read is unreadable and the rest of status survives', async () => {
    const db = makeStore();
    db.ensureClient = async () => { throw new Error('down at /secret/session-store'); };
    const session_id = '2026-10-27_status-unreadable';
    const res = await withStore(db, () => dispatchTool('emet_status', { session_id }, { dbManager: db, logger: null }));
    const text = res.content[0].text;
    const body = JSON.parse(text);
    assert.ok(!res.isError, text.slice(0, 400));
    assert.deepStrictEqual(body.data.session, { state: 'unreadable', emet_code: 'EMET-SESS-005' });
    assert.ok(!text.includes(session_id), 'the asked id is not echoed');
    assert.ok(!text.includes('/secret/session-store'));
    assert.ok(!text.includes('down at'));
    assert.ok('initialized' in body.data, 'setup fields still present');
    assert.ok('database' in body.data, 'database field still present');
  });
  test('the seat is called with a logger', async () => {
    let got = null;
    setStatusSeatForTests(async (opts) => { got = opts; return { gems_available: [], gems_active: [] }; });
    try {
      await status();
      assert.ok(got && got.log && typeof got.log.warn === 'function' && typeof got.log.info === 'function');
    } finally { setStatusSeatForTests(null); }
  });
});

summary('emet_status gems');
