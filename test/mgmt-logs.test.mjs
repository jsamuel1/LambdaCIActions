// Log-viewer locator + tail semantics (spec 04 § Run detail, M4 review fixes, ADR-048).
//
// Two classes of bug live here, and only one of them was previously covered:
//
//  1. TAIL semantics — CloudWatch's FilterLogEvents stops issuing `nextToken` once a filter
//     is caught up, so a client that re-sends the last token replays the same page forever.
//  2. LOCATOR direction — the microVM id is a stream-name SUFFIX
//     (`2026/08/03[10.0]microvm-…`), so `logStreamNamePrefix: microvmId` matches nothing and
//     the pane renders `0 events` forever. That shipped, because the old stub replied from a
//     scripted queue and ignored the locator arguments entirely: no test in this file could
//     observe a wrong direction, and its fixture names (`vm-1/x`) were even id-prefixed.
//
// So the stub below is a small CloudWatch MODEL, not a response queue: it holds streams and
// events and honours `logStreamNamePrefix` / `logStreamNames` / `startTime` / `limit` /
// `nextToken` / `orderBy` the way the service does — including rejecting the
// prefix+`orderBy: LastEventTime` combination the API forbids. A locator regression now
// fails as an empty page, which is exactly how it manifests in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRunLogs, resolveLogStreamName, streamBelongsTo, _setClient } from '../dist/src/mgmt/logs.js';
import { parseEpochMs } from '../dist/src/mgmt/validate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VM = 'microvm-98c2f28c-2463-3526-a201-ef44bd494d15';
/** A real stream name from dev (us-west-2, /aws/lambda/microvms/runs/lca-dev). */
const REAL_STREAM = `2026/08/03[10.0]${VM}`;

/**
 * CloudWatch Logs model.
 *
 * @param streams `[{ name, events?: [{ timestamp, message }], lastEventTimestamp? }]`
 * @param opts    `{ error: { on: 'DescribeLogStreams'|'FilterLogEvents', err } }`
 */
function fakeCloudWatch(streams = [], opts = {}) {
  const sent = [];
  const all = streams.map((s) => ({
    logStreamName: s.name,
    events: s.events ?? [],
    lastEventTimestamp:
      s.lastEventTimestamp ?? (s.events?.length ? s.events[s.events.length - 1].timestamp : 0),
  }));

  function describe(input) {
    if (input.logStreamNamePrefix && input.orderBy === 'LastEventTime') {
      const err = new Error('orderBy LastEventTime cannot be combined with logStreamNamePrefix');
      err.name = 'InvalidParameterException';
      throw err;
    }
    let matched = input.logStreamNamePrefix
      ? all.filter((s) => s.logStreamName.startsWith(input.logStreamNamePrefix))
      : [...all];
    matched =
      input.orderBy === 'LastEventTime'
        ? matched.sort((a, b) =>
            input.descending
              ? b.lastEventTimestamp - a.lastEventTimestamp
              : a.lastEventTimestamp - b.lastEventTimestamp,
          )
        : matched.sort((a, b) => a.logStreamName.localeCompare(b.logStreamName));
    const from = input.nextToken ? Number(input.nextToken.replace('s-', '')) : 0;
    const size = input.limit ?? 50;
    const page = matched.slice(from, from + size);
    const more = from + size < matched.length;
    return {
      logStreams: page.map((s) => ({
        logStreamName: s.logStreamName,
        lastEventTimestamp: s.lastEventTimestamp,
      })),
      ...(more ? { nextToken: `s-${from + size}` } : {}),
    };
  }

  function filter(input) {
    assert.equal(
      input.logStreamNamePrefix,
      undefined,
      'FilterLogEvents must locate by exact stream name, never by a microVM-id prefix',
    );
    const names = input.logStreamNames;
    const picked = names ? all.filter((s) => names.includes(s.logStreamName)) : all;
    let events = picked
      .flatMap((s) => s.events.map((e) => ({ ...e, logStreamName: s.logStreamName })))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (input.startTime !== undefined) events = events.filter((e) => e.timestamp >= input.startTime);
    const from = input.nextToken ? Number(input.nextToken.replace('e-', '')) : 0;
    const size = input.limit ?? 200;
    const page = events.slice(from, from + size);
    const more = from + size < events.length;
    return { events: page, ...(more ? { nextToken: `e-${from + size}` } : {}) };
  }

  return {
    sent,
    names: () => sent.map((c) => c.name),
    client: {
      async send(cmd) {
        const name = cmd.constructor.name.replace('Command', '');
        sent.push({ name, input: cmd.input });
        if (opts.error?.on === name) throw opts.error.err;
        return name === 'DescribeLogStreams' ? describe(cmd.input) : filter(cmd.input);
      },
    },
  };
}

/** Guard on the model itself: the shipped locator direction must be unable to pass. */
test('the stub filters by prefix the way CloudWatch does (so a bad locator fails)', async () => {
  const s = fakeCloudWatch([{ name: REAL_STREAM, events: [{ timestamp: 1, message: 'x' }] }]);
  _setClient(s.client);
  // Exactly the call the defect made: prefix = microVM id. CloudWatch matches nothing.
  const res = await s.client.send({
    constructor: { name: 'DescribeLogStreamsCommand' },
    input: { logGroupName: '/g', logStreamNamePrefix: VM },
  });
  assert.deepEqual(res.logStreams, [], 'the id is a suffix — a prefix scan cannot see it');
  _setClient(undefined);
});

test('streamBelongsTo matches the id anywhere in the name, not just at the front', () => {
  assert.equal(streamBelongsTo(REAL_STREAM, VM), true);
  assert.equal(streamBelongsTo(`${VM}/extra`, VM), true, 'a prefixed layout still matches');
  assert.equal(streamBelongsTo('2026/08/03[10.0]microvm-deadbeef', VM), false);
});

test('a run with no microVM is pending without touching CloudWatch', async () => {
  const s = fakeCloudWatch();
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: undefined });
  assert.deepEqual(page, { events: [], pending: true });
  assert.equal(s.sent.length, 0);
  _setClient(undefined);
});

// THE regression: a date-decorated stream name (the only kind the service produces).
test('a date-stamped stream is resolved and read by exact name', async () => {
  const s = fakeCloudWatch([
    { name: '2026/08/03[10.0]microvm-unrelated-vm', events: [{ timestamp: 1, message: 'other' }] },
    {
      name: REAL_STREAM,
      events: [
        { timestamp: 10, message: 'Running job: m4-console' },
        { timestamp: 20, message: 'Job m4-console completed with result: Succeeded' },
      ],
    },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
    limit: 7,
  });
  assert.equal(page.pending, false);
  assert.equal(page.logStream, REAL_STREAM);
  assert.deepEqual(
    page.events.map((e) => e.message),
    ['Running job: m4-console', 'Job m4-console completed with result: Succeeded'],
  );
  assert.equal(page.events[0].stream, REAL_STREAM);
  assert.deepEqual(s.names(), ['DescribeLogStreams', 'FilterLogEvents']);
  assert.equal(s.sent[0].input.logStreamNamePrefix, '2026/08/03', 'scan bounded by run date');
  assert.deepEqual(s.sent[1].input.logStreamNames, [REAL_STREAM]);
  assert.equal(s.sent[1].input.limit, 7);
  assert.equal(s.sent[1].input.startTime, undefined, 'no watermark on a token-less first page');
  _setClient(undefined);
});

test("a VM that launched after midnight UTC is found on the run date's next day", async () => {
  const s = fakeCloudWatch([{ name: `2026/08/04[10.0]${VM}`, events: [{ timestamp: 5, message: 'a' }] }]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T23:59:30.000Z',
  });
  assert.equal(page.logStream, `2026/08/04[10.0]${VM}`);
  assert.deepEqual(
    s.sent.filter((c) => c.name === 'DescribeLogStreams').map((c) => c.input.logStreamNamePrefix),
    ['2026/08/03', '2026/08/04'],
  );
  _setClient(undefined);
});

test('a run with no usable createdAt falls back to a recency-ordered scan', async () => {
  const s = fakeCloudWatch([
    { name: '2026/07/01[9.0]microvm-old-vm', events: [{ timestamp: 1, message: 'old' }] },
    { name: REAL_STREAM, events: [{ timestamp: 900, message: 'mine' }] },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: VM, runCreatedAt: 'not-a-date' });
  assert.equal(page.logStream, REAL_STREAM);
  const describe = s.sent.find((c) => c.name === 'DescribeLogStreams').input;
  assert.equal(describe.logStreamNamePrefix, undefined);
  assert.equal(describe.orderBy, 'LastEventTime');
  assert.equal(describe.descending, true);
  _setClient(undefined);
});

// The fallback's whole point is surviving a stream name the date tiers cannot predict. It is
// only load-bearing if it runs for a run row with a PERFECTLY GOOD createdAt — which is every
// production row — and not merely for the garbled-date case above.
//
// Scope: this covers a changed name FORMAT, which empties the date namespace for every stream
// at once. A single stream stamped off-window while the queue date holds other streams is a
// different case, and is deliberately NOT found — pinned by the test below it.
test('a stream stamped with an unexpected date is still found when the date tiers list nothing', async () => {
  const s = fakeCloudWatch([
    // Neither the queue date nor the day after, and nothing else under either: this is what a
    // changed date/version decoration looks like from the resolver's side.
    { name: `2026/08/06[10.0]${VM}`, events: [{ timestamp: 5, message: 'runner output' }] },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.equal(page.pending, false, 'an unpredicted date must degrade to recency, not to empty');
  assert.equal(page.logStream, `2026/08/06[10.0]${VM}`);
  assert.deepEqual(
    page.events.map((e) => e.message),
    ['runner output'],
  );
  assert.equal(
    s.sent.some((c) => c.name === 'DescribeLogStreams' && c.input.orderBy === 'LastEventTime'),
    true,
    'the date prefixes listed nothing, so nothing ruled the stream out',
  );
  _setClient(undefined);
});

// The other side of the authoritative-miss rule, and the reason the test above is scoped to an
// EMPTY date namespace: once the queue date holds real streams, an exhausted date scan rules
// the stream out and the fallback never runs. A VM stamped outside [D, D+1] — clock skew, or a
// launch more than a day after the queue — is then unresolvable. That is the deliberate price
// of keeping the ordinary "not written yet" poll at two describes instead of a group scan
// (ADR-048, second residual limit); pinned so it stays a known cost, not a surprise.
test('an off-window stream is NOT found once the queue date is populated (documented residual)', async () => {
  const s = fakeCloudWatch([
    { name: '2026/08/03[10.0]microvm-someone-else', events: [{ timestamp: 1, message: 'other' }] },
    { name: `2026/08/06[10.0]${VM}`, events: [{ timestamp: 5, message: 'mine' }] },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.deepEqual(page, { events: [], pending: true });
  assert.deepEqual(
    s.sent.map((c) => c.input.logStreamNamePrefix),
    ['2026/08/03', '2026/08/04'],
    'a populated, exhausted date namespace is an authoritative miss — no whole-group scan',
  );
  assert.equal(
    s.sent.some((c) => c.input.orderBy === 'LastEventTime'),
    false,
    'if this starts running the fallback, the cost claims in ADR-048 need re-measuring',
  );
  _setClient(undefined);
});

// Budget arithmetic, not policy: the date tiers must not be able to spend the calls the
// fallback needs. A live run's stream is the newest in the group, so recency finds it on its
// first page — but only if there is a page left to spend.
test('a date scan truncated by the budget still reaches the recency fallback', async () => {
  // 5 000 streams on the run's own date, all sorting BEFORE the run's stream by name (so a
  // name-ordered date scan is truncated before reaching it) and all older by event time (so
  // recency ordering reaches it first).
  const busy = Array.from({ length: 5_000 }, (_, i) => ({
    name: `2026/08/03[10.0]microvm-0other-${String(i).padStart(5, '0')}`,
    events: [{ timestamp: i, message: 'noise' }],
  }));
  const s = fakeCloudWatch([
    ...busy,
    { name: REAL_STREAM, events: [{ timestamp: 99_999_999, message: 'mine' }] },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.equal(page.logStream, REAL_STREAM);
  assert.deepEqual(
    page.events.map((e) => e.message),
    ['mine'],
  );
  const describes = s.sent.filter((c) => c.name === 'DescribeLogStreams');
  assert.equal(
    describes.some((c) => c.input.orderBy === 'LastEventTime'),
    true,
    'a truncated date scan rules nothing out, so the fallback must still run',
  );
  assert.ok(describes.length <= 12, `still inside the shared budget, got ${describes.length}`);
  _setClient(undefined);
});

test('the scan pages past the first page of a busy group', async () => {
  const filler = Array.from({ length: 60 }, (_, i) => ({
    name: `2026/08/03[10.0]microvm-0filler-${String(i).padStart(3, '0')}`,
    events: [{ timestamp: i, message: 'noise' }],
  }));
  // Name-ordered scans sort ascending and the filler ids start '0' against the real id's
  // '9', so the run's own stream lands past the first 50-stream page.
  const s = fakeCloudWatch([...filler, { name: REAL_STREAM, events: [{ timestamp: 99, message: 'mine' }] }]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.equal(page.logStream, REAL_STREAM);
  assert.deepEqual(
    page.events.map((e) => e.message),
    ['mine'],
    'only the run’s own stream is read, never the whole group',
  );
  assert.equal(s.sent.filter((c) => c.name === 'DescribeLogStreams').length, 2);
  _setClient(undefined);
});

test('the resolved name is cached, so a 4 s log poll does not re-scan the group', async () => {
  const s = fakeCloudWatch([{ name: REAL_STREAM, events: [{ timestamp: 10, message: 'a' }] }]);
  _setClient(s.client);
  const args = { logGroupName: '/g', microvmId: VM, runCreatedAt: '2026-08-03T10:00:00.000Z' };
  await fetchRunLogs(args);
  await fetchRunLogs({ ...args, startTime: 11 });
  await fetchRunLogs({ ...args, startTime: 12 });
  assert.equal(s.sent.filter((c) => c.name === 'DescribeLogStreams').length, 1);
  assert.equal(s.sent.filter((c) => c.name === 'FilterLogEvents').length, 3);
  _setClient(undefined);
});

test('a VM with no stream yet is pending and reads nothing', async () => {
  const s = fakeCloudWatch([{ name: '2026/08/03[10.0]microvm-someone-else' }]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.deepEqual(page, { events: [], pending: true });
  assert.equal(s.names().includes('FilterLogEvents'), false, 'nothing to read → no read');
  // Both of the run's own dates were listed to their end AND held real streams, so the miss
  // is authoritative: the whole-group recency fallback is not spent re-answering it.
  assert.deepEqual(
    s.sent.map((c) => c.input.logStreamNamePrefix),
    ['2026/08/03', '2026/08/04'],
    'no unbounded fallback scan once the run’s own dates are exhausted',
  );
  // A miss must stay retryable: the stream appears seconds later while the VM boots.
  s.sent.length = 0;
  const streams = [{ name: REAL_STREAM, events: [{ timestamp: 1, message: 'booted' }] }];
  const s2 = fakeCloudWatch(streams);
  _setClient(s2.client);
  const later = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.equal(later.pending, false);
  assert.equal(later.logStream, REAL_STREAM);
  _setClient(undefined);
});

// The pane polls logs every 4 s. A queued/booting VM resolves to nothing on every one of
// those polls, so an uncached miss re-scans the group each time: 7 describes/poll on a busy
// group ≈ 1.8 TPS from ONE viewer, against an account-wide 5 TPS DescribeLogStreams quota that
// a second viewer would push past — and a ThrottlingException is a 500, not a pending pane.
test('polling a booting VM does not re-scan the group on every poll', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // A busy day: 300 streams under the run's date, none of them this run's.
  const busy = Array.from({ length: 300 }, (_, i) => ({
    name: `2026/08/03[10.0]microvm-other-${String(i).padStart(4, '0')}`,
    events: [{ timestamp: i, message: 'noise' }],
  }));
  const s = fakeCloudWatch(busy);
  _setClient(s.client);
  const args = { logGroupName: '/g', microvmId: VM, runCreatedAt: '2026-08-03T10:00:00.000Z' };

  const first = await fetchRunLogs(args);
  assert.equal(first.pending, true);
  const perAttempt = s.sent.length;
  assert.ok(perAttempt <= 12, `one attempt must stay inside the shared budget, got ${perAttempt}`);

  // Three more polls inside the miss TTL cost nothing at all.
  s.sent.length = 0;
  t.mock.timers.tick(4_000);
  assert.equal((await fetchRunLogs(args)).pending, true);
  assert.equal(s.sent.length, 0, 'a cached miss is reused, not re-derived');

  // Once the TTL lapses the miss is re-derived — so a stream that appeared is picked up.
  t.mock.timers.tick(2_000);
  const s2 = fakeCloudWatch([...busy, { name: REAL_STREAM, events: [{ timestamp: 9, message: 'booted' }] }]);
  // Swap the backing data without _setClient (which clears the caches) to prove the TTL,
  // not the reset, is what makes the retry happen.
  s.client.send = s2.client.send;
  const later = await fetchRunLogs(args);
  assert.equal(later.pending, false, 'the TTL lapsed, so the stream is found');
  assert.equal(later.logStream, REAL_STREAM);
  t.mock.timers.reset();
  _setClient(undefined);
});

test('a busy queue date cannot starve the next-day scan out of budget', async () => {
  // 5 000 streams on the queue date exhaust the budget without matching; the VM actually
  // launched just after midnight, so only the next-day prefix can find it.
  const busy = Array.from({ length: 5_000 }, (_, i) => ({
    name: `2026/08/03[10.0]microvm-other-${String(i).padStart(5, '0')}`,
    events: [{ timestamp: i, message: 'noise' }],
  }));
  const s = fakeCloudWatch([...busy, { name: `2026/08/04[10.0]${VM}`, events: [{ timestamp: 1, message: 'mine' }] }]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T23:59:30.000Z',
  });
  assert.equal(page.logStream, `2026/08/04[10.0]${VM}`);
  assert.deepEqual(
    page.events.map((e) => e.message),
    ['mine'],
  );
  const describes = s.sent.filter((c) => c.name === 'DescribeLogStreams').length;
  assert.ok(describes <= 12, `still inside the shared budget, got ${describes} describes`);
  _setClient(undefined);
});

test('the scan budget is shared across tiers, not multiplied by them', async () => {
  // No usable date → the recency fallback is the only tier, over a group far larger than
  // the budget can walk. It must stop at the budget instead of paging the whole group.
  const huge = Array.from({ length: 5_000 }, (_, i) => ({
    name: `2026/08/03[10.0]microvm-other-${String(i).padStart(5, '0')}`,
    events: [{ timestamp: i, message: 'noise' }],
  }));
  const s = fakeCloudWatch(huge);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: VM, runCreatedAt: 'not-a-date' });
  assert.equal(page.pending, true);
  assert.ok(s.sent.length <= 12, `budget must bound the scan, got ${s.sent.length} calls`);
  assert.ok(s.sent.length >= 2, 'but it must actually page, not give up after one');
  _setClient(undefined);
});

test('nextToken wins over the watermark (they describe contradictory windows)', async () => {
  const s = fakeCloudWatch([
    {
      name: REAL_STREAM,
      events: [
        { timestamp: 1, message: 'a' },
        { timestamp: 9, message: 'b' },
      ],
    },
  ]);
  _setClient(s.client);
  await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
    nextToken: 'e-1',
    startTime: 5,
  });
  const filter = s.sent.find((c) => c.name === 'FilterLogEvents').input;
  assert.equal(filter.nextToken, 'e-1');
  assert.equal(filter.startTime, undefined);
  _setClient(undefined);
});

test('paging a token through does not replay the page already read', async () => {
  const s = fakeCloudWatch([
    {
      name: REAL_STREAM,
      events: [
        { timestamp: 1, message: 'a' },
        { timestamp: 2, message: 'b' },
        { timestamp: 3, message: 'c' },
      ],
    },
  ]);
  _setClient(s.client);
  const args = { logGroupName: '/g', microvmId: VM, runCreatedAt: '2026-08-03T10:00:00.000Z', limit: 2 };
  const first = await fetchRunLogs(args);
  assert.deepEqual(first.events.map((e) => e.message), ['a', 'b']);
  assert.ok(first.nextToken);
  const second = await fetchRunLogs({ ...args, nextToken: first.nextToken });
  assert.deepEqual(second.events.map((e) => e.message), ['c']);
  assert.equal(second.nextToken, undefined, 'caught up → CloudWatch stops issuing tokens');
  _setClient(undefined);
});

test('with no token, the watermark resumes the tail instead of replaying', async () => {
  const s = fakeCloudWatch([
    {
      name: REAL_STREAM,
      events: [
        { timestamp: 10, message: 'a' },
        { timestamp: 20, message: 'b' },
      ],
    },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
    startTime: 21,
  });
  assert.equal(s.sent.find((c) => c.name === 'FilterLogEvents').input.startTime, 21);
  assert.deepEqual(page.events, []);
  // A resumed tail that returns nothing is "caught up", NOT "pending" — the UI must not
  // flash "no log stream yet" over already-rendered output.
  assert.equal(page.pending, false);
  _setClient(undefined);
});

test('a missing log group is a normal pending state, not a 500', async () => {
  const err = new Error('no such group');
  err.name = 'ResourceNotFoundException';
  const s = fakeCloudWatch([{ name: REAL_STREAM }], { error: { on: 'DescribeLogStreams', err } });
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: VM });
  assert.deepEqual(page, { events: [], pending: true });
  _setClient(undefined);
});

test('a stream that vanishes between resolve and read is pending, not a 500', async () => {
  const err = new Error('stream gone');
  err.name = 'ResourceNotFoundException';
  const s = fakeCloudWatch([{ name: REAL_STREAM }], { error: { on: 'FilterLogEvents', err } });
  _setClient(s.client);
  const page = await fetchRunLogs({
    logGroupName: '/g',
    microvmId: VM,
    runCreatedAt: '2026-08-03T10:00:00.000Z',
  });
  assert.deepEqual(page, { events: [], pending: true });
  _setClient(undefined);
});

test('other CloudWatch failures propagate (the handler maps them to 500)', async () => {
  const err = new Error('throttled');
  err.name = 'ThrottlingException';
  const s = fakeCloudWatch([{ name: REAL_STREAM }], { error: { on: 'DescribeLogStreams', err } });
  _setClient(s.client);
  await assert.rejects(() => fetchRunLogs({ logGroupName: '/g', microvmId: VM }), /throttled/);
  _setClient(undefined);
});

test('resolution is exposed on its own, so callers can report the stream name', async () => {
  const s = fakeCloudWatch([{ name: REAL_STREAM }]);
  _setClient(s.client);
  assert.equal(
    await resolveLogStreamName('/g', VM, '2026-08-03T10:00:00.000Z'),
    REAL_STREAM,
  );
  assert.equal(await resolveLogStreamName('/g', 'microvm-nope', '2026-08-03T10:00:00.000Z'), undefined);
  _setClient(undefined);
});

test('the since watermark is validated, so junk never reaches CloudWatch', () => {
  assert.equal(parseEpochMs('1753000000000'), 1753000000000);
  assert.equal(parseEpochMs('0'), 0);
  assert.equal(parseEpochMs(undefined), undefined);
  assert.equal(parseEpochMs('-5'), undefined);
  assert.equal(parseEpochMs('12.5'), undefined);
  assert.equal(parseEpochMs('now'), undefined);
  assert.equal(parseEpochMs('9'.repeat(20)), undefined);
});

// ---------------------------------------------------------------------------------------
// Wiring pins (source-level, the repo's existing pattern — see test/image-content.test.mjs).
//
// Everything above tests `fetchRunLogs` with arguments the TEST supplies. That is exactly the
// blind spot that let the original defect ship: a locator can be perfect in the module and
// wrong at the call site, and no test in this file would notice.
// ---------------------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

test('the logs route bounds resolution with the run’s own createdAt', () => {
  const handler = src('src/mgmt/handler.ts');
  const route = handler.slice(
    handler.indexOf("case 'getRunLogs':"),
    handler.indexOf("case 'listFlavors':"),
  );
  assert.ok(route.length > 0, 'getRunLogs case not found — update this test');
  // Without this the resolver has no date tier at all and degrades to the recency fallback,
  // which by construction cannot find a FINISHED run's stream (ADR-048 residual limit) —
  // i.e. the original "0 events forever" symptom, with every test above still green.
  assert.match(route, /runCreatedAt:\s*run\.record\.createdAt/);
  // And the resolved name has to reach the client, or the pane cannot report it.
  assert.match(route, /logStream:\s*page\.logStream\s*\?\?\s*null/);
});

test('the log pane reports the resolved stream per poll, not from buffered pages', () => {
  const pane = src('web/src/screens/RunDetail.tsx');
  // `pages` only holds pages that CARRIED events, so a stream resolved for a run that has
  // written nothing (or whose events aged out) would never be shown — the one case where the
  // name is the difference between "nothing written yet" and "resolution failed".
  assert.match(pane, /if \(page\.logStream\) setLogStream\(page\.logStream\)/);
  assert.doesNotMatch(
    pane,
    /pages\.find\(\(p\) => p\.logStream\)/,
    'deriving the stream name from buffered pages hides it on an empty pane',
  );
  // Run identity change must clear it, or a new run inherits the previous run's stream.
  const reset = pane.slice(pane.indexOf('setPages([]);'), pane.indexOf('}, [repoId, runId, jobId]);'));
  assert.match(reset, /setLogStream\(null\)/);
});
