// Installation GSI1 indexing + reconcile-on-read (src/shared/install-store.ts, ADR-037).
//
// The bug this pins: `listInstallations` enumerates installations from the GSI1 `INSTALLS`
// partition. An INSTALL row written before M4 has no `gsi1pk`, so it is invisible to that
// query — the console rendered "no installations" while the platform was claiming and
// running that very installation's jobs. Two invariants:
//   1. every installation WRITE stamps the GSI1 keys (so no new row is born invisible);
//   2. a legacy unindexed row still surfaces through the management read path, and gets
//      repaired on the way out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildInstallUpsert,
  installGsi1Keys,
  isUnindexedInstall,
  missingInstallationIds,
  needsIndexRepair,
  reconcileInstallations,
  installPk,
  listInstallations,
  INSTALL_SK,
  INSTALLS_GSI1PK,
} from '../dist/src/shared/install-store.js';
import { canAdminInstallation } from '../dist/src/mgmt/session.js';

const NOW = new Date('2026-07-29T00:00:00.000Z');

function install(over = {}) {
  return {
    entity: 'INSTALL',
    installationId: 146431062,
    accountLogin: 'jsamuel1',
    accountId: 3156090,
    suspended: false,
    deleted: false,
    createdAt: '2026-07-14T03:44:16.881Z',
    updatedAt: '2026-07-14T03:44:16.881Z',
    ...over,
  };
}

// ---- invariant 1: writes always carry the index keys ------------------------

test('installation index keys are the fixed partition + account login', () => {
  assert.deepEqual(installGsi1Keys('jsamuel1'), {
    gsi1pk: 'INSTALLS',
    gsi1sk: 'jsamuel1',
  });
  assert.equal(INSTALLS_GSI1PK, 'INSTALLS');
});

test('upsertInstallation ALWAYS writes both gsi1 keys', () => {
  const cmd = buildInstallUpsert(
    { installationId: 146431062, accountLogin: 'jsamuel1', accountId: 3156090 },
    NOW,
  );
  assert.deepEqual(cmd.Key, { pk: installPk(146431062), sk: INSTALL_SK });
  // The literal regression: a SET clause that omits these makes the row invisible.
  assert.match(cmd.UpdateExpression, /gsi1pk = :gpk/);
  assert.match(cmd.UpdateExpression, /gsi1sk = :gsk/);
  assert.equal(cmd.ExpressionAttributeValues[':gpk'], 'INSTALLS');
  assert.equal(cmd.ExpressionAttributeValues[':gsk'], 'jsamuel1');
});

test('the upsert stamps the index for every flag combination', () => {
  for (const flags of [
    {},
    { suspended: true },
    { deleted: true },
    { suspended: false, deleted: false },
  ]) {
    const cmd = buildInstallUpsert(
      { installationId: 1, accountLogin: 'acme', accountId: 2, ...flags },
      NOW,
    );
    assert.equal(cmd.ExpressionAttributeValues[':gpk'], 'INSTALLS', JSON.stringify(flags));
    assert.equal(cmd.ExpressionAttributeValues[':gsk'], 'acme', JSON.stringify(flags));
  }
});

test('the upsert never resets createdAt (re-install keeps first-seen)', () => {
  const cmd = buildInstallUpsert({ installationId: 1, accountLogin: 'a', accountId: 2 }, NOW);
  assert.match(cmd.UpdateExpression, /createdAt = if_not_exists\(createdAt, :now\)/);
});

test('a legacy row is recognised as unindexed, an M4 row is not', () => {
  assert.equal(isUnindexedInstall(install()), true); // no gsi1pk — the live dev row
  assert.equal(isUnindexedInstall(install({ gsi1pk: 'INSTALLS' })), false);
  assert.equal(isUnindexedInstall({ entity: 'REPO', repoId: 1 }), false);
});

test('the repair gate keys off the missing stamp, not the optional entity attribute', () => {
  // A row fetched by primary key (`INSTALL#<id>` / `INSTALL`) is an installation by
  // construction. `entity` is optional on the record type, so gating the repair on it would
  // leave such a row invisible to the console forever: this path would skip the write and
  // the backfill script's `entity = :e` scan filter would never see it either.
  const row = install();
  delete row.entity;
  assert.equal(needsIndexRepair(row), true, 'an entity-less legacy row is still repairable');
  assert.equal(needsIndexRepair(install()), true);
  assert.equal(needsIndexRepair(install({ gsi1pk: 'INSTALLS' })), false, 'already stamped');
  const noLogin = install();
  delete noLogin.accountLogin;
  assert.equal(needsIndexRepair(noLogin), false, 'gsi1sk would be undefined');
});

// ---- invariant 2: the read path surfaces unindexed rows ---------------------

test('nothing to reconcile when the index already returned every grant', () => {
  const indexed = [install({ installationId: 11 }), install({ installationId: 22 })];
  assert.deepEqual(missingInstallationIds(indexed, [11, 22]), []);
});

test('a granted id absent from the index is a reconcile candidate, de-duplicated', () => {
  const indexed = [install({ installationId: 11 })];
  assert.deepEqual(missingInstallationIds(indexed, [11, 22, 22, 33]), [22, 33]);
});

test('an empty index with no grants reconciles nothing (no unbounded fan-out)', () => {
  assert.deepEqual(missingInstallationIds([], []), []);
});

test('a legacy unindexed installation surfaces through the read path and is repaired', async () => {
  const legacy = install(); // installation 146431062 / jsamuel1, no gsi1pk
  const gets = [];
  const repairs = [];
  const out = await reconcileInstallations([], [146431062], {
    get: async (id) => {
      gets.push(id);
      return id === 146431062 ? legacy : undefined;
    },
    repair: async (input) => {
      repairs.push(input);
      return true;
    },
  });

  assert.equal(out.length, 1, 'the installation the platform is serving must be listed');
  assert.equal(out[0].accountLogin, 'jsamuel1');
  assert.deepEqual(gets, [146431062], 'exactly one GetItem — bounded by the grant list');
  assert.deepEqual(repairs, [{ installationId: 146431062, accountLogin: 'jsamuel1' }]);
});

test('reconcile is additive — indexed rows are preserved alongside recovered ones', async () => {
  const modern = install({ installationId: 22, accountLogin: 'acme', gsi1pk: 'INSTALLS' });
  const legacy = install({ installationId: 11, accountLogin: 'legacy' });
  const out = await reconcileInstallations([modern], [22, 11], {
    get: async (id) => (id === 11 ? legacy : undefined),
    repair: async () => true,
  });
  assert.deepEqual(
    out.map((i) => i.installationId).sort(),
    [11, 22],
    'a partially-indexed table must return BOTH rows',
  );
});

test('a grant for an installation we never stored is skipped, not faked', async () => {
  const out = await reconcileInstallations([], [999], {
    get: async () => undefined,
    repair: async () => {
      throw new Error('must not repair a row that does not exist');
    },
  });
  assert.deepEqual(out, []);
});

test('a failed repair still returns the row (read must not fail on a write fault)', async () => {
  const out = await reconcileInstallations([], [11], {
    get: async () => install({ installationId: 11 }),
    repair: async () => {
      throw new Error('AccessDeniedException');
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].installationId, 11);
});

test('a lost repair race is not an error (idempotent conditional write)', async () => {
  const out = await reconcileInstallations([], [11], {
    get: async () => install({ installationId: 11 }),
    repair: async () => false, // ConditionalCheckFailed → someone else stamped it
  });
  assert.equal(out.length, 1);
});

test('an already-indexed row reached by reconcile is returned but never rewritten', async () => {
  // A truncated/eventually-consistent index page can put an already-stamped row in the
  // candidate set. Repairing it would be a pointless conditional write per poll.
  const out = await reconcileInstallations([], [11], {
    get: async () => install({ installationId: 11, gsi1pk: 'INSTALLS', gsi1sk: 'mine' }),
    repair: async () => {
      throw new Error('must not repair an already-indexed row');
    },
  });
  assert.equal(out.length, 1, 'the row is still surfaced to the console');
  assert.equal(out[0].installationId, 11);
});

test('a row with no accountLogin is surfaced but not stamped with an undefined sort key', async () => {
  // `gsi1sk` IS the account login; writing it undefined would fail the write (or index the
  // row under a meaningless key). The backfill script skips the same case.
  const out = await reconcileInstallations([], [11], {
    get: async () => {
      const row = install({ installationId: 11 });
      delete row.accountLogin;
      return row;
    },
    repair: async () => {
      throw new Error('must not repair a row with no accountLogin');
    },
  });
  assert.equal(out.length, 1);
});

test('an entity-less legacy row is still repaired through the read path', async () => {
  // Regression: an earlier revision gated the repair on `entity === 'INSTALL'`. A row keyed
  // `INSTALL#<id>`/`INSTALL` is an installation whether or not it carries that attribute,
  // and the backfill script cannot rescue it (its scan filters on `entity`).
  const legacy = install({ installationId: 11 });
  delete legacy.entity;
  const repairs = [];
  const out = await reconcileInstallations([], [11], {
    get: async () => legacy,
    repair: async (input) => {
      repairs.push(input);
      return true;
    },
  });
  assert.equal(out.length, 1);
  assert.deepEqual(repairs, [{ installationId: 11, accountLogin: 'jsamuel1' }]);
});

test('reconcile cannot widen authorization beyond the session grants', async () => {
  // The handler passes session grants as candidates AND filters the result. A row recovered
  // for a foreign id would still be dropped — but it must never be fetched in the first place.
  const session = {
    login: 'operator',
    installations: [{ installationId: 11, accountLogin: 'mine' }],
    iat: 0,
    exp: 2 ** 40,
  };
  const fetched = [];
  const out = await reconcileInstallations(
    [],
    session.installations.map((i) => i.installationId),
    {
      get: async (id) => {
        fetched.push(id);
        return install({ installationId: id, accountLogin: 'mine' });
      },
      repair: async () => true,
    },
  );
  assert.deepEqual(fetched, [11], 'only granted ids are read by primary key');
  assert.ok(out.every((i) => canAdminInstallation(session, i.installationId)));
});

test('listInstallations requires an explicit grant list (no silent zero-arg regression)', () => {
  // A default of [] would let a future caller write `listInstallations()` and get the exact
  // pre-ADR-037 behaviour back — index-only, legacy rows invisible — with no compile error.
  // Pinned on the source because the arity is the contract, not runtime behaviour.
  const src = readFileSync(
    new URL('../src/shared/install-store.ts', import.meta.url),
    'utf8',
  );
  const sig =
    /export async function listInstallations\(\s*reconcileIds: readonly number\[\](\s*=[^,)]*)?,?\s*\)/.exec(
      src,
    );
  assert.ok(sig, 'listInstallations signature not found');
  assert.equal(sig[1], undefined, 'reconcileIds must NOT have a default value');
  assert.equal(listInstallations.length, 1, 'the grant list is a required parameter');
});
