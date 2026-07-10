import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface ImageStackProps extends StackProps {
  /** Environment name (dev|prod); namespaces SSM + resource names. */
  envName: string;
  /** SSM parameter prefix, e.g. `/lca/dev`. */
  ssmPrefix: string;
}

/**
 * ImageStack — compute-plane image-build infrastructure (spec 05, phase 1).
 *
 * Deployed FIRST. It provisions the code bucket that `scripts/build-images.mjs` uploads
 * the staged Dockerfile + microvm/ context to, and the IAM role that the microVM image
 * build assumes. Image ARNs themselves are produced out-of-band by the build script
 * (phase 2) and published to SSM at `<ssmPrefix>/config/image-arn-<flavor>` — the
 * orchestrator (ControlStack) reads them from there, decoupling deploy ordering (ADR-011).
 */
export class ImageStack extends Stack {
  /** The bucket build artifacts (zipped context) are uploaded to. */
  readonly codeBucket: s3.Bucket;
  /** Role the microVM image build assumes (s3 read of context + image build APIs). */
  readonly buildRole: iam.Role;

  constructor(scope: Construct, id: string, props: ImageStackProps) {
    super(scope, id, props);

    const { envName, ssmPrefix } = props;

    this.codeBucket = new s3.Bucket(this, 'CodeBucket', {
      bucketName: undefined, // let CDK name it to avoid global-name collisions
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // Build contexts are disposable; expire old versions to control cost.
      lifecycleRules: [
        {
          noncurrentVersionExpiration: Duration.days(14),
          abortIncompleteMultipartUploadAfter: Duration.days(3),
        },
      ],
      // dev may be torn down; prod retains. Bucket must be empty on dev destroy.
      removalPolicy: envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== 'prod',
    });

    // Role assumed by the microVM image build. Scoped to the code bucket + the image
    // build API surface (create-microvm-image and friends live under the `lambda:` action
    // namespace for the microVM control plane).
    this.buildRole = new iam.Role(this, 'ImageBuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'LambdaCIActions microVM image build role',
    });
    this.codeBucket.grantRead(this.buildRole);
    this.buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MicroVMImageBuild',
        actions: [
          'lambda:CreateMicroVMImage',
          'lambda:GetMicroVMImage',
          'lambda:ListMicroVMImages',
          'lambda:DeleteMicroVMImage',
        ],
        // Image ARNs aren't known until built; scope to this account/region.
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );

    // Record the code bucket name in SSM so the build script can discover it without a
    // CFN export lookup.
    new ssm.StringParameter(this, 'CodeBucketParam', {
      parameterName: `${ssmPrefix}/config/image-code-bucket`,
      stringValue: this.codeBucket.bucketName,
      description: 'S3 bucket for microVM image build contexts',
    });

    new CfnOutput(this, 'CodeBucketName', { value: this.codeBucket.bucketName });
    new CfnOutput(this, 'ImageBuildRoleArn', { value: this.buildRole.roleArn });
  }
}
