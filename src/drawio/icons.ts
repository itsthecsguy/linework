// Cloud icons from draw.io's bundled stencil sets. `icon: aws.lambda` puts AWS's
// Lambda icon at the left of the node; the node keeps its kind colours.

export const PROVIDERS = {
  aws: { set: 'aws4.xml', prefix: 'mxgraph.aws4.' },
  gcp: { set: 'gcp2.xml', prefix: 'mxgraph.gcp2.' },
  k8s: { set: 'kubernetes2.xml', prefix: 'mxgraph.kubernetes2.' },
  azure: { set: 'azure.xml', prefix: 'mxgraph.azure.' },
} as const;
export type Provider = keyof typeof PROVIDERS;

const ALIASES: Record<Provider, Record<string, string>> = {
  aws: {
    efs: 'elastic_file_system',
    documentdb: 'documentdb_with_mongodb_compatibility',
    memorydb: 'memorydb_for_redis',
    msk: 'managed_streaming_for_kafka',
    kafka: 'managed_streaming_for_kafka',
    iam: 'identity_and_access_management',
    kms: 'key_management_service',
    alb: 'application_load_balancer',
    elb: 'elastic_load_balancing',
    route53: 'route_53',
    apigateway: 'api_gateway',
    stepfunctions: 'step_functions',
    sfn: 'step_functions',
  },
  gcp: {
    pubsub: 'cloud_pubsub',
    firestore: 'cloud_firestore',
    spanner: 'cloud_spanner',
    memorystore: 'cloud_memorystore',
    dataflow: 'cloud_dataflow',
    bigtable: 'cloud_bigtable',
    functions: 'cloud_functions',
    gcs: 'cloud_storage',
    storage: 'cloud_storage',
    sql: 'cloud_sql',
    run: 'cloud_run',
    gce: 'compute_engine',
    gke: 'container_engine',
    kubernetes_engine: 'container_engine',
  },
  k8s: {
    service: 'svc',
    deployment: 'deploy',
    ingress: 'ing',
    statefulset: 'sts',
    daemonset: 'ds',
    configmap: 'cm',
    namespace: 'ns',
    persistentvolume: 'pv',
    persistentvolumeclaim: 'pvc',
    replicaset: 'rs',
    serviceaccount: 'sa',
  },
  azure: {},
};

// AWS colours icons by service category.
const AWS_CATEGORY: Array<[string, string[]]> = [
  ['#ED7100', ['lambda', 'ec2', 'ecs', 'eks', 'fargate', 'batch', 'app_runner', 'elastic_beanstalk', 'lightsail', 'ecr']],
  ['#7AA116', ['s3', 'elastic_file_system', 'glacier', 'backup', 'fsx', 'storage_gateway']],
  ['#C925D1', ['rds', 'aurora', 'dynamodb', 'elasticache', 'documentdb_with_mongodb_compatibility', 'neptune', 'memorydb_for_redis', 'timestream', 'keyspaces']],
  ['#8C4FFF', ['api_gateway', 'cloudfront', 'route_53', 'elastic_load_balancing', 'application_load_balancer', 'vpc', 'direct_connect', 'global_accelerator', 'app_mesh', 'cloud_map', 'transit_gateway', 'kinesis', 'athena', 'glue', 'redshift', 'emr', 'quicksight', 'managed_streaming_for_kafka', 'lake_formation']],
  ['#E7157B', ['sqs', 'sns', 'eventbridge', 'step_functions', 'mq', 'appsync', 'cloudwatch', 'cloudformation', 'systems_manager', 'cloudtrail', 'config']],
  ['#DD344C', ['cognito', 'identity_and_access_management', 'key_management_service', 'secrets_manager', 'waf', 'shield', 'guardduty', 'certificate_manager']],
  ['#01A88D', ['sagemaker', 'bedrock', 'rekognition', 'comprehend', 'textract', 'transcribe', 'polly', 'lex']],
];
// Generic AWS resources are plain glyphs, not coloured tiles.
const AWS_GENERAL = new Set(['users', 'user', 'client', 'mobile_client', 'internet', 'traditional_server', 'generic_database', 'office_building', 'corporate_data_center']);

export interface ResolvedIcon {
  provider: Provider;
  name: string;
  stencil: string;
  style: string;
}

export function parseIcon(icon: string): { provider: Provider; name: string } | { error: string } {
  const m = /^(aws|gcp|k8s|azure)\.([\w-]+)$/.exec(icon.trim().toLowerCase());
  if (!m) return { error: `icon "${icon}" should look like aws.lambda, gcp.cloud_run, k8s.pod or azure.<name>. Run "linework icons aws" to list names.` };
  const provider = m[1] as Provider;
  const raw = m[2]!.replace(/-/g, '_');
  return { provider, name: ALIASES[provider][raw] ?? raw };
}

/**
 * The icon's draw.io style. Plain glyph icons (AWS generic resources, GCP and
 * Azure) take their brand color only where it shows against the node's fill;
 * on a dark or saturated fill they switch to the node's text color. Tiled icons
 * (AWS services, Kubernetes) carry a white glyph on their own color, so they read
 * on any fill and keep their colors.
 */
export function resolveIcon(icon: string, on?: { fill: string; ink: string }): ResolvedIcon | { error: string } {
  const p = parseIcon(icon);
  if ('error' in p) return p;
  const { provider, name } = p;
  const stencil = PROVIDERS[provider].prefix + name;
  const base = 'outlineConnect=0;aspect=fixed;html=1;sketch=0;';
  const glyph = (brand: string) => (on && contrast(brand, on.fill) < 3 ? on.ink : brand);
  let style: string;
  if (provider === 'aws') {
    style = AWS_GENERAL.has(name)
      ? `${base}shape=${stencil};fillColor=${glyph('#232F3E')};strokeColor=none;`
      : `${base}shape=mxgraph.aws4.resourceIcon;resIcon=${stencil};fillColor=${AWS_CATEGORY.find(([, names]) => names.includes(name))?.[0] ?? '#232F3E'};strokeColor=#ffffff;`;
  } else if (provider === 'gcp') style = `${base}shape=${stencil};fillColor=${glyph('#4285F4')};strokeColor=none;`;
  else if (provider === 'k8s') style = `${base}shape=mxgraph.kubernetes.icon2;prIcon=${name};fillColor=#326CE5;strokeColor=#ffffff;`;
  else style = `${base}shape=${stencil};fillColor=${glyph('#0078D4')};strokeColor=none;`;
  return { provider, name, stencil, style };
}

/** WCAG contrast ratio of two #RRGGBB colors. Anything else counts as white. */
export function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) return 1;
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export const ICON_SIZE = 28;
export const ICON_PAD = 44; // left space a node reserves for its icon
