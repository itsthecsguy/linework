// Cloud icons from draw.io's bundled stencil sets. `icon: aws.lambda` puts AWS's
// Lambda icon at the left of the node; the node keeps its kind colours.

export const PROVIDERS = {
  aws: { set: 'aws4.xml', prefix: 'mxgraph.aws4.' },
  gcp: { set: 'gcp2.xml', prefix: 'mxgraph.gcp2.' },
  k8s: { set: 'kubernetes2.xml', prefix: 'mxgraph.kubernetes2.' },
  azure: { set: 'azure.xml', prefix: 'mxgraph.azure.' },
} as const;
export type Provider = keyof typeof PROVIDERS;

// Azure comes in two draw.io sets. The older one (PROVIDERS.azure) has the basics:
// virtual machines, SQL, storage. This one has the services added since: Functions,
// Cosmos DB, Key Vault, Event Hubs. Where both draw a service, this one wins.
export const AZURE_CLOUD = { set: 'mscae/cloud.xml', prefix: 'mxgraph.mscae.cloud.' } as const;
const AZURE_CLOUD_NAMES = new Set(
  'active_directory active_directory_b2b active_directory_b2c active_directory_domain_services active_directory_health_monitoring advisor analysis_service api_app api_management application_gateway application_insights app_service azure azure_automatic_load_balancer azure_batch azure_dns azure_files_service azure_load_balancer_feature azure_logo azure_rights_management_rms azure_search azure_storage batch blockchain bot_services building_block central cloud_office_365 cloud_service cognitive_services container_registry container_service content_delivery_network content_delivery_network2 cortona_management_suite cosmos_db customer_insights c_series data_bricks data_catalog data_factory data_lake data_lake_analytics data_lake_store data_warehouse devtest_labs docdb_account docdb_collections document documentdb dps event_grid event_hubs expressroute functions gateway hdinsight health_monitoring hockeyapp hybrid_connections hybrid_connection_manager iot iot_edge key_vault logic_app logic_apps machine_learning machine_learning2 machine_learning_service_plans machine_learning_web_services machine_learning_work_spaces managed_applications managed_discs management_portal microsoft_account microsoft_azure mobile_app mobile_engagement monitor network_watcher nsg office_365 office_365_subscription oms_log_analytics operational_insights power_bi_embedded recovery_vault remoteapp resource_group route_filters runbooks security_center service_bus service_bus2 service_bus_queues service_bus_relay service_bus_relay2 service_bus_topics service_endpoint service_endpoint2 service_fabric service_package site_recovery snapshot sql_database_premium sql_datawarehouse sql_elastic_database_pools sql_stretch_database stack storage storage_cs storage_files storage_sync_services stream_analytics tags time_series_insights vhd virtual_machines_availability_set virtual_machine_container vm_scale_set vpn_gateway vpn_gateway2 webhooks webjobs worker_pools work_account'.split(' '),
);

/** The stencil sets a provider's icons come from. */
export function stencilSets(provider: Provider): Array<{ set: string; prefix: string }> {
  return provider === 'azure' ? [PROVIDERS.azure, AZURE_CLOUD] : [PROVIDERS[provider]];
}

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
  azure: {
    cosmos: 'cosmos_db',
    cosmosdb: 'cosmos_db',
    aks: 'container_service',
    kubernetes_service: 'container_service',
    acr: 'container_registry',
    keyvault: 'key_vault',
    apim: 'api_management',
    eventhub: 'event_hubs',
    eventhubs: 'event_hubs',
    eventgrid: 'event_grid',
    servicebus: 'service_bus',
    appservice: 'app_service',
    app_gateway: 'application_gateway',
    aad: 'active_directory',
    entra: 'active_directory',
    entra_id: 'active_directory',
    function: 'functions',
    function_app: 'functions',
    databricks: 'data_bricks',
    synapse: 'sql_datawarehouse',
    vm: 'virtual_machine',
    vmss: 'vm_scale_set',
    vnet: 'virtual_network',
    sql: 'sql_database',
    blob: 'storage_blob',
    blob_storage: 'storage_blob',
    cdn: 'content_delivery_network',
    load_balancer: 'azure_load_balancer',
    redis: 'azure_cache',
    app_insights: 'application_insights',
    log_analytics: 'oms_log_analytics',
  },
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
  const stencil = (provider === 'azure' && AZURE_CLOUD_NAMES.has(name) ? AZURE_CLOUD.prefix : PROVIDERS[provider].prefix) + name;
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
