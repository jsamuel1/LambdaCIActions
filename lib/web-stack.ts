import { Stack, StackProps, CfnOutput, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type { ConsoleDomainConfig } from './console-domain.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
/** Built SPA bundle (`npm run build:web` → web/dist). */
const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

export interface WebStackProps extends StackProps {
  envName: string;
  /** Bare host of the management HTTP API (MgmtStack.apiEndpointHost). */
  apiHost: string;
  /**
   * Vanity console domain (ADR-036), or undefined to serve on the raw CloudFront domain.
   * When set, `certificate` MUST also be supplied (issued in us-east-1 by CertStack).
   */
  domain?: ConsoleDomainConfig;
  /** us-east-1 ACM certificate for `domain.hostname` (CertStack.certificate). */
  certificate?: acm.ICertificate;
}

/**
 * WebStack — console hosting (spec 04 § Tech choices, ADR-024).
 *
 * S3 (private, OAC) + CloudFront, with the management API attached to the SAME
 * distribution as `/api/*` and `/auth/*` behaviors. One origin for the browser means:
 *   - the session cookie is first-party (no CORS, no SameSite=None), and
 *   - the OAuth redirect URI is a stable console URL.
 *
 * The bucket is never public; CloudFront reaches it through Origin Access Control.
 *
 * NOTE on SPA fallback: CloudFront custom error responses are DISTRIBUTION-wide — they
 * apply to every behavior, including `/api/*`. Rewriting 403/404 → `/index.html` would
 * therefore turn the management API's `403 forbidden` and `404 not found` into `200` with
 * an HTML body, breaking the API contract (and masking authorization denials). The console
 * is hash-routed (`#/runs/1/2/3`, ADR-022) so every real URL path is `/` — no fallback is
 * needed, and none is configured.
 *
 * The asset deployment is skipped when `web/dist` is absent so a credential-less
 * `cdk synth` (the CI gate) works on a fresh clone that hasn't built the SPA yet.
 *
 * Custom domain (ADR-036): when `domain` + `certificate` are supplied the distribution gets
 * a stable vanity alias plus Route53 A/AAAA records, and the console origin is known before
 * any resource exists — which is what removes the two-pass `-c publicOrigin=...` bootstrap.
 * With no domain configured every custom-domain resource is skipped and the raw
 * `*.cloudfront.net` path keeps working unchanged (a fresh account owning no domain).
 */
export class WebStack extends Stack {
  /** Raw CloudFront domain — always present. */
  public readonly distributionDomainName: string;
  /** Origin the browser should use: the vanity origin when configured, else raw CloudFront. */
  public readonly consoleOrigin: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, {
      ...props,
      // Consumes CertStack's us-east-1 cert ARN. Must be enabled on the consuming stack too.
      crossRegionReferences: true,
    });

    const { envName, apiHost, domain, certificate } = props;

    // Half-wiring these would synth fine and fail at deploy with CloudFront's opaque
    // "one or more of the CNAMEs you provided are already associated" / missing-cert error.
    if (domain && !certificate) {
      throw new Error(
        `WebStack (${id}): a console domain (${domain.hostname}) was configured without a ` +
          'certificate. CertStack must supply a us-east-1 ACM cert for the alias.',
      );
    }
    if (!domain && certificate) {
      throw new Error(
        `WebStack (${id}): a certificate was supplied with no console domain — nothing would ` +
          'reference it.',
      );
    }

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `lca-${envName}-console-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== 'prod',
    });

    const apiOrigin = new origins.HttpOrigin(apiHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // API behaviors must forward cookies + the Authorization-free session, and must NOT
    // cache (every response is per-operator). CACHING_DISABLED + ALL_VIEWER_EXCEPT_HOST_HEADER
    // is the standard combination for an API behind CloudFront.
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    // Security headers for the app shell. CSP is `self`-only: the SPA loads no third-party
    // script/style/font and calls only the same-origin API (ADR-022), so a strict policy
    // costs nothing and blocks injected-script + clickjacking classes outright.
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ConsoleSecurityHeaders', {
      responseHeadersPolicyName: `lca-${envName}-console-security`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "form-action 'self'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `LambdaCIActions console (${envName})`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        '/api/*': apiBehavior,
        '/auth/*': apiBehavior,
      },
      // No `errorResponses`: see the class doc — a distribution-wide rewrite would corrupt
      // the API's 403/404 responses.
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // Only meaningful together: CloudFront requires a viewer certificate for any alias,
      // and `minimumProtocolVersion` above is inert until one is attached.
      ...(domain && certificate
        ? { domainNames: [domain.hostname], certificate }
        : {}),
    });

    if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
      new s3deploy.BucketDeployment(this, 'DeploySite', {
        sources: [s3deploy.Source.asset(WEB_DIST)],
        destinationBucket: bucket,
        distribution,
        distributionPaths: ['/*'],
        prune: true,
      });
    }

    this.distributionDomainName = distribution.distributionDomainName;
    this.consoleOrigin = domain ? domain.origin : `https://${distribution.distributionDomainName}`;

    if (domain) {
      // Zone by id+name, not `fromLookup`: keeps credential-less synth working (ADR-018).
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'ConsoleZone', {
        hostedZoneId: domain.hostedZoneId,
        zoneName: domain.zoneName,
      });
      const aliasTarget = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution),
      );
      // A record only would leave IPv6-only clients unable to resolve the console at all,
      // while the raw CloudFront domain answers AAAA — so the vanity name must too.
      const recordName = domain.hostname === domain.zoneName ? undefined : domain.hostname;
      new route53.ARecord(this, 'ConsoleAliasA', { zone, recordName, target: aliasTarget });
      new route53.AaaaRecord(this, 'ConsoleAliasAAAA', { zone, recordName, target: aliasTarget });

      new CfnOutput(this, 'ConsoleDomainName', { value: domain.hostname });
    }

    new CfnOutput(this, 'ConsoleUrl', {
      value: this.consoleOrigin,
      description: domain
        ? 'Console URL (vanity domain, ADR-036). PUBLIC_ORIGIN is derived from config, so no ' +
          "second deploy pass is needed. Register the GitHub App OAuth callback as " +
          `${domain.origin}/auth/callback.`
        : 'Console URL (raw CloudFront — no custom domain configured). Set this as MgmtStack ' +
          "publicOrigin (-c publicOrigin=...) and as the GitHub App's OAuth callback " +
          'https://<domain>/auth/callback (docs/DEPLOY-M4.md).',
    });
    new CfnOutput(this, 'ConsoleOAuthCallbackUrl', {
      value: `${this.consoleOrigin}/auth/callback`,
      description:
        "Exact value to register on the GitHub App. GitHub has no REST endpoint for App " +
        'settings, so this is a browser-only edit.',
    });
    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'Raw CloudFront domain (alias target).',
    });
    new CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
