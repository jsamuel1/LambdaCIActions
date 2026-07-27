import { Stack, StackProps, CfnOutput, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
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
 * SPA deep links (`/runs/123`) 404 at S3, so 403/404 are rewritten to `/index.html`.
 *
 * The asset deployment is skipped when `web/dist` is absent so a credential-less
 * `cdk synth` (the CI gate) works on a fresh clone that hasn't built the SPA yet.
 */
export class WebStack extends Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { envName, apiHost } = props;

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

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `LambdaCIActions console (${envName})`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': apiBehavior,
        '/auth/*': apiBehavior,
      },
      errorResponses: [
        // SPA routing: unknown paths fall through to the app shell.
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
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

    new CfnOutput(this, 'ConsoleUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description:
        'Console URL. Set this as MgmtStack publicOrigin (-c publicOrigin=...) and as the ' +
        "GitHub App's OAuth callback https://<domain>/auth/callback (docs/DEPLOY-M4.md).",
    });
    new CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
