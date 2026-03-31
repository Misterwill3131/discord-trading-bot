const { Client, GatewayIntentBits } = require('discord.js');

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required');
    process.exit(1);
    }

    if (!MAKE_WEBHOOK_URL) {
      console.error('MAKE_WEBHOOK_URL is required');
        process.exit(1);
        }

        const client = new Client({
          intents: [
              GatewayIntentBits.Guilds,
                  GatewayIntentBits.GuildMessages,
                      GatewayIntentBits.MessageContent
                        ]
                        });

                        client.on('ready', () => {
                          console.log(`Bot connected as ${client.user.tag}`);
                            console.log(`Watching ${client.guilds.cache.size} server(s)`);
                            });

                            client.on('messageCreate', async (msg) => {
                              // Ignore bot messages
                                if (msg.author.bot) return;

                                  try {
                                      const payload = {
                                            content: msg.content,
                                                  author_username: msg.author.username,
                                                        author_avatar: msg.author.displayAvatarURL({ format: 'png', size: 128 }),
                                                              channel_name: msg.channel.name,
                                                                    channel_id: msg.channel.id,
                                                                          guild_name: msg.guild ? msg.guild.name : 'DM',
                                                                                timestamp: msg.createdAt.toISOString(),
                                                                                      message_id: msg.id
                                                                                          };

                                                                                              const response = await fetch(MAKE_WEBHOOK_URL, {
                                                                                                    method: 'POST',
                                                                                                          headers: { 'Content-Type': 'application/json' },
                                                                                                                body: JSON.stringify(payload)
                                                                                                                    });
                                                                                                                    
                                                                                                                        if (response.ok) {
                                                                                                                              console.log(`Forwarded message from ${msg.author.username} in #${msg.channel.name}`);
                                                                                                                                  } else {
                                                                                                                                        console.error(`Make webhook error: ${response.status}`);
                                                                                                                                            }
                                                                                                                                              } catch (error) {
                                                                                                                                                  console.error('Error forwarding message:', error.message);
                                                                                                                                                    }
                                                                                                                                                    });
                                                                                                                                                    
                                                                                                                                                    client.login(DISCORD_TOKEN);
