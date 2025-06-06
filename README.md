# DNS Monitor Bot

A simple, pre-built Cloudflare Worker that monitors DNS records and TLS certificates for any list of user-specified domains and sends notifications via Telegram when changes are detected.

The project is designed to stay comfortably within Cloudflare's free tier for its Worker and KV storage services.

<p align="center">
  <img src="images/example_alert.png" alt="Example alert" />
  <br/>
  <i>Example alert</i>
</p>

## Prerequisites

- [Node.js](https://nodejs.org/) (v20 or later)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v4 or later)

## Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/wavey0x/dns-bot.git
   cd dns-bot
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure your bot and secrets:**

   - Create a `.env` file in the project root and supply values:

     ```bash
     cp .env.example .env
     ```

   - Supply the same variables and values as GitHub Actions secrets within your repository's settings.[^1]

   - Update `config.json` with your settings. The config file is now read directly by the Worker (no need for environment variable secrets for domain config):

     ```json
     {
       "domains": [
         {
           "name": "domain1.com",
           "suppressNonIpSoaAlerts": true,
           "suppressCertAlerts": false,
           "suppressIpChangeAlerts": false,
           "criticalChangeWindowMinutes": 10
         },
         {
           "name": "domain2.com",
           "suppressCertAlerts": false,
           "suppressIpChangeAlerts": false,
           "criticalChangeWindowMinutes": 10
         }
       ],
       "cron": "*/5 * * * *",
       "kvNamespace": {
         "id": "your-kv-namespace-id"
       }
     }
     ```

   > **Note:** Each domain you want to monitor must be explicitly listed in the `domains` array. Subdomains are not automatically monitored - if you want to monitor a subdomain, add it to the list (e.g., `"name": "sub.domain.com"`).

   - Get your Cloudflare API token[^2]

4. **Deploy the bot:**

   - **Option 1: Deploy locally**

     Run the deploy script:

     ```bash
     npm run deploy
     ```

     This will:

     - Set up the KV namespace if needed
     - Configure Telegram secrets
     - Update the worker configuration
     - Deploy to Cloudflare Workers

   - **Option 2: Deploy via GitHub Actions**

     - Push your changes to the `main` branch.
     - The GitHub Action will automatically deploy the bot.

## Viewing Logs

To view the logs for your deployed worker:

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Workers & Pages**.
3. Select your worker (`dns-bot`).
4. Click on **Logs** to view the worker's logs.

## Troubleshooting

- **Wrangler not found:** Ensure Wrangler is installed globally or use `npx wrangler`.
- **Deployment fails:** Check your API token and ensure all environment variables are set correctly.
- **No logs:** Ensure logging is enabled in your `wrangler.toml` file.
- **GitHub Actions fails:** Verify that all required secrets are set in your repository's Settings > Secrets and variables > Actions.

## Footnotes

[^1]: Required secrets must be set in both your local `.env` file and GitHub Actions repository secrets. Go to your repository's Settings > Secrets and variables > Actions and add: `CLOUDFLARE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`.
[^2]: To get your Cloudflare API token:

    1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/)
    2. Navigate to **My Profile** > **API Tokens**
    3. Click **Create Token**
    4. Choose **Create Custom Token**
    5. Set the following permissions:
       - **Account** > **Workers** > **Edit**
       - **Zone** > **DNS** > **Read**
    6. Set the **Account Resources** to **All accounts**
    7. Set the **Zone Resources** to **All zones**
    8. Click **Continue to summary** and then **Create Token**

## Certificate and DNS Change Detection Logic

The bot includes robust logic to detect both DNS and certificate changes for your domains:

1. **IP Change Detection:**

   - The bot monitors DNS A records for each domain.
   - IP addresses are always sorted before comparison to avoid false positives due to order changes.
   - When an IP change is detected, the bot sends an alert with before/after details.

2. **Certificate Validation:**

   - On every run, the bot connects to the domain's IP and retrieves the TLS certificate.
   - The certificate is compared to a baseline (the last known valid certificate) stored in KV.
   - If the certificate changes unexpectedly, a high-severity alert is sent.
   - If the certificate is invalid or cannot be retrieved, a critical alert is sent immediately.

3. **SOA Change Detection:**

   - The bot also checks the SOA serial for the domain.
   - If the SOA serial changes (and IPs have not changed), an alert is sent (unless suppressed by config).

4. **Critical Change Window:**

   - If both an IP change and a certificate change occur within a configurable time window, a critical alert is sent.

5. **Alerting:**

   - Alerts are sent via Telegram with clear before/after information and technical details.
   - You can suppress certain alerts (e.g., SOA, IP, or certificate) per domain in the config.

6. **No CloudFront Logic:**
   - All CloudFront-specific logic and configuration have been removed. The bot now works for any domain and does not treat CloudFront IPs specially.

## Best Practices

- **Monitor all critical domains and subdomains.**
- **Review alerts promptly** to catch potential DNS hijacking or certificate issues.
- **Update the baseline certificate** in KV if you perform a legitimate certificate renewal.
- **Keep your config.json up to date** with all domains you want to monitor.

This bot adds an extra layer of security to your DNS monitoring, ensuring that both IP and certificate changes are tracked and alerted on for potential threats.
