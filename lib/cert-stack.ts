import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { ConsoleDomainConfig } from './console-domain.js';

export interface CertStackProps extends StackProps {
  envName: string;
  domain: ConsoleDomainConfig;
}

/**
 * CertStack — the console's ACM certificate, pinned to **us-east-1** (ADR-036).
 *
 * CloudFront only accepts viewer certificates from us-east-1, regardless of where the
 * distribution's stack lives. This is the classic trap: a cert issued in the deploy region
 * synths cleanly and fails at `cdk deploy` on the distribution update, after the cert has
 * already been issued. So the cert gets its own stack with `env.region` hard-pinned, and
 * the constructor asserts the pin rather than trusting the caller.
 *
 * Validation is **DNS** against the same public hosted zone that holds the alias record, so
 * issuance is hands-off. It is not instant: ACM writes a `_<hash>` CNAME and polls, which
 * adds a few minutes of wall clock to the FIRST deploy of a new hostname (subsequent
 * deploys reuse the issued cert). CloudFormation blocks the cert resource until ISSUED, so
 * the distribution can never come up with an alias whose cert is still pending.
 */
export class CertStack extends Stack {
  public readonly certificate: acm.ICertificate;
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, {
      ...props,
      // Cross-region references: WebStack (deploy region) consumes this stack's cert ARN.
      // CDK implements that with an SSM-backed custom resource pair — it must be enabled on
      // BOTH the producing and consuming stack.
      crossRegionReferences: true,
    });

    if (props.env?.region !== 'us-east-1') {
      throw new Error(
        `CertStack must be created in us-east-1 (got "${props.env?.region ?? 'undefined'}"). ` +
          'CloudFront rejects viewer certificates from any other region.',
      );
    }

    const { envName, domain } = props;

    // Zone reference by id+name: no AWS lookup, so credential-less `cdk synth` (the CI
    // gate, ADR-018 exemption) still works. `fromLookup` would require credentials and
    // write account-specific data into cdk.context.json.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'ConsoleZone', {
      hostedZoneId: domain.hostedZoneId,
      zoneName: domain.zoneName,
    });

    const certificate = new acm.Certificate(this, 'ConsoleCert', {
      domainName: domain.hostname,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    this.certificate = certificate;
    this.certificateArn = certificate.certificateArn;

    new CfnOutput(this, 'ConsoleCertificateArn', {
      value: certificate.certificateArn,
      description: `us-east-1 ACM certificate for the ${envName} console (${domain.hostname}).`,
    });
    // Documented for operators chasing a stuck first deploy: a cert stuck in PENDING_VALIDATION
    // means the CNAME never resolved (wrong zone, or the zone is not authoritative publicly).
    new CfnOutput(this, 'ConsoleCertificateDomain', { value: domain.hostname });
  }
}
