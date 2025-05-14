# DNS Monitoring Bot

A Cloudflare Worker that monitors DNS A records for specified domains and sends notifications via Telegram when changes are detected. The bot also tracks and notifies about DNS authority reachability issues.

## Features

- Monitors multiple domains simultaneously
- Tracks DNS A record changes
- Detects DNS authority reachability issues
- Sends notifications via Telegram
- Persistent storage of DNS states and IPs
- Detailed logging for debugging

## Prerequisites

- Node.js and npm installed
- Cloudflare account
- Telegram bot token and chat ID
- Wrangler CLI installed globally (`npm install -g wrangler`)

## Setup

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd dns-bot
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Login to Cloudflare:

   ```bash
   wrangler login
   ```

4. Create a KV namespace:

   ```bash
   wrangler kv:namespace create "DNS_KV"
   ```

5. Update `wrangler.toml` with your configuration:

   ```toml
   # KV Namespace configuration
   kv_namespaces = [
     { binding = "DNS_KV", id = "your-namespace-id" }
   ]

   # Environment variables
   [vars]
   MONITOR_DOMAINS = "domain1.com,domain2.com,domain3.com"  # Comma-separated list of domains
   ```

6. Set your Telegram secrets:
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   ```

## Configuration

### Environment Variables

- `MONITOR_DOMAINS`: Comma-separated list of domains to monitor (e.g., "curve.fi,yearn.fi,yearn.finance,curve.finance")
- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
- `TELEGRAM_CHAT_ID`: Your Telegram chat ID

### Managing Domains

The list of domains to monitor is configured in `wrangler.toml` under the `[vars]` section.

Example:

```toml
[vars]
MONITOR_DOMAINS = "yearn.fi,yearn.finance,curve.finance,curve.fi,resupply.fi"
```

The changes will take effect after the next deployment. You can verify the domains being monitored by:

- Checking the worker logs: `wrangler tail dns-bot`
- Viewing the KV storage: `wrangler kv key list --namespace-id=your-namespace-id`

### KV Storage

The bot uses Cloudflare KV to store:

- `dns:${domain}:state` - Current state ('no_authority' or 'resolved')
- `dns:${domain}:ips` - Last known IP addresses

To view KV storage:

```bash
# List all keys
wrangler kv key list --namespace-id=your-namespace-id

# Get value for a specific key
wrangler kv key get --namespace-id=your-namespace-id "dns:domain.com:state"
wrangler kv key get --namespace-id=your-namespace-id "dns:domain.com:ips"
```

### Logging

The bot includes detailed logging for debugging. To view logs:

```bash
# Start a log tailing session
wrangler tail dns-bot
```

## Notifications

The bot sends three types of notifications:

1. 🚨 DNS Change Detected

   - When IP addresses change
   - Includes previous and new IPs
   - Technical details about the change

2. ⚠️ DNS Authority Unreachable

   - When a domain's authority servers are unreachable
   - Includes DNS status and comments
   - Technical details about the issue

3. ✅ DNS Authority Restored
   - When a previously unreachable domain becomes reachable
   - Includes new IP addresses
   - Technical details about the resolution

## Deployment

Deploy the worker:

```bash
wrangler deploy
```

The worker will run every minute to check for DNS changes.

## Troubleshooting

### Common Issues

1. **Wrangler not found**

   - Solution: Install Wrangler globally: `npm install -g wrangler`

2. **KV namespace errors**

   - Solution: Verify the namespace ID in `wrangler.toml`
   - Check KV permissions in Cloudflare dashboard

3. **Telegram notification failures**

   - Solution: Verify bot token and chat ID
   - Check if the bot is added to the chat
   - Ensure the bot has permission to send messages

4. **DNS query failures**
   - Solution: Check the logs using `wrangler tail dns-bot`
   - Verify domain names are correct
   - Check if domains are accessible

### Checking Status

1. View worker logs:

   ```bash
   wrangler tail dns-bot
   ```

2. Check KV storage:

   ```bash
   wrangler kv key list --namespace-id=your-namespace-id
   ```

3. Verify worker status in Cloudflare dashboard:
   - Go to Workers & Pages
   - Select your worker
   - Check "Triggers" for cron status
   - Check "Logs" for recent activity

## License

MIT
