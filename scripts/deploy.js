const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper to run commands and handle errors
function runCommand(command, errorMessage) {
  try {
    return execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error(`❌ ${errorMessage}`);
    console.error(error.message);
    process.exit(1);
  }
}

// Helper to prompt for input
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Check if Wrangler is installed
function checkWrangler() {
  try {
    execSync("npx wrangler --version", { stdio: "ignore" });
    console.log("✅ Wrangler is installed");
  } catch (error) {
    console.error("❌ Installing Wrangler...");
    runCommand(
      "npm install --save-dev wrangler@4",
      "Failed to install Wrangler"
    );
  }
}

// Check if logged in to Cloudflare
function checkCloudflareLogin() {
  try {
    execSync("npx wrangler whoami", { stdio: "ignore" });
    console.log("✅ Logged in to Cloudflare");
  } catch (error) {
    console.error("❌ Not logged in to Cloudflare. Please login...");
    runCommand("npx wrangler login", "Failed to login to Cloudflare");
  }
}

// Update wrangler.toml with config values
function updateWranglerConfig() {
  console.log("📝 Updating wrangler.toml with config values...");

  // Read config.json
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf8")
  );

  // Read wrangler.toml
  const wranglerPath = path.join(__dirname, "../wrangler.toml");
  let wranglerContent = fs.readFileSync(wranglerPath, "utf8");

  // Update KV namespace ID
  wranglerContent = wranglerContent.replace(
    /id = ".*"/,
    `id = "${config.kvNamespace.id}"`
  );

  // Update cron schedule
  wranglerContent = wranglerContent.replace(
    /crons = \[".*"\]/,
    `crons = ["${config.cron}"]`
  );

  // Write updated wrangler.toml
  fs.writeFileSync(wranglerPath, wranglerContent);
  console.log("✅ Updated wrangler.toml with config values");
}

// Check and create KV namespace if needed
async function setupKVNamespace() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf8")
  );

  if (!config.kvNamespace?.id) {
    console.log("Creating KV namespace...");
    const output = execSync('npx wrangler kv:namespace create "DNS_KV"', {
      encoding: "utf8",
    });
    const match = output.match(/id = "([^"]+)"/);

    if (!match) {
      console.error("❌ Failed to create KV namespace");
      process.exit(1);
    }

    const namespaceId = match[1];
    config.kvNamespace = { id: namespaceId };
    fs.writeFileSync(
      path.join(__dirname, "../config.json"),
      JSON.stringify(config, null, 2)
    );
    console.log("✅ KV namespace created and added to config.json");
  } else {
    console.log("✅ KV namespace already configured");
  }
}

// Check and set up Telegram secrets
async function setupTelegramSecrets() {
  // TELEGRAM_BOT_TOKEN
  let botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    console.log("ℹ️ Using TELEGRAM_BOT_TOKEN from environment");
    runCommand(
      `echo '${botToken}' | npx wrangler secret put TELEGRAM_BOT_TOKEN`,
      "Failed to set Telegram bot token from environment"
    );
  } else {
    try {
      execSync("npx wrangler secret get TELEGRAM_BOT_TOKEN", {
        stdio: "ignore",
      });
      console.log("✅ Telegram bot token is set");
    } catch (error) {
      const token = await prompt("Enter your Telegram bot token: ");
      runCommand(
        `echo '${token}' | npx wrangler secret put TELEGRAM_BOT_TOKEN`,
        "Failed to set Telegram bot token"
      );
    }
  }

  // TELEGRAM_CHAT_ID
  let chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId) {
    console.log("ℹ️ Using TELEGRAM_CHAT_ID from environment");
    runCommand(
      `echo '${chatId}' | npx wrangler secret put TELEGRAM_CHAT_ID`,
      "Failed to set Telegram chat ID from environment"
    );
  } else {
    try {
      execSync("npx wrangler secret get TELEGRAM_CHAT_ID", { stdio: "ignore" });
      console.log("✅ Telegram chat ID is set");
    } catch (error) {
      const chatIdPrompt = await prompt("Enter your Telegram chat ID: ");
      runCommand(
        `echo '${chatIdPrompt}' | npx wrangler secret put TELEGRAM_CHAT_ID`,
        "Failed to set Telegram chat ID"
      );
    }
  }

  // TELEGRAM_TOPIC_ID (optional)
  let topicId = process.env.TELEGRAM_TOPIC_ID;
  if (topicId) {
    console.log("ℹ️ Using TELEGRAM_TOPIC_ID from environment");
    runCommand(
      `echo '${topicId}' | npx wrangler secret put TELEGRAM_TOPIC_ID`,
      "Failed to set Telegram topic ID from environment"
    );
  } else {
    console.log("ℹ️ Skipping TELEGRAM_TOPIC_ID (not set)");
  }
}

// Set up MONITOR_DOMAINS from config.json
async function setupMonitorDomains() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf8")
  );
  const domains = config.domains.join(",");

  console.log("ℹ️ Setting MONITOR_DOMAINS from config.json");
  runCommand(
    `echo '${domains}' | npx wrangler secret put MONITOR_DOMAINS`,
    "Failed to set MONITOR_DOMAINS"
  );
}

// Main deployment process
async function deploy() {
  console.log("🚀 Starting deployment process...\n");

  // Check prerequisites
  checkWrangler();
  checkCloudflareLogin();

  // Set up configuration
  await setupKVNamespace();
  await setupTelegramSecrets();
  await setupMonitorDomains();
  updateWranglerConfig();

  // Deploy
  console.log("\n📦 Deploying...");
  runCommand("npx wrangler deploy", "Deployment failed");

  console.log("\n✅ Deployment completed successfully!");
  rl.close();
}

// Run deployment
deploy().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exit(1);
});
