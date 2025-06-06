export interface Env {
  DNS_KV: KVNamespace;
  MONITOR_DOMAINS: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export interface DNSResponse {
  Status: number;
  TC?: boolean;
  RD?: boolean;
  RA?: boolean;
  AD?: boolean;
  CD?: boolean;
  Answer?: Array<{
    name: string;
    type: number;
    TTL: number;
    data: string;
  }>;
  Question?: Array<{
    name: string;
    type: number;
  }>;
  Comment?: string[];
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface CertificateInfo {
  issuer: string;
  subject: string;
  validFrom: string;
  validTo: string;
  fingerprint: string;
}

export interface CloudFrontIPResponse {
  CLOUDFRONT_GLOBAL_IP_LIST: string[];
  CLOUDFRONT_REGIONAL_EDGE_IP_LIST: string[];
}

export interface DomainConfig {
  name: string;
  suppressNonIpSoaAlerts?: boolean;
  suppressCertAlerts?: boolean;
  suppressIpChangeAlerts?: boolean;
  criticalChangeWindowMinutes?: number;
}

export interface DomainState {
  state: string;
  ips: string[];
  serial: string | null;
  lastIpChange: string | null;
  lastCertChange: string | null;
  baselineCert: CertificateInfo | null;
}

export interface Config {
  domains: DomainConfig[];
  cron: string;
  kvNamespace: {
    id: string;
  };
}
