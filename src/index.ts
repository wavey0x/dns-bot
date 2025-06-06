import {
  Env,
  CertificateInfo,
  DNSResponse,
  DomainConfig,
  DomainState,
  Config,
} from "./types";
import { checkCertificate, validateCertificates } from "./cert-utils";
import config from "../config.json";

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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, index) => val === sortedB[index]);
}

async function queryDNS(domain: string): Promise<DNSResponse> {
  // Using Cloudflare's 1.1.1.1 DNS service for reliable DNS queries
  const response = await fetch(
    `https://1.1.1.1/dns-query?name=${domain}&type=A`,
    {
      headers: {
        accept: "application/dns-json",
      },
    }
  );
  return response.json();
}

async function checkDomain(env: Env, domainConfig: DomainConfig) {
  const domain = domainConfig.name;
  const dnsData = await queryDNS(domain);

  // Get current domain state from KV
  const domainStateStr = await env.DNS_KV.get(`dns:${domain}`);
  const domainState = domainStateStr
    ? (JSON.parse(domainStateStr) as DomainState)
    : null;

  if (domainState && domainState.ips) {
    domainState.ips = [...domainState.ips].sort();
  }

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
    console.log(`[${domain}] Initialized state`);
    return;
  }

  // Check for "No Reachable Authority" case
  if (dnsData.Status === 3) {
    if (domainState.state !== "No Reachable Authority") {
      domainState.state = "No Reachable Authority";
      domainState.ips = [];
      domainState.serial = null;
      await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(domainState));
      console.log(`[${domain}] Domain unreachable`);
    }
    return;
  }

  // Get current IPs from A records and sort them
  const currentIps = (
    dnsData.Answer?.filter((record) => record.type === 1).map(
      (record) => record.data
    ) || []
  ).sort();
  const previousIps = (domainState.ips || []).sort();
  const ipChanged = !arraysEqual(currentIps, previousIps);

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
      certCriticalError,
    } = await validateCertificates(domain, currentIps, domainState);

    if (certCriticalError) {
      const message =
        `🚨 <b>CRITICAL: Certificate Validation Error</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Time: ${new Date().toISOString()}\n` +
        `Error: <code>${certCriticalError}</code>\n`;
      await sendTelegramMessage(env, message);
      console.log(
        `[${domain}] CRITICAL: Certificate validation error: ${certCriticalError}`
      );
      return;
    }

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
        console.log(`[${domain}] Certificate changed: ${newCertInfo.issuer}`);
      }
    }
  }

  // Handle IP changes
  if (ipChanged) {
    domainState.ips = [...currentIps].sort();
    domainState.lastIpChange = new Date().toISOString();
    needsUpdate = true;

    if (!domainConfig.suppressIpChangeAlerts) {
      const message =
        `⚠️ <b>DNS IP Change Detected</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Previous IPs: <code>${previousIps.join(", ") || "none"}</code>\n` +
        `New IPs: <code>${currentIps.join(", ")}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>A</code>\n` +
        `- Number of Records: <code>${currentIps.length}</code>\n` +
        `- SOA Serial: <code>${serial || "unknown"}</code>`;

      await sendTelegramMessage(env, message);
      console.log(
        `[${domain}] IPs changed: ${
          previousIps.join(", ") || "none"
        } -> ${currentIps.join(", ")}`
      );
    }
  }

  // Handle SOA changes if IPs haven't changed
  if (serial !== domainState.serial && !ipChanged) {
    domainState.serial = serial;
    needsUpdate = true;

    // Skip SOA alert if suppression is enabled for this domain (default to true)
    if (domainConfig.suppressNonIpSoaAlerts !== false) {
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
    console.log(
      `[${domain}] SOA updated: ${domainState.serial || "unknown"} -> ${
        serialNum || "unknown"
      }`
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
        `[${domain}] CRITICAL: IP and certificate changed within ${domainConfig.criticalChangeWindowMinutes} minutes`
      );
    }
  }

  // Save state if there were changes
  if (needsUpdate) {
    await env.DNS_KV.put(`dns:${domain}`, JSON.stringify(domainState));
  } else {
    console.log(`[${domain}] No changes detected`);
  }
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error(
        "Telegram configuration is missing. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
      );
      return;
    }

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
    return new Response(
      "DNS Monitor Worker is running. This worker is triggered by cron.",
      {
        headers: { "Content-Type": "text/plain" },
      }
    );
  },
};
