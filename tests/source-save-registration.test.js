/**
 * An unregistered source on a save warns until 2026-12-15
 * America/New_York and is refused on that date. The membership test is the
 * one emet_transcript_append already uses. Reads of legacy rows stay.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { layerDb, layerHonouringDb, makeStore, withStore, withEnv } from './memstore.js';

const BEFORE = new Date('2026-12-15T04:59:59.999Z'); // 2026-12-14 23:59 EST
const ON = new Date('2026-12-15T05:00:00.000Z'); // 2026-12-15 00:00 EST
const REG = {
  EMET_SOURCE_TAGS: 'project-host,hub-bot,second-bot,third-bot,hubbot-speaks-of-memory,note-bot,fourth-bot',
  EMET_SOURCE_TAG: undefined,
  EMET_SOURCE_SAVE_CUTOFF: undefined,
  CASCADE_SOURCE_SAVE_CUTOFF: undefined
};
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('\n=== unregistered source saves ===');

async function save(metadata, env, now, db = layerDb()) {
  return withEnv(env, async () => {
    const { saveMemory } = await import('../src/tools.js');
    const receipt = await saveMemory(db, 'A durable fact about the cutoff.', 'working', metadata, null, null, { now });
    return { receipt, db };
  });
}

function refused(error) {
  return error && error.emetCode === 'EMET-MEM-035'
    && /Nothing was written/.test(error.message)
    && /2026-12-15/.test(error.message)
    && /America\/New_York/.test(error.message)
    && !/project-host/.test(error.message)
    && !/note-bot/.test(error.message);
}

testGroup('membership and the cutoff clock', () => {
  test('the transcript check and the save check share one membership', async () => {
    const { sourceMembership } = await import('../src/source-registration.js');
    const { requireRegisteredSource } = await import('../src/dispatch.js');
    const registry = ['project-host', 'hub-bot'];
    assert.equal(sourceMembership('project-host', registry), 'registered');
    assert.equal(sourceMembership('cursor-cloud-agent', registry), 'unregistered');
    assert.equal(sourceMembership('', registry), 'absent');
    assert.equal(sourceMembership('anything', []), 'open');
    await withEnv(REG, () => {
      assert.equal(requireRegisteredSource('project-host', 'emet_transcript_append'), 'project-host');
      assert.throws(() => requireRegisteredSource('stranger', 'emet_transcript_append'), /EMET-TOOL-004|is not registered/);
    });
  });

  test('2026-12-15T04:59Z is still the day before in New York, and 05:00Z is the cutoff', async () => {
    const { sourceSaveCivilDate, sourceSavePhase, sourceSaveCutoff } = await import('../src/source-registration.js');
    await withEnv({ EMET_SOURCE_SAVE_CUTOFF: undefined, CASCADE_SOURCE_SAVE_CUTOFF: undefined }, () => {
      assert.equal(sourceSaveCutoff(), '2026-12-15');
      assert.equal(sourceSaveCivilDate(BEFORE), '2026-12-14');
      assert.equal(sourceSaveCivilDate(ON), '2026-12-15');
      assert.equal(sourceSavePhase(BEFORE), 'before');
      assert.equal(sourceSavePhase(ON), 'on_or_after');
      assert.equal(sourceSaveCivilDate(new Date(NaN)), null);
      assert.equal(sourceSavePhase(new Date(NaN)), 'before');
    });
  });

  test('a bad cutoff value stays on 2026-12-15, and CASCADE_ is the fallback', async () => {
    const { sourceSaveCutoff, _resetSourceSaveCutoffWarningForTests } = await import('../src/source-registration.js');
    _resetSourceSaveCutoffWarningForTests();
    await withEnv({ EMET_SOURCE_SAVE_CUTOFF: 'tomorrow', CASCADE_SOURCE_SAVE_CUTOFF: '2099-01-01' }, () => {
      assert.equal(sourceSaveCutoff(), '2026-12-15');
    });
    await withEnv({ EMET_SOURCE_SAVE_CUTOFF: undefined, CASCADE_SOURCE_SAVE_CUTOFF: '2099-04-04' }, () => {
      assert.equal(sourceSaveCutoff(), '2099-04-04');
    });
    await withEnv({ EMET_SOURCE_SAVE_CUTOFF: ' 2027-06-01 ', CASCADE_SOURCE_SAVE_CUTOFF: undefined }, () => {
      assert.equal(sourceSaveCutoff(), '2027-06-01');
    });
  });
});

testGroup('save_to_layer', () => {
  test('a registered tag is stored on and after the cutoff, with no warning', async () => {
    for (const source of ['project-host', 'hub-bot', 'note-bot', 'cursor-cloud-agent']) {
      const env = source === 'cursor-cloud-agent'
        ? { ...REG, EMET_SOURCE_TAGS: `${REG.EMET_SOURCE_TAGS},cursor-cloud-agent` }
        : REG;
      const { receipt, db } = await save({ source }, env, ON);
      assert.equal(receipt.source, source);
      assert.equal(receipt.source_unregistered, undefined);
      assert.ok(!receipt.warnings.some((w) => /not registered/.test(w)), receipt.warnings.join(' '));
      assert.equal(db.writes.length, 1);
    }
  });

  test('an approved tag that is not in the env string is registered, the same as a transcript', async () => {
    const { loadApprovals, renderApprovals, _resetForTests } = await import('../src/attribution.js');
    _resetForTests();
    await loadApprovals({
      async readDoc() {
        return {
          content: renderApprovals({
            approved: {
              'cursor-cloud-agent': { basis: 'declared' },
              'Grok Bot (hub-bot)': { basis: 'declared' }
            },
            pending: {},
            denied: {},
            clients: {}
          }),
          version: 1
        };
      }
    }, { fresh: true });
    try {
      const { receipt } = await save({ source: 'cursor-cloud-agent' }, REG, ON);
      assert.equal(receipt.source, 'cursor-cloud-agent');
      assert.equal(receipt.source_unregistered, undefined);
      const named = await save({ source: 'Grok Bot (hub-bot)' }, REG, ON);
      assert.equal(named.receipt.source_unregistered, undefined);
      assert.ok(!named.receipt.warnings.some((w) => /not registered/.test(w)));
    } finally {
      _resetForTests();
    }
  });

  test('before the cutoff an unregistered save is kept and the warning names the date', async () => {
    const { receipt, db } = await save({ source: 'stranger' }, REG, BEFORE);
    assert.equal(receipt.source, 'stranger');
    assert.equal(receipt.source_unregistered, true);
    assert.equal(db.writes[0].doc.metadata.source_unregistered, true);
    const warning = receipt.warnings.find((w) => /not registered/.test(w));
    assert.ok(warning && warning.includes('2026-12-15') && warning.includes('America/New_York'), warning);
    assert.ok(!/project-host/.test(warning));
  });

  test('on the cutoff an unregistered save is refused and nothing is written', async () => {
    const db = layerDb();
    await assert.rejects(() => save({ source: 'stranger' }, REG, ON, db), refused);
    assert.equal(db.writes.length, 0);
  });

  test('a missing source stays source_missing after the cutoff', async () => {
    const { receipt, db } = await save({}, REG, ON);
    assert.equal(receipt.source_missing, true);
    assert.equal(receipt.source_unregistered, undefined);
    assert.ok(!receipt.warnings.some((w) => /not registered/.test(w)));
    assert.equal(db.writes.length, 1);
  });

  test('a default that is not on the list is unregistered', async () => {
    const { receipt } = await save({}, { ...REG, EMET_SOURCE_TAG: 'odd-host' }, BEFORE);
    assert.equal(receipt.source, 'odd-host');
    assert.equal(receipt.source_defaulted, true);
    assert.equal(receipt.source_unregistered, true);
    assert.ok(receipt.warnings.some((w) => w.includes('2026-12-15')));
    const db = layerDb();
    await assert.rejects(() => save({}, { ...REG, EMET_SOURCE_TAG: 'odd-host' }, ON, db), refused);
    assert.equal(db.writes.length, 0);
  });

  test('with no registry an unregistered-looking tag is stored after the cutoff', async () => {
    const { receipt } = await save({ source: 'stranger' }, { EMET_SOURCE_TAGS: undefined, EMET_SOURCE_TAG: undefined }, ON);
    assert.equal(receipt.source, 'stranger');
    assert.equal(receipt.source_unregistered, undefined);
    assert.ok(!receipt.warnings.some((w) => /not registered/.test(w)));
  });

  test('EMET_TEST_CLOCK is ignored unless EMET_UNDER_TEST is 1', async () => {
    const { sourceSaveNow } = await import('../src/source-registration.js');
    await withEnv({ EMET_TEST_CLOCK: '2026-12-16T15:00:00.000Z', EMET_UNDER_TEST: undefined }, () => {
      const at = sourceSaveNow();
      assert.ok(Math.abs(at.getTime() - Date.now()) < 5000, at.toISOString());
    });
    await withEnv({ EMET_TEST_CLOCK: '2026-12-16T15:00:00.000Z', EMET_UNDER_TEST: '1' }, () => {
      assert.equal(sourceSaveNow().toISOString(), '2026-12-16T15:00:00.000Z');
    });
  });

  test('EMET_TEST_CLOCK refuses an unregistered save that does not pass an instant', async () => {
    const db = layerDb();
    await withEnv({ ...REG, EMET_TEST_CLOCK: '2026-12-16T15:00:00.000Z', EMET_UNDER_TEST: '1' }, async () => {
      const { saveMemory } = await import('../src/tools.js');
      await assert.rejects(
        () => saveMemory(db, 'A durable fact about the cutoff.', 'working', { source: 'stranger' }),
        refused
      );
      assert.equal(db.writes.length, 0);
      const kept = await saveMemory(db, 'A durable fact about the cutoff.', 'working', { source: 'project-host' });
      assert.equal(kept.source, 'project-host');
      assert.equal(kept.source_unregistered, undefined);
    });
  });

  test('the three pending rename tags warn before the cutoff and are refused on it', async () => {
    for (const source of ['old-label', 'old-name', 'rename-cloud']) {
      const early = await save({ source }, REG, BEFORE);
      assert.equal(early.receipt.source, source);
      assert.equal(early.receipt.source_unregistered, true);
      assert.ok(early.receipt.warnings.some((w) => w.includes('2026-12-15') && w.includes(source)), early.receipt.warnings.join(' '));
      const db = layerDb();
      await assert.rejects(() => save({ source }, REG, ON, db), refused);
      assert.equal(db.writes.length, 0);
    }
  });

  test('a sub-key whose tag is not on the registry is refused after the cutoff', async () => {
    // A sub-key is issued only for a tag in EMET_SOURCE_TAGS. The key record is
    // not approvedTags(), so a tag later removed from the registry is the same
    // unregistered source a transcript append refuses.
    const { actorStore } = await import('../src/persons.js');
    const { requireRegisteredSource } = await import('../src/dispatch.js');
    const sub = {
      transport: 'http', authenticated: true, personId: 'owner', ownerId: 'owner',
      clientId: 'note-client', sourceTag: 'hub-bot', sourceBasis: 'subkey',
      effectiveTag: 'retired-bot', subkeyId: 'key-retired', door: 'member',
      grantId: 'grant-owner', scopes: ['emet.write']
    };
    const early = await actorStore.run(sub, () => save({ source: 'ignored' }, REG, BEFORE));
    assert.equal(early.receipt.source, 'retired-bot');
    assert.equal(early.db.writes[0].doc.metadata.source_basis, 'subkey');
    assert.equal(early.receipt.source_unregistered, true);
    assert.ok(early.receipt.warnings.some((w) => w.includes('2026-12-15')));
    const db = layerDb();
    await actorStore.run(sub, async () => {
      await assert.rejects(() => save({ source: 'ignored' }, REG, ON, db), refused);
    });
    assert.equal(db.writes.length, 0);
    await withEnv(REG, () => {
      assert.throws(() => requireRegisteredSource('retired-bot', 'emet_transcript_append'), /is not registered/);
    });
  });

  test('an owner-door bound tag and a sub-key tag still save after the cutoff', async () => {
    const { actorStore } = await import('../src/persons.js');
    const owner = {
      transport: 'http', authenticated: true, personId: 'owner', ownerId: 'owner',
      clientId: 'owner-client', sourceTag: 'project-host', sourceBasis: 'login',
      door: 'owner', grantId: 'grant-owner', scopes: ['emet.write']
    };
    const owned = await actorStore.run(owner, () => save({ source: 'stranger' }, REG, ON));
    assert.equal(owned.receipt.source, 'project-host');
    assert.equal(owned.receipt.source_unregistered, undefined);
    assert.ok(!owned.receipt.warnings.some((w) => /not registered/.test(w)));

    const sub = {
      ...owner,
      sourceTag: 'hub-bot',
      sourceBasis: 'subkey',
      effectiveTag: 'note-bot',
      subkeyId: 'key-note',
      door: 'member',
      clientId: 'note-client'
    };
    const keyed = await actorStore.run(sub, () => save({ source: 'stranger' }, REG, ON));
    assert.equal(keyed.receipt.source, 'note-bot');
    assert.equal(keyed.db.writes[0].doc.metadata.source_basis, 'subkey');
    assert.equal(keyed.receipt.source_unregistered, undefined);
    assert.ok(!keyed.receipt.warnings.some((w) => /not registered/.test(w)));
  });

  test('revise_memory uses the same gate and does not mark the parent when refused', async () => {
    const db = layerHonouringDb();
    await withEnv(REG, async () => {
      const { saveMemory, reviseMemory } = await import('../src/tools.js');
      const first = await saveMemory(db, 'The current semantic note.', 'semantic', {
        source: 'project-host',
        derived_from: { session_id: '2026-11-22_cutoff', exchange_start: 1, exchange_end: 1 }
      }, null, null, { now: BEFORE });
      await assert.rejects(
        () => reviseMemory(db, 'semantic', first.id, 'A revision from a stranger.', {
          source: 'stranger',
          derived_from: { session_id: '2026-11-22_cutoff', exchange_start: 1, exchange_end: 1 }
        }, null, { now: ON }),
        refused
      );
      assert.equal(db.row('semantic', first.id).superseded_by ?? null, null);
      assert.equal(db.writes.length, 1);
      const kept = await reviseMemory(db, 'semantic', first.id, 'A revision from the owner tag.', {
        source: 'project-host',
        derived_from: { session_id: '2026-11-22_cutoff', exchange_start: 1, exchange_end: 1 }
      }, null, { now: ON });
      assert.equal(kept.source, 'project-host');
      assert.equal(db.row('semantic', first.id).superseded_by, kept.id);
    });
  });
});

testGroup('dispatch', () => {
  test('a dispatch save with no ctx.now follows EMET_TEST_CLOCK', async () => {
    const store = makeStore();
    await withStore(store, () => withEnv({
      EMET_SOURCE_TAGS: REG.EMET_SOURCE_TAGS,
      EMET_SOURCE_TAG: undefined,
      EMET_SOURCE_SAVE_CUTOFF: undefined,
      CASCADE_SOURCE_SAVE_CUTOFF: undefined,
      EMET_TEST_CLOCK: '2026-12-16T15:00:00.000Z',
      EMET_UNDER_TEST: '1'
    }, async () => {
      const { dispatchTool } = await import('../src/dispatch.js');
      const refused = await dispatchTool('write_doc', {
        doc_id: 'drops/dispatch-late.md',
        content: 'a note from dispatch\n',
        source: 'stranger'
      }, { dbManager: store, logger: null });
      const body = JSON.parse(refused.content[0].text);
      assert.equal(body.success, false, JSON.stringify(body).slice(0, 500));
      assert.equal(body.error.emet_code, 'EMET-MEM-035');
      assert.match(body.error.message, /Nothing was written/);
      assert.equal(store.doc('drops/dispatch-late.md'), undefined);
      const kept = await dispatchTool('write_doc', {
        doc_id: 'drops/dispatch-kept.md',
        content: 'a registered note\n',
        source: 'project-host'
      }, { dbManager: store, logger: null });
      const keptBody = JSON.parse(kept.content[0].text);
      assert.equal(keptBody.success, true, JSON.stringify(keptBody).slice(0, 500));
      assert.equal(store.doc('drops/dispatch-kept.md').version, 1);
    }));
  });
});

testGroup('documents and legacy rows', () => {
  test('a new drop warns before the cutoff and is refused on it, and threads stay EMET-DOC-020', async () => {
    const store = makeStore();
    await withStore(store, () => withEnv(REG, async () => {
      const { writeDoc } = await import('../src/tools.js');
      await assert.rejects(
        () => writeDoc('threads/nope.md', '# No\n', 'stranger', null, null, { now: BEFORE }),
        (error) => error.emetCode === 'EMET-DOC-020' && /new drop only/.test(error.message)
      );
      const drop = await writeDoc('drops/early.md', 'a visitor note\n', 'stranger', null, null, { now: BEFORE });
      assert.equal(drop.version, 1);
      assert.ok(drop.warnings.some((w) => w.includes('2026-12-15') && w.includes('America/New_York')));
      await assert.rejects(
        () => writeDoc('drops/late.md', 'too late\n', 'stranger', null, null, { now: ON }),
        refused
      );
      assert.equal(store.doc('drops/late.md'), undefined);
      assert.equal(store.doc('threads/nope.md'), undefined);
      const ownerDrop = await writeDoc('drops/owner.md', 'owner note\n', 'project-host', null, null, { now: ON });
      assert.equal(ownerDrop.version, 1);
      assert.ok(!(ownerDrop.warnings || []).some((w) => /not registered/.test(w)));
    }));
  });

  test('a staged begin of an unregistered drop writes no stage on the cutoff', async () => {
    const store = makeStore();
    await withStore(store, () => withEnv(REG, async () => {
      const { beginStagedDoc } = await import('../src/staged-write.js');
      const early = await beginStagedDoc({ doc_id: 'drops/staged-early.md', source: 'stranger' }, null, BEFORE);
      assert.ok(early.warnings.some((w) => w.includes('2026-12-15')));
      assert.equal(store.collection('emet_doc_stages').docs.length, 1);
      await assert.rejects(
        () => beginStagedDoc({ doc_id: 'drops/staged-late.md', source: 'stranger' }, null, ON),
        refused
      );
      assert.equal(store.collection('emet_doc_stages').docs.length, 1);
      const keyed = await beginStagedDoc({ doc_id: 'drops/staged-note.md', source: 'note-bot' }, null, ON);
      assert.ok(!(keyed.warnings || []).some((w) => /not registered/.test(w)));
    }));
  });

  test('a legacy pre-attribution row stays readable and is not rewritten', async () => {
    const db = layerHonouringDb();
    const legacy = {
      id: 351,
      content: 'Tablet session before source tags were required.',
      metadata: { source: null },
      timestamp: Date.parse('2026-07-30T15:00:00.000Z') / 1000,
      is_live: true
    };
    db.byLayer.episodic = { 351: { ...legacy } };
    await withEnv(REG, async () => {
      const { saveMemory, queryLayer } = await import('../src/tools.js');
      await assert.rejects(
        () => saveMemory(db, 'A new stranger note.', 'working', { source: 'stranger' }, null, null, { now: ON }),
        refused
      );
      const still = await db.readMemory('episodic', 351);
      assert.equal(still.content, legacy.content);
      assert.equal(still.metadata.source, null);
      const page = await queryLayer(db, 'episodic', { filters: { id: 351 }, limit: 5 });
      const hit = page.find((row) => row.id === 351);
      assert.ok(hit, JSON.stringify(page.map((row) => row.id)));
      assert.equal(hit.content, legacy.content);
      assert.equal(db.writes.length, 0);
    });
  });

  test('an older document stays readable after an unregistered drop is refused', async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { writeDoc, readDoc } = await import('../src/tools.js');
      await withEnv({ EMET_SOURCE_TAGS: undefined, EMET_SOURCE_TAG: undefined }, () =>
        writeDoc('threads/legacy.md', '# Before attribution\n', null));
      const before = store.doc('threads/legacy.md').content;
      await withEnv(REG, async () => {
        await assert.rejects(
          () => writeDoc('drops/after.md', 'no\n', 'stranger', null, null, { now: ON }),
          refused
        );
      });
      const live = await readDoc('threads/legacy.md');
      assert.equal(live.content, before);
      assert.equal(store.doc('drops/after.md'), undefined);
      assert.equal(store.doc('threads/legacy.md').content, before);
    });
  });
});

testGroup('statechart', () => {
  test('the ten rows match the picture, the doc, and /statechart', async () => {
    const mod = await import('../src/source-save-statechart.js');
    const rows = mod.sourceSaveRows();
    assert.equal(rows.length, 10);
    const refusedRow = rows.find((row) => row.membership === 'unregistered' && row.phase === 'on_or_after');
    assert.equal(refusedRow.code, 'EMET-MEM-035');
    assert.equal(refusedRow.stored, false);
    const warned = rows.find((row) => row.membership === 'unregistered' && row.phase === 'before');
    assert.equal(warned.outcome, 'stored_warn');
    assert.equal(warned.stored, true);
    assert.ok(rows.filter((row) => row.membership === 'registered').every((row) => row.outcome === 'stored' && row.warned === false));
    assert.ok(rows.filter((row) => row.membership === 'legacy').every((row) => row.outcome === 'legacy_readable' && row.refused === false));
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'source-save-statechart.md'), 'utf8');
    const fenced = /```mermaid\n([\s\S]*?)\n```/.exec(doc);
    assert.ok(fenced);
    assert.equal(fenced[1], mod.SOURCE_SAVE_MERMAID);
    const { statechartBody } = await import('../src/access-statechart.js');
    const html = statechartBody();
    assert.match(html, /Unregistered source saves/);
    assert.match(html, /UnregisteredBefore/);
    assert.match(html, /LegacyRead/);
    assert.match(html, /EMET-MEM-035/);
  });
});

summary('Source save registration');
