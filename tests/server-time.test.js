/**
 * Server-stamped local time on write receipts, stored on the
 * revision or row, and a warn-only check when a host-written time on the
 * top HANDOFF heading or board patch line is far from the server clock.
 *
 * The clock is pinned
 * at 2026-11-10T04:50:00.000Z, which is 2026-11-09 23:50 EST.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeStore, withStore, layerHonouringDb } from './memstore.js';
import { writeDoc, readDoc, readDocHistory, saveMemory, queryLayer, patchDoc, transcriptAppend } from '../src/tools.js';
import { validateDocument } from '../src/conformance.js';
import { digest } from '../src/aleph.js';
import { beginStagedDoc, appendStagedChunk, commitStagedDoc } from '../src/staged-write.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
delete process.env.EMET_TIMEZONE;
delete process.env.CASCADE_TIMEZONE;

const NY = 'America/New_York';
const wall = (ap) => ap + ' ' + 'ET';
const SERVER_1150 = new Date('2026-11-10T04:50:00.000Z');
const SKEW_WARNING = 'host-written time 11/9 ~7:00 ' + wall('PM') + ' differs from the server local time 2026-11-09 23:50 EST by more than 90 minutes';

let serverTimeMod = null;
try {
  serverTimeMod = await import('../src/server-time.js');
} catch {
  serverTimeMod = null;
}

function handoff(heading) {
  return `${heading}

## §0 RECORD CONTROL
- Template: \`templates/HANDOFF.md\` rev 3
- Session id: 2026-11-09_test · Source tag: host · Written (local): noted
- Scope of this session, one line: server time check

## §1 START HERE
- Half-state rows on the board: None.
- The next session first action: Read the board.
- Left undecided this session: None.
- Why this session stopped: finished

## §2 BOARD CHANGES THIS SESSION
- Added: None.
- Changed: None.
- Closed: None.

## §3 DONE THIS SESSION
Nothing completed this session.

## §4 DECISIONS THIS SESSION
No decisions this session.

## §5 ERRORS THIS SESSION
None identified this session.

## §6 CLOSE VERIFICATION
| Artifact | Done | Evidence |
|---|---|---|
| Working documents for anything this session changed | N-A | no document changed |
| Session record in memory | Y | episodic 1 |
| Board | Y | v1 |
| Seed scan | Y | 2026-11-09 |
| Verbatim transcript | Y | session id |
| This handoff | Y | this revision
`;
}

function pinClock() {
  assert.ok(serverTimeMod && typeof serverTimeMod.setServerNowForTests === 'function', 'src/server-time.js pins the server clock');
  serverTimeMod.setServerNowForTests(SERVER_1150);
}

function clearClock() {
  if (serverTimeMod) serverTimeMod.setServerNowForTests(null);
}

testGroup('formatter: America/New_York across the 2026-11-01 DST boundary', () => {
  test('2026-11-01T05:30:00.000Z is 2026-11-01 01:30 EDT', () => {
    assert.ok(serverTimeMod, 'src/server-time.js exports serverTime');
    assert.deepStrictEqual(serverTimeMod.serverTime(new Date('2026-11-01T05:30:00.000Z'), NY), {
      utc: '2026-11-01T05:30:00.000Z',
      local: '2026-11-01 01:30 EDT',
      zone: NY,
      offset: '-04:00'
    });
  });

  test('2026-11-01T06:30:00.000Z is 2026-11-01 01:30 EST', () => {
    assert.ok(serverTimeMod, 'src/server-time.js exports serverTime');
    assert.deepStrictEqual(serverTimeMod.serverTime(new Date('2026-11-01T06:30:00.000Z'), NY), {
      utc: '2026-11-01T06:30:00.000Z',
      local: '2026-11-01 01:30 EST',
      zone: NY,
      offset: '-05:00'
    });
  });
});

testGroup('write receipts carry server_time in America/New_York', () => {
  test('a write_doc receipt contains server_time.local', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      const before = Date.now();
      const receipt = await writeDoc('threads/server-time.md', '# Time\nA note.\n', 'host');
      const after = Date.now();
      assert.equal(receipt.server_time.zone, NY);
      assert.match(receipt.server_time.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)$/);
      const utcMs = Date.parse(receipt.server_time.utc);
      assert.ok(utcMs >= before - 1000 && utcMs <= after + 1000, receipt.server_time.utc);
      assert.equal(receipt.server_time.local, serverTimeMod.serverTime(new Date(receipt.server_time.utc), NY).local);
    });
  });

  test('patch_doc, write_doc_commit, save_to_layer, and emet_transcript_append carry server_time', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('threads/patch-time.md', '# Old\n', 'host');
      const patched = await patchDoc('threads/patch-time.md', '# Old\n', '# New\n', 'host', null, null, { reason: 'stamp the patch' });
      assert.equal(patched.server_time.zone, NY);
      assert.match(patched.server_time.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)$/);

      const body = '# Staged\nserver time\n';
      const begun = await beginStagedDoc({ doc_id: 'threads/staged-time.md', source: 'host' });
      await appendStagedChunk({ stage_id: begun.stage_id, part: 1, chunk: body, source: 'host' });
      const committed = await commitStagedDoc({
        stage_id: begun.stage_id, doc_id: 'threads/staged-time.md', sha256: digest(body), part_count: 1, source: 'host'
      });
      assert.equal(committed.server_time.zone, NY);
      assert.match(committed.server_time.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)$/);

      const append = await transcriptAppend({
        session_id: '2026-11-09_time', user_message: 'hi', assistant_message: 'hello'
      });
      assert.equal(append.server_time.zone, NY);
      assert.equal(db.transcripts()[0].exchanges[0].server_written_local, append.server_time.local);
    });

    const layers = layerHonouringDb();
    const saved = await saveMemory(layers, 'A fact stamped by the server clock.', 'working', { source: 'host', assertion_origin: 'user' });
    assert.equal(saved.server_time.zone, NY);
    assert.equal(layers.row('working', saved.id).server_written_local, saved.server_time.local);
    const rows = await queryLayer(layers, 'working', { filters: { id: saved.id } });
    assert.equal(rows[0].server_written_local, saved.server_time.local);
  });
});

testGroup('a stored revision read back carries server_written_local', () => {
  test('read_doc and read_doc_history return the local time stored on the revision', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      const firstText = handoff('## Session close');
      const first = await writeDoc('HANDOFF.md', firstText, 'host');
      const live = await readDoc('HANDOFF.md');
      assert.equal(live.server_written_local, first.server_time.local);
      const second = await writeDoc('HANDOFF.md', handoff('## Later close'), 'host', null, null, {
        supersedes: first.version,
        reason: 'a later close of the same day'
      });
      const retained = await readDocHistory('HANDOFF.md', first.version);
      assert.equal(retained.server_written_local, first.server_time.local);
      const current = await readDocHistory('HANDOFF.md', second.version);
      assert.equal(current.is_current, true);
      assert.equal(current.server_written_local, second.server_time.local);
    });
  });
});

testGroup('host clock skew warns and does not refuse', () => {
  test('a HANDOFF heading of 11/9 ~7:00 ' + wall('PM') + ' at 11:50 ' + wall('PM') + ' warns, still conforms, and the write succeeds', async () => {
    const db = makeStore();
    const text = handoff('## 11/9 ~7:00 ' + wall('PM') + ' session close');
    if (serverTimeMod) serverTimeMod.setServerNowForTests(SERVER_1150);
    try {
      await withStore(db, async () => {
        const receipt = await writeDoc('HANDOFF.md', text, 'host');
        assert.equal(receipt.verified, true);
        assert.equal(receipt.conformance.verdict, 'conforms');
        assert.deepStrictEqual(receipt.conformance.failures, []);
        assert.ok(receipt.conformance.warnings.includes(SKEW_WARNING), JSON.stringify(receipt.conformance.warnings));
        assert.match(db.doc('HANDOFF.md').content, new RegExp('## 11/9 ~7:00 ' + wall('PM') + ' session close'));
        assert.doesNotMatch(db.doc('HANDOFF.md').content, /23:50/);
      });
    } finally {
      clearClock();
    }
  });

  test('a heading within 90 minutes gets no warning', async () => {
    pinClock();
    try {
      const r = validateDocument('HANDOFF.md', handoff('## 11/9 ~10:30 ' + wall('PM') + ' session close'));
      assert.equal(r.verdict, 'conforms');
      assert.ok(!r.warnings.some((w) => w.includes('differs from the server local time')), JSON.stringify(r.warnings));
    } finally {
      clearClock();
    }
  });

  test('a heading with no parsable time gets no warning', async () => {
    pinClock();
    try {
      const text = handoff('## Session close') + '\nPatch 11/9 ~7:00 ' + wall('PM') + ' not the top\n';
      const r = validateDocument('HANDOFF.md', text);
      assert.equal(r.verdict, 'conforms');
      assert.ok(!r.warnings.some((w) => w.includes('7:00 ' + wall('PM') + '')), JSON.stringify(r.warnings));
    } finally {
      clearClock();
    }
  });

  test('a patch line that is not the top is ignored', async () => {
    pinClock();
    try {
      const text = handoff('## 11/9 ~11:40 ' + wall('PM') + ' session close').replace(
        '## §1 START HERE',
        'Patch 11/9 ~7:00 ' + wall('PM') + ' an older line\n\n## §1 START HERE'
      );
      const r = validateDocument('HANDOFF.md', text);
      assert.equal(r.verdict, 'conforms');
      assert.ok(!r.warnings.some((w) => w.includes('7:00 ' + wall('PM') + '')), JSON.stringify(r.warnings));
    } finally {
      clearClock();
    }
  });

  test('the top patch line is the line that is checked', async () => {
    pinClock();
    try {
      const text = 'Patch 11/9 ~7:00 ' + wall('PM') + ' board line\n\n' + handoff('## 11/9 ~11:50 ' + wall('PM') + ' session close');
      const r = validateDocument('HANDOFF.md', text);
      assert.equal(r.verdict, 'conforms');
      assert.deepStrictEqual(r.failures, []);
      assert.ok(r.warnings.includes(SKEW_WARNING), JSON.stringify(r.warnings));
    } finally {
      clearClock();
    }
  });

  test('EMET_HOST_TIME_SKEW_MIN widens the window and still does not refuse', async () => {
    pinClock();
    const prev = process.env.EMET_HOST_TIME_SKEW_MIN;
    process.env.EMET_HOST_TIME_SKEW_MIN = '300';
    try {
      const r = validateDocument('HANDOFF.md', handoff('## 11/9 ~7:00 ' + wall('PM') + ' session close'));
      assert.equal(r.verdict, 'conforms');
      assert.ok(!r.warnings.some((w) => w.includes('differs from the server local time')), JSON.stringify(r.warnings));
    } finally {
      if (prev === undefined) delete process.env.EMET_HOST_TIME_SKEW_MIN;
      else process.env.EMET_HOST_TIME_SKEW_MIN = prev;
      clearClock();
    }
  });
});

function pinAt(date) {
  assert.ok(serverTimeMod && typeof serverTimeMod.setServerNowForTests === 'function', 'src/server-time.js pins the server clock');
  serverTimeMod.setServerNowForTests(date);
}

function noSkew(r) {
  assert.equal(r.verdict, 'conforms');
  assert.deepStrictEqual(r.failures, []);
  assert.ok(!r.warnings.some((w) => w.includes('differs from the server local time')), JSON.stringify(r.warnings));
}

testGroup('a heading with no year uses the closest year', () => {
  test('12/31 at 11:50 ' + wall('PM') + ' is not a skew when the server is 12:20 AM on Jan 1', () => {
    pinAt(new Date('2027-01-01T05:20:00.000Z'));
    try {
      noSkew(validateDocument('HANDOFF.md', handoff('## 12/31 ~11:50 ' + wall('PM') + ' session close')));
    } finally {
      clearClock();
    }
  });

  test('1/1 at 12:10 ' + wall('AM') + ' is not a skew when the server is 11:40 PM on Dec 31', () => {
    pinAt(new Date('2027-01-01T04:40:00.000Z'));
    try {
      noSkew(validateDocument('HANDOFF.md', handoff('## 1/1 ~12:10 ' + wall('AM') + ' session close')));
    } finally {
      clearClock();
    }
  });

  test('a July heading on New Year is still a skew', () => {
    pinAt(new Date('2027-01-01T05:20:00.000Z'));
    try {
      const r = validateDocument('HANDOFF.md', handoff('## 7/4 ~1:00 ' + wall('AM') + ' session close'));
      assert.equal(r.verdict, 'conforms');
      assert.ok(r.warnings.some((w) => w.includes('7/4 ~1:00 ' + wall('AM') + '') && w.includes('differs from the server local time')), JSON.stringify(r.warnings));
    } finally {
      clearClock();
    }
  });
});

testGroup('the repeated fall-back hour does not warn when either occurrence is inside 90 minutes', () => {
  test('11/1 ~1:20 ' + wall('AM') + ' at 2:40 AM EST does not warn', () => {
    pinAt(new Date('2026-11-01T07:40:00.000Z'));
    try {
      noSkew(validateDocument('HANDOFF.md', handoff('## 11/1 ~1:20 ' + wall('AM') + ' session close')));
    } finally {
      clearClock();
    }
  });
});

testGroup('a spring-forward gap is not a skew when the shifted time is close', () => {
  test('3/14 ~2:30 ' + wall('AM') + ' at 03:00 EDT on 2027-03-14 does not warn', () => {
    pinAt(new Date('2027-03-14T07:00:00.000Z'));
    try {
      noSkew(validateDocument('HANDOFF.md', handoff('## 3/14 ~2:30 ' + wall('AM') + ' session close')));
    } finally {
      clearClock();
    }
  });

  test('3/14 ~2:30 ' + wall('AM') + ' on New Year is still a skew', () => {
    pinAt(new Date('2027-01-01T05:20:00.000Z'));
    try {
      const r = validateDocument('HANDOFF.md', handoff('## 3/14 ~2:30 ' + wall('AM') + ' session close'));
      assert.equal(r.verdict, 'conforms');
      assert.ok(r.warnings.some((w) => w.includes('3/14 ~2:30 ' + wall('AM') + '') && w.includes('differs from the server local time')), JSON.stringify(r.warnings));
    } finally {
      clearClock();
    }
  });
});

testGroup('formatter: spring-forward 2027-03-14', () => {
  test('01:59 EST then 03:00 EDT', () => {
    assert.ok(serverTimeMod, 'src/server-time.js exports serverTime');
    const before = serverTimeMod.serverTime(new Date('2027-03-14T06:59:00.000Z'), NY);
    const after = serverTimeMod.serverTime(new Date('2027-03-14T07:00:00.000Z'), NY);
    assert.equal(before.local, '2027-03-14 01:59 EST');
    assert.equal(before.utc, '2027-03-14T06:59:00.000Z');
    assert.equal(before.offset, '-05:00');
    assert.equal(after.local, '2027-03-14 03:00 EDT');
    assert.equal(after.utc, '2027-03-14T07:00:00.000Z');
    assert.equal(after.offset, '-04:00');
  });
});

testGroup('a line that is not a host time is not parsed', () => {
  test('version numbers, ratios, ids, a missing tilde, and UTC or EST do not warn', () => {
    pinAt(new Date('2026-11-10T04:50:00.000Z'));
    try {
      for (const heading of [
        '## v334',
        '## v11/9 ~7:00 ' + wall('PM') + '',
        '## 23147/32',
        '## 2311/2 ~1:00 ' + wall('AM') + '',
        '## item-125e',
        '## 11/9 7:00 ' + wall('PM') + '',
        '## 11/9 ~7:00 PM UTC',
        '## 11/9 ~7:00 PM EST'
      ]) {
        const r = validateDocument('HANDOFF.md', handoff(heading));
        assert.equal(r.verdict, 'conforms', heading);
        assert.ok(!r.warnings.some((w) => w.includes('differs from the server local time')), `${heading}: ${JSON.stringify(r.warnings)}`);
      }
    } finally {
      clearClock();
    }
  });
});

testGroup('a clock failure does not fail the write or the verdict', () => {
  test('an invalid zone returns null and does not throw', () => {
    assert.ok(serverTimeMod, 'src/server-time.js exports serverTime');
    assert.equal(serverTimeMod.serverTime(new Date('2026-11-10T04:50:00.000Z'), 'Not/A/Zone'), null);
  });

  test('a write after the prior revision is archived still succeeds when the clock throws', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      const first = await writeDoc('HANDOFF.md', handoff('## Session close'), 'host');
      assert.equal(first.verified, true);
      pinAt(new Date(NaN));
      try {
        const second = await writeDoc('HANDOFF.md', handoff('## Later close'), 'host', null, null, {
          supersedes: first.version,
          reason: 'a later close of the same day'
        });
        assert.equal(second.verified, true);
        assert.equal(second.version, 2);
        assert.equal(second.server_time, null);
        assert.equal(second.conformance.verdict, 'conforms');
        assert.deepStrictEqual(second.conformance.failures, []);
        assert.equal(db.doc('HANDOFF.md').version, 2);
        assert.equal(db.doc('HANDOFF.md').server_written_local, null);
      } finally {
        clearClock();
      }
    });
  });

  test('save_to_layer and emet_transcript_append store server_written_local null when the clock fails', async () => {
    pinAt(new Date(NaN));
    try {
      const db = makeStore();
      await withStore(db, async () => {
        const append = await transcriptAppend({
          session_id: '2026-11-09_nullclock', user_message: 'hi', assistant_message: 'hello'
        });
        assert.equal(append.server_time, null);
        assert.equal(db.transcripts()[0].exchanges[0].server_written_local, null);
      });
      const layers = layerHonouringDb();
      const saved = await saveMemory(layers, 'A fact with no clock.', 'working', { source: 'host', assertion_origin: 'user' });
      assert.equal(saved.server_time, null);
      assert.equal(layers.row('working', saved.id).server_written_local, null);
      const rows = await queryLayer(layers, 'working', { filters: { id: saved.id } });
      assert.equal(rows[0].server_written_local, null);
    } finally {
      clearClock();
    }
  });

  test('a skew check that throws leaves a conforming verdict in place', () => {
    const r = validateDocument('HANDOFF.md', handoff('## 11/9 ~7:00 ' + wall('PM') + ' session close'), null, {
      at: { utc: '2026-11-10T04:50:00.000Z', local: '2026-11-09 23:50 EST', zone: 'Not/A/Zone' }
    });
    assert.equal(r.verdict, 'conforms');
    assert.deepStrictEqual(r.failures, []);
    assert.ok(!r.warnings.some((w) => /could not run/.test(w)), JSON.stringify(r));
  });
});

testGroup('initialize and status expose server_time once', () => {
  test('emet_initialize and emet_status each carry one server_time', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const store = makeStore();
    const init = await withStore(store, async () => {
      const response = await dispatchTool('emet_initialize', { page: 'all' }, { dbManager: store, logger: null });
      return JSON.parse(response.content[0].text).data;
    });
    assert.equal(init.server_time.zone, NY);
    assert.match(init.server_time.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)$/);
    const status = await withStore(store, () => dispatchTool('emet_status', {}, { dbManager: store, logger: null }));
    const body = JSON.parse(status.content[0].text);
    assert.equal(body.success, true);
    assert.equal(body.data.server_time.zone, NY);
    assert.match(body.data.server_time.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)$/);
  });
});

testGroup('docs match the stored clock failure', () => {
  test('write_doc stores server_written_local null, and the docs say null', async () => {
    const { TOOLS } = await import('../src/tools.js');
    const write = TOOLS.find((t) => t.name === 'write_doc');
    assert.ok(write, 'write_doc is declared');
    assert.match(write.description, /stores server_written_local null/);
    assert.doesNotMatch(write.description, /omits server_written_local/);
    const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const unreleased = changelog.slice(0, changelog.indexOf('\n## 0.3.3'));
    assert.match(unreleased, /stores `server_written_local` null/);
    assert.doesNotMatch(unreleased, /omits `server_written_local`/);
  });

  test('the README receipt-shape sentence includes server_time', () => {
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const line = readme.split('\n').find((row) => row.includes('One receipt shape on both transports'));
    assert.ok(line, 'receipt-shape sentence');
    assert.match(line, /server_time/);
  });
});

summary('Server time');
