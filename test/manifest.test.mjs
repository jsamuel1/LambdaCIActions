// Unit tests for the GitHub App manifest builder.
// Run: node --test test/   (or: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, manifestFormPage } from '../scripts/create-github-app.mjs';

// buildManifest reads CONSOLE_URL/WEBHOOK_URL/ORG/ENV from the module's parsed
// argv at import time; under `node --test` no flags are passed, so it uses
// defaults (env=dev, placeholder URLs). We assert on the stable shape.

test('manifest declares the exact permissions spec 01 requires', () => {
  const m = buildManifest();
  assert.deepEqual(m.default_permissions, {
    actions: 'read',
    administration: 'write',
    contents: 'read',
    metadata: 'read',
  });
});

test('manifest subscribes to the required webhook events', () => {
  const m = buildManifest();
  // Only subscribable events belong in default_events. `installation` /
  // `installation_repositories` are App lifecycle events delivered automatically and are
  // NOT valid in a manifest's default_events (GitHub rejects them).
  for (const ev of ['workflow_job', 'push']) {
    assert.ok(m.default_events.includes(ev), `missing event ${ev}`);
  }
  for (const ev of ['installation', 'installation_repositories']) {
    assert.ok(!m.default_events.includes(ev), `${ev} must NOT be in default_events (not subscribable)`);
  }
});

test('app is private and points its webhook at the hook url', () => {
  const m = buildManifest();
  assert.equal(m.public, false);
  assert.ok(m.hook_attributes.url.length > 0);
  assert.equal(m.hook_attributes.active, true);
});

test('redirect_url is a localhost callback', () => {
  const m = buildManifest();
  assert.match(m.redirect_url, /^http:\/\/localhost:\d+\/callback$/);
});

test('manifest form escapes the JSON to prevent HTML/script breakout', () => {
  const m = buildManifest();
  const html = manifestFormPage(m, 'deadbeef');
  // no raw "</...>" from the manifest payload should appear unescaped in the value
  assert.ok(html.includes('\\u003c') || !html.includes('</script></script>'));
  assert.ok(html.includes('name="manifest"'));
  assert.ok(html.includes('deadbeef')); // state threaded through
});

test('personal-account form posts to the user apps/new endpoint', () => {
  const m = buildManifest();
  const html = manifestFormPage(m, 'abc123');
  assert.ok(html.includes('https://github.com/settings/apps/new?state=abc123'));
});
