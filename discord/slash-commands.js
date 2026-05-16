// ─────────────────────────────────────────────────────────────────────
// discord/slash-commands.js — FMP-powered Discord slash commands
// ─────────────────────────────────────────────────────────────────────
// Three slash commands : /analyze, /insider, /politicians.
// All take a single required `ticker` string option and reply with an
// ephemeral embed. Data is sourced via market-data orchestrator (FMP
// with Yahoo fallback) — handlers don't know which source served the
// data, they just receive { source, ...payload }.
//
// Registration : global by default (slow propagation ~1h, visible in
// all guilds where the bot is). Set SLASH_COMMAND_GUILD_ID env var to
// scope to a single guild (instant propagation, useful for dev).
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-slash-commands-design.md
// ─────────────────────────────────────────────────────────────────────

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0x06b6d4;

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return '$' + n.toFixed(2);
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtMarketCap(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + n.toFixed(0);
}

function fmtShares(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

function fmtValue(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function collectSources(...results) {
  const sources = new Set();
  for (const r of results) if (r && r.source) sources.add(r.source);
  if (sources.size === 0) return 'No source';
  if (sources.size === 1) return 'Source: ' + Array.from(sources)[0].toUpperCase();
  return 'Sources: ' + Array.from(sources).sort().map(s => s.toUpperCase()).join(' + ') + ' (mixed)';
}

function createSlashCommands({ marketData, logger = console } = {}) {
  if (!marketData) throw new Error('marketData required');

  const commandDefs = [
    new SlashCommandBuilder()
      .setName('analyze')
      .setDescription('Show fundamentals + analyst targets + last earnings for a ticker')
      .addStringOption(opt => opt
        .setName('ticker')
        .setDescription('Stock ticker (e.g., AAPL)')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('insider')
      .setDescription('Show the last 5 insider transactions for a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Stock ticker').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('politicians')
      .setDescription('Show the last 5 US Senate + House trades for a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Stock ticker').setRequired(true))
      .toJSON(),
  ];

  async function register(client) {
    const guildId = process.env.SLASH_COMMAND_GUILD_ID || '';
    try {
      if (guildId) {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(commandDefs);
        logger.log('[slash-commands] registered ' + commandDefs.length
          + ' commands on guild ' + guildId + ' (instant propagation)');
      } else {
        await client.application.commands.set(commandDefs);
        logger.log('[slash-commands] registered ' + commandDefs.length
          + ' commands GLOBALLY (propagation up to 1h)');
      }
    } catch (err) {
      logger.error('[slash-commands] registration failed: ' + err.message);
    }
  }

  async function handleInteractionCreate(interaction) {
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case 'analyze':     return handleAnalyze(interaction);
      case 'insider':     return handleInsider(interaction);
      case 'politicians': return handlePoliticians(interaction);
    }
  }

  async function handleAnalyze(interaction) {
    const ticker = interaction.options.getString('ticker').toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      const [quote, ratios, targets, earnings] = await Promise.all([
        marketData.getQuote(ticker),
        marketData.getRatiosTtm(ticker),
        marketData.getPriceTargetSummary(ticker),
        marketData.getEarningsSurprises(ticker),
      ]);
      if (!quote && !ratios && !targets && !earnings) {
        await interaction.editReply({ content: '❌ Ticker $' + ticker + ' not found' });
        return;
      }
      const embed = buildAnalyzeEmbed({ ticker, quote, ratios, targets, earnings });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[slash-commands] /analyze ' + ticker + ' error: ' + err.message);
      try {
        await interaction.editReply({ content: '❌ Service unavailable, try again later' });
      } catch (e2) {
        logger.error('[slash-commands] /analyze editReply failed: ' + e2.message);
      }
    }
  }

  async function handleInsider(interaction) {
    const ticker = interaction.options.getString('ticker').toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await marketData.getInsiderTrades(ticker, 5);
      if (!data || !data.trades || data.trades.length === 0) {
        await interaction.editReply({ content: '❌ No insider transactions found for $' + ticker });
        return;
      }
      const embed = buildInsiderEmbed({ ticker, data });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[slash-commands] /insider ' + ticker + ' error: ' + err.message);
      try {
        await interaction.editReply({ content: '❌ Service unavailable, try again later' });
      } catch (e2) {
        logger.error('[slash-commands] /insider editReply failed: ' + e2.message);
      }
    }
  }

  async function handlePoliticians(interaction) {
    const ticker = interaction.options.getString('ticker').toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      const [senate, house] = await Promise.all([
        marketData.getSenateTrades(ticker, 5),
        marketData.getHouseTrades(ticker, 5),
      ]);
      const combined = [];
      if (senate && senate.trades) {
        for (const t of senate.trades) combined.push({ chamber: 'Sen.', ...t });
      }
      if (house && house.trades) {
        for (const t of house.trades) combined.push({ chamber: 'Rep.', ...t });
      }
      if (combined.length === 0) {
        await interaction.editReply({ content: '❌ No congressional trades found for $' + ticker });
        return;
      }
      combined.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const top5 = combined.slice(0, 5);
      const embed = buildPoliticiansEmbed({ ticker, trades: top5, sources: [senate, house] });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[slash-commands] /politicians ' + ticker + ' error: ' + err.message);
      try {
        await interaction.editReply({ content: '❌ Service unavailable, try again later' });
      } catch (e2) {
        logger.error('[slash-commands] /politicians editReply failed: ' + e2.message);
      }
    }
  }

  function buildAnalyzeEmbed({ ticker, quote, ratios, targets, earnings }) {
    const name = quote && quote.name ? ' — ' + quote.name : '';
    const e = new EmbedBuilder()
      .setTitle('🔍 ' + ticker + name)
      .setColor(EMBED_COLOR);

    if (quote) {
      const line = fmtPrice(quote.price)
        + (quote.changePct != null ? ' (' + fmtPct(quote.changePct) + ')' : '')
        + (quote.dayHigh != null && quote.dayLow != null
            ? ' — day H/L: ' + fmtPrice(quote.dayHigh) + ' / ' + fmtPrice(quote.dayLow)
            : '');
      e.addFields({ name: 'Price', value: line, inline: false });
    }
    if (ratios) {
      e.addFields({
        name: 'Fundamentals',
        value: 'P/E ' + (ratios.peRatio != null ? ratios.peRatio.toFixed(2) : '—')
          + ' · EPS ' + fmtPrice(ratios.eps)
          + ' · Market Cap ' + fmtMarketCap(ratios.marketCap),
        inline: false,
      });
    }
    if (targets) {
      e.addFields({
        name: 'Analyst Targets',
        value: 'Avg ' + fmtPrice(targets.targetMean)
          + (targets.targetHigh != null ? ' · High ' + fmtPrice(targets.targetHigh) : '')
          + (targets.targetLow != null ? ' · Low ' + fmtPrice(targets.targetLow) : '')
          + (targets.numberOfAnalysts != null ? ' (' + targets.numberOfAnalysts + ' analysts)' : ''),
        inline: false,
      });
    }
    if (earnings && earnings.mostRecent) {
      const er = earnings.mostRecent;
      const beatStr = er.beat === true ? '✅ beat' : er.beat === false ? '❌ miss' : '—';
      e.addFields({
        name: 'Last Earnings',
        value: (er.date || '—')
          + ' — EPS ' + fmtPrice(er.epsActual) + ' vs est ' + fmtPrice(er.epsEstimate)
          + ' (' + beatStr + (er.surprisePct != null ? ' ' + fmtPct(er.surprisePct) : '') + ')',
        inline: false,
      });
    }
    e.setFooter({ text: collectSources(quote, ratios, targets, earnings) });
    return e;
  }

  function buildInsiderEmbed({ ticker, data }) {
    const lines = data.trades.slice(0, 5).map(t => {
      return '▸ `' + (t.date || '—') + '`  ' + (t.name || '—')
        + '  ' + (t.type || '—')
        + '  ' + fmtShares(t.shares) + ' sh @ ' + fmtPrice(t.price)
        + '  (' + fmtValue(t.value) + ')';
    });
    const e = new EmbedBuilder()
      .setTitle('👤 ' + ticker + ' — Insider transactions (' + data.trades.length + ' most recent)')
      .setColor(EMBED_COLOR)
      .setDescription(lines.join('\n'))
      .setFooter({ text: collectSources(data) });
    return e;
  }

  function buildPoliticiansEmbed({ ticker, trades, sources }) {
    const lines = trades.map(t => {
      return '▸ `' + (t.date || '—') + '`  ' + (t.chamber || '') + ' ' + (t.name || '—')
        + '  ' + (t.type || '—') + '  ' + (t.amount || '—');
    });
    const e = new EmbedBuilder()
      .setTitle('🏛️ ' + ticker + ' — US Congressional trades (' + trades.length + ' most recent)')
      .setColor(EMBED_COLOR)
      .setDescription(lines.join('\n'))
      .setFooter({ text: collectSources(...sources) });
    return e;
  }

  function wire(client) {
    client.once('ready', () => register(client));
    client.on('interactionCreate', (interaction) => {
      handleInteractionCreate(interaction).catch(err =>
        logger.error('[slash-commands] handler error: ' + err.message));
    });
  }

  return {
    wire,
    register,
    handleInteractionCreate,
    handleAnalyze,
    handleInsider,
    handlePoliticians,
  };
}

module.exports = { createSlashCommands };
