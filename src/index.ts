import {
  Env,
  CertificateInfo,
  DNSResponse,
  CloudFrontIPResponse,
  DomainConfig,
  DomainState,
  Config,
} from "./types";
import { checkCertificate, validateCertificates } from "./cert-utils";

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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, index) => val === sortedB[index]);
}

async function checkDomain(env: Env, domainConfig: DomainConfig) {
  const domain = domainConfig.name;
  console.log(`Querying DNS server for SOA: ${domain}`);
  const dnsData = await queryDNS(domain);

  // Get current domain state from KV
  const domainStateStr = await env.DNS_KV.get(`dns:${domain}`);
  const domainState = domainStateStr
    ? (JSON.parse(domainStateStr) as DomainState)
    : null;

  // Initialize state if it doesn't exist
  if (!domainState) {
    const newState: DomainState = {
      state: "No Reachable Authority",
      ips: [],
      serial: null,
      lastIpChange: null,
      lastCertChange: null,
      baselineCert: null,
    };
    await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(newState));
    console.log(`Initialized state for ${domain}`);
    return;
  }

  // Check for "No Reachable Authority" case
  if (dnsData.Status === 3) {
    if (domainState.state !== "No Reachable Authority") {
      domainState.state = "No Reachable Authority";
      domainState.ips = [];
      domainState.serial = null;
      await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(domainState));
      console.log(`Domain ${domain} is now unreachable`);
    }
    return;
  }

  // Get current IPs from A records
  const currentIps =
    dnsData.Answer?.filter((record) => record.type === 1).map(
      (record) => record.data
    ) || [];
  const ipChanged = !arraysEqual(currentIps, domainState.ips);

  // Get SOA serial
  const soaData =
    dnsData.Answer?.find((record) => record.type === 6)?.data.split(" ") || [];
  const serial = soaData[2] || null;

  // Update state if needed
  let needsUpdate = false;
  let certChanged = false;
  let certInfo: CertificateInfo | null = null;

  // Always validate certificates
  if (currentIps.length > 0) {
    const {
      isExpected,
      certInfo: newCertInfo,
      certChanged: newCertChanged,
    } = await validateCertificates(domain, currentIps, domainState);
    if (!isExpected && newCertInfo) {
      certChanged = newCertChanged;
      certInfo = newCertInfo;
      domainState.lastCertChange = new Date().toISOString();
      domainState.baselineCert = newCertInfo;
      needsUpdate = true;

      if (!domainConfig.suppressCertAlerts) {
        const message =
          `🚨 <b>Unexpected Certificate Change</b>\n\n` +
          `Domain: <code>${domain}</code>\n` +
          `Time: ${new Date().toISOString()}\n\n` +
          `<b>Current Certificate:</b>\n` +
          `- Issuer: <code>${newCertInfo.issuer}</code>\n` +
          `- Subject: <code>${newCertInfo.subject}</code>\n` +
          `- Valid From: <code>${newCertInfo.validFrom}</code>\n` +
          `- Valid To: <code>${newCertInfo.validTo}</code>\n` +
          `- Fingerprint: <code>${newCertInfo.fingerprint}</code>\n` +
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
  }

  // Handle IP changes
  if (ipChanged) {
    domainState.ips = currentIps;
    domainState.lastIpChange = new Date().toISOString();
    needsUpdate = true;
    console.log(`IPs changed for ${domain}:`, currentIps);

    if (!domainConfig.suppressIpChangeAlerts) {
      const message =
        `⚠️ <b>DNS IP Change Detected</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Previous IPs: <code>${domainState.ips.join(", ") || "none"}</code>\n` +
        `New IPs: <code>${currentIps.join(", ")}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>A</code>\n` +
        `- Number of Records: <code>${currentIps.length}</code>\n` +
        `- SOA Serial: <code>${serial || "unknown"}</code>`;

      await sendTelegramMessage(env, message);
      console.log(`DNS IP change detected for ${domain}:`);
      console.log(`Previous IPs: ${domainState.ips.join(", ") || "none"}`);
      console.log(`New IPs: ${currentIps.join(", ")}`);
    } else {
      console.log(`Suppressing IP change alert for ${domain} as configured`);
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

    // Parse SOA data more carefully
    const soaFields = soaData.length >= 7 ? soaData : Array(7).fill("unknown");
    const [primaryNS, adminEmail, serialNum, refresh, retry, expire, minTTL] =
      soaFields;

    const message =
      `📝 <b>DNS Zone Updated</b>\n\n` +
      `Domain: <code>${domain}</code>\n` +
      `Previous Serial: <code>${domainState.serial || "unknown"}</code>\n` +
      `New Serial: <code>${serialNum || "unknown"}</code>\n` +
      `Time: ${new Date().toISOString()}\n\n` +
      `<b>Technical Details:</b>\n` +
      `- DNS Status: <code>${dnsData.Status}</code>\n` +
      `- Record Type: <code>SOA</code>\n` +
      `- Primary NS: <code>${primaryNS}</code>\n` +
      `- Admin Email: <code>${adminEmail}</code>\n` +
      `- Refresh: <code>${refresh}</code>\n` +
      `- Retry: <code>${retry}</code>\n` +
      `- Expire: <code>${expire}</code>\n` +
      `- Min TTL: <code>${minTTL}</code>`;

    await sendTelegramMessage(env, message);
    console.log(`SOA record updated for ${domain}:`);
    console.log(`Previous Serial: ${domainState.serial || "unknown"}`);
    console.log(`New Serial: ${serialNum || "unknown"}`);
  } else if (!ipChanged) {
    console.log(
      `No change detected for ${domain} (IPs: ${currentIps.join(", ")})`
    );
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
      ? new Date().getTime() - lastIpChange.getTime()
      : Infinity;
    const timeSinceLastCertChange = lastCertChange
      ? new Date().getTime() - lastCertChange.getTime()
      : Infinity;

    if (
      timeSinceLastIpChange <= windowMs &&
      timeSinceLastCertChange <= windowMs
    ) {
      const message =
        `🚨🚨 <b>CRITICAL: Concurrent IP and Certificate Changes</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>IP Change:</b>\n` +
        `- Previous IPs: <code>${
          domainState.ips.join(", ") || "none"
        }</code>\n` +
        `- New IPs: <code>${currentIps.join(", ")}</code>\n\n` +
        `<b>Certificate Change:</b>\n` +
        `- Current Issuer: <code>${certInfo?.issuer || "unknown"}</code>\n` +
        `- Current Subject: <code>${certInfo?.subject || "unknown"}</code>\n` +
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

  // Save state if there were changes
  if (needsUpdate) {
    await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(domainState));
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
      await checkDomain(env, domainConfig);
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
