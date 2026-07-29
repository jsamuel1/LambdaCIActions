// Console vanity-domain infrastructure (ADR-028).
//
// Two failure modes are invisible at synth time and expensive at deploy time:
//   1. an ACM cert in any region but us-east-1 — CloudFront rejects it, so the deploy fails
//      on the distribution update AFTER the cert has been issued and validated;
//   2. an alias with no AAAA record — IPv6-only clients can resolve the raw CloudFront
//      domain but not the vanity one, which looks like an intermittent outage.
// Both are pinned here, along with the no-domain fallback that keeps a domain-less account
// deployable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CertStack } from '../dist/lib/cert-stack.js';
import { WebStack } from '../dist/lib/web-stack.js';

const ACCOUNT = '123456789012';
const DOMAIN = {
  hostname: 'dev.lambdaciactions.example.com',
  origin: 'https://dev.lambdaciactions.example.com',
  hostedZoneId: 'Z02507931YD34U5I9XM3T',
  zoneName: 'example.com',
};

function certStack(region = 'us-east-1') {
  const app = new App();
  return new CertStack(app, 'Cert', {
    env: { account: ACCOUNT, region },
    envName: 'dev',
    domain: DOMAIN,
  });
}

/** Web stack with the vanity domain + its cert wired, as bin/lca.ts does. */
function withDomain() {
  const app = new App();
  const cert = new CertStack(app, 'Cert', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    envName: 'dev',
    domain: DOMAIN,
  });
  const web = new WebStack(app, 'Web', {
    env: { account: ACCOUNT, region: 'us-west-2' },
    envName: 'dev',
    apiHost: 'abc123.execute-api.us-west-2.amazonaws.com',
    domain: DOMAIN,
    certificate: cert.certificate,
  });
  return { web, template: Template.fromStack(web), cert, certTemplate: Template.fromStack(cert) };
}

function withoutDomain() {
  const app = new App();
  const web = new WebStack(app, 'Web', {
    env: { account: ACCOUNT, region: 'us-west-2' },
    envName: 'dev',
    apiHost: 'abc123.execute-api.us-west-2.amazonaws.com',
  });
  return { web, template: Template.fromStack(web) };
}

function distributionConfig(t) {
  const found = Object.values(t.findResources('AWS::CloudFront::Distribution'));
  assert.equal(found.length, 1);
  return found[0].Properties.DistributionConfig;
}

test('the certificate stack refuses any region but us-east-1', () => {
  assert.doesNotThrow(() => certStack('us-east-1'));
  for (const region of ['us-west-2', 'eu-west-1']) {
    assert.throws(() => certStack(region), /must be created in us-east-1/);
  }
});

test('the certificate is DNS-validated against the console hosted zone', () => {
  const t = Template.fromStack(certStack());
  t.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: DOMAIN.hostname,
    ValidationMethod: 'DNS',
    DomainValidationOptions: [{ DomainName: DOMAIN.hostname, HostedZoneId: DOMAIN.hostedZoneId }],
  });
});

test('the distribution carries the alias and a viewer certificate', () => {
  const cfg = distributionConfig(withDomain().template);
  assert.deepEqual(cfg.Aliases, [DOMAIN.hostname]);
  assert.ok(cfg.ViewerCertificate, 'an alias without a viewer certificate is rejected by CloudFront');
  assert.equal(cfg.ViewerCertificate.MinimumProtocolVersion, 'TLSv1.2_2021');
  assert.equal(cfg.ViewerCertificate.SslSupportMethod, 'sni-only');
});

test('the alias gets BOTH A and AAAA records pointing at the distribution', () => {
  const t = withDomain().template;
  for (const type of ['A', 'AAAA']) {
    const records = Object.values(t.findResources('AWS::Route53::RecordSet')).filter(
      (r) => r.Properties.Type === type,
    );
    assert.equal(records.length, 1, `expected exactly one ${type} record`);
    const props = records[0].Properties;
    assert.equal(props.Name, `${DOMAIN.hostname}.`);
    assert.equal(props.HostedZoneId, DOMAIN.hostedZoneId);
    assert.ok(props.AliasTarget, `${type} record must be an alias, not a literal address`);
    // The alias target's zone id is CloudFront's fixed Z2FDTNDATAQYW2, emitted as a
    // partition-aware mapping lookup because cdk.json sets target-partitions to aws+aws-cn.
    assert.deepEqual(Object.keys(props.AliasTarget.HostedZoneId), ['Fn::FindInMap']);
    assert.equal(
      props.AliasTarget.HostedZoneId['Fn::FindInMap'][0],
      'AWSCloudFrontPartitionHostedZoneIdMap',
    );
  }
});

test('consoleOrigin is the vanity origin when a domain is configured', () => {
  const { web } = withDomain();
  assert.equal(web.consoleOrigin, DOMAIN.origin);
  // The raw CloudFront name stays exposed as the alias target for operators.
  assert.ok(web.distributionDomainName);
});

test('with no domain: no alias, no cert, no Route53 records — raw CloudFront still works', () => {
  const { template } = withoutDomain();
  const cfg = distributionConfig(template);
  assert.equal(cfg.Aliases, undefined);
  assert.equal(cfg.ViewerCertificate, undefined);
  template.resourceCountIs('AWS::Route53::RecordSet', 0);
  template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  // `consoleOrigin` is an unresolved token here (the CloudFront domain is a deploy-time
  // attribute), so assert the synthesized output instead of the JS string. The ConsoleUrl
  // output must resolve to `https://` + the distribution's own DomainName.
  const consoleUrl = template.findOutputs('ConsoleUrl');
  const value = Object.values(consoleUrl)[0].Value;
  assert.deepEqual(value['Fn::Join'][1][0], 'https://');
  assert.ok(
    JSON.stringify(value).includes('DomainName'),
    'the raw-CloudFront console URL is built from the distribution attribute',
  );
});

test('a half-wired domain/certificate pair throws at synth', () => {
  // Both directions synth "fine" in CloudFormation terms but fail at deploy (or silently
  // serve the wrong origin), so reject them in the construct.
  const app = new App();
  assert.throws(
    () =>
      new WebStack(app, 'WebNoCert', {
        env: { account: ACCOUNT, region: 'us-west-2' },
        envName: 'dev',
        apiHost: 'abc.execute-api.us-west-2.amazonaws.com',
        domain: DOMAIN,
      }),
    /without a certificate/,
  );
  // The reverse: a cert with no domain would be paid for and referenced by nothing, and the
  // distribution would still serve the raw CloudFront name — an origin mismatch with
  // PUBLIC_ORIGIN that only shows up as a broken login.
  const app2 = new App();
  const cert = new CertStack(app2, 'Cert', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    envName: 'dev',
    domain: DOMAIN,
  });
  assert.throws(
    () =>
      new WebStack(app2, 'WebNoDomain', {
        env: { account: ACCOUNT, region: 'us-west-2' },
        envName: 'dev',
        apiHost: 'abc.execute-api.us-west-2.amazonaws.com',
        certificate: cert.certificate,
      }),
    /with no console domain/,
  );
});

test('the security posture is unchanged by the alias (ADR-024 invariants hold)', () => {
  // Adding a custom domain must not disturb the single-origin/API-contract posture.
  const cfg = distributionConfig(withDomain().template);
  assert.equal(cfg.CustomErrorResponses, undefined);
  assert.deepEqual(cfg.CacheBehaviors.map((b) => b.PathPattern).sort(), ['/api/*', '/auth/*']);
  assert.equal(cfg.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
});

test('the OAuth callback URL is emitted as an output for the browser-only GitHub edit', () => {
  const outputs = withDomain().template.findOutputs('*');
  const callback = Object.values(outputs).find(
    (o) => o.Value === `${DOMAIN.origin}/auth/callback`,
  );
  assert.ok(callback, 'operators need the exact callback string; GitHub has no API for it');
});
