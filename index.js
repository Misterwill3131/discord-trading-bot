const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');
const http = require('http');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';

if (!DISCORD_TOKEN) {
        console.error('ERROR: DISCORD_TOKEN is not set');
        process.exit(1);
}

if (!MAKE_WEBHOOK_URL) {
        console.error('ERROR: MAKE_WEBHOOK_URL is not set');
        process.exit(1);
}

const client = new Client({
        intents: [
                  GatewayIntentBits.Guilds,
                  GatewayIntentBits.GuildMessages,
                  GatewayIntentBits.MessageContent,
                ],
});

function sendToMake(payload) {
        return new Promise((resolve, reject) => {
                  const data = JSON.stringify(payload);
                  const url = new URL(MAKE_WEBHOOK_URL);
                  const options = {
                              hostname: url.hostname,
                              path: url.pathname + url.search,
                              method: 'POST',
                              headers: {
                                            'Content-Type': 'application/json',
                                            'Content-Length': Buffer.byteLength(data),
                              },
                  };
                  const lib = url.protocol === 'https:' ? https : http;
                  const req = lib.request(options, (res) => {
                              let body = '';
                              res.on('data', (chunk) => { body += chunk; });
                              res.on('end', () => resolve({ status: res.statusCode, body }));
                  });
                  req.on('error', reject);
                  req.write(data);
                  req.end();
        });
}

client.once('ready', () => {
        console.log(`Bot connected as ${client.user.tag}`);
        console.log(`Listening for messages in channels containing: ${TRADING_CHANNEL}`);
});

client.on('messageCreate', async (message) => {
        if (message.author.bot) return;

            const channelName = message.channel.name || '';
        console.log(`Message received - channel: "${channelName}", author: ${message.author.username}`);

            if (!channelName.includes(TRADING_CHANNEL)) return;

            const content = message.content;
        console.log(`Trading signal in #${channelName}: ${content}`);

            try {
                      const payload = {
                                  content: content,
                                  author: message.author.username,
                                  author_id: message.author.id,
                                  channel: channelName,
                                  timestamp: message.createdAt.toISOString(),
                                  message_id: message.id,
                      };

          const result = await sendToMake(payload);
                      console.log(`Sent to Make, status: ${result.status}`);
            } catch (err) {
                      console.error('Error sending to Make:', err.message);
            }
});

client.login(DISCORD_TOKEN);
