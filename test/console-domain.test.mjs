// Console vanity-domain config resolution (ADR-036).
//
// The origin these functions produce is load-bearing in three coupled places — PUBLIC_ORIGIN,
// the GitHub App OAuth callback (browser-only to edit), and the first-party session cookie —
// so the failure mode for a bad value is "login is broken until a human edits GitHub in a
// browser". These tests pin the scheme and the refuse-on-partial-config behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConsoleDomain,
  consoleHostname,
  normalizeZoneName,
  CONSOLE_LABEL,
} from '../dist/lib/console-domain.js';

const ZONE = { LCA_CONSOLE_HOSTED_ZONE_ID: 'Z02507931YD34U5I9XM3T', LCA_CONSOLE_ZONE_NAME: 'example.com' };

test('no LCA_CONSOLE_* config → null (raw CloudFront path stays available)', () => {
  assert.equal(resolveConsoleDomain({ envName: 'dev', envLocal: null }), null);
  assert.equal(resolveConsoleDomain({ envName: 'dev', envLocal: {} }), null);
  // Empty strings are treated as unset, not as a half-configured domain.
  assert.equal(
    resolveConsoleDomain({
      envName: 'dev',
      envLocal: { LCA_CONSOLE_HOSTED_ZONE_ID: '', LCA_CONSOLE_ZONE_NAME: '  ' },
    }),
    null,
  );
});

test('prod owns the bare project label; other envs are prefixed', () => {
  assert.equal(consoleHostname('prod', 'example.com'), `${CONSOLE_LABEL}.example.com`);
  assert.equal(consoleHostname('dev', 'example.com'), `dev.${CONSOLE_LABEL}.example.com`);
  assert.equal(consoleHostname('staging', 'example.com'), `staging.${CONSOLE_LABEL}.example.com`);
});

test('resolve builds the origin and keeps the zone attributes', () => {
  const dev = resolveConsoleDomain({ envName: 'dev', envLocal: ZONE });
  assert.equal(dev.hostname, `dev.${CONSOLE_LABEL}.example.com`);
  assert.equal(dev.origin, `https://dev.${CONSOLE_LABEL}.example.com`);
  assert.equal(dev.hostedZoneId, ZONE.LCA_CONSOLE_HOSTED_ZONE_ID);
  assert.equal(dev.zoneName, 'example.com');

  const prod = resolveConsoleDomain({ envName: 'prod', envLocal: ZONE });
  assert.equal(prod.origin, `https://${CONSOLE_LABEL}.example.com`);
});

test('origin is https and carries no trailing slash (PUBLIC_ORIGIN contract)', () => {
  // src/mgmt/handler.ts strips trailing slashes, but the OAuth callback registered on the
  // App must match byte-for-byte — so produce the canonical form here.
  const { origin } = resolveConsoleDomain({ envName: 'dev', envLocal: ZONE });
  assert.match(origin, /^https:\/\//);
  assert.equal(origin.endsWith('/'), false);
});

test('context overrides beat .env.local', () => {
  const d = resolveConsoleDomain({
    envName: 'dev',
    envLocal: ZONE,
    contextZoneName: 'other.test',
    contextHostedZoneId: 'ZOTHER1234567',
  });
  assert.equal(d.zoneName, 'other.test');
  assert.equal(d.hostedZoneId, 'ZOTHER1234567');
  assert.equal(d.hostname, `dev.${CONSOLE_LABEL}.other.test`);
});

test('an explicit domain override bypasses the scheme but must stay inside the zone', () => {
  const d = resolveConsoleDomain({
    envName: 'dev',
    envLocal: { ...ZONE, LCA_CONSOLE_DOMAIN: 'console.example.com' },
  });
  assert.equal(d.hostname, 'console.example.com');
  assert.equal(d.origin, 'https://console.example.com');

  // Outside the zone: the alias + ACM validation records live in that zone, so validation
  // would hang forever and the alias would never resolve.
  assert.throws(
    () =>
      resolveConsoleDomain({
        envName: 'dev',
        envLocal: { ...ZONE, LCA_CONSOLE_DOMAIN: 'console.elsewhere.net' },
      }),
    /not inside hosted zone/,
  );
});

test('an override is still validated as a DNS hostname', () => {
  // The override skips the scheme, so it must not skip label validation — an unvalidated
  // hostname reaches ACM + CloudFront + Route53 verbatim and fails mid-deploy.
  for (const bad of ['console bad.example.com', 'con_sole.example.com', '-x.example.com']) {
    assert.throws(
      () =>
        resolveConsoleDomain({
          envName: 'dev',
          envLocal: { ...ZONE, LCA_CONSOLE_DOMAIN: bad },
        }),
      /not a valid DNS hostname/,
      `expected "${bad}" to be rejected`,
    );
  }
});

test('the zone apex itself is accepted', () => {
  const d = resolveConsoleDomain({
    envName: 'prod',
    envLocal: { ...ZONE, LCA_CONSOLE_DOMAIN: 'example.com' },
  });
  assert.equal(d.hostname, 'example.com');
});

test('partial config throws rather than silently falling back', () => {
  // Silent fallback is the dangerous case: the distribution would come up with no alias
  // while PUBLIC_ORIGIN pointed at the vanity name → login breaks with a misleading error.
  assert.throws(
    () =>
      resolveConsoleDomain({
        envName: 'dev',
        envLocal: { LCA_CONSOLE_ZONE_NAME: 'example.com' },
      }),
    /hosted zone id is required/,
  );
  assert.throws(
    () =>
      resolveConsoleDomain({
        envName: 'dev',
        envLocal: { LCA_CONSOLE_HOSTED_ZONE_ID: ZONE.LCA_CONSOLE_HOSTED_ZONE_ID },
      }),
    /zone name is required/,
  );
  assert.throws(
    () =>
      resolveConsoleDomain({
        envName: 'dev',
        envLocal: { LCA_CONSOLE_DOMAIN: 'console.example.com' },
      }),
    /hosted zone id is required/,
  );
});

test('a `/hostedzone/...` path is rejected with a pointed message', () => {
  // Route53's list-hosted-zones returns the id in that form — pasting it verbatim is the
  // most likely operator mistake.
  assert.throws(
    () =>
      resolveConsoleDomain({
        envName: 'dev',
        envLocal: { ...ZONE, LCA_CONSOLE_HOSTED_ZONE_ID: '/hostedzone/Z02507931YD34U5I9XM3T' },
      }),
    /not a Route53 zone id/,
  );
});

test('zone names are normalized (trailing dot, case)', () => {
  assert.equal(normalizeZoneName('Example.COM.'), 'example.com');
  const d = resolveConsoleDomain({
    envName: 'dev',
    envLocal: { ...ZONE, LCA_CONSOLE_ZONE_NAME: 'Example.COM.' },
  });
  assert.equal(d.hostname, `dev.${CONSOLE_LABEL}.example.com`);
  assert.throws(() => normalizeZoneName('not a domain'), /not a valid DNS name/);
});

test('a non-DNS-label env name is rejected', () => {
  assert.throws(() => consoleHostname('Dev_1', 'example.com'), /not a valid DNS label/);
});

test('an env name that is not a legal DNS label is rejected in every spelling', () => {
  // A derived hostname skips the LCA_CONSOLE_DOMAIN override's `isDnsName` check, so the
  // label rule here is the only guard. A trailing hyphen (`dev-`) is the realistic slip: it
  // would otherwise reach ACM + CloudFront + Route53 verbatim and fail mid-deploy.
  for (const bad of ['dev-', '-dev', 'dev_1', 'dev.x', 'dev x', '', 'a'.repeat(64)]) {
    assert.throws(
      () => consoleHostname(bad, 'example.com'),
      /not a valid DNS label/,
      `expected env name "${bad}" to be rejected`,
    );
    assert.throws(
      () => resolveConsoleDomain({ envName: bad, envLocal: ZONE }),
      /not a valid DNS label/,
      `expected resolve() to reject env name "${bad}"`,
    );
  }
  // Legal labels with inner hyphens/digits still work.
  assert.equal(consoleHostname('dev-2', 'example.com'), `dev-2.${CONSOLE_LABEL}.example.com`);
  assert.equal(consoleHostname('a', 'example.com'), `a.${CONSOLE_LABEL}.example.com`);
});
