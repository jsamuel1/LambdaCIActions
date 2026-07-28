// WebStack posture tests (spec 04 § Tech choices, ADR-022 — M4 review fixes).
//
// Two invariants are easy to break by "helpfully" re-adding a CloudFront convenience:
//   1. custom error responses are DISTRIBUTION-wide, so an SPA 403/404 → /index.html rewrite
//      also rewrites the management API's 403/404 into 200 + HTML;
//   2. the console bucket must never be public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WebStack } from '../dist/lib/web-stack.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function synth() {
  const app = new App();
  const web = new WebStack(app, 'Web', {
    env: { account: '123456789012', region: 'us-west-2' },
    envName: 'test',
    apiHost: 'abc123.execute-api.us-west-2.amazonaws.com',
  });
  return Template.fromStack(web);
}

function distribution(t) {
  const found = Object.values(t.findResources('AWS::CloudFront::Distribution'));
  assert.equal(found.length, 1, 'expected exactly one distribution');
  return found[0].Properties.DistributionConfig;
}

test('no custom error responses — they would corrupt the API 403/404 contract', () => {
  const cfg = distribution(synth());
  assert.equal(
    cfg.CustomErrorResponses,
    undefined,
    'custom error responses apply to /api/* too — they must stay off (ADR-022)',
  );
});

test('the console bucket blocks all public access', () => {
  synth().hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('api + auth behaviors disable caching and forward to the API origin', () => {
  const cfg = distribution(synth());
  const paths = cfg.CacheBehaviors.map((b) => b.PathPattern).sort();
  assert.deepEqual(paths, ['/api/*', '/auth/*']);
  const s3OriginId = cfg.DefaultCacheBehavior.TargetOriginId;
  for (const b of cfg.CacheBehaviors) {
    assert.notEqual(b.TargetOriginId, s3OriginId, 'API behavior must not point at S3');
    // CACHING_DISABLED is an AWS managed policy id — assert it is NOT the same policy the
    // default (CACHING_OPTIMIZED) behavior uses.
    assert.notEqual(b.CachePolicyId, cfg.DefaultCacheBehavior.CachePolicyId);
  }
});

test('viewers are redirected to HTTPS on every behavior', () => {
  const cfg = distribution(synth());
  assert.equal(cfg.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  for (const b of cfg.CacheBehaviors) {
    assert.equal(b.ViewerProtocolPolicy, 'redirect-to-https');
  }
  // Note: with no custom domain/ACM cert (M5), CloudFormation emits no `ViewerCertificate`
  // at all — the distribution uses the default *.cloudfront.net cert and CloudFront pins the
  // TLS floor itself, so the stack's `minimumProtocolVersion` is inert until an alias is
  // attached. Asserted here so nobody reads it as an enforced control.
  assert.equal(cfg.ViewerCertificate, undefined);
});

test('the app shell ships a self-only CSP that denies framing', () => {
  const t = synth();
  const policies = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
  assert.equal(policies.length, 1);
  const security = policies[0].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
  const csp = security.ContentSecurityPolicy.ContentSecurityPolicy;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(csp.includes('unsafe-inline'), false, 'no unsafe-inline in the console CSP');
  assert.equal(security.StrictTransportSecurity.Override, true);
  // The S3 (app shell) behavior must actually reference it.
  const cfg = distribution(t);
  assert.ok(cfg.DefaultCacheBehavior.ResponseHeadersPolicyId, 'shell has no headers policy');
});

test('the SPA source carries no inline style attributes (CSP style-src self)', () => {
  // `style-src 'self'` with no `unsafe-inline` means browsers DROP `style="..."` attributes.
  // React's `style={{...}}` prop compiles to exactly that, so any inline style would work in
  // a dev server and silently vanish behind CloudFront. Layout lives in web/src/styles.css.
  const webSrc = path.join(REPO_ROOT, 'web', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('style={{')) {
        offenders.push(path.relative(webSrc, p));
      }
    }
  };
  walk(webSrc);
  assert.deepEqual(offenders, [], 'inline styles are dropped by the console CSP');
});
