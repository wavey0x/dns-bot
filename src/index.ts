import {
  Env,
  DNSResponse,
  KVNamespace,
  CertificateInfo,
  CloudFrontIPResponse,
} from "./types";
import { checkCertificate, validateCertificates } from "./cert-utils";

interface DomainConfig {
  name: string;
  suppressNonIpSoaAlerts?: boolean;
  trustCloudFrontIps?: boolean;
  suppressCertAlerts?: boolean;
  suppressIpChangeAlerts?: boolean;
  criticalChangeWindowMinutes?: number;
}

interface Config {
  domains: DomainConfig[];
  cron: string;
  kvNamespace: {
    id: string;
  };
}

interface DomainState {
  state: string;
  ips: string;
  serial: string;
  lastIpChange: string | null;
  lastCertChange: string | null;
  baselineCert: CertificateInfo | null;
}

function ipToNumber(ip: string): number {
  return (
    ip
      .split(".")
      .reduce(
        (acc: number, octet: string) => (acc << 8) + parseInt(octet),
        0
      ) >>> 0
  );
}

async function sendTelegramMessage(env: Env, message: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to send Telegram message: ${response.statusText}`);
  }
}

async function queryDNS(domain: string): Promise<DNSResponse> {
  const server = "https://1.1.1.1/dns-query";
  const url = new URL(server);
  url.searchParams.append("name", domain);
  url.searchParams.append("type", "SOA"); // First query SOA record

  console.log(`Querying DNS server for SOA: ${url.toString()}`);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-json",
    },
  });

  console.log(`Response status:`, response.status);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  console.log("Response headers:", JSON.stringify(responseHeaders, null, 2));

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DNS query failed: ${response.status} - ${errorText}`);
  }

  const soaData: DNSResponse = await response.json();
  console.log("SOA Response data:", JSON.stringify(soaData, null, 2));

  // Now query A records
  url.searchParams.set("type", "A");
  console.log(`Querying DNS server for A records: ${url.toString()}`);

  const aResponse = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-json",
    },
  });

  if (!aResponse.ok) {
    const errorText = await aResponse.text();
    throw new Error(`DNS query failed: ${aResponse.status} - ${errorText}`);
  }

  const aData: DNSResponse = await aResponse.json();
  console.log("A Record Response data:", JSON.stringify(aData, null, 2));

  // Combine both responses
  return {
    ...aData,
    Answer: [...(aData.Answer || []), ...(soaData.Answer || [])],
  };
}

async function isCloudFrontIP(ip: string): Promise<boolean> {
  try {
    const response = await fetch(
      "https://d7uri8nf7uskq.cloudfront.net/tools/list-cloudfront-ips"
    );
    if (!response.ok) {
      console.error("Failed to fetch CloudFront IP ranges");
      return false;
    }

    const data = (await response.json()) as CloudFrontIPResponse;
    const ipRanges = [
      ...data.CLOUDFRONT_GLOBAL_IP_LIST,
      ...data.CLOUDFRONT_REGIONAL_EDGE_IP_LIST,
    ];

    // Convert IP to number for comparison
    const ipNum = ipToNumber(ip);

    // Check if IP is in any of the ranges
    return ipRanges.some((range) => {
      const [baseIP, bits] = range.split("/");
      const baseNum = ipToNumber(baseIP);
      const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;
      return (ipNum & mask) === (baseNum & mask);
    });
  } catch (error) {
    console.error("Error checking CloudFront IP:", error);
    return false;
  }
}

async function checkDomain(
  domain: string,
  domainConfig: DomainConfig,
  env: Env
): Promise<void> {
  try {
    const dnsData = await queryDNS(domain);

    // Check for "No Reachable Authority" case
    const noAuthority = dnsData.Comment?.some((comment) =>
      comment.includes("No Reachable Authority")
    );

    // Get current domain state from KV
    const domainStateStr = await env.DNS_KV.get(`dns:${domain}`);
    const domainState: DomainState = domainStateStr
      ? JSON.parse(domainStateStr)
      : {
          state: "unknown",
          ips: "",
          serial: "",
          lastIpChange: null,
          lastCertChange: null,
          baselineCert: null,
        };

    if (noAuthority) {
      if (domainState.state !== "no_authority") {
        // Update state
        domainState.state = "no_authority";
        await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(domainState));

        const message =
          `⚠️ <b>DNS Authority Unreachable</b>\n\n` +
          `Domain: <code>${domain}</code>\n` +
          `Status: <code>No Reachable Authority</code>\n` +
          `Time: ${new Date().toISOString()}\n\n` +
          `<b>Technical Details:</b>\n` +
          `- DNS Status: <code>${dnsData.Status}</code>\n` +
          `- Comments: <code>${dnsData.Comment?.join(", ")}</code>\n` +
          `- Worker: <code>dns-bot</code>`;

        await sendTelegramMessage(env, message);
        console.log(`DNS authority unreachable for ${domain}`);
      }
      return;
    }

    // Get all A records
    const aRecords =
      dnsData.Answer?.filter((answer) => answer.type === 1) || [];

    // Get SOA record
    const soaRecord = dnsData.Answer?.find((answer) => answer.type === 6);
    const soaData = soaRecord?.data.split(" ") || [];
    const serial = soaData[2] || "unknown";

    const previousIPsArray = domainState.ips ? domainState.ips.split(",") : [];
    const currentIPs = aRecords.map((record) => record.data);

    // Sort arrays for consistent comparison
    previousIPsArray.sort();
    currentIPs.sort();

    // Check if we should trust CloudFront IPs (default to false)
    let shouldSkipAlert = false;
    if (
      domainConfig.trustCloudFrontIps === true &&
      JSON.stringify(previousIPsArray) !== JSON.stringify(currentIPs)
    ) {
      // Check if all new IPs are CloudFront IPs
      const allCloudFrontIPs = await Promise.all(
        currentIPs.map((ip) => isCloudFrontIP(ip))
      );
      shouldSkipAlert = allCloudFrontIPs.every((isCloudFront) => isCloudFront);
    }

    // Always validate certificates
    const { isExpected, certInfo } = await validateCertificates(
      domain,
      currentIPs,
      env
    );

    const now = new Date();
    let ipChanged = false;
    let certChanged = false;
    let needsUpdate = false;

    // If the IPs have changed
    if (JSON.stringify(previousIPsArray) !== JSON.stringify(currentIPs)) {
      ipChanged = true;
      domainState.state = "resolved";
      domainState.ips = currentIPs.join(",");
      domainState.serial = serial;
      domainState.lastIpChange = now.toISOString();
      needsUpdate = true;

      if (!shouldSkipAlert && !domainConfig.suppressIpChangeAlerts) {
        const message =
          `⚠️ <b>DNS IP Change Detected</b>\n\n` +
          `Domain: <code>${domain}</code>\n` +
          `Previous IPs: <code>${domainState.ips || "none"}</code>\n` +
          `New IPs: <code>${currentIPs.join(", ")}</code>\n` +
          `TTL: <code>${aRecords[0]?.TTL || "N/A"}</code>\n` +
          `Time: ${now.toISOString()}\n\n` +
          `<b>Technical Details:</b>\n` +
          `- DNS Status: <code>${dnsData.Status}</code>\n` +
          `- Record Type: <code>A</code>\n` +
          `- Number of Records: <code>${aRecords.length}</code>\n` +
          `- SOA Serial: <code>${serial}</code>\n` +
          `- Primary NS: <code>${soaData[0] || "unknown"}</code>\n` +
          `- Admin Email: <code>${soaData[1] || "unknown"}</code>`;

        await sendTelegramMessage(env, message);
        console.log(`DNS IP change detected for ${domain}:`);
        console.log(`Previous IPs: ${domainState.ips || "none"}`);
        console.log(`New IPs: ${currentIPs.join(", ")}`);
      } else if (domainConfig.suppressIpChangeAlerts) {
        console.log(`Suppressing IP change alert for ${domain} as configured`);
      }
    }

    // Check for certificate changes
    if (!isExpected && certInfo) {
      certChanged = true;
      domainState.lastCertChange = now.toISOString();
      domainState.baselineCert = certInfo;
      needsUpdate = true;

      if (!domainConfig.suppressCertAlerts) {
        const message =
          `🚨 <b>Unexpected Certificate Change</b>\n\n` +
          `Domain: <code>${domain}</code>\n` +
          `Time: ${now.toISOString()}\n\n` +
          `<b>Current Certificate:</b>\n` +
          `- Issuer: <code>${certInfo.issuer}</code>\n` +
          `- Subject: <code>${certInfo.subject}</code>\n` +
          `- Valid From: <code>${certInfo.validFrom}</code>\n` +
          `- Valid To: <code>${certInfo.validTo}</code>\n` +
          `- Fingerprint: <code>${certInfo.fingerprint}</code>\n` +
          (domainState.baselineCert
            ? `\n<b>Previous Certificate:</b>\n` +
              `- Issuer: <code>${domainState.baselineCert.issuer}</code>\n` +
              `- Subject: <code>${domainState.baselineCert.subject}</code>\n` +
              `- Fingerprint: <code>${domainState.baselineCert.fingerprint}</code>\n`
            : `\n<b>Previous Certificate:</b> None recorded\n`);

        await sendTelegramMessage(env, message);
        console.log(`Unexpected certificate change detected for ${domain}`);
      } else {
        console.log(
          `Suppressing certificate alert for ${domain} as configured`
        );
      }
    }

    // Check for critical changes (both IP and cert changed within window)
    if (ipChanged && certChanged && domainConfig.criticalChangeWindowMinutes) {
      const windowMs = domainConfig.criticalChangeWindowMinutes * 60 * 1000;
      const lastIpChange = domainState.lastIpChange
        ? new Date(domainState.lastIpChange)
        : null;
      const lastCertChange = domainState.lastCertChange
        ? new Date(domainState.lastCertChange)
        : null;
      const timeSinceLastIpChange = lastIpChange
        ? now.getTime() - lastIpChange.getTime()
        : Infinity;
      const timeSinceLastCertChange = lastCertChange
        ? now.getTime() - lastCertChange.getTime()
        : Infinity;

      if (
        timeSinceLastIpChange <= windowMs &&
        timeSinceLastCertChange <= windowMs
      ) {
        const message =
          `🚨🚨 <b>CRITICAL: Concurrent IP and Certificate Changes</b>\n\n` +
          `Domain: <code>${domain}</code>\n` +
          `Time: ${now.toISOString()}\n\n` +
          `<b>IP Change:</b>\n` +
          `- Previous IPs: <code>${domainState.ips || "none"}</code>\n` +
          `- New IPs: <code>${currentIPs.join(", ")}</code>\n\n` +
          `<b>Certificate Change:</b>\n` +
          `- Current Issuer: <code>${certInfo?.issuer || "unknown"}</code>\n` +
          `- Current Subject: <code>${
            certInfo?.subject || "unknown"
          }</code>\n` +
          `- Current Fingerprint: <code>${
            certInfo?.fingerprint || "unknown"
          }</code>\n` +
          (domainState.baselineCert
            ? `\n<b>Previous Certificate:</b>\n` +
              `- Issuer: <code>${domainState.baselineCert.issuer}</code>\n` +
              `- Subject: <code>${domainState.baselineCert.subject}</code>\n` +
              `- Fingerprint: <code>${domainState.baselineCert.fingerprint}</code>\n`
            : `\n<b>Previous Certificate:</b> None recorded\n`) +
          `\n<b>Technical Details:</b>\n` +
          `- Time Window: <code>${domainConfig.criticalChangeWindowMinutes} minutes</code>\n` +
          `- Last IP Change: <code>${
            lastIpChange?.toISOString() || "unknown"
          }</code>\n` +
          `- Last Cert Change: <code>${
            lastCertChange?.toISOString() || "unknown"
          }</code>`;

        await sendTelegramMessage(env, message);
        console.log(
          `CRITICAL: Concurrent IP and certificate changes detected for ${domain}`
        );
      }
    }

    // Handle SOA changes if IPs haven't changed
    if (serial !== domainState.serial && !ipChanged) {
      domainState.serial = serial;
      needsUpdate = true;

      // Skip SOA alert if suppression is enabled for this domain (default to true)
      if (domainConfig.suppressNonIpSoaAlerts !== false) {
        console.log(`Suppressing SOA alert for ${domain} as configured`);
        return;
      }

      const message =
        `📝 <b>DNS Zone Updated</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Previous Serial: <code>${domainState.serial || "unknown"}</code>\n` +
        `New Serial: <code>${serial}</code>\n` +
        `Time: ${now.toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>SOA</code>\n` +
        `- Primary NS: <code>${soaData[0] || "unknown"}</code>\n` +
        `- Admin Email: <code>${soaData[1] || "unknown"}</code>\n` +
        `- Refresh: <code>${soaData[3] || "unknown"}</code>\n` +
        `- Retry: <code>${soaData[4] || "unknown"}</code>\n` +
        `- Expire: <code>${soaData[5] || "unknown"}</code>\n` +
        `- Min TTL: <code>${soaData[6] || "unknown"}</code>`;

      await sendTelegramMessage(env, message);
      console.log(`SOA record updated for ${domain}:`);
      console.log(`Previous Serial: ${domainState.serial || "unknown"}`);
      console.log(`New Serial: ${serial}`);
    } else if (!ipChanged) {
      console.log(
        `No change detected for ${domain} (IPs: ${currentIPs.join(", ")})`
      );
    }

    // Only write to KV if there were changes
    if (needsUpdate) {
      await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(domainState));
    }
  } catch (error: unknown) {
    const errorMessage =
      `❌ <b>Error Monitoring DNS</b>\n\n` +
      `Domain: <code>${domain}</code>\n` +
      `Error: <code>${
        error instanceof Error ? error.message : String(error)
      }</code>\n\n` +
      `<b>Technical Details:</b>\n` +
      `- Time: <code>${new Date().toISOString()}</code>\n` +
      `- Worker: <code>dns-bot</code>\n` +
      `- Domain: <code>${domain}</code>`;

    await sendTelegramMessage(env, errorMessage);
    console.error(`Error monitoring DNS for ${domain}:`, error);
  }
}

async function testCloudFrontIPCheck() {
  const testIP = "3.166.244.103";
  const testRange = "3.166.0.0/15";

  // Convert IP to number
  const ipNum = ipToNumber(testIP);

  // Convert range to number and mask
  const [baseIP, bits] = testRange.split("/");
  const baseNum = ipToNumber(baseIP);
  const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;

  // Check if IP is in range
  const isInRange = (ipNum & mask) === (baseNum & mask);

  console.log(`Testing IP range check:`);
  console.log(`IP: ${testIP} (${ipNum})`);
  console.log(`Range: ${testRange}`);
  console.log(`Base IP: ${baseIP} (${baseNum})`);
  console.log(`Mask: ${mask.toString(2)}`);
  console.log(`Is in range: ${isInRange}`);

  return isInRange;
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (!env.MONITOR_DOMAINS) {
      console.error("MONITOR_DOMAINS environment variable is not set");
      return;
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error(
        "Telegram configuration is missing. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
      );
      return;
    }

    // Get the config
    const configResponse = await fetch(
      "https://d7uri8nf7uskq.cloudfront.net/tools/list-cloudfront-ips"
    );
    const config: Config = await configResponse.json();

    // Check each domain
    for (const domainConfig of config.domains) {
      await checkDomain(domainConfig.name, domainConfig, env);
    }
  },

  // Add fetch handler for HTTP requests
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Add test endpoint
    if (request.url.endsWith("/test-ip-range")) {
      const result = await testCloudFrontIPCheck();
      return new Response(JSON.stringify({ result }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      "DNS Monitor Worker is running. This worker is triggered by cron.",
      {
        headers: { "Content-Type": "text/plain" },
      }
    );
  },
};
