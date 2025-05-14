interface Env {
  DNS_KV: KVNamespace;
  MONITOR_DOMAINS: string; // Comma-separated list of domains
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

interface DNSResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
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
  url.searchParams.append("type", "A");

  console.log(`Querying DNS server: ${url.toString()}`);

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

  const data: DNSResponse = await response.json();
  console.log("Response data:", JSON.stringify(data, null, 2));

  return data;
}

async function checkDomain(domain: string, env: Env): Promise<void> {
  try {
    const dnsData = await queryDNS(domain);

    // Check for "No Reachable Authority" case
    const noAuthority = dnsData.Comment?.some((comment) =>
      comment.includes("No Reachable Authority")
    );

    if (noAuthority) {
      // Get the previous state from KV
      const previousState = await env.DNS_KV.get(`dns:${domain}:state`);

      if (previousState !== "no_authority") {
        // State has changed to no authority
        await env.DNS_KV.put(`dns:${domain}:state`, "no_authority");

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

    // Get the previous state and IPs from KV
    const previousState = await env.DNS_KV.get(`dns:${domain}:state`);
    const previousIPs = await env.DNS_KV.get(`dns:${domain}:ips`);
    const previousIPsArray = previousIPs ? previousIPs.split(",") : [];
    const currentIPs = aRecords.map((record) => record.data);

    // Sort arrays for consistent comparison
    previousIPsArray.sort();
    currentIPs.sort();

    // If the state has changed from no_authority to having IPs
    if (previousState === "no_authority" && currentIPs.length > 0) {
      await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
      await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));

      const message =
        `✅ <b>DNS Authority Restored</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `New IPs: <code>${currentIPs.join(", ")}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>A</code>\n` +
        `- Number of Records: <code>${aRecords.length}</code>`;

      await sendTelegramMessage(env, message);
      console.log(`DNS authority restored for ${domain}`);
      return;
    }

    // If the IPs have changed
    if (JSON.stringify(previousIPsArray) !== JSON.stringify(currentIPs)) {
      await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
      await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));

      const message =
        `🚨 <b>DNS Change Detected</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Previous IPs: <code>${previousIPs || "none"}</code>\n` +
        `New IPs: <code>${currentIPs.join(", ")}</code>\n` +
        `TTL: <code>${aRecords[0]?.TTL || "N/A"}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>A</code>\n` +
        `- Number of Records: <code>${aRecords.length}</code>`;

      await sendTelegramMessage(env, message);
      console.log(`DNS change detected for ${domain}:`);
      console.log(`Previous IPs: ${previousIPs || "none"}`);
      console.log(`New IPs: ${currentIPs.join(", ")}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
    } else {
      console.log(
        `No change detected for ${domain} (IPs: ${currentIPs.join(", ")})`
      );
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

    // Split the domains string into an array and trim whitespace
    const domains = env.MONITOR_DOMAINS.split(",").map((domain) =>
      domain.trim()
    );

    // Check each domain
    for (const domain of domains) {
      await checkDomain(domain, env);
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
