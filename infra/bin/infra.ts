import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as blueprints from '@aws-quickstart/eks-blueprints';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';


const app = new cdk.App();
const account = '707690426194';
const region = 'us-east-1';
const version = 'auto';

blueprints.HelmAddOn.validateHelmVersions = true; // optional if you would like to check for newer versions

// choose env via CDK context or ENV var: -c env=dev (or prod)
const envName = app.node.tryGetContext('env') ?? process.env.ENV ?? 'dev';
const domainName = 'acimate.com';
const fqdn = 'argocd.acimate.com';

// ----- SHARED STACK -----
const shared = new cdk.Stack(app, 'shared-infra', { env: { account, region } });

// Lookup existing Route 53 zone
const zone = route53.HostedZone.fromLookup(shared, 'HostedZone', { domainName });

// ACM certificate (DNS validated)
const cert = new acm.Certificate(shared, 'ArgocdAcmCert', {
  domainName: fqdn,
  validation: acm.CertificateValidation.fromDns(zone),
});

// Generate a random strong password at deploy time
const generatedPassword = crypto.randomBytes(12).toString('base64'); // ~16 chars with symbols
const adminPasswordHash = bcrypt.hashSync(generatedPassword, 10);

// Store plaintext admin password in Secrets Manager (retain for reuse)
const argocdSecret = new secretsmanager.Secret(shared, 'ArgocdAdminSecret', {
  secretName: '/eks/argocd/admin',
  description: 'Argo CD admin console credentials',
  secretObjectValue: {
    username: cdk.SecretValue.unsafePlainText('admin'),
    password: cdk.SecretValue.unsafePlainText(generatedPassword),
  },
  removalPolicy: RemovalPolicy.RETAIN,
});

const addOns: Array<blueprints.ClusterAddOn> = [
    new blueprints.addons.ArgoCDAddOn({        
        bootstrapRepo: {
        repoUrl: 'https://github.com/acimate-courses/aws-eks-cluster-onboarding',
        targetRevision: 'main',
        path: `environments/${envName}/apps`,
            },
        values: {
            configs: {
                secret: {
                    createSecret: true,
                    argocdServerAdminPassword: adminPasswordHash,
                    argocdServerAdminPasswordMtime: new Date().toISOString(),
                },
            },
            server: {
                ingress: {
                enabled: true,
                ingressClassName: 'alb',
                annotations: {
                    'kubernetes.io/ingress.class': 'alb',
                    'alb.ingress.kubernetes.io/scheme': 'internet-facing',
                    'alb.ingress.kubernetes.io/target-type': 'ip',
                    'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]',
                    'alb.ingress.kubernetes.io/certificate-arn': cert.certificateArn,
                    'alb.ingress.kubernetes.io/ssl-redirect': '443',
                    'alb.ingress.kubernetes.io/backend-protocol-version': 'HTTP2',
                    'external-dns.alpha.kubernetes.io/hostname': fqdn,
                },
                hosts: [fqdn],
                paths: ['/'],
                pathType: 'Prefix',
                },
            },
            },
        }),
    new blueprints.addons.MetricsServerAddOn(),
    new blueprints.addons.ClusterAutoScalerAddOn(),
    new blueprints.addons.AwsLoadBalancerControllerAddOn(),
    new blueprints.addons.VpcCniAddOn(), // support network policies ootb
    new blueprints.addons.CoreDnsAddOn(),
    new blueprints.addons.KubeProxyAddOn(),    
    new blueprints.addons.ExternalDnsAddOn({
        hostedZoneResources:["public-acimate-zone"],
    }),
];

const stack = blueprints.EksBlueprint.builder()
    .resourceProvider('public-acimate-zone', new blueprints.LookupHostedZoneProvider('acimate.com'))
    .account(account)
    .region(region)
    .version(version)
    .addOns(...addOns)
    .useDefaultSecretEncryption(true) // set to false to turn secret encryption off (non-production/demo cases)
    .build(app, 'eks-blueprint');
