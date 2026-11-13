// Console Flavors screen (spec 04 § Flavors, ADR-040/041) — rendered for real in jsdom.
//
// These pin three behaviours that are invisible to `tsc` and to every server-side test, because
// the server is correct in each case and only the SCREEN is wrong:
//
//   1. Scope binding. `useApi` keeps the previous read on screen while a new one is in flight. If
//      the Flavors screen rendered that read after an installation switch, installation A's rows
//      would carry installation B's Delete/Re-validate scope, and a same-named flavor in both would
//      let a click on A's row mutate B. Rows are now tagged with the installation that produced
//      them and only render for the current selection.
//   2. Validation progress. The smoke λ runs asynchronously for minutes, so the screen must poll
//      while any custom row is pending/validating and stop once every row is terminal.
//   3. The two-step registration is enforced. Register needs a passing preview computed for
//      EXACTLY the current installation + payload, and a preview that resolves after an edit, a
//      newer Check or an installation switch is dropped.
//
// `web/src/screens/Platform.tsx` is bundled with esbuild (already a devDependency), React and all,
// into a temp module, so the test exercises the shipped component through a real DOM.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- DOM + bundle ----------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://console.test/',
  pretendToBeVisual: true, // makes document.visibilityState === 'visible', which polling requires
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// Node ≥21 ships a getter-only `navigator`; define over it rather than assigning.
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// In a browser bundle React's `act` queues work through a fresh `MessageChannel` per call, and
// Node keeps every port with a listener ref'd — so the test process would never exit. Unref them.
const NodeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NodeMessageChannel {
  constructor() {
    super();
    const unrefOnListen = (port) => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(port), 'onmessage')?.set;
      if (!set) return;
      Object.defineProperty(port, 'onmessage', {
        configurable: true,
        set(fn) {
          set.call(port, fn);
          port.unref?.();
        },
      });
    };
    unrefOnListen(this.port1);
    unrefOnListen(this.port2);
  }
};

/** Interval registry: polling is driven by hand so the test is deterministic and instant. */
const intervals = new Map();
let nextInterval = 1;
window.setInterval = (fn, ms) => {
  const id = nextInterval++;
  intervals.set(id, { fn, ms });
  return id;
};
window.clearInterval = (id) => {
  intervals.delete(id);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-web-flavors-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// A live jsdom window (pretendToBeVisual runs an animation-frame loop) keeps the process alive.
after(() => window.close());
const entry = path.join(tmp, 'entry.tsx');
fs.writeFileSync(
  entry,
  [
    `export { Flavors, FLAVOR_POLL_MS } from ${JSON.stringify(path.join(repoRoot, 'web/src/screens/Platform.tsx'))};`,
    `export { act, createElement } from 'react';`,
    `export { createRoot } from 'react-dom/client';`,
  ].join('\n'),
);
const outfile = path.join(tmp, 'bundle.mjs');
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  nodePaths: [path.join(repoRoot, 'node_modules')],
  // Development React: `act` is only available there.
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});
const { Flavors, FLAVOR_POLL_MS, act, createElement, createRoot } = await import(`file://${outfile}`);

// ---- fake API --------------------------------------------------------------

/**
 * Every request is recorded and HELD until the test answers it, except those an auto-responder
 * claims. That is what lets a test order responses deliberately (B before a late A, a preview after
 * an edit) instead of hoping a timing window reproduces.
 */
function fakeApi(auto = () => undefined) {
  const calls = [];
  globalThis.fetch = window.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, url: String(url), body, settled: false };
    calls.push(call);
    const respond = (status, payload) => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(payload),
    });
    const canned = auto(call);
    if (canned !== undefined) {
      call.settled = true;
      return respond(canned.status ?? 200, canned.body ?? canned);
    }
    return new Promise((resolve) => {
      call.answer = (payload, status = 200) => {
        call.settled = true;
        resolve(respond(status, payload));
      };
    });
  };
  /** The newest still-held request matching method + URL prefix. */
  const held = (method, prefix) => {
    const c = [...calls].reverse().find((x) => !x.settled && x.method === method && x.url.startsWith(prefix));
    assert.ok(c, `expected a held ${method} ${prefix}; saw ${calls.map((x) => `${x.method} ${x.url}`).join(', ')}`);
    return c;
  };
  return { calls, held };
}

const INSTALLS = {
  installations: [
    { installationId: 1, accountLogin: 'alpha' },
    { installationId: 2, accountLogin: 'bravo' },
  ],
};
const baseAuto = (c) => {
  if (c.method === 'GET' && c.url === '/api/installations') return INSTALLS;
  if (c.method === 'GET' && c.url === '/api/flavors') return { flavors: [] };
  return undefined;
};

function customRow(name, state, extra = {}) {
  return {
    name,
    label: `lambda-ci-${name}`,
    arch: 'arm64',
    vcpu: 2,
    memoryMb: 4096,
    capabilities: [],
    description: '',
    usdPerMinute: 0.0044,
    imageAvailable: true,
    custom: true,
    validationState: state,
    routable: state === 'valid',
    ...extra,
  };
}
const scopedBody = (rows) => ({ flavors: rows, customFlavorsRead: 'ok', readiness: [] });

// ---- DOM helpers -----------------------------------------------------------

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  intervals.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(createElement(Flavors)));
  await flush();
  return root;
}

const text = () => document.body.textContent;
const buttons = (label) => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === label);
const button = (label) => {
  const [b] = buttons(label);
  assert.ok(b, `no "${label}" button`);
  return b;
};

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function selectInstallation(id) {
  const sel = document.querySelector('select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await act(async () => {
    setter.call(sel, String(id));
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await flush();
}

async function type(placeholder, value) {
  const el = document.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(el, `no input with placeholder ${placeholder}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await flush();
}

const NAME = 'gpu';
const IMAGE = 'arn:aws:lambda:us-west-2:123456789012:microvm-image:my-image';
async function fillForm(base = 'gpu', image = 'arn:aws:lambda:us-west-2:111111111111:microvm-image:img') {
  await type(NAME, base);
  await type(IMAGE, image);
}

const previewOk = (name) => ({
  name: `custom-${name}`,
  label: `lambda-ci-custom-${name}`,
  usdPerMinute: 0.0044,
  rateIsEstimate: true,
  staticGate: { ok: true },
  note: 'static checks only',
});

// ---- 1. scope binding -------------------------------------------------------

test('installation switch: A rows never render with B scope, and a late A read cannot overwrite B', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();

  await selectInstallation(1);
  api.held('GET', '/api/flavors?installation=1').answer(
    scopedBody([customRow('custom-gpu', 'invalid', { imageArn: 'arn:A', validationReason: 'A reason' })]),
  );
  await flush();
  assert.match(text(), /arn:A/);
  assert.equal(buttons('Delete').length, 1);

  // Switch to B while B's read is held. A's rows must disappear: every button on them would now
  // be B-scoped, and B also has a `custom-gpu`.
  await selectInstallation(2);
  assert.doesNotMatch(text(), /arn:A/, "A's rows must not stay on screen under B's scope");
  assert.equal(buttons('Delete').length, 0, 'no mutation control may exist while the scope is unsettled');
  assert.equal(buttons('Re-validate').length, 0);
  assert.equal(buttons('Register').length, 0, "A's draft form must not survive into B");
  assert.match(text(), /Loading flavors/);

  api.held('GET', '/api/flavors?installation=2').answer(
    scopedBody([customRow('custom-gpu', 'invalid', { imageArn: 'arn:B' })]),
  );
  await flush();
  assert.match(text(), /arn:B/);
  assert.doesNotMatch(text(), /arn:A/);

  await click(button('Delete'));
  const del = api.calls.filter((c) => c.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.equal(del[0].url, '/api/flavors/custom-gpu?installation=2', 'the click targets the row it was rendered from');
  del[0].answer({ deleted: 'custom-gpu' });
  await flush();
  await act(async () => root.unmount());
});

test('a slow read for the previous installation is discarded, not rendered over the current one', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();

  await selectInstallation(1);
  const lateA = api.held('GET', '/api/flavors?installation=1');
  await selectInstallation(2);
  api.held('GET', '/api/flavors?installation=2').answer(
    scopedBody([customRow('custom-gpu', 'valid', { imageArn: 'arn:B' })]),
  );
  await flush();
  lateA.answer(scopedBody([customRow('custom-gpu', 'invalid', { imageArn: 'arn:A' })]));
  await flush();

  assert.match(text(), /arn:B/);
  assert.doesNotMatch(text(), /arn:A/);
  await click(button('Re-validate'));
  const rv = api.calls.filter((c) => c.method === 'POST' && c.url.includes('/revalidate'));
  assert.equal(rv.length, 1);
  assert.equal(rv[0].url, '/api/flavors/custom-gpu/revalidate?installation=2');
  rv[0].answer({ flavor: null, validationTriggered: true });
  await flush();
  await act(async () => root.unmount());
});

test('a registration in flight when the installation changes reports to its own scope only', async () => {
  const api = fakeApi((c) => {
    if (c.method === 'POST' && c.url.startsWith('/api/flavors/preview')) return previewOk('gpu');
    return baseAuto(c);
  });
  const root = await mount();
  await selectInstallation(1);
  api.held('GET', '/api/flavors?installation=1').answer(scopedBody([]));
  await flush();
  await fillForm();
  await click(button('Check'));
  await click(button('Register'));
  const reg = api.held('POST', '/api/flavors?installation=1');

  await selectInstallation(2);
  api.held('GET', '/api/flavors?installation=2').answer(scopedBody([]));
  await flush();
  reg.answer({ flavor: {}, validationTriggered: true, note: 'validation started', smokeWorkflow: 'YAML-FOR-A' }, 201);
  await flush();
  // A's register response must not leak A's note or smoke workflow into B's screen.
  assert.doesNotMatch(text(), /YAML-FOR-A/);
  assert.doesNotMatch(text(), /validation started/);
  await act(async () => root.unmount());
});

// ---- 2. validation progress -------------------------------------------------

test('validation progress polls pending → validating → invalid with the reason, then stops', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await selectInstallation(1);
  api.held('GET', '/api/flavors?installation=1').answer(scopedBody([customRow('custom-gpu', 'pending')]));
  await flush();
  assert.match(text(), /pending/);

  const polls = () => [...intervals.values()].filter((i) => i.ms === FLAVOR_POLL_MS);
  assert.equal(polls().length, 1, 'a pending row must arm the poll');

  const tick = async () => {
    await act(async () => polls()[0].fn());
    await flush();
  };

  await tick();
  api.held('GET', '/api/flavors?installation=1').answer(
    scopedBody([customRow('custom-gpu', 'validating', { validationReason: 'launching smoke VM' })]),
  );
  await flush();
  assert.match(text(), /validating/);
  assert.match(text(), /launching smoke VM/);
  assert.equal(polls().length, 1, 'still in flight → still polling');

  await tick();
  api.held('GET', '/api/flavors?installation=1').answer(
    scopedBody([customRow('custom-gpu', 'invalid', { validationReason: 'the Actions runner never registered' })]),
  );
  await flush();
  assert.match(text(), /invalid/);
  assert.match(text(), /the Actions runner never registered/);
  assert.equal(polls().length, 0, 'every row terminal → polling stops');
  await act(async () => root.unmount());
});

test('validation progress reaches valid without a reload; a hidden tab does not poll', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await selectInstallation(1);
  api.held('GET', '/api/flavors?installation=1').answer(scopedBody([customRow('custom-gpu', 'validating')]));
  await flush();
  const [poll] = [...intervals.values()].filter((i) => i.ms === FLAVOR_POLL_MS);
  assert.ok(poll);

  const before = api.calls.length;
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await act(async () => poll.fn());
  await flush();
  assert.equal(api.calls.length, before, 'a hidden tab must not bill reads');
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

  await act(async () => poll.fn());
  await flush();
  api.held('GET', '/api/flavors?installation=1').answer(scopedBody([customRow('custom-gpu', 'valid')]));
  await flush();
  assert.match(text(), /valid/);
  assert.equal([...intervals.values()].filter((i) => i.ms === FLAVOR_POLL_MS).length, 0);
  await act(async () => root.unmount());
});

test('no polling when every custom flavor is terminal or no installation is selected', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  assert.equal([...intervals.values()].filter((i) => i.ms === FLAVOR_POLL_MS).length, 0);
  await selectInstallation(1);
  api.held('GET', '/api/flavors?installation=1').answer(
    scopedBody([customRow('custom-a', 'valid'), customRow('custom-b', 'invalid')]),
  );
  await flush();
  assert.equal([...intervals.values()].filter((i) => i.ms === FLAVOR_POLL_MS).length, 0);
  await act(async () => root.unmount());
});

// ---- 3. two-step registration ----------------------------------------------

async function scopedForm(api) {
  await selectInstallation(1);
  api.held('GET', '/api/flavors?installation=1').answer(scopedBody([]));
  await flush();
}

test('Register is refused without a current passing preview', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await scopedForm(api);
  await fillForm();

  assert.equal(button('Register').disabled, true, 'no preview → Register disabled');
  await click(button('Register'));
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0, 'clicking must not POST');

  // The handler refuses on its own, not only via `disabled` (which is a render behind the form):
  // invoke React's onClick directly, bypassing the DOM's disabled-button suppression.
  const reg = button('Register');
  const propsKey = Object.keys(reg).find((k) => k.startsWith('__reactProps$'));
  await act(async () => {
    await reg[propsKey].onClick();
  });
  await flush();
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0, 'handler must not POST without a preview');
  assert.match(text(), /Run Check on the current values first/);

  // A FAILING preview does not unlock it either.
  await click(button('Check'));
  api.held('POST', '/api/flavors/preview?installation=1').answer({
    ...previewOk('gpu'),
    staticGate: { ok: false, failures: [{ code: 'not-arm64', message: 'image is x86_64' }] },
  });
  await flush();
  assert.match(text(), /image is x86_64/);
  assert.equal(button('Register').disabled, true);

  // An edit after a PASSING preview re-locks it.
  await type(NAME, 'gpu2');
  await click(button('Check'));
  api.held('POST', '/api/flavors/preview?installation=1').answer(previewOk('gpu2'));
  await flush();
  assert.equal(button('Register').disabled, false);
  await type(NAME, 'gpu3');
  assert.equal(button('Register').disabled, true, 'an edit invalidates the verdict');
  assert.doesNotMatch(text(), /custom-gpu2/);
  await act(async () => root.unmount());
});

test('a preview that resolves after an edit is discarded', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await scopedForm(api);
  await fillForm('gpu');
  await click(button('Check'));
  const stale = api.held('POST', '/api/flavors/preview?installation=1');
  assert.equal(stale.body.base, 'gpu');

  await type(NAME, 'cuda');
  stale.answer(previewOk('gpu'));
  await flush();
  assert.doesNotMatch(text(), /custom-gpu ·|label lambda-ci-custom-gpu/, 'stale verdict must not repopulate');
  assert.equal(button('Register').disabled, true);
  await act(async () => root.unmount());
});

test('an older Check resolving after a newer one cannot replace it', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await scopedForm(api);
  await fillForm('gpu');
  await click(button('Check'));
  const first = api.held('POST', '/api/flavors/preview?installation=1');
  await type(NAME, 'cuda');
  await click(button('Check'));
  const second = api.held('POST', '/api/flavors/preview?installation=1');
  assert.notEqual(first, second);

  second.answer(previewOk('cuda'));
  await flush();
  first.answer(previewOk('gpu'));
  await flush();
  assert.match(text(), /lambda-ci-custom-cuda/);
  assert.doesNotMatch(text(), /lambda-ci-custom-gpu/);

  await click(button('Register'));
  const reg = api.held('POST', '/api/flavors?installation=1');
  assert.equal(reg.body.base, 'cuda', 'registers exactly the previewed payload');
  reg.answer({ flavor: {}, validationTriggered: true, note: 'validation started' }, 201);
  await flush();
  await act(async () => root.unmount());
});

test('a preview in flight across an installation switch never reaches the new form', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await scopedForm(api);
  await fillForm('gpu');
  await click(button('Check'));
  const inflight = api.held('POST', '/api/flavors/preview?installation=1');

  await selectInstallation(2);
  api.held('GET', '/api/flavors?installation=2').answer(scopedBody([]));
  await flush();
  inflight.answer(previewOk('gpu'));
  await flush();

  assert.doesNotMatch(text(), /lambda-ci-custom-gpu/);
  const nameInput = document.querySelector(`input[placeholder="${NAME}"]`);
  assert.equal(nameInput.value, '', "A's draft is not carried into B");
  assert.equal(button('Register').disabled, true);
  await act(async () => root.unmount());
});

test('the happy path: Check passes, Register posts the previewed payload to the shown installation', async () => {
  const api = fakeApi(baseAuto);
  const root = await mount();
  await scopedForm(api);
  await fillForm('gpu');
  await click(button('Check'));
  api.held('POST', '/api/flavors/preview?installation=1').answer(previewOk('gpu'));
  await flush();
  assert.match(text(), /static checks pass/);
  assert.match(text(), /estimate/);
  assert.equal(button('Register').disabled, false);

  await click(button('Register'));
  const reg = api.held('POST', '/api/flavors?installation=1');
  assert.equal(reg.body.base, 'gpu');
  reg.answer({ flavor: {}, validationTriggered: true, note: 'validation started', smokeWorkflow: 'name: lca-validate' }, 201);
  await flush();
  // The post-register reload is issued, and the smoke workflow for THIS installation is shown.
  api.held('GET', '/api/flavors?installation=1').answer(scopedBody([customRow('custom-gpu', 'pending')]));
  await flush();
  assert.match(text(), /name: lca-validate/);
  assert.match(text(), /pending/);
  await act(async () => root.unmount());
});
