// Log-viewer tail semantics (spec 04 § Run detail, M4 review fixes).
//
// The tail is the one place where a wrong parameter choice silently costs correctness:
// CloudWatch's FilterLogEvents stops issuing `nextToken` once a filter is caught up, so a
// client that re-sends the last token replays the same page forever. These tests pin the
// token/watermark contract and the `pending` semantics the UI renders on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRunLogs, _setClient } from '../dist/src/mgmt/logs.js';
import { parseEpochMs } from '../dist/src/mgmt/validate.js';

/** Record every command sent, replying with a scripted queue of responses. */
function stub(responses) {
  const sent = [];
  const queue = [...responses];
  return {
    sent,
    client: {
      async send(cmd) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? {};
      },
    },
  };
}

test('a run with no microVM is pending without touching CloudWatch', async () => {
  const s = stub([]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: undefined });
  assert.deepEqual(page, { events: [], pending: true });
  assert.equal(s.sent.length, 0);
  _setClient(undefined);
});

test('first page filters by the microVM stream prefix and returns its token', async () => {
  const s = stub([
    {
      events: [{ timestamp: 10, message: 'a', logStreamName: 'vm-1/x' }],
      nextToken: 'tok-1',
    },
  ]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1', limit: 7 });
  assert.equal(page.pending, false);
  assert.equal(page.nextToken, 'tok-1');
  assert.deepEqual(page.events, [{ timestamp: 10, message: 'a', stream: 'vm-1/x' }]);
  const input = s.sent[0].input;
  assert.equal(input.logStreamNamePrefix, 'vm-1');
  assert.equal(input.limit, 7);
  assert.equal(input.startTime, undefined, 'no watermark on a token-less first page');
  _setClient(undefined);
});

test('nextToken wins over the watermark (they describe contradictory windows)', async () => {
  const s = stub([{ events: [], nextToken: 'tok-2' }]);
  _setClient(s.client);
  await fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1', nextToken: 'tok-1', startTime: 5 });
  assert.equal(s.sent[0].input.nextToken, 'tok-1');
  assert.equal(s.sent[0].input.startTime, undefined);
  _setClient(undefined);
});

test('with no token, the watermark resumes the tail instead of replaying', async () => {
  const s = stub([{ events: [] }]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1', startTime: 1234 });
  assert.equal(s.sent[0].input.startTime, 1234);
  assert.equal(s.sent[0].input.nextToken, undefined);
  // A resumed tail that returns nothing is "caught up", NOT "pending" — the UI must not
  // flash "no log stream yet" over already-rendered output.
  assert.equal(page.pending, false);
  _setClient(undefined);
});

test('an empty cold page checks for a stream before claiming pending', async () => {
  const s = stub([{ events: [] }, { logStreams: [] }]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1' });
  assert.equal(page.pending, true, 'no stream yet → pending');
  assert.deepEqual(
    s.sent.map((c) => c.name),
    ['FilterLogEventsCommand', 'DescribeLogStreamsCommand'],
  );
  _setClient(undefined);
});

test('an empty cold page with an existing stream is caught up, not pending', async () => {
  const s = stub([{ events: [] }, { logStreams: [{ logStreamName: 'vm-1/x' }] }]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1' });
  assert.equal(page.pending, false);
  _setClient(undefined);
});

test('a missing log group is a normal pending state, not a 500', async () => {
  const err = new Error('no such group');
  err.name = 'ResourceNotFoundException';
  const s = stub([err]);
  _setClient(s.client);
  const page = await fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1' });
  assert.deepEqual(page, { events: [], pending: true });
  _setClient(undefined);
});

test('other CloudWatch failures propagate (the handler maps them to 500)', async () => {
  const err = new Error('throttled');
  err.name = 'ThrottlingException';
  const s = stub([err]);
  _setClient(s.client);
  await assert.rejects(() => fetchRunLogs({ logGroupName: '/g', microvmId: 'vm-1' }), /throttled/);
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
