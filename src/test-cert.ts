import { Env, DNSResponse, CertificateInfo } from "./types";
import { checkCertificate, validateCertificates } from "./cert-utils";

interface DNSAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

async function testDomain(domain: string, env: Env) {
  console.log(`\n=== Testing domain: ${domain} ===`);

  // First, get the current IPs
  const dnsResponse = await fetch(
    `https://1.1.1.1/dns-query?name=${domain}&type=A`,
    {
      headers: {
        Accept: "application/dns-json",
      },
    }
  );

  const dnsData = (await dnsResponse.json()) as DNSResponse;
  const currentIPs =
    dnsData.Answer?.filter((a: DNSAnswer) => a.type === 1).map(
      (a: DNSAnswer) => a.data
    ) || [];

  console.log(`Current IPs: ${currentIPs.join(", ")}`);

  if (currentIPs.length === 0) {
    console.log("No IPs found for domain");
    return;
  }

  // Test certificate validation using the same logic as index.ts
  const { isExpected, certInfo, baselineCert } = await validateCertificates(
    domain,
    currentIPs,
    env
  );

  console.log("\nCertificate Check Results:");
  console.log(`Is Expected: ${isExpected ? "✅" : "❌"}`);

  if (certInfo) {
    console.log("\nCurrent Certificate:");
    console.log(`Issuer: ${certInfo.issuer}`);
    console.log(`Subject: ${certInfo.subject}`);
    console.log(`Valid From: ${certInfo.validFrom}`);
    console.log(`Valid To: ${certInfo.validTo}`);
    console.log(`Fingerprint: ${certInfo.fingerprint}`);
  } else {
    console.log("\nNo certificate information available");
  }

  if (baselineCert) {
    console.log("\nBaseline Certificate:");
    console.log(`Issuer: ${baselineCert.issuer}`);
    console.log(`Subject: ${baselineCert.subject}`);
    console.log(`Fingerprint: ${baselineCert.fingerprint}`);
  } else {
    console.log("\nNo baseline certificate recorded");
  }
}

// Mock KV namespace for testing
class MockKV {
  private store: Map<string, string> = new Map();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

async function main() {
  // Test domains
  const testDomains = ["yearn.fi", "curve.fi", "safe.global"];

  // Create mock environment
  const env: Env = {
    DNS_KV: new MockKV() as any,
    MONITOR_DOMAINS: testDomains.join(","),
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "test-chat",
  };

  // Test each domain
  for (const domain of testDomains) {
    await testDomain(domain, env);
  }
}

// Run the tests
main().catch(console.error);
