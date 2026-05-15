// ─────────────────────────────────────────────────────────────────────
// db/sqlite.js — Base SQLite embarquée (fichier `boom.db` dans DATA_DIR)
// ─────────────────────────────────────────────────────────────────────
// Stocke les messages Discord traités (source de vérité). Remplace les
// fichiers journaliers messages-YYYY-MM-DD.json qui restent en backup
// mais ne sont plus lus par l'app.
//
// Choix techniques :
//   • better-sqlite3 : API synchrone, plus simple que le modèle async de
//     node-sqlite3. Bloque l'event loop sur chaque query mais les
//     volumes restent faibles (quelques milliers de messages/jour) et
//     le bot est single-process donc pas de contention.
//   • WAL mode : autorise les lectures concurrentes pendant les writes,
//     réduit les verrous. Recommandé pour un read-heavy workload.
//   • `ts` en TEXT ISO : inexable, triable lexicographiquement. Pas de
//     DATETIME car SQLite n'a pas de type date natif de toute façon.
//   • `passed` / `isReply` en INTEGER : 0/1. SQLite n'a pas de BOOLEAN.
//
// IDs au format "timestamp-rand" hérités de logEvent() — on garde le
// format exact pour que la migration JSON → DB soit idempotente (on
// réinsère tel quel, et INSERT OR IGNORE sur la PK déduplique).
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../utils/persistence');

const DB_PATH = path.join(DATA_DIR, 'boom.db');

// Singleton : une seule connexion pour tout le process. `verbose` peut
// être ajouté pour logger chaque query pendant le debug.
const db = new Database(DB_PATH);

// WAL = Write-Ahead Logging : lectures concurrentes aux writes, plus
// performant pour un pattern write-write-read-read que le rollback journal.
db.pragma('journal_mode = WAL');
// FK constraints off par défaut dans SQLite — on n'en a pas ici, mais
// activation future facile.
db.pragma('foreign_keys = ON');

// Schema creation — idempotent. Appelé à l'import, crée les tables
// absentes sans toucher aux existantes.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    ts            TEXT NOT NULL,
    author        TEXT,
    channel       TEXT,
    content       TEXT NOT NULL DEFAULT '',
    preview       TEXT NOT NULL DEFAULT '',
    passed        INTEGER NOT NULL,            -- 0 ou 1
    type          TEXT,                         -- 'entry' | 'exit' | 'neutral' | NULL
    reason        TEXT,
    confidence    INTEGER,
    ticker        TEXT,
    entry_price   REAL,
    isReply       INTEGER NOT NULL DEFAULT 0,
    parentPreview TEXT,
    parentAuthor  TEXT
  );

  -- Index pour les queries les plus fréquentes du dashboard :
  CREATE INDEX IF NOT EXISTS idx_messages_ts            ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_ticker        ON messages(ticker);
  CREATE INDEX IF NOT EXISTS idx_messages_author        ON messages(author);
  CREATE INDEX IF NOT EXISTS idx_messages_passed_ts     ON messages(passed, ts);
  CREATE INDEX IF NOT EXISTS idx_messages_ticker_passed ON messages(ticker, passed);

  -- Compteur journalier de profits (1 ligne / jour). milestones_json garde
  -- les paliers déjà annoncés (10/25/50/...) pour ne pas re-notifier.
  CREATE TABLE IF NOT EXISTS profit_counts (
    date            TEXT PRIMARY KEY,       -- YYYY-MM-DD
    count           INTEGER NOT NULL DEFAULT 0,
    milestones_json TEXT    NOT NULL DEFAULT '[]'
  );

  -- Review des messages postés dans #profits (incluant les ignorés).
  -- Permet le feedback learned (blacklist/whitelist) via la page /profits.
  CREATE TABLE IF NOT EXISTS profit_messages (
    id        TEXT PRIMARY KEY,            -- "timestamp-rand" (comme messages)
    ts        TEXT NOT NULL,
    author    TEXT,
    content   TEXT NOT NULL DEFAULT '',
    preview   TEXT NOT NULL DEFAULT '',
    hasImage  INTEGER NOT NULL DEFAULT 0,   -- 0/1
    hasTicker INTEGER NOT NULL DEFAULT 0,   -- 0/1
    textCount INTEGER NOT NULL DEFAULT 0,   -- # de ranges de prix trouvés
    counted   INTEGER NOT NULL DEFAULT 0,   -- 0/1 (a incrémenté le compteur?)
    reason    TEXT,                         -- 'image' | 'ticker' | 'learned-*' | ...
    feedback  TEXT                          -- NULL | 'good' | 'bad'
  );
  CREATE INDEX IF NOT EXISTS idx_profit_messages_ts ON profit_messages(ts);

  -- Filtres learned sur les messages profits (1 ligne par phrase).
  -- Dénormalisé vs un seul blob JSON : queries plus simples, stats faciles.
  CREATE TABLE IF NOT EXISTS profit_filter_phrases (
    phrase TEXT NOT NULL,
    kind   TEXT NOT NULL CHECK (kind IN ('blocked', 'allowed')),
    PRIMARY KEY (phrase, kind)
  );

  -- Table KV générique pour les configs stockées en blob JSON :
  -- custom_filters, config_overrides, etc. Chaque ligne = 1 fichier
  -- JSON. Read/write pattern : on lit l'objet complet, on le mute en
  -- mémoire, on réécrit. Pas de queries par champ → pas besoin de
  -- dénormaliser.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  -- Items de news récents (max 50 en pratique, via cap à l'insertion).
  -- Persiste le fil affiché sur /news et dans !news pour qu'il survive
  -- aux restarts du bot (sinon le dashboard est vide pendant des heures).
  CREATE TABLE IF NOT EXISTS news_items (
    id     TEXT PRIMARY KEY,        -- "timestamp-rand" format
    ts     TEXT NOT NULL,
    title  TEXT NOT NULL,
    emoji  TEXT,
    source TEXT,
    link   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_news_items_ts ON news_items(ts);

  -- Welcome events log : sent + error-channel + error-send + config-missing.
  -- Persiste les événements du welcome listener pour qu'ils survivent
  -- aux restarts. Pas de cap — la dashboard page /welcome-log render tout
  -- (à 1-2 events/jour, ~700 lignes/an, négligeable). Source : spec
  -- 2026-05-14-welcome-log-persistence-design.md.
  CREATE TABLE IF NOT EXISTS welcome_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    type     TEXT NOT NULL,
    user_id  TEXT,
    username TEXT,
    detail   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_welcome_log_ts ON welcome_log(ts);

  -- Galerie d'images générées (signal proof + promo). Persiste les
  -- buffers PNG pour que /gallery et /gallery/image/:id fonctionnent
  -- après un restart du bot. Cap à 100 items — buffer type ~20 KB,
  -- soit ~2 MB max. better-sqlite3 mappe Buffer <-> BLOB nativement.
  CREATE TABLE IF NOT EXISTS gallery_items (
    id     TEXT PRIMARY KEY,        -- "timestamp-rand"
    ts     TEXT NOT NULL,
    type   TEXT NOT NULL,           -- 'signal' | 'proof'
    ticker TEXT,
    author TEXT,
    buffer BLOB NOT NULL             -- PNG bytes
  );
  CREATE INDEX IF NOT EXISTS idx_gallery_items_ts ON gallery_items(ts);

  -- Recap quotidien : 1×/jour max, idempotence par date NY-timezone.
  -- Chaque ligne = un message "RECAP:" qui a déclenché un render.
  -- date = clé naturelle (PRIMARY KEY) garantit l'unicité.
  CREATE TABLE IF NOT EXISTS daily_recaps (
    date          TEXT PRIMARY KEY,
    message_id    TEXT NOT NULL,
    render_job_id INTEGER,
    tickers_count INTEGER NOT NULL,
    runners_hit   INTEGER,
    runners_total INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_daily_recaps_date ON daily_recaps(date);

  -- Positions ouvertes par le trading engine. Une ligne = un signal
  -- transformé en ordre. Lifecycle :
  --   pending   → bracket envoyé à IBKR, pas encore fillé
  --   open      → parent order fillé
  --   closed    → TP, trailing SL ou exit manuel déclenché
  --   cancelled → limit order expiré (timeout) ou annulation explicite
  --   error     → erreur broker ou désynchro au boot (bloque le trading)
  CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    author          TEXT NOT NULL,
    entry_price     REAL NOT NULL,
    quantity        INTEGER NOT NULL,
    sl_price        REAL,
    tp_price        REAL,
    ibkr_parent_id  TEXT,
    ibkr_tp_id      TEXT,
    ibkr_sl_id      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    opened_at       TEXT,
    closed_at       TEXT,
    close_reason    TEXT,
    fill_price      REAL,
    exit_price      REAL,
    pnl             REAL,
    raw_signal      TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_positions_ticker_status ON positions(ticker, status);
  CREATE INDEX IF NOT EXISTS idx_positions_author_status ON positions(author, status);
  CREATE INDEX IF NOT EXISTS idx_positions_status        ON positions(status);

  -- ═════════════════════════════════════════════════════════════════════
  -- SaaS relais : licences clients, journal d'envoi, audit admin, leaves
  -- ═════════════════════════════════════════════════════════════════════

  -- Une licence = un guild Discord client autorisé à recevoir le relais.
  -- guild_id en TEXT (snowflake Discord = 64-bit, dépasse Number.MAX_SAFE_INTEGER).
  -- status piloté par les commandes admin et par les webhooks Launchpass/Stripe.
  -- target_channel_id défini par le client via /setup une fois le bot dans le serveur.
  CREATE TABLE IF NOT EXISTS licenses (
    guild_id                   TEXT PRIMARY KEY,
    status                     TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','active','suspended','expired','cancelled')),
    plan                       TEXT NOT NULL DEFAULT 'standard',
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at                 TEXT,
    last_relay_at              TEXT,
    launchpass_subscription_id TEXT,
    launchpass_customer_email  TEXT,
    target_channel_id          TEXT,
    guild_name                 TEXT,
    notes                      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_licenses_status     ON licenses(status);
  CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses(expires_at);
  CREATE INDEX IF NOT EXISTS idx_licenses_lp_sub     ON licenses(launchpass_subscription_id);

  -- Journal d'envoi : 1 ligne par tentative de relais (succès ou échec).
  -- Permet le debug et l'analytics ("dernier relais", taux d'erreur par guild).
  CREATE TABLE IF NOT EXISTS relay_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT NOT NULL DEFAULT (datetime('now')),
    guild_id            TEXT NOT NULL,
    source_message_id   TEXT NOT NULL,
    relayed_message_id  TEXT,
    status              TEXT NOT NULL CHECK (status IN ('ok','skip','error')),
    error               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_relay_log_guild_ts          ON relay_log(guild_id, ts);
  CREATE INDEX IF NOT EXISTS idx_relay_log_source_message_id ON relay_log(source_message_id);

  -- État journalier par ticker côté SOURCE : "ce ticker a-t-il été alerté
  -- aujourd'hui (entry/exit) ?". Utilisé comme filet de sécurité pour
  -- éviter de re-broadcaster une 2e entrée sur un ticker déjà alerté quand
  -- le 2e message ressemble à un signal court ambigu (ex: "CRE 2.80-3.91"
  -- raté par le détecteur exit). Reset implicite à minuit UTC : la PK
  -- composite inclut alert_date donc un nouveau jour = nouvelle ligne.
  CREATE TABLE IF NOT EXISTS daily_alert_log (
    ticker             TEXT NOT NULL,
    alert_type         TEXT NOT NULL CHECK (alert_type IN ('entry','exit')),
    alert_date         TEXT NOT NULL,                -- 'YYYY-MM-DD' UTC
    ts_iso             TEXT NOT NULL,                -- ISO timestamp du 1er broadcast
    source_message_id  TEXT,
    PRIMARY KEY (ticker, alert_type, alert_date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_alert_log_date ON daily_alert_log(alert_date);

  -- Cache des classifications LLM. Clé : SHA-256 du texte trimmé.
  -- Un même message = même classification → cache forever (pas de TTL).
  -- Évite de re-payer l'API pour les duplicates ("watch list updated"
  -- reposté, signal copié, etc.). Stocke aussi le modèle utilisé pour
  -- pouvoir invalider proprement quand on change de modèle.
  CREATE TABLE IF NOT EXISTS llm_classifications (
    text_hash      TEXT PRIMARY KEY,                 -- SHA-256 hex du texte trimmé
    text_sample    TEXT NOT NULL,                    -- 200 premiers chars (debug/audit)
    type           TEXT NOT NULL,                    -- 'entry'|'exit'|'ipo'|'passthrough'|'ignore'
    entities_json  TEXT NOT NULL,                    -- JSON {ticker, entry, target, stop, low, high, confidence}
    model          TEXT NOT NULL,                    -- ex: 'claude-haiku-4-5-20251001'
    ts             TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_llm_classifications_ts ON llm_classifications(ts);

  -- Audit admin : trace immuable des actions sur les licences (pour
  -- support, conformité, et debug si un client se plaint d'une suspension).
  CREATE TABLE IF NOT EXISTS admin_actions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL DEFAULT (datetime('now')),
    admin     TEXT NOT NULL,
    action    TEXT NOT NULL,
    guild_id  TEXT,
    payload   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_actions_ts ON admin_actions(ts);

  -- Trace des serveurs où le bot SaaS a été invité. 'joined-active' =
  -- invitation OK, 'grace-timeout' / 'no-license' / 'expired' / 'suspended' =
  -- raisons de leave. left_at NULL = bot encore présent.
  CREATE TABLE IF NOT EXISTS auto_leave_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    guild_name TEXT,
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    left_at    TEXT,
    reason     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auto_leave_log_guild ON auto_leave_log(guild_id);

  -- Dedup state pour les market-data alerts (yesterday H/L break, weekly
  -- H/L break, volume spike). Une ligne par (ticker, alert_type) par jour
  -- ET. PK composite garantit qu'on ne déclenche qu'une fois par jour ;
  -- INSERT OR IGNORE (markAlertFired) sert d'atomic check.
  CREATE TABLE IF NOT EXISTS market_alert_state (
    ticker        TEXT NOT NULL,
    alert_type    TEXT NOT NULL CHECK (alert_type IN (
                    'yday_high', 'yday_low',
                    'week_high', 'week_low',
                    'volume_spike'
                  )),
    fired_date_et TEXT NOT NULL,                -- 'YYYY-MM-DD' America/New_York
    fired_at_ms   INTEGER NOT NULL,             -- Date.now() au moment du fire
    PRIMARY KEY (ticker, alert_type, fired_date_et)
  );
  CREATE INDEX IF NOT EXISTS idx_market_alert_state_date ON market_alert_state(fired_date_et);

  -- ═════════════════════════════════════════════════════════════════════
  -- Site public de vente : plans tarifaires, customers, sessions, magic-links
  -- ═════════════════════════════════════════════════════════════════════

  -- Plans tarifaires éditables par l'admin via /admin/plans (CMS pricing).
  -- Affichés dynamiquement sur /pricing. Changements appliqués sans redeploy.
  CREATE TABLE IF NOT EXISTS plans (
    id                       TEXT PRIMARY KEY,           -- ex: 'starter', 'pro'
    name                     TEXT NOT NULL,
    description              TEXT,
    price_monthly_cents      INTEGER,
    price_annual_cents       INTEGER,
    currency                 TEXT NOT NULL DEFAULT 'USD',
    is_active                INTEGER NOT NULL DEFAULT 1,  -- 0/1
    display_order            INTEGER NOT NULL DEFAULT 0,
    features_json            TEXT NOT NULL DEFAULT '[]',  -- ['1 server','Unlimited signals',...]
    highlight_label          TEXT,                        -- ex: 'Most Popular'
    stripe_price_id_monthly  TEXT,
    stripe_price_id_annual   TEXT,
    launchpass_url           TEXT,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plans_active_order ON plans(is_active, display_order);

  -- Customers indexés par email (identité primaire du panel client self-service).
  -- Lié informellement à licenses.guild_id quand le claim_code a été consommé.
  CREATE TABLE IF NOT EXISTS customers (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    email                    TEXT UNIQUE NOT NULL,
    guild_id                 TEXT,
    stripe_customer_id       TEXT,
    launchpass_customer_id   TEXT,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_customers_guild ON customers(guild_id);
  CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);

  -- Sessions persistées du panel client. Cookie 'tob_customer_session' = token.
  -- Distinct des sessions admin (cookie 'boom_session' / DASHBOARD_PASSWORD).
  CREATE TABLE IF NOT EXISTS customer_sessions (
    token                    TEXT PRIMARY KEY,
    customer_id              INTEGER NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at               TEXT NOT NULL,
    user_agent               TEXT,
    ip                       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires ON customer_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id);

  -- Magic-links one-shot pour login customer (email envoyé avec lien temporaire).
  -- consumed_at NULL = pas encore utilisé. Sinon = horodate la consommation.
  CREATE TABLE IF NOT EXISTS magic_links (
    token                    TEXT PRIMARY KEY,
    email                    TEXT NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at               TEXT NOT NULL,
    consumed_at              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
  CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);

  -- Idempotence webhook events (Stripe + Launchpass). event_id stocké pour
  -- éviter de traiter 2x le même event en cas de retry du provider.
  CREATE TABLE IF NOT EXISTS webhook_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT NOT NULL,                              -- 'stripe' | 'launchpass'
    event_id     TEXT NOT NULL,                              -- id unique fourni par le provider
    event_type   TEXT,
    received_at  TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    UNIQUE(provider, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at);

  -- Watchlist par guild Discord pour le module trend.
  -- (guild_id, ticker) unique. PK composite évite les doublons et
  -- les indexes utiles sont implicites (PK + ticker).
  CREATE TABLE IF NOT EXISTS trend_watchlist (
    guild_id  TEXT    NOT NULL,
    ticker    TEXT    NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, ticker)
  );
  CREATE INDEX IF NOT EXISTS idx_trend_watchlist_ticker ON trend_watchlist(ticker);

  -- Channel d'alerte par guild. 1 ligne / guild.
  CREATE TABLE IF NOT EXISTS trend_channel (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT    NOT NULL,
    set_at      INTEGER NOT NULL
  );

  -- État global par ticker (partagé entre toutes les guilds qui watch
  -- le même ticker). Sert à détecter les transitions de direction et
  -- à dédupliquer les events breakout/reversal.
  CREATE TABLE IF NOT EXISTS trend_state (
    ticker                       TEXT PRIMARY KEY,
    direction                    TEXT,                -- uptrend|downtrend|sideways|NULL
    direction_changed_at         INTEGER,
    last_breakout_at             INTEGER,
    last_bullish_reversal_at     INTEGER,
    last_bearish_reversal_at     INTEGER,
    last_scan_at                 INTEGER
  );

  -- Audit log de tous les messages du trading-floor channel.
  -- Chaque ligne = 1 message Discord (bot ou humain).
  -- Base de données brute pour l'analyst-watchlist et milestone-alerts :
  -- on stocke tout, on filtre au moment de la lecture.
  CREATE TABLE IF NOT EXISTS tracked_messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id        TEXT NOT NULL UNIQUE,
    channel_id        TEXT NOT NULL,
    author_id         TEXT NOT NULL,
    author_username   TEXT,
    is_bot            INTEGER NOT NULL DEFAULT 0,
    content           TEXT,
    embed_json        TEXT,
    extracted_ticker  TEXT,
    extracted_price   REAL,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracked_messages_ticker
    ON tracked_messages(extracted_ticker);
  CREATE INDEX IF NOT EXISTS idx_tracked_messages_created
    ON tracked_messages(created_at);

  CREATE TABLE IF NOT EXISTS analyst_watchlist (
    ticker                  TEXT PRIMARY KEY,
    initial_price           REAL NOT NULL,
    initial_price_source    TEXT NOT NULL,
    source_message_id       TEXT NOT NULL,
    source_channel_id       TEXT NOT NULL,
    mentioned_by_user_id    TEXT NOT NULL,
    mentioned_by_username   TEXT,
    first_seen_at           INTEGER NOT NULL,
    last_milestone_pct      INTEGER,
    last_alert_at           INTEGER,
    archived_at             INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_watchlist_active
    ON analyst_watchlist(archived_at);

  CREATE TABLE IF NOT EXISTS milestone_alerts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT NOT NULL,
    milestone_pct       INTEGER NOT NULL,
    initial_price       REAL NOT NULL,
    current_price       REAL NOT NULL,
    gain_pct            REAL NOT NULL,
    fired_at            INTEGER NOT NULL,
    discord_message_id  TEXT,
    UNIQUE (ticker, milestone_pct)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS render_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    entry_author    TEXT NOT NULL,
    entry_message   TEXT NOT NULL,
    entry_ts        TEXT NOT NULL,
    exit_author     TEXT NOT NULL,
    exit_message    TEXT NOT NULL,
    exit_ts         TEXT NOT NULL,
    pnl             TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    done_at         TEXT,
    error           TEXT,
    discord_msg_id  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status, created_at);
`);

// ── Trend module: daily-reference signals — column migrations ─────────
// SQLite ne supporte pas ALTER TABLE IF NOT EXISTS, donc on inspecte
// table_info pour rester idempotent et safe au re-démarrage.
function addColumnIfMissing(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

addColumnIfMissing('trend_watchlist', 'quote_type', 'TEXT');
addColumnIfMissing('trend_state', 'daily_state_date',           'TEXT');
addColumnIfMissing('trend_state', 'pdh_alerts_today',           'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'pdh_below_since',            'INTEGER');
addColumnIfMissing('trend_state', 'pdl_alerts_today',           'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'pdl_above_since',            'INTEGER');
addColumnIfMissing('trend_state', 'gap_alerted_today',          'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'volume_above_alerted_today', 'INTEGER DEFAULT 0');
// Premarket high/low break tracking. PMH = plus haut atteint en premarket
// (4:00-9:30 ET) ; PML = plus bas. Break = close intraday RTH > PMH (ou < PML).
// Mirror du pattern PDH/PDL : 1× par jour avec ré-entrée propre 15 min.
addColumnIfMissing('trend_state', 'pmh_alerts_today', 'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'pmh_below_since', 'INTEGER');
addColumnIfMissing('trend_state', 'pml_alerts_today', 'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'pml_above_since', 'INTEGER');
// Salon dédié pour les alertes gap_up / gap_down. NULL = utilise le
// channel principal (rétrocompat). Permet de séparer les alertes overnight
// du flux trend principal (direction, breakout, reversal, PDH/PDL, volume).
addColumnIfMissing('trend_channel', 'gap_channel_id', 'TEXT');
// Toggle per-guild : 1 = pas d'alertes direction (uptrend/downtrend), 0 =
// comportement normal. Utile pour les serveurs qui veulent uniquement les
// events ponctuels (breakout, reversal, PDH/PDL, gap, volume) sans le bruit
// des transitions de direction.
addColumnIfMissing('trend_channel', 'direction_disabled', 'INTEGER DEFAULT 0');

// ── render_jobs : proof image base64 (Phase 3.5) ──────────────────────
// Image PNG canvas-rendered (entry+exit conversation Discord-styled) qui
// sera embed dans la proof video par le worker. Stockée en base64 TEXT
// pour simplicité (~150-300 KB par job, exposée via /api/render-queue).
// Optionnel : si null, le worker fallback sur le rendu Discord cards.
addColumnIfMissing('render_jobs', 'proof_image_base64', 'TEXT');

// ── render_jobs : template_name pour dispatch automatique ─────────────
// Nom du template Remotion utilisé pour ce job (ex: "classic-green",
// "gold-celebration"). Choisi côté bot via utils/template-dispatcher.js
// au moment de l'enqueue (selon le pnl notamment). Le worker charge
// templates/<name>.json et merge les props par défaut + props du job.
// Optionnel : si null, le worker utilise les defaultProps de Root.tsx.
addColumnIfMissing('render_jobs', 'template_name', 'TEXT');

// ── render_jobs : composition (ChartTemplate | BoomEntry | etc.) ──────
// Nom de la composition Remotion à rendre. Default 'ChartTemplate' (ex-
// BoomProof renommé). Permet aussi BoomEntry (signal d'entry) et
// BoomRecap (recap quotidien) depuis le dashboard /video-studio.
addColumnIfMissing('render_jobs', 'composition', "TEXT NOT NULL DEFAULT 'ChartTemplate'");

// ── Migration : ancien nom 'BoomProof' → 'ChartTemplate' ──────────────
// Idempotente : si pas de rows à migrer, no-op. Cf rename de la
// composition Remotion. Le worker accepte les 2 noms en rétrocompat
// mais on migre pour cleanup et cohérence DB.
try {
  const result = db.prepare(`UPDATE render_jobs SET composition = 'ChartTemplate' WHERE composition = 'BoomProof'`).run();
  if (result.changes > 0) {
    console.log(`[db] migrated ${result.changes} render_jobs from 'BoomProof' to 'ChartTemplate'`);
  }
} catch (err) {
  // Si la column n'existe pas encore au boot ultra-early, on swallow
  // (addColumnIfMissing l'aura créée au-dessus).
  console.warn('[db] BoomProof→ChartTemplate migration skipped:', err.message);
}

// ── render_jobs : recap_data pour BoomRecap composition ───────────────
// JSON stringified de { tickers, runnersHit, runnersTotal, tagline, ... }
// Utilisé uniquement pour composition='BoomRecap'. Le worker parse
// uniquement si non-null. Nullable pour rétrocompat avec les jobs
// ChartTemplate/BoomEntry existants.
addColumnIfMissing('render_jobs', 'recap_data', 'TEXT');

// ── render_jobs : tease_action + tease_subtext (picker contextuel) ─────
// Texte du tease (action verb + subtext) choisi par utils/pick-tease.js
// au moment de l'enqueue, en fonction du contexte (entry / exit-win-small
// / exit-win-big). Override les valeurs du template pour permettre une
// rotation contextuelle des phrases sans toucher aux JSON templates.
// Nullable : si null, le worker utilise les valeurs du template.
addColumnIfMissing('render_jobs', 'tease_action', 'TEXT');
addColumnIfMissing('render_jobs', 'tease_subtext', 'TEXT');

// ── render_jobs : entry_price + exit_price ─────────────────────────────
// Prix entry/exit du trade — passés au worker qui les utilise pour positionner
// les callouts sur le chart TradingView (fetched via chart-img.com). Nullable
// car certains messages d'exit ne contiennent pas de prix exact (ex: "out
// for profit") — dans ce cas le chart est fetched sans callouts.
addColumnIfMissing('render_jobs', 'entry_price', 'REAL');
addColumnIfMissing('render_jobs', 'exit_price',  'REAL');

// ── render_jobs : output_channel_id (routing du MP4 par job) ──────────
// Channel Discord où poster le MP4 final. NULL = fallback sur la var
// d'env RENDER_OUTPUT_CHANNEL_ID (comportement historique). Permet à
// certains jobs (ex: TobTradeRecap déclenché depuis un canal dédié) de
// renvoyer le rendu dans le même canal que l'image source.
addColumnIfMissing('render_jobs', 'output_channel_id', 'TEXT');

// ── render_jobs : props_override (JSON arbitraire) ────────────────────
// Permet de surcharger n'importe quelle prop de la composition Remotion
// sans modifier le template (ex: accentColor, ctaUrl, musicVolume). Le
// worker merge dans cet ordre :
//   templateProps (base) ← job columns ← props_override (top priority)
// NULL = pas de surcharge. Format : '{"accentColor":"#ff00ff",...}'.
addColumnIfMissing('render_jobs', 'props_override', 'TEXT');

// ── SaaS licenses : passthrough channel séparé pour bots upstream ─────
// Permet de router les alertes "passthrough" (ex: TrendVision) vers un
// salon distinct du target_channel_id (signaux principaux).
addColumnIfMissing('licenses', 'passthrough_channel_id', 'TEXT');

// Salon dédié aux annonces IPO multi-section. Distinct des signaux
// classiques et du salon passthrough.
addColumnIfMissing('licenses', 'ipo_channel_id', 'TEXT');

// ── Prepared statements (réutilisables, plus rapides) ────────────────

// INSERT OR IGNORE : si un id existe déjà, on saute sans erreur. Utile
// pour la migration (re-import sans doublons) et pour les éventuels
// retries côté Discord.
const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, ts, author, channel, content, preview, passed, type, reason,
     confidence, ticker, entry_price, isReply, parentPreview, parentAuthor)
  VALUES
    (@id, @ts, @author, @channel, @content, @preview, @passed, @type, @reason,
     @confidence, @ticker, @entry_price, @isReply, @parentPreview, @parentAuthor)
`);

const stmtRecent = db.prepare(`
  SELECT * FROM messages
  ORDER BY ts DESC
  LIMIT ?
`);

const stmtByTsRange = db.prepare(`
  SELECT * FROM messages
  WHERE ts >= ? AND ts <= ?
  ORDER BY ts DESC
`);

const stmtByDateKey = db.prepare(`
  SELECT * FROM messages
  WHERE substr(ts, 1, 10) = ?
  ORDER BY ts DESC
`);

const stmtByTicker = db.prepare(`
  SELECT * FROM messages
  WHERE ticker = ? AND ts >= ?
  ORDER BY ts DESC
`);

const stmtCount = db.prepare('SELECT COUNT(*) as n FROM messages');

// ── Helpers typés ────────────────────────────────────────────────────

// Convertit une entry JS (format logEvent) en row SQLite (booleans → 0/1).
function toRow(entry) {
  return {
    id:            entry.id,
    ts:            entry.ts,
    author:        entry.author || null,
    channel:       entry.channel || null,
    content:       entry.content || '',
    preview:       entry.preview || '',
    passed:        entry.passed ? 1 : 0,
    type:          entry.type || null,
    reason:        entry.reason || null,
    confidence:    entry.confidence != null ? entry.confidence : null,
    ticker:        entry.ticker || null,
    entry_price:   entry.entry_price != null ? entry.entry_price : null,
    isReply:       entry.isReply ? 1 : 0,
    parentPreview: entry.parentPreview || null,
    parentAuthor:  entry.parentAuthor || null,
  };
}

// Convertit une row SQLite en entry JS (0/1 → boolean). Reproduit le
// format exact attendu par les consommateurs (messageLog.filter, etc.).
function fromRow(row) {
  return {
    id:            row.id,
    ts:            row.ts,
    author:        row.author,
    channel:       row.channel,
    content:       row.content,
    preview:       row.preview,
    passed:        row.passed === 1,
    type:          row.type,
    reason:        row.reason,
    confidence:    row.confidence,
    ticker:        row.ticker,
    entry_price:   row.entry_price,
    isReply:       row.isReply === 1,
    parentPreview: row.parentPreview,
    parentAuthor:  row.parentAuthor,
  };
}

// ── API publique ─────────────────────────────────────────────────────

// Insert un message. Retourne true si inséré, false si doublon ignoré.
function insertMessage(entry) {
  const result = stmtInsert.run(toRow(entry));
  return result.changes > 0;
}

// Bulk insert — utilisé par la migration. Wrappé dans une transaction
// pour ~100× perf vs N inserts isolés.
function insertMessagesBulk(entries) {
  const tx = db.transaction((rows) => {
    let inserted = 0;
    for (const r of rows) {
      const res = stmtInsert.run(r);
      if (res.changes > 0) inserted++;
    }
    return inserted;
  });
  return tx(entries.map(toRow));
}

// Les N messages les plus récents (pour peupler le cache messageLog au boot).
function getRecentMessages(limit) {
  return stmtRecent.all(limit).map(fromRow);
}

// Messages d'une journée précise (date key YYYY-MM-DD). Remplace
// loadDailyFile(dateKey).
function getMessagesByDateKey(dateKey) {
  return stmtByDateKey.all(dateKey).map(fromRow);
}

// Messages dans un range de ts ISO (inclusive). Utile pour
// /api/messages?from=...&to=... et les aggregations analytics.
function getMessagesByTsRange(fromIso, toIso) {
  return stmtByTsRange.all(fromIso, toIso).map(fromRow);
}

// Tous les messages d'un ticker depuis un ts minimum.
function getMessagesByTicker(ticker, sinceIso) {
  return stmtByTicker.all(ticker, sinceIso).map(fromRow);
}

// Diagnostic : total de messages en base.
function countMessages() {
  return stmtCount.get().n;
}

// Purge les messages FILTRÉS (passed=0) qui n'ont ni ticker ni
// entry_price stocké. Ce sont les messages sans valeur analytique :
// questions, réactions, phrases sans données trade parsables.
//
// Les messages passed=1 sont PROTÉGÉS même s'ils n'ont pas de ticker
// (ex: signaux allowed sans ticker détectable — rares mais possible).
//
// Retourne le nombre de lignes supprimées. Helper utile à appeler au
// boot + avant chaque backup nightly pour garder la DB svelte.
const stmtMessagesPurgeFiltered = db.prepare(`
  DELETE FROM messages
  WHERE passed = 0 AND ticker IS NULL AND entry_price IS NULL
`);
function purgeFilteredMessagesWithoutData() {
  return stmtMessagesPurgeFiltered.run().changes;
}

// ═════════════════════════════════════════════════════════════════════
//  Profits — compteur journalier + messages review + filters learned
// ═════════════════════════════════════════════════════════════════════

// ── profit_counts ────────────────────────────────────────────────────

const stmtProfitCountGet = db.prepare(
  'SELECT count, milestones_json FROM profit_counts WHERE date = ?'
);
const stmtProfitCountUpsert = db.prepare(`
  INSERT INTO profit_counts (date, count, milestones_json)
  VALUES (@date, @count, @milestones_json)
  ON CONFLICT(date) DO UPDATE SET
    count = excluded.count,
    milestones_json = excluded.milestones_json
`);
const stmtProfitCountHistory = db.prepare(
  'SELECT date, count FROM profit_counts WHERE date >= ? ORDER BY date ASC'
);

// Retourne { count, milestones } pour un jour donné (0 + [] si absent).
// Shape identique à l'ancien loadProfitData pour backward compat.
function getProfitData(dateKey) {
  const row = stmtProfitCountGet.get(dateKey);
  if (!row) return { count: 0, milestones: [] };
  let milestones = [];
  try { milestones = JSON.parse(row.milestones_json || '[]'); } catch (_) {}
  return { count: row.count, milestones };
}

// UPSERT count+milestones pour un jour. Équivalent de saveProfitData.
function setProfitData(dateKey, data) {
  stmtProfitCountUpsert.run({
    date: dateKey,
    count: data.count | 0,
    milestones_json: JSON.stringify(data.milestones || []),
  });
}

// Historique sur N jours pour le bar chart — renvoie les jours EXISTANTS
// uniquement. Le caller complète avec count:0 pour les jours manquants.
function getProfitHistoryFrom(sinceDateKey) {
  return stmtProfitCountHistory.all(sinceDateKey);
}

// ── profit_messages ─────────────────────────────────────────────────

const stmtProfitMsgInsert = db.prepare(`
  INSERT OR IGNORE INTO profit_messages
    (id, ts, author, content, preview, hasImage, hasTicker, textCount, counted, reason, feedback)
  VALUES
    (@id, @ts, @author, @content, @preview, @hasImage, @hasTicker, @textCount, @counted, @reason, @feedback)
`);
const stmtProfitMsgByDate = db.prepare(
  "SELECT * FROM profit_messages WHERE substr(ts, 1, 10) = ? ORDER BY ts DESC"
);
const stmtProfitMsgSetFeedback = db.prepare(
  'UPDATE profit_messages SET feedback = ? WHERE id = ?'
);

function profitMsgToRow(m) {
  return {
    id:        m.id,
    ts:        m.ts,
    author:    m.author || null,
    content:   m.content || '',
    preview:   m.preview || '',
    hasImage:  m.hasImage ? 1 : 0,
    hasTicker: m.hasTicker ? 1 : 0,
    textCount: m.textCount | 0,
    counted:   m.counted ? 1 : 0,
    reason:    m.reason || null,
    feedback:  m.feedback || null,
  };
}

function profitMsgFromRow(r) {
  return {
    id:        r.id,
    ts:        r.ts,
    author:    r.author,
    content:   r.content,
    preview:   r.preview,
    hasImage:  r.hasImage === 1,
    hasTicker: r.hasTicker === 1,
    textCount: r.textCount,
    counted:   r.counted === 1,
    reason:    r.reason,
    feedback:  r.feedback,
  };
}

function insertProfitMessage(entry) {
  return stmtProfitMsgInsert.run(profitMsgToRow(entry)).changes > 0;
}

function insertProfitMessagesBulk(entries) {
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const r of rows) if (stmtProfitMsgInsert.run(r).changes > 0) n++;
    return n;
  });
  return tx(entries.map(profitMsgToRow));
}

function getProfitMessagesByDate(dateKey) {
  return stmtProfitMsgByDate.all(dateKey).map(profitMsgFromRow);
}

// Update feedback sur un message existant. Cherche par `id` seul (pas de
// filtre date car l'id contient timestamp → garantit unicité globale).
// Retourne true si la ligne existait et a été modifiée.
function updateProfitMessageFeedback(id, feedback) {
  return stmtProfitMsgSetFeedback.run(feedback, id).changes > 0;
}

// ── profit_filter_phrases ───────────────────────────────────────────

const stmtProfitFilterAdd = db.prepare(
  'INSERT OR IGNORE INTO profit_filter_phrases (phrase, kind) VALUES (?, ?)'
);
const stmtProfitFilterRemove = db.prepare(
  'DELETE FROM profit_filter_phrases WHERE phrase = ? AND kind = ?'
);
const stmtProfitFilterAll = db.prepare(
  'SELECT phrase, kind FROM profit_filter_phrases'
);

// Retourne { blocked: [phrase...], allowed: [phrase...] }. Shape identique
// à l'ancien loadProfitFilters pour backward compat avec le code consommateur.
function getProfitFilters() {
  const out = { blocked: [], allowed: [] };
  for (const row of stmtProfitFilterAll.all()) {
    if (row.kind === 'blocked') out.blocked.push(row.phrase);
    else if (row.kind === 'allowed') out.allowed.push(row.phrase);
  }
  return out;
}

// Ajoute une phrase à blocked OU allowed. Idempotent (INSERT OR IGNORE).
function addProfitFilterPhrase(phrase, kind) {
  return stmtProfitFilterAdd.run(phrase, kind).changes > 0;
}

// Retire une phrase de blocked OU allowed. Silencieux si absente.
function removeProfitFilterPhrase(phrase, kind) {
  return stmtProfitFilterRemove.run(phrase, kind).changes > 0;
}

// ═════════════════════════════════════════════════════════════════════
//  Settings — KV blob générique (1 ligne / namespace)
// ═════════════════════════════════════════════════════════════════════

const stmtSettingGet = db.prepare('SELECT value_json FROM settings WHERE key = ?');
const stmtSettingUpsert = db.prepare(`
  INSERT INTO settings (key, value_json) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
`);

// Retourne la valeur parsée du setting `key`, ou `defaultValue` si absent
// ou si le JSON stocké est corrompu (robustesse > échec dur).
function getSetting(key, defaultValue) {
  const row = stmtSettingGet.get(key);
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.value_json);
  } catch (e) {
    console.error('[settings] Invalid JSON for key', key, ':', e.message);
    return defaultValue;
  }
}

// UPSERT la valeur sérialisée en JSON. Remplace complètement — pas de merge.
function setSetting(key, value) {
  stmtSettingUpsert.run(key, JSON.stringify(value));
}

// ═════════════════════════════════════════════════════════════════════
//  News items — fil récent persisté (dashboard + !news au restart)
// ═════════════════════════════════════════════════════════════════════

const stmtNewsInsert = db.prepare(`
  INSERT OR IGNORE INTO news_items (id, ts, title, emoji, source, link)
  VALUES (@id, @ts, @title, @emoji, @source, @link)
`);
const stmtNewsRecent = db.prepare(
  'SELECT * FROM news_items ORDER BY ts DESC LIMIT ?'
);
const stmtNewsTrim = db.prepare(`
  DELETE FROM news_items
  WHERE id NOT IN (
    SELECT id FROM news_items ORDER BY ts DESC LIMIT ?
  )
`);

// Persist un item. Retourne true si inséré, false si PK déjà connue
// (évite les doublons si le poller retombe sur un GUID déjà stocké).
function insertNewsItem(item) {
  return stmtNewsInsert.run({
    id:     item.id,
    ts:     item.ts,
    title:  item.title || '',
    emoji:  item.emoji || null,
    source: item.source || null,
    link:   item.link || null,
  }).changes > 0;
}

// Les N plus récents — utilisé au boot pour hydrater `recentNews`.
function getRecentNewsItems(limit) {
  return stmtNewsRecent.all(limit);
}

// Conserve uniquement les `keep` plus récents. Appelé après chaque
// insert pour que la table ne grossisse pas indéfiniment.
function trimNewsItems(keep) {
  stmtNewsTrim.run(keep);
}

// Supprime les items plus vieux que `days` jours. La comparaison se
// fait en string ISO (lexicographique = chronologique pour ce format).
// Retourne le nombre de lignes supprimées — utile pour les logs.
const stmtNewsPurge = db.prepare(
  "DELETE FROM news_items WHERE ts < datetime('now', ?)"
);
function purgeNewsOlderThan(days) {
  // SQLite datetime('now', '-7 days') accepte le modifier comme string.
  return stmtNewsPurge.run('-' + (days | 0) + ' days').changes;
}

// ═════════════════════════════════════════════════════════════════════
//  Welcome log — events persistés par discord/welcome-listener
// ═════════════════════════════════════════════════════════════════════

const stmtWelcomeLogInsert = db.prepare(`
  INSERT INTO welcome_log (ts, type, user_id, username, detail)
  VALUES (@ts, @type, @user_id, @username, @detail)
`);
const stmtWelcomeLogList = db.prepare(`
  SELECT id, ts, type, user_id AS userId, username, detail
  FROM welcome_log
  ORDER BY id DESC
`);

// Append a single welcome event. Accepts the camelCase shape used by the
// listener; this layer translates to snake_case columns. ts is auto-filled
// with the current ISO time if not provided. Nullables (userId, username,
// detail) are coerced to strings when present, kept as null when absent.
function insertWelcomeLog({ ts, type, userId, username, detail }) {
  stmtWelcomeLogInsert.run({
    ts:       ts || new Date().toISOString(),
    type,
    user_id:  userId != null ? String(userId) : null,
    username: username != null ? String(username) : null,
    detail:   detail != null ? String(detail) : null,
  });
}

// Return ALL entries, most recent first (id DESC). No LIMIT — the
// dashboard renders the full history. If volume ever grows past what
// the page can render comfortably, add an optional `limit` param.
function getWelcomeLog() {
  return stmtWelcomeLogList.all();
}

// ═════════════════════════════════════════════════════════════════════
//  Gallery items — buffers PNG des images générées
// ═════════════════════════════════════════════════════════════════════

const stmtGalleryInsert = db.prepare(`
  INSERT OR IGNORE INTO gallery_items (id, ts, type, ticker, author, buffer)
  VALUES (@id, @ts, @type, @ticker, @author, @buffer)
`);
const stmtGalleryRecent = db.prepare(
  'SELECT id, ts, type, ticker, author, buffer FROM gallery_items ORDER BY ts DESC LIMIT ?'
);
const stmtGalleryTrim = db.prepare(`
  DELETE FROM gallery_items
  WHERE id NOT IN (
    SELECT id FROM gallery_items ORDER BY ts DESC LIMIT ?
  )
`);

// Persist un item (buffer doit être un Buffer Node — mappé en BLOB).
function insertGalleryItem(item) {
  return stmtGalleryInsert.run({
    id:     item.id,
    ts:     item.ts,
    type:   item.type,
    ticker: item.ticker || null,
    author: item.author || null,
    buffer: item.buffer,
  }).changes > 0;
}

// Les N plus récents — hydrate imageState.imageGallery au boot.
// better-sqlite3 retourne les BLOB sous forme de Buffer natif : pas de
// conversion nécessaire côté caller.
function getRecentGalleryItems(limit) {
  return stmtGalleryRecent.all(limit);
}

function trimGalleryItems(keep) {
  stmtGalleryTrim.run(keep);
}

// ═════════════════════════════════════════════════════════════════════
//  Positions — lifecycle d'un trade (pending → open → closed/cancelled)
// ═════════════════════════════════════════════════════════════════════

const stmtPositionInsert = db.prepare(`
  INSERT INTO positions
    (ticker, author, entry_price, quantity, sl_price, tp_price,
     ibkr_parent_id, ibkr_tp_id, ibkr_sl_id, raw_signal, status)
  VALUES
    (@ticker, @author, @entry_price, @quantity, @sl_price, @tp_price,
     @ibkr_parent_id, @ibkr_tp_id, @ibkr_sl_id, @raw_signal, 'pending')
`);

const stmtPositionUpdateIds = db.prepare(`
  UPDATE positions SET
    ibkr_parent_id = @ibkr_parent_id,
    ibkr_tp_id     = @ibkr_tp_id,
    ibkr_sl_id     = @ibkr_sl_id
  WHERE id = @id
`);

const stmtPositionMarkOpen = db.prepare(`
  UPDATE positions SET status='open', fill_price=@fill_price, opened_at=@opened_at WHERE id=@id
`);

const stmtPositionMarkClosed = db.prepare(`
  UPDATE positions SET
    status='closed',
    close_reason=@close_reason,
    exit_price=@exit_price,
    closed_at=@closed_at,
    pnl=@pnl
  WHERE id=@id
`);

const stmtPositionMarkCancelled = db.prepare(`
  UPDATE positions SET status='cancelled', closed_at=@closed_at WHERE id=@id
`);

const stmtPositionMarkError = db.prepare(`
  UPDATE positions SET status='error', error_message=@msg, closed_at=datetime('now') WHERE id=@id
`);

const stmtOpenPositions = db.prepare(`
  SELECT * FROM positions WHERE status IN ('pending', 'open') ORDER BY created_at DESC
`);

const stmtCountOpen = db.prepare(`
  SELECT COUNT(*) AS n FROM positions WHERE status IN ('pending', 'open')
`);

const stmtPositionByTickerAuthorOpen = db.prepare(`
  SELECT * FROM positions
  WHERE ticker = ? AND author = ? AND status IN ('pending', 'open')
  ORDER BY created_at DESC LIMIT 1
`);

const stmtPositionByIbkrParent = db.prepare(`
  SELECT * FROM positions WHERE ibkr_parent_id = ? LIMIT 1
`);

const stmtPositionHistory = db.prepare(`
  SELECT * FROM positions ORDER BY created_at DESC LIMIT ?
`);

function insertPosition(p) {
  const info = stmtPositionInsert.run({
    ticker:         p.ticker,
    author:         p.author,
    entry_price:    p.entry_price,
    quantity:       p.quantity,
    sl_price:       p.sl_price != null ? p.sl_price : null,
    tp_price:       p.tp_price != null ? p.tp_price : null,
    ibkr_parent_id: p.ibkr_parent_id || null,
    ibkr_tp_id:     p.ibkr_tp_id || null,
    ibkr_sl_id:     p.ibkr_sl_id || null,
    raw_signal:     p.raw_signal || null,
  });
  return info.lastInsertRowid;
}

function updatePositionOrderIds(id, ids) {
  stmtPositionUpdateIds.run({
    id,
    ibkr_parent_id: ids.ibkr_parent_id || null,
    ibkr_tp_id:     ids.ibkr_tp_id || null,
    ibkr_sl_id:     ids.ibkr_sl_id || null,
  });
}

function markPositionOpen(id, { fill_price, opened_at }) {
  stmtPositionMarkOpen.run({ id, fill_price, opened_at });
}

function markPositionClosed(id, { close_reason, exit_price, closed_at, pnl }) {
  stmtPositionMarkClosed.run({ id, close_reason, exit_price, closed_at, pnl });
}

function markPositionCancelled(id, { closed_at }) {
  stmtPositionMarkCancelled.run({ id, closed_at });
}

function markPositionError(id, msg) {
  stmtPositionMarkError.run({ id, msg: msg || '' });
}

function getOpenPositions() { return stmtOpenPositions.all(); }
function countOpenPositions() { return stmtCountOpen.get().n; }

function getPositionByTickerAndAuthor(ticker, author) {
  return stmtPositionByTickerAuthorOpen.get(ticker, author) || null;
}

function getPositionByIbkrParentId(parentId) {
  return stmtPositionByIbkrParent.get(parentId) || null;
}

function getPositionHistory(limit = 100) {
  return stmtPositionHistory.all(limit);
}

// ═════════════════════════════════════════════════════════════════════
//  SaaS — licences clients, journal de relais, audit admin, leaves
// ═════════════════════════════════════════════════════════════════════

// ── licenses ────────────────────────────────────────────────────────

const stmtLicenseUpsert = db.prepare(`
  INSERT INTO licenses
    (guild_id, status, plan, expires_at, launchpass_subscription_id,
     launchpass_customer_email, target_channel_id, guild_name, notes)
  VALUES
    (@guild_id, @status, @plan, @expires_at, @launchpass_subscription_id,
     @launchpass_customer_email, @target_channel_id, @guild_name, @notes)
  ON CONFLICT(guild_id) DO UPDATE SET
    status                     = excluded.status,
    plan                       = excluded.plan,
    expires_at                 = excluded.expires_at,
    launchpass_subscription_id = COALESCE(excluded.launchpass_subscription_id, licenses.launchpass_subscription_id),
    launchpass_customer_email  = COALESCE(excluded.launchpass_customer_email, licenses.launchpass_customer_email),
    target_channel_id          = COALESCE(excluded.target_channel_id, licenses.target_channel_id),
    guild_name                 = COALESCE(excluded.guild_name, licenses.guild_name),
    notes                      = COALESCE(excluded.notes, licenses.notes)
`);
const stmtLicenseGet            = db.prepare('SELECT * FROM licenses WHERE guild_id = ?');
const stmtLicenseList           = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC');
const stmtLicenseListByStatus   = db.prepare('SELECT * FROM licenses WHERE status = ? ORDER BY created_at DESC');
const stmtLicenseSetStatus      = db.prepare('UPDATE licenses SET status = ? WHERE guild_id = ?');
const stmtLicenseSetExpires     = db.prepare('UPDATE licenses SET expires_at = ?, status = ? WHERE guild_id = ?');
const stmtLicenseSetTargetCh    = db.prepare('UPDATE licenses SET target_channel_id = ? WHERE guild_id = ?');
const stmtLicenseSetPassCh      = db.prepare('UPDATE licenses SET passthrough_channel_id = ? WHERE guild_id = ?');
const stmtLicenseSetIPOCh       = db.prepare('UPDATE licenses SET ipo_channel_id = ? WHERE guild_id = ?');
const stmtLicenseListPassthrough = db.prepare("SELECT * FROM licenses WHERE status = 'active' AND passthrough_channel_id IS NOT NULL");
const stmtLicenseListIPO        = db.prepare("SELECT * FROM licenses WHERE status = 'active' AND ipo_channel_id IS NOT NULL");
const stmtLicenseTouchRelay     = db.prepare("UPDATE licenses SET last_relay_at = datetime('now') WHERE guild_id = ?");
const stmtLicenseFindByLpSub    = db.prepare('SELECT * FROM licenses WHERE launchpass_subscription_id = ? LIMIT 1');
const stmtLicenseDelete         = db.prepare('DELETE FROM licenses WHERE guild_id = ?');

// UPSERT d'une licence. Champs obligatoires : guild_id. Tout le reste a un
// défaut. Ne touche pas created_at en update (le défaut DB ne s'applique
// qu'à l'insert grâce à ON CONFLICT … DO UPDATE).
function licenseUpsert(input) {
  return stmtLicenseUpsert.run({
    guild_id:                   String(input.guild_id),
    status:                     input.status || 'pending',
    plan:                       input.plan || 'standard',
    expires_at:                 input.expires_at || null,
    launchpass_subscription_id: input.launchpass_subscription_id || null,
    launchpass_customer_email:  input.launchpass_customer_email || null,
    target_channel_id:          input.target_channel_id || null,
    guild_name:                 input.guild_name || null,
    notes:                      input.notes || null,
  }).changes;
}

function licenseGet(guildId) {
  return stmtLicenseGet.get(String(guildId)) || null;
}

function licenseList(status) {
  return status ? stmtLicenseListByStatus.all(status) : stmtLicenseList.all();
}

function licenseSetStatus(guildId, status) {
  return stmtLicenseSetStatus.run(status, String(guildId)).changes > 0;
}

// Met à jour expires_at ET status atomiquement (ex: passer 'expired' à
// 'active' avec une nouvelle expires_at en un seul write).
function licenseSetExpires(guildId, expiresAtIso, status) {
  return stmtLicenseSetExpires.run(expiresAtIso, status, String(guildId)).changes > 0;
}

function licenseSetTargetChannel(guildId, channelId) {
  return stmtLicenseSetTargetCh.run(channelId ? String(channelId) : null, String(guildId)).changes > 0;
}

function licenseSetPassthroughChannel(guildId, channelId) {
  return stmtLicenseSetPassCh.run(channelId ? String(channelId) : null, String(guildId)).changes > 0;
}

function licenseSetIPOChannel(guildId, channelId) {
  return stmtLicenseSetIPOCh.run(channelId ? String(channelId) : null, String(guildId)).changes > 0;
}

// Active licenses qui ont un passthrough_channel_id configuré. Le filtrage
// d'expiration reste à la charge du caller (cohérent avec licenseList).
function licenseListPassthroughReady() {
  return stmtLicenseListPassthrough.all();
}

// Active licenses qui ont un ipo_channel_id configuré.
function licenseListIPOReady() {
  return stmtLicenseListIPO.all();
}

function licenseTouchRelay(guildId) {
  stmtLicenseTouchRelay.run(String(guildId));
}

function licenseFindByLaunchpassSub(subId) {
  return stmtLicenseFindByLpSub.get(subId) || null;
}

function licenseDelete(guildId) {
  return stmtLicenseDelete.run(String(guildId)).changes > 0;
}

// ── relay_log ───────────────────────────────────────────────────────

const stmtRelayLogInsert = db.prepare(`
  INSERT INTO relay_log (guild_id, source_message_id, relayed_message_id, status, error)
  VALUES (@guild_id, @source_message_id, @relayed_message_id, @status, @error)
`);
const stmtRelayLogRecent = db.prepare(`
  SELECT * FROM relay_log
  WHERE guild_id = ?
  ORDER BY ts DESC
  LIMIT ?
`);
const stmtRelayLogStats = db.prepare(`
  SELECT status, COUNT(*) AS n FROM relay_log
  WHERE guild_id = ? AND ts >= ?
  GROUP BY status
`);

function relayLogInsert(entry) {
  stmtRelayLogInsert.run({
    guild_id:           String(entry.guild_id),
    source_message_id:  String(entry.source_message_id),
    relayed_message_id: entry.relayed_message_id ? String(entry.relayed_message_id) : null,
    status:             entry.status,
    error:              entry.error || null,
  });
}

function relayLogRecent(guildId, limit = 20) {
  return stmtRelayLogRecent.all(String(guildId), limit | 0);
}

function relayLogStatsSince(guildId, sinceIso) {
  const rows = stmtRelayLogStats.all(String(guildId), sinceIso);
  const out = { ok: 0, skip: 0, error: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ── daily_alert_log ─────────────────────────────────────────────────

const stmtDailyAlertLogInsert = db.prepare(`
  INSERT OR IGNORE INTO daily_alert_log (ticker, alert_type, alert_date, ts_iso, source_message_id)
  VALUES (@ticker, @alert_type, @alert_date, @ts_iso, @source_message_id)
`);
const stmtDailyAlertLogHas = db.prepare(`
  SELECT 1 FROM daily_alert_log
  WHERE ticker = ? AND alert_type = ? AND alert_date = ?
  LIMIT 1
`);
const stmtDailyAlertLogPurge = db.prepare(`
  DELETE FROM daily_alert_log WHERE alert_date < ?
`);

// Date UTC au format YYYY-MM-DD pour la fenêtre de reset journalière.
function todayUTCDate() {
  return new Date().toISOString().slice(0, 10);
}

// Enregistre un broadcast réussi pour un ticker. Idempotent grâce à la PK
// composite (ticker, alert_type, alert_date) + INSERT OR IGNORE : un même
// ticker alerté plusieurs fois le même jour n'est compté qu'une fois.
// Renvoie true si une nouvelle ligne a été insérée, false si déjà présente.
function dailyAlertLogInsert({ ticker, alert_type, source_message_id }) {
  const info = stmtDailyAlertLogInsert.run({
    ticker:            String(ticker).toUpperCase(),
    alert_type:        alert_type,
    alert_date:        todayUTCDate(),
    ts_iso:            new Date().toISOString(),
    source_message_id: source_message_id ? String(source_message_id) : null,
  });
  return info.changes > 0;
}

// Vérifie si un ticker a déjà été alerté aujourd'hui (UTC) en `alert_type`.
// Utilisé comme filet de sécurité avant de broadcaster un nouveau signal
// d'entrée pour décider s'il faut le re-router en sortie.
function dailyAlertLogHas(ticker, alert_type) {
  if (!ticker) return false;
  const row = stmtDailyAlertLogHas.get(
    String(ticker).toUpperCase(),
    alert_type,
    todayUTCDate(),
  );
  return !!row;
}

// Cleanup pour tâche périodique (optionnel) : supprime les lignes plus
// vieilles que `keepDays` jours.
function dailyAlertLogPurgeOld(keepDays = 30) {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  return stmtDailyAlertLogPurge.run(cutoff).changes;
}

// ── llm_classifications ─────────────────────────────────────────────

const stmtLlmClassifyGet = db.prepare(`
  SELECT type, entities_json, model FROM llm_classifications WHERE text_hash = ?
`);
const stmtLlmClassifyPut = db.prepare(`
  INSERT OR REPLACE INTO llm_classifications (text_hash, text_sample, type, entities_json, model)
  VALUES (@text_hash, @text_sample, @type, @entities_json, @model)
`);
const stmtLlmClassifyStats = db.prepare(`
  SELECT type, COUNT(*) AS n FROM llm_classifications GROUP BY type
`);

// Lookup cache. Renvoie { type, entities, model } ou null si miss.
function llmClassifyGet(hash) {
  const row = stmtLlmClassifyGet.get(hash);
  if (!row) return null;
  let entities = null;
  try { entities = JSON.parse(row.entities_json); } catch { entities = {}; }
  return { type: row.type, entities, model: row.model };
}

// Insère ou remplace le cache (REPLACE permet d'override si on re-classifie
// avec un modèle plus récent — voir llmClassifyInvalidateModel).
function llmClassifyPut(hash, textSample, type, entities, model) {
  stmtLlmClassifyPut.run({
    text_hash:     String(hash),
    text_sample:   String(textSample || '').slice(0, 200),
    type:          String(type),
    entities_json: JSON.stringify(entities || {}),
    model:         String(model),
  });
}

// Invalide tout le cache d'un modèle donné (utile après un changement de
// prompt ou un upgrade Haiku → Sonnet). Renvoie le nombre de lignes supprimées.
function llmClassifyInvalidateModel(model) {
  return db.prepare('DELETE FROM llm_classifications WHERE model = ?').run(String(model)).changes;
}

function llmClassifyStats() {
  const out = {};
  for (const row of stmtLlmClassifyStats.all()) out[row.type] = row.n;
  return out;
}

// ── admin_actions ───────────────────────────────────────────────────

const stmtAdminActionInsert = db.prepare(`
  INSERT INTO admin_actions (admin, action, guild_id, payload)
  VALUES (@admin, @action, @guild_id, @payload)
`);

function adminActionInsert({ admin, action, guild_id, payload }) {
  stmtAdminActionInsert.run({
    admin:    String(admin || 'unknown'),
    action:   String(action),
    guild_id: guild_id ? String(guild_id) : null,
    payload:  payload != null ? JSON.stringify(payload) : null,
  });
}

// ── auto_leave_log ──────────────────────────────────────────────────

const stmtAutoLeaveInsert = db.prepare(`
  INSERT INTO auto_leave_log (guild_id, guild_name, reason)
  VALUES (@guild_id, @guild_name, @reason)
`);
const stmtAutoLeaveClose = db.prepare(`
  UPDATE auto_leave_log
  SET left_at = datetime('now')
  WHERE id = (
    SELECT id FROM auto_leave_log
    WHERE guild_id = ? AND left_at IS NULL
    ORDER BY id DESC LIMIT 1
  )
`);

function autoLeaveLogInsert({ guild_id, guild_name, reason }) {
  stmtAutoLeaveInsert.run({
    guild_id:   String(guild_id),
    guild_name: guild_name || null,
    reason:     String(reason),
  });
}

// Ferme la dernière entrée ouverte pour ce guild (left_at = NULL → now).
// Idempotent : si aucune entrée ouverte, no-op.
function autoLeaveLogClose(guildId) {
  stmtAutoLeaveClose.run(String(guildId));
}

// ═════════════════════════════════════════════════════════════════════
//  Market alert state — dedup pour les alertes prix/volume
// ═════════════════════════════════════════════════════════════════════

const stmtAlertWasFired = db.prepare(`
  SELECT 1 FROM market_alert_state
  WHERE ticker = ? AND alert_type = ? AND fired_date_et = ?
  LIMIT 1
`);
const stmtMarkAlertFired = db.prepare(`
  INSERT OR IGNORE INTO market_alert_state
    (ticker, alert_type, fired_date_et, fired_at_ms)
  VALUES (?, ?, ?, ?)
`);
const stmtPurgeOldAlertState = db.prepare(`
  DELETE FROM market_alert_state WHERE fired_date_et < ?
`);

function alertWasFired(ticker, alertType, etDate) {
  return !!stmtAlertWasFired.get(String(ticker), String(alertType), String(etDate));
}

// INSERT OR IGNORE : retourne true ssi cet appel a réellement inséré
// (donc qu'on est le PREMIER à marquer ce combo aujourd'hui). À utiliser
// comme check atomique : ne pas faire "wasFired? mark : nothing" qui est
// race-prone. Au lieu de ça : try markAlertFired() ; si true → send.
function markAlertFired(ticker, alertType, etDate, firedAtMs) {
  return stmtMarkAlertFired.run(
    String(ticker), String(alertType), String(etDate),
    firedAtMs | 0,
  ).changes > 0;
}

function purgeMarketAlertStateOlderThan(keepDateEt) {
  return stmtPurgeOldAlertState.run(String(keepDateEt)).changes;
}

// ═════════════════════════════════════════════════════════════════════
//  Site public : plans, customers, customer_sessions, magic_links
// ═════════════════════════════════════════════════════════════════════

// ── plans (CMS pricing, éditable par admin) ────────────────────────

const stmtPlanUpsert = db.prepare(`
  INSERT INTO plans
    (id, name, description, price_monthly_cents, price_annual_cents, currency,
     is_active, display_order, features_json, highlight_label,
     stripe_price_id_monthly, stripe_price_id_annual, launchpass_url, updated_at)
  VALUES
    (@id, @name, @description, @price_monthly_cents, @price_annual_cents, @currency,
     @is_active, @display_order, @features_json, @highlight_label,
     @stripe_price_id_monthly, @stripe_price_id_annual, @launchpass_url, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name                    = excluded.name,
    description             = excluded.description,
    price_monthly_cents     = excluded.price_monthly_cents,
    price_annual_cents      = excluded.price_annual_cents,
    currency                = excluded.currency,
    is_active               = excluded.is_active,
    display_order           = excluded.display_order,
    features_json           = excluded.features_json,
    highlight_label         = excluded.highlight_label,
    stripe_price_id_monthly = excluded.stripe_price_id_monthly,
    stripe_price_id_annual  = excluded.stripe_price_id_annual,
    launchpass_url          = excluded.launchpass_url,
    updated_at              = datetime('now')
`);
const stmtPlanGet         = db.prepare('SELECT * FROM plans WHERE id = ?');
const stmtPlanListAll     = db.prepare('SELECT * FROM plans ORDER BY display_order ASC, name ASC');
const stmtPlanListActive  = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY display_order ASC, name ASC');
const stmtPlanDelete      = db.prepare('DELETE FROM plans WHERE id = ?');

function planRowFromInput(p) {
  return {
    id:                      String(p.id),
    name:                    p.name || p.id,
    description:             p.description || null,
    price_monthly_cents:     p.price_monthly_cents != null ? (p.price_monthly_cents | 0) : null,
    price_annual_cents:      p.price_annual_cents != null ? (p.price_annual_cents | 0) : null,
    currency:                p.currency || 'USD',
    is_active:               p.is_active === 0 || p.is_active === false ? 0 : 1,
    display_order:           (p.display_order | 0) || 0,
    features_json:           Array.isArray(p.features) ? JSON.stringify(p.features)
                              : (p.features_json || '[]'),
    highlight_label:         p.highlight_label || null,
    stripe_price_id_monthly: p.stripe_price_id_monthly || null,
    stripe_price_id_annual:  p.stripe_price_id_annual || null,
    launchpass_url:          p.launchpass_url || null,
  };
}

// Parse `features_json` en array pour faciliter la consommation côté pages.
function planRowToView(row) {
  if (!row) return null;
  let features = [];
  try { features = JSON.parse(row.features_json || '[]'); } catch (_) {}
  return { ...row, features, is_active: row.is_active === 1 };
}

function planUpsert(input) {
  return stmtPlanUpsert.run(planRowFromInput(input)).changes;
}
function planGet(id) {
  return planRowToView(stmtPlanGet.get(String(id)));
}
function planList(activeOnly) {
  const rows = activeOnly ? stmtPlanListActive.all() : stmtPlanListAll.all();
  return rows.map(planRowToView);
}
function planDelete(id) {
  return stmtPlanDelete.run(String(id)).changes > 0;
}

// ── customers (identités email pour panel client) ──────────────────

const stmtCustomerUpsert = db.prepare(`
  INSERT INTO customers (email)
  VALUES (?)
  ON CONFLICT(email) DO NOTHING
`);
const stmtCustomerGetByEmail = db.prepare('SELECT * FROM customers WHERE email = ? LIMIT 1');
const stmtCustomerGetById    = db.prepare('SELECT * FROM customers WHERE id = ?');
const stmtCustomerSetGuild   = db.prepare('UPDATE customers SET guild_id = ? WHERE id = ?');
const stmtCustomerSetStripe  = db.prepare('UPDATE customers SET stripe_customer_id = ? WHERE id = ?');
const stmtCustomerSetLp      = db.prepare('UPDATE customers SET launchpass_customer_id = ? WHERE id = ?');
const stmtCustomerTouchLogin = db.prepare("UPDATE customers SET last_login_at = datetime('now') WHERE id = ?");

// Crée le customer s'il n'existe pas, retourne la ligne (avec id auto-généré).
function customerUpsertByEmail(email) {
  const norm = String(email).trim().toLowerCase();
  stmtCustomerUpsert.run(norm);
  return stmtCustomerGetByEmail.get(norm);
}
function customerGet(id) {
  return stmtCustomerGetById.get(id | 0) || null;
}
function customerGetByEmail(email) {
  return stmtCustomerGetByEmail.get(String(email).trim().toLowerCase()) || null;
}
function customerLinkGuild(customerId, guildId) {
  return stmtCustomerSetGuild.run(guildId ? String(guildId) : null, customerId | 0).changes > 0;
}
function customerSetStripeId(customerId, stripeId) {
  return stmtCustomerSetStripe.run(stripeId || null, customerId | 0).changes > 0;
}
function customerSetLaunchpassId(customerId, lpId) {
  return stmtCustomerSetLp.run(lpId || null, customerId | 0).changes > 0;
}
function customerTouchLogin(customerId) {
  stmtCustomerTouchLogin.run(customerId | 0);
}

// ── customer_sessions (cookie 'tob_customer_session') ──────────────

const stmtCustomerSessionInsert = db.prepare(`
  INSERT INTO customer_sessions (token, customer_id, expires_at, user_agent, ip)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtCustomerSessionGet = db.prepare(`
  SELECT s.*, c.email, c.guild_id, c.stripe_customer_id, c.launchpass_customer_id
  FROM customer_sessions s
  INNER JOIN customers c ON c.id = s.customer_id
  WHERE s.token = ? AND s.expires_at > datetime('now')
`);
const stmtCustomerSessionDelete = db.prepare('DELETE FROM customer_sessions WHERE token = ?');
const stmtCustomerSessionPurgeExpired = db.prepare("DELETE FROM customer_sessions WHERE expires_at <= datetime('now')");

function customerSessionCreate({ customer_id, expires_at, user_agent, ip }) {
  const token = require('crypto').randomBytes(32).toString('hex');
  stmtCustomerSessionInsert.run(
    token, customer_id | 0, expires_at, user_agent || null, ip || null
  );
  return token;
}
function customerSessionGet(token) {
  if (!token) return null;
  return stmtCustomerSessionGet.get(String(token)) || null;
}
function customerSessionDelete(token) {
  return stmtCustomerSessionDelete.run(String(token)).changes > 0;
}
function customerSessionPurgeExpired() {
  return stmtCustomerSessionPurgeExpired.run().changes;
}

// ── magic_links (login one-shot par email) ─────────────────────────

const stmtMagicLinkInsert = db.prepare(`
  INSERT INTO magic_links (token, email, expires_at)
  VALUES (?, ?, ?)
`);
const stmtMagicLinkGet = db.prepare(`
  SELECT * FROM magic_links WHERE token = ? LIMIT 1
`);
const stmtMagicLinkConsume = db.prepare(`
  UPDATE magic_links SET consumed_at = datetime('now')
  WHERE token = ? AND consumed_at IS NULL AND expires_at > datetime('now')
`);
const stmtMagicLinkCountRecent = db.prepare(`
  SELECT COUNT(*) AS n FROM magic_links
  WHERE email = ? AND created_at > datetime('now', ?)
`);
const stmtMagicLinkPurgeExpired = db.prepare("DELETE FROM magic_links WHERE expires_at <= datetime('now', '-1 day')");

function magicLinkCreate({ email, expires_at }) {
  const token = require('crypto').randomBytes(32).toString('hex');
  stmtMagicLinkInsert.run(token, String(email).trim().toLowerCase(), expires_at);
  return token;
}
// Atomic : passe consumed_at et retourne la ligne SI le link était valide.
// Renvoie null si invalide / expiré / déjà consommé.
function magicLinkConsume(token) {
  const result = stmtMagicLinkConsume.run(String(token));
  if (result.changes === 0) return null;
  return stmtMagicLinkGet.get(String(token));
}
// Compte les magic-links créés pour un email dans les N dernières minutes.
// Utilisé pour rate-limiter (max 5 / heure / email).
function magicLinkCountRecent(email, minutes) {
  return stmtMagicLinkCountRecent.get(
    String(email).trim().toLowerCase(),
    `-${(minutes | 0) || 60} minutes`
  ).n;
}
function magicLinkPurgeExpired() {
  return stmtMagicLinkPurgeExpired.run().changes;
}

// ── webhook_events (idempotence Stripe + Launchpass) ───────────────

const stmtWebhookEventInsert = db.prepare(`
  INSERT OR IGNORE INTO webhook_events (provider, event_id, event_type)
  VALUES (?, ?, ?)
`);
const stmtWebhookEventMarkProcessed = db.prepare(`
  UPDATE webhook_events SET processed_at = datetime('now')
  WHERE provider = ? AND event_id = ?
`);

// Tente d'insérer l'event. Retourne true si nouveau (à traiter), false si
// déjà vu (idempotence — skip pour éviter double traitement).
function webhookEventClaim({ provider, event_id, event_type }) {
  const result = stmtWebhookEventInsert.run(
    String(provider), String(event_id), event_type || null
  );
  return result.changes > 0;
}
function webhookEventMarkProcessed({ provider, event_id }) {
  stmtWebhookEventMarkProcessed.run(String(provider), String(event_id));
}

// ═════════════════════════════════════════════════════════════════════
//  Stats — diagnostic global (taille fichier, count + range par table)
// ═════════════════════════════════════════════════════════════════════

// Colonne temporelle utilisée pour MIN/MAX par table. `null` = pas de
// range affichable (table KV ou sans timestamp).
const TIME_COLUMNS = {
  messages:              'ts',
  profit_counts:         'date',
  profit_messages:       'ts',
  news_items:            'ts',
  gallery_items:         'ts',
  positions:             'created_at',
  profit_filter_phrases: null,
  settings:              null,
  licenses:              'created_at',
  relay_log:             'ts',
  admin_actions:         'ts',
  auto_leave_log:        'joined_at',
  market_alert_state:    'fired_date_et',
  plans:                 'created_at',
  customers:             'created_at',
  customer_sessions:     'created_at',
  magic_links:           'created_at',
  webhook_events:        'received_at',
};

// Retourne un résumé structuré pour la page /db-viewer :
//   { dbPath, fileSize, pageSize, pageCount, tables: [{name, rowCount, oldest, newest}] }
//
// Erreurs tolérées sur un range individuel (table absente / vide) → on
// renvoie oldest/newest à null plutôt que crasher le diagnostic global.
function getDbStats() {
  const fs = require('fs');
  let fileSize = 0;
  try { fileSize = fs.statSync(DB_PATH).size; } catch (_) {}

  // SQLite pragmas pour la structure interne (pages = taille réelle
  // incluant le WAL si actif).
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });

  const tables = Object.keys(TIME_COLUMNS).map(name => {
    let rowCount = 0;
    let oldest = null;
    let newest = null;
    try {
      rowCount = db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n;
      const col = TIME_COLUMNS[name];
      if (col && rowCount > 0) {
        const row = db.prepare(
          'SELECT MIN(' + col + ') AS a, MAX(' + col + ') AS b FROM ' + name
        ).get();
        oldest = row.a;
        newest = row.b;
      }
    } catch (e) {
      // Table absente ou autre erreur : on la signale via rowCount = -1.
      rowCount = -1;
    }
    return { name, rowCount, oldest, newest };
  });

  return {
    dbPath: DB_PATH,
    fileSize,
    pageSize,
    pageCount,
    tables,
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Backup snapshot — pour la commit git quotidienne
// ═════════════════════════════════════════════════════════════════════

// Crée un snapshot binaire cohérent de la DB à `destPath`. Utilise
// l'API native SQLite qui gère la concurrence : safe même si des INSERT
// arrivent pendant la copie (contrairement à un simple fs.copyFile qui
// pourrait attraper un état intermédiaire en mode WAL).
//
// Retourne une Promise. Le fichier résultat est une base SQLite
// autonome — ouvrable directement, sans fichiers .wal/.shm annexes.
function backupDb(destPath) {
  return db.backup(destPath);
}

// ═════════════════════════════════════════════════════════════════════
//  Render jobs — queue de rendu vidéo (Phase 3 auto-render proof videos)
// ═════════════════════════════════════════════════════════════════════
//
// Le bot enfile un job ici quand un signal exit gagnant matche une entry.
// Un worker local poll l'endpoint HTTP, processe le job (Remotion render),
// puis appelle markRenderJobDone/markRenderJobFailed.

const stmtEnqueueRenderJob = db.prepare(`
  INSERT INTO render_jobs
    (ticker, entry_author, entry_message, entry_ts,
     exit_author, exit_message, exit_ts, pnl, proof_image_base64,
     template_name, composition, recap_data, tease_action, tease_subtext,
     entry_price, exit_price, output_channel_id, props_override)
  VALUES
    (@ticker, @entry_author, @entry_message, @entry_ts,
     @exit_author, @exit_message, @exit_ts, @pnl, @proof_image_base64,
     @template_name, @composition, @recap_data, @tease_action, @tease_subtext,
     @entry_price, @exit_price, @output_channel_id, @props_override)
`);

const stmtGetPendingRenderJobs = db.prepare(`
  SELECT id, ticker, entry_author, entry_message, entry_ts,
         exit_author, exit_message, exit_ts, pnl, status, created_at,
         proof_image_base64, template_name, composition, recap_data,
         tease_action, tease_subtext, entry_price, exit_price,
         output_channel_id, props_override
  FROM render_jobs
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT ?
`);

const stmtGetRenderJobById = db.prepare(`
  SELECT id, ticker, entry_author, entry_message, entry_ts,
         exit_author, exit_message, exit_ts, pnl, status, created_at,
         proof_image_base64, template_name, composition, recap_data,
         tease_action, tease_subtext, entry_price, exit_price,
         output_channel_id, props_override
  FROM render_jobs
  WHERE id = ?
`);

const stmtMarkRenderJobDone = db.prepare(`
  UPDATE render_jobs
  SET status = 'done', done_at = datetime('now'), discord_msg_id = ?
  WHERE id = ?
`);

const stmtMarkRenderJobFailed = db.prepare(`
  UPDATE render_jobs
  SET status = 'failed', done_at = datetime('now'), error = ?
  WHERE id = ?
`);

function enqueueRenderJob(payload) {
  // proof_image_base64 + template_name + composition + recap_data + tease_*
  // optionnels — si absents du payload, défaulte à null/'ChartTemplate'.
  // better-sqlite3 plante si on ne fournit pas explicitement les @-paramètres.
  const result = stmtEnqueueRenderJob.run({
    proof_image_base64: null,
    template_name: null,
    composition: 'ChartTemplate',
    recap_data: null,
    tease_action: null,
    tease_subtext: null,
    entry_price: null,
    exit_price: null,
    output_channel_id: null,
    props_override: null,
    ...payload,
  });
  return result.lastInsertRowid;
}

function getPendingRenderJobs(limit = 10) {
  return stmtGetPendingRenderJobs.all(limit);
}

function getRenderJobById(id) {
  return stmtGetRenderJobById.get(id);
}

// Liste des N derniers render jobs, tous statuts confondus (ordre récent
// en premier). Utilisé par /video-studio pour afficher l'historique des
// vidéos générées + leur état actuel.
//
// `statusFilter` (optionnel) = 'pending' | 'done' | 'failed' pour filtrer
// sur un seul état. Si absent → tout.
const stmtGetAllRenderJobs = db.prepare(`
  SELECT id, ticker, entry_author, entry_message, entry_ts,
         exit_author, exit_message, exit_ts, pnl, status, created_at,
         done_at, error, discord_msg_id,
         template_name, composition,
         entry_price, exit_price, output_channel_id
  FROM render_jobs
  ORDER BY created_at DESC
  LIMIT ?
`);
const stmtGetRenderJobsByStatus = db.prepare(`
  SELECT id, ticker, entry_author, entry_message, entry_ts,
         exit_author, exit_message, exit_ts, pnl, status, created_at,
         done_at, error, discord_msg_id,
         template_name, composition,
         entry_price, exit_price, output_channel_id
  FROM render_jobs
  WHERE status = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

function getAllRenderJobs(limit = 50, statusFilter = null) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  if (statusFilter) {
    return stmtGetRenderJobsByStatus.all(statusFilter, cap);
  }
  return stmtGetAllRenderJobs.all(cap);
}

function markRenderJobDone(id, discordMsgId) {
  stmtMarkRenderJobDone.run(discordMsgId || null, id);
}

function markRenderJobFailed(id, errorMessage) {
  stmtMarkRenderJobFailed.run(errorMessage || 'unknown error', id);
}

// ─────────────────────────────────────────────────────────────────────
// daily_recaps : idempotence par date pour les recaps auto-déclenchés
// ─────────────────────────────────────────────────────────────────────

const stmtClaimRecapDate = db.prepare(`
  INSERT OR IGNORE INTO daily_recaps (date, message_id, tickers_count)
  VALUES (?, ?, ?)
`);

const stmtSetRecapRenderJobId = db.prepare(`
  UPDATE daily_recaps SET render_job_id = ? WHERE date = ?
`);

const stmtGetRecapByDate = db.prepare(`
  SELECT date, message_id, render_job_id, tickers_count,
         runners_hit, runners_total, created_at
  FROM daily_recaps WHERE date = ?
`);

// Tente de claimer une date : true au premier call (recap pas encore
// fait aujourd'hui), false sinon. Idempotent : safe à appeler 2× sur
// la même date sans side effect.
function tryClaimRecapDate(date, messageId, tickersCount) {
  const result = stmtClaimRecapDate.run(date, messageId, tickersCount);
  return result.changes > 0;
}

function setRecapRenderJobId(date, renderJobId) {
  stmtSetRecapRenderJobId.run(renderJobId, date);
}

function getRecapByDate(date) {
  return stmtGetRecapByDate.get(date) || null;
}

// ── tracked_messages (analyst-watchlist audit) ──────────────────────
const stmtTrackedMessageInsert = db.prepare(`
  INSERT OR IGNORE INTO tracked_messages
    (message_id, channel_id, author_id, author_username, is_bot,
     content, embed_json, extracted_ticker, extracted_price, created_at)
  VALUES
    (@messageId, @channelId, @authorId, @authorUsername, @isBot,
     @content, @embedJson, @extractedTicker, @extractedPrice, @createdAt)
`);

const stmtTrackedMessageGet = db.prepare(`
  SELECT * FROM tracked_messages WHERE message_id = ?
`);

function insertTrackedMessage(entry) {
  stmtTrackedMessageInsert.run({
    messageId:       String(entry.messageId),
    channelId:       String(entry.channelId),
    authorId:        String(entry.authorId),
    authorUsername:  entry.authorUsername ?? null,
    isBot:           entry.isBot ? 1 : 0,
    content:         entry.content ?? null,
    embedJson:       entry.embedJson ?? null,
    extractedTicker: entry.extractedTicker ?? null,
    extractedPrice:  Number.isFinite(entry.extractedPrice) ? entry.extractedPrice : null,
    createdAt:       Number(entry.createdAt),
  });
}

function getTrackedMessage(messageId) {
  return stmtTrackedMessageGet.get(String(messageId)) || null;
}

// ── analyst_watchlist (active tickers tracked for milestones) ───────
const stmtWatchlistInsert = db.prepare(`
  INSERT OR IGNORE INTO analyst_watchlist
    (ticker, initial_price, initial_price_source, source_message_id,
     source_channel_id, mentioned_by_user_id, mentioned_by_username,
     first_seen_at)
  VALUES
    (@ticker, @initialPrice, @initialPriceSource, @sourceMessageId,
     @sourceChannelId, @mentionedByUserId, @mentionedByUsername,
     @firstSeenAt)
`);

const stmtWatchlistGet = db.prepare(`
  SELECT * FROM analyst_watchlist WHERE ticker = ?
`);

const stmtWatchlistActive = db.prepare(`
  SELECT * FROM analyst_watchlist
  WHERE archived_at IS NULL
  ORDER BY first_seen_at ASC
`);

const stmtWatchlistUpdateAfterAlert = db.prepare(`
  UPDATE analyst_watchlist
  SET last_milestone_pct = @lastMilestonePct,
      last_alert_at      = @lastAlertAt
  WHERE ticker = @ticker
`);

const stmtWatchlistArchiveExpired = db.prepare(`
  UPDATE analyst_watchlist
  SET archived_at = @now
  WHERE archived_at IS NULL AND first_seen_at < @cutoff
`);

function insertWatchlistEntry(entry) {
  stmtWatchlistInsert.run({
    ticker:              String(entry.ticker).toUpperCase(),
    initialPrice:        Number(entry.initialPrice),
    initialPriceSource:  String(entry.initialPriceSource),
    sourceMessageId:     String(entry.sourceMessageId),
    sourceChannelId:     String(entry.sourceChannelId),
    mentionedByUserId:   String(entry.mentionedByUserId),
    mentionedByUsername: entry.mentionedByUsername ?? null,
    firstSeenAt:         Number(entry.firstSeenAt),
  });
}

function getWatchlistEntry(ticker) {
  return stmtWatchlistGet.get(String(ticker).toUpperCase()) || null;
}

function getActiveWatchlist() {
  return stmtWatchlistActive.all();
}

function updateWatchlistAfterAlert({ ticker, lastMilestonePct, lastAlertAt }) {
  stmtWatchlistUpdateAfterAlert.run({
    ticker:           String(ticker).toUpperCase(),
    lastMilestonePct: Number(lastMilestonePct),
    lastAlertAt:      Number(lastAlertAt),
  });
}

function archiveExpiredWatchlist(cutoffMs, nowMs = Date.now()) {
  const result = stmtWatchlistArchiveExpired.run({
    cutoff: Number(cutoffMs),
    now:    Number(nowMs),
  });
  return result.changes;
}

// ── milestone_alerts (atomic dedup via UNIQUE constraint) ───────────
const stmtMilestoneAlertInsert = db.prepare(`
  INSERT OR IGNORE INTO milestone_alerts
    (ticker, milestone_pct, initial_price, current_price,
     gain_pct, fired_at, discord_message_id)
  VALUES
    (@ticker, @milestonePct, @initialPrice, @currentPrice,
     @gainPct, @firedAt, @discordMessageId)
`);

// Returns true when the insert actually wrote (= this caller may post).
// Returns false when UNIQUE constraint blocked it (= already fired).
function insertMilestoneAlert(entry) {
  const result = stmtMilestoneAlertInsert.run({
    ticker:           String(entry.ticker).toUpperCase(),
    milestonePct:     Number(entry.milestonePct),
    initialPrice:     Number(entry.initialPrice),
    currentPrice:     Number(entry.currentPrice),
    gainPct:          Number(entry.gainPct),
    firedAt:          Number(entry.firedAt),
    discordMessageId: entry.discordMessageId ?? null,
  });
  return result.changes > 0;
}

const stmtMilestoneAlertSetDiscordId = db.prepare(`
  UPDATE milestone_alerts
  SET discord_message_id = @discordMessageId
  WHERE ticker = @ticker AND milestone_pct = @milestonePct
`);

// Updates the discord_message_id for an already-inserted milestone alert.
// Called from milestone-checker after a successful Discord reply.
// Returns true if a row was updated, false otherwise.
function setMilestoneAlertDiscordId({ ticker, milestonePct, discordMessageId }) {
  const result = stmtMilestoneAlertSetDiscordId.run({
    ticker:           String(ticker).toUpperCase(),
    milestonePct:     Number(milestonePct),
    discordMessageId: discordMessageId == null ? null : String(discordMessageId),
  });
  return result.changes > 0;
}

module.exports = {
  db,
  DB_PATH,

  // messages
  insertMessage,
  insertMessagesBulk,
  getRecentMessages,
  getMessagesByDateKey,
  getMessagesByTsRange,
  getMessagesByTicker,
  countMessages,
  purgeFilteredMessagesWithoutData,

  // profits
  getProfitData,
  setProfitData,
  getProfitHistoryFrom,
  insertProfitMessage,
  insertProfitMessagesBulk,
  getProfitMessagesByDate,
  updateProfitMessageFeedback,
  getProfitFilters,
  addProfitFilterPhrase,
  removeProfitFilterPhrase,

  // settings (KV blob)
  getSetting,
  setSetting,

  // news items
  insertNewsItem,
  getRecentNewsItems,
  trimNewsItems,
  purgeNewsOlderThan,

  // welcome log
  insertWelcomeLog,
  getWelcomeLog,

  // gallery items
  insertGalleryItem,
  getRecentGalleryItems,
  trimGalleryItems,

  // positions (trading)
  insertPosition,
  updatePositionOrderIds,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  markPositionError,
  getOpenPositions,
  countOpenPositions,
  getPositionByTickerAndAuthor,
  getPositionByIbkrParentId,
  getPositionHistory,

  // SaaS — licences
  licenseUpsert,
  licenseGet,
  licenseList,
  licenseSetStatus,
  licenseSetExpires,
  licenseSetTargetChannel,
  licenseSetPassthroughChannel,
  licenseSetIPOChannel,
  licenseListPassthroughReady,
  licenseListIPOReady,
  licenseTouchRelay,
  licenseFindByLaunchpassSub,
  licenseDelete,

  // SaaS — relay log
  relayLogInsert,
  dailyAlertLogInsert,
  dailyAlertLogHas,
  dailyAlertLogPurgeOld,
  todayUTCDate,
  llmClassifyGet,
  llmClassifyPut,
  llmClassifyInvalidateModel,
  llmClassifyStats,
  relayLogRecent,
  relayLogStatsSince,

  // SaaS — admin audit
  adminActionInsert,

  // SaaS — auto-leave log
  autoLeaveLogInsert,
  autoLeaveLogClose,

  // market alert state (dedup)
  alertWasFired,
  markAlertFired,
  purgeMarketAlertStateOlderThan,

  // Site public — plans (CMS pricing)
  planUpsert,
  planGet,
  planList,
  planDelete,

  // Site public — customers
  customerUpsertByEmail,
  customerGet,
  customerGetByEmail,
  customerLinkGuild,
  customerSetStripeId,
  customerSetLaunchpassId,
  customerTouchLogin,

  // Site public — customer sessions
  customerSessionCreate,
  customerSessionGet,
  customerSessionDelete,
  customerSessionPurgeExpired,

  // Site public — magic links
  magicLinkCreate,
  magicLinkConsume,
  magicLinkCountRecent,
  magicLinkPurgeExpired,

  // Site public — webhook events idempotence
  webhookEventClaim,
  webhookEventMarkProcessed,

  // backup
  backupDb,

  // diagnostic
  getDbStats,

  // render jobs (Phase 3 auto-render proof videos)
  enqueueRenderJob,
  getPendingRenderJobs,
  getRenderJobById,
  getAllRenderJobs,
  markRenderJobDone,
  markRenderJobFailed,

  // daily_recaps (idempotence recap auto-déclenché)
  tryClaimRecapDate,
  setRecapRenderJobId,
  getRecapByDate,

  // analyst-watchlist audit
  insertTrackedMessage,
  getTrackedMessage,

  // analyst-watchlist module
  insertWatchlistEntry,
  getWatchlistEntry,
  getActiveWatchlist,
  updateWatchlistAfterAlert,
  archiveExpiredWatchlist,

  // analyst-watchlist module — milestone dedup
  insertMilestoneAlert,
  setMilestoneAlertDiscordId,
};
