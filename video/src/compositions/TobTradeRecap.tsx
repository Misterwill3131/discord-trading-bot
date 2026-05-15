import { AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { zColor } from '@remotion/zod-types';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { SharedOutro } from '../components/SharedOutro';
import { NarrationSubtitles } from '../components/NarrationSubtitles';
import { LogoOverlay } from '../components/LogoOverlay';

const { fontFamily } = loadInter('normal', { weights: ['400', '600', '700', '800', '900'] });

// ─────────────────────────────────────────────────────────────────────
// TobTradeRecap — Daily trade recap with table + alerts parade
// ─────────────────────────────────────────────────────────────────────
// Composition pour le template "Daily Trade Recap" version data-dense :
//
//   1. Intro 3s — Titre "TOB TRADE RECAP" doré + sparkle
//   2. Table récap ~10s — toutes les lignes (ticker/entry/HOD/T1/T2/T3/
//      success rate) avec auto-scroll vertical
//   3. AlertsParade ~12s — défilement TikTok-style des PNG d'alertes
//      du jour (générés par canvas/proof.js)
//   4. Stats panel 4s — 7 boîtes count-up (total calls, success rate, etc.)
//   5. Long-term spotlight 3s — investissement long-terme highlight doré
//   6. Outro 3s — SharedOutro lion
//
// Total nominal : ~35s @ 30fps.
//
// Workflow :
//   1. scripts/generate-trade-recap.js query DB getMessagesByDateKey(today)
//   2. Génère PNG alertes via canvas/generateImage → public/recap-alerts/
//   3. Build inputProps (trades + alertImages paths) → Remotion render MP4
//   4. MP4 dans video/out/tob-trade-recap-{timestamp}.mp4
// ─────────────────────────────────────────────────────────────────────

const tradeSchema = z.object({
  ticker: z.string().describe('Ticker symbol with $ prefix (ex: "$XOS")'),
  entryPrice: z.number().describe('Prix d\'entrée'),
  hodPrice: z.number().describe('High of Day — prix max atteint après entry'),
});

const longTermSchema = z.object({
  ticker: z.string(),
  entryPrice: z.number(),
  currentPrice: z.number(),
});

const alertImageSchema = z.object({
  // Soit un chemin staticFile (legacy "recap-alerts/alert-1.png"), soit
  // une data URL inline ("data:image/png;base64,..."). Les data URLs
  // contournent le pb du bundle Remotion qui snapshot public/ au boot
  // du worker — fichiers ajoutés après ne sont pas servis.
  imagePath: z.string().describe('staticFile path OU data:image/png;base64,...'),
  ticker: z.string().nullable().optional(),
});

export const tobTradeRecapSchema = z.object({
  dateLabel: z.string().default('TODAY'),
  trades: z.array(tradeSchema).min(1).max(80),
  // Liste de placements long-terme (peut être 0, 1, 2…). On affiche
  // toutes les cartes en stack vertical dans LongTermPhase.
  longTermInvestments: z.array(longTermSchema).default([]),
  alertImages: z.array(alertImageSchema).default([]),
  // Délai (en s) entre l'apparition de 2 alertes successives. 1.0s = 1 alerte
  // par seconde. Plus la valeur est basse, plus le feed se remplit vite.
  // Feed-style : les alertes s'empilent verticalement, scroll up quand
  // l'écran est plein. Les vieilles fade out en haut.
  secondsPerAlert: z.number().min(0.3).max(3).default(1.0),
  // Hold final après la dernière alerte apparue (lecture confortable).
  alertsHoldEndSeconds: z.number().min(0).max(10).default(3),
  // Placeholder si 0 alertes — évite cut sec entre table et stats.
  alertsFallbackSeconds: z.number().min(1).max(10).default(4),
  accentColor: zColor().default('#fbbf24'),
  successColor: zColor().default('#10b981'),
  errorColor: zColor().default('#ef4444'),
  bgColor: zColor().default('#0a0a0f'),
  outroSeed: z.string().default('trade-recap'),
  // TTS narration MP3 inline (data:audio/mpeg;base64,...). Si fourni, la
  // composition layer un <Audio> par-dessus la BG music au volume plein.
  // null/empty = pas de voix off.
  narrationDataUrl: z.string().nullable().optional(),
  // Texte de la narration (même contenu que ce qui est TTS-é). Si fourni,
  // la composition affiche des subtitles burned-in pour autoplay muet
  // (TikTok/Reels). Indépendant du dataUrl — on peut activer subtitles
  // sans audio si on veut juste la lisibilité.
  narrationText: z.string().nullable().optional(),
  // Logo overlay (watermark) configurable par template.
  logoUrl: z.string().nullable().optional(),
  logoCorner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
});

export type TobTradeRecapProps = z.infer<typeof tobTradeRecapSchema>;

// ── Durées des phases (frames @ 30fps) ──────────────────────────────
const FPS = 30;
const FRAMES_INTRO = 90;          // 3s
const FRAMES_TABLE = 360;         // 12s — large pour 41 lignes (peut tenir +)
const FRAMES_STATS = 120;         // 4s
const FRAMES_LONGTERM = 90;       // 3s
const FRAMES_OUTRO = 90;          // 3s

// Durée de la phase alerts en mode "feed" :
//   (N-1) × secondsPerAlert × 30   ← dernière alerte apparaît à ce frame
//   + APPEAR_FRAMES                ← 12 frames pour le fade-in final
//   + alertsHoldEndSeconds × 30    ← hold pour lire le résultat
// Si pas d'alertes : fallback fixed.
const APPEAR_FRAMES = 12;
function computeAlertsFrames(props: TobTradeRecapProps): number {
  const n = props.alertImages?.length || 0;
  if (n === 0) return Math.round((props.alertsFallbackSeconds || 4) * FPS);
  const perAlert = props.secondsPerAlert || 1.0;
  const holdEnd = props.alertsHoldEndSeconds ?? 3;
  return Math.round((n - 1) * perAlert * FPS + APPEAR_FRAMES + holdEnd * FPS);
}

export function computeTradeRecapTotalFrames(props: TobTradeRecapProps): number {
  return FRAMES_INTRO + FRAMES_TABLE + computeAlertsFrames(props) + FRAMES_STATS + FRAMES_LONGTERM + FRAMES_OUTRO;
}

// ─── Helpers : calculs stats trades ──────────────────────────────────
type ComputedTrade = {
  ticker: string;
  entryPrice: number;
  hodPrice: number;
  t1Price: number;
  t2Price: number;
  t3Price: number;
  t1Hit: boolean;
  t2Hit: boolean;
  t3Hit: boolean;
  targetsHitCount: number;
  successRate: number;  // 0-100
  finalGainPct: number; // (hod - entry) / entry × 100
};

function computeTrade(t: { ticker: string; entryPrice: number; hodPrice: number }): ComputedTrade {
  const t1Price = t.entryPrice * 1.05;
  const t2Price = t.entryPrice * 1.10;
  const t3Price = t.entryPrice * 1.15;
  const t1Hit = t.hodPrice >= t1Price;
  const t2Hit = t.hodPrice >= t2Price;
  const t3Hit = t.hodPrice >= t3Price;
  const targetsHitCount = (t1Hit ? 1 : 0) + (t2Hit ? 1 : 0) + (t3Hit ? 1 : 0);
  return {
    ticker: t.ticker,
    entryPrice: t.entryPrice,
    hodPrice: t.hodPrice,
    t1Price, t2Price, t3Price,
    t1Hit, t2Hit, t3Hit,
    targetsHitCount,
    successRate: (targetsHitCount / 3) * 100,
    finalGainPct: ((t.hodPrice - t.entryPrice) / t.entryPrice) * 100,
  };
}

type Summary = {
  totalCalls: number;
  callsWithT3Hit: number;
  callsWithT3HitPct: number;
  combinedFinalPct: number;
  averageFinalPct: number;
  highestFinalPct: number;
  highestTicker: string;
  lowestFinalPct: number;
  lowestTicker: string;
  successRate: number;
  greenCount: number;
  redCount: number;
};

function computeSummary(computed: ComputedTrade[]): Summary {
  const totalCalls = computed.length;
  const callsWithT3Hit = computed.filter(t => t.t3Hit).length;
  const greenCount = computed.filter(t => t.finalGainPct > 0).length;
  const redCount = totalCalls - greenCount;
  const combinedFinalPct = computed.reduce((s, t) => s + t.finalGainPct, 0);
  const averageFinalPct = combinedFinalPct / totalCalls;
  const highest = computed.reduce((max, t) => t.finalGainPct > max.finalGainPct ? t : max, computed[0]);
  const lowest = computed.reduce((min, t) => t.finalGainPct < min.finalGainPct ? t : min, computed[0]);
  return {
    totalCalls,
    callsWithT3Hit,
    callsWithT3HitPct: (callsWithT3Hit / totalCalls) * 100,
    combinedFinalPct,
    averageFinalPct,
    highestFinalPct: highest.finalGainPct,
    highestTicker: highest.ticker,
    lowestFinalPct: lowest.finalGainPct,
    lowestTicker: lowest.ticker,
    successRate: (greenCount / totalCalls) * 100,
    greenCount,
    redCount,
  };
}

function fmtPrice(n: number): string {
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ─── Phase 1 : Intro (titre doré + sparkle) ─────────────────────────
const IntroPhase: React.FC<{ accentColor: string; dateLabel: string }> = ({ accentColor, dateLabel }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({ frame, fps, config: { damping: 12, stiffness: 100 }, durationInFrames: 30 });
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const sparkleOpacity = interpolate(frame, [20, 30, 70, 90], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      backgroundColor: '#0a0a0f',
      fontFamily,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
    }}>
      <div style={{
        opacity: titleOpacity,
        transform: `scale(${titleScale})`,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 56, color: accentColor, opacity: sparkleOpacity, marginBottom: 24 }}>✦ ✦ ✦</div>
        <div style={{ fontSize: 88, fontWeight: 900, color: accentColor, letterSpacing: -2, textShadow: '0 4px 24px rgba(251,191,36,0.5)', lineHeight: 1.05 }}>
          TOB TRADE
        </div>
        <div style={{ fontSize: 88, fontWeight: 900, color: accentColor, letterSpacing: -2, textShadow: '0 4px 24px rgba(251,191,36,0.5)', lineHeight: 1.05 }}>
          RECAP
        </div>
        <div style={{ fontSize: 48, fontWeight: 700, color: '#fff', marginTop: 32, letterSpacing: 4 }}>
          {dateLabel.toUpperCase()}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Phase 2 : Table — auto-scroll vertical + scaling adaptatif ──────
// Le SCALE adapte la taille des rows (et fonts/checkmarks) au nombre
// de trades : peu de trades → rows + texte zoomés pour remplir l'écran ;
// beaucoup de trades → rows compactes + auto-scroll vertical.
//
// Bornes : SCALE ∈ [1, 2.5]
//   - 28 trades (1456px) → SCALE=1 (rows à taille de base, pile la frame)
//   - 10 trades (520px)  → SCALE=2.5 → 1300px de contenu, plein écran
//   - 41 trades (2132px) → SCALE=1 → scroll vertical comme avant
const TablePhase: React.FC<{
  trades: ComputedTrade[];
  accentColor: string;
  successColor: string;
  errorColor: string;
  bgColor: string;
}> = ({ trades, accentColor, successColor, errorColor, bgColor }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, height: canvasHeight } = useVideoConfig();

  // Layout responsive : VISIBLE_TABLE_HEIGHT = ~75% du canvas height pour
  // laisser room au titre + padding. Marche pour 9:16 (1920→1440), 1:1
  // (1080→810), 16:9 (1080→810).
  const ROW_HEIGHT_BASE = 52;
  const HEADER_HEIGHT = 60;
  const VISIBLE_TABLE_HEIGHT = Math.round(canvasHeight * 0.75);
  const naturalContentH = Math.max(1, trades.length * ROW_HEIGHT_BASE);
  const SCALE = Math.max(1, Math.min(2.5, VISIBLE_TABLE_HEIGHT / naturalContentH));

  const ROW_HEIGHT = Math.round(ROW_HEIGHT_BASE * SCALE);
  const CELL_FONT_SIZE = Math.round(TABLE_CELL_FONT_SIZE * SCALE);
  const HEADER_FONT_SIZE = Math.round(18 * SCALE);
  const CHECK_SIZE = Math.round(22 * SCALE);

  const TOTAL_CONTENT_HEIGHT = trades.length * ROW_HEIGHT;
  // Container = min(content, full budget). Quand peu de trades, on n'alloue
  // que ce qu'il faut → le bottom n'est plus du vide noir.
  const USED_TABLE_HEIGHT = Math.min(TOTAL_CONTENT_HEIGHT, VISIBLE_TABLE_HEIGHT);
  const MAX_SCROLL = Math.max(0, TOTAL_CONTENT_HEIGHT - VISIBLE_TABLE_HEIGHT + HEADER_HEIGHT);
  const SCROLL_NEEDED = MAX_SCROLL > 0;

  // Scroll from 0 to MAX_SCROLL over (durationInFrames - 60) frames.
  // Hold first 30 frames at top, hold last 30 frames at bottom for readability.
  const scrollOffset = interpolate(
    frame,
    [30, durationInFrames - 30],
    [0, MAX_SCROLL],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Fade in titre
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      backgroundColor: bgColor,
      fontFamily,
      padding: '30px 24px',
      flexDirection: 'column',
      // Centre verticalement quand le contenu est plus petit que le budget
      // (peu de trades) — évite la grosse zone vide en bas.
      justifyContent: SCROLL_NEEDED ? 'flex-start' : 'center',
    }}>
      {/* Mini-titre */}
      <div style={{
        opacity: titleOpacity,
        textAlign: 'center',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 34, fontWeight: 900, color: accentColor, letterSpacing: 1, textShadow: '0 2px 12px rgba(251,191,36,0.4)' }}>
          ✦ TOB TRADE RECAP ✦
        </div>
      </div>

      {/* Header columns sticky */}
      <TableHeader accentColor={accentColor} fontSize={HEADER_FONT_SIZE} />

      {/* Scrolling rows */}
      <div style={{ height: USED_TABLE_HEIGHT, overflow: 'hidden', position: 'relative' }}>
        <div style={{ transform: `translateY(-${scrollOffset}px)`, willChange: 'transform' }}>
          {trades.map((t, i) => (
            <TradeRow
              key={i}
              index={i}
              trade={t}
              accentColor={accentColor}
              successColor={successColor}
              errorColor={errorColor}
              rowHeight={ROW_HEIGHT}
              fontSize={CELL_FONT_SIZE}
              checkSize={CHECK_SIZE}
            />
          ))}
        </div>
        {/* Gradient fade at bottom — uniquement quand le contenu scroll, sinon
            ça mange visuellement la dernière row. */}
        {SCROLL_NEEDED && (
          <div style={{
            position: 'absolute',
            bottom: 0, left: 0, right: 0,
            height: 80,
            background: `linear-gradient(180deg, transparent 0%, ${bgColor} 100%)`,
            pointerEvents: 'none',
          }} />
        )}
      </div>
    </AbsoluteFill>
  );
};

// 8 columns : Ticker | Entry | HOD | T1 | T2 | T3 | Targets | Success
const TABLE_GRID = '1.2fr 1fr 1fr 1fr 1fr 1fr 1.6fr 1fr';
const TABLE_CELL_FONT_SIZE = 22;

const TableHeader: React.FC<{ accentColor: string; fontSize: number }> = ({ accentColor, fontSize }) => (
  <div style={{
    display: 'grid',
    gridTemplateColumns: TABLE_GRID,
    padding: '14px 12px',
    color: accentColor,
    fontSize,
    fontWeight: 800,
    letterSpacing: 0.5,
    borderBottom: `2px solid ${accentColor}66`,
    backgroundColor: '#0a0a0f',
    textAlign: 'center',
  }}>
    <div style={{ textAlign: 'left' }}>TICKER</div>
    <div>ENTRY</div>
    <div>HOD</div>
    <div>T1 +5%</div>
    <div>T2 +10%</div>
    <div>T3 +15%</div>
    <div>TARGETS</div>
    <div>SUCCESS</div>
  </div>
);

const TradeRow: React.FC<{
  index: number;
  trade: ComputedTrade;
  accentColor: string;
  successColor: string;
  errorColor: string;
  rowHeight: number;
  fontSize: number;
  checkSize: number;
}> = ({ index, trade, successColor, errorColor, rowHeight, fontSize, checkSize }) => {
  const hodColor = trade.hodPrice >= trade.entryPrice ? successColor : errorColor;
  const t1Color = trade.t1Hit ? successColor : errorColor;
  const t2Color = trade.t2Hit ? successColor : errorColor;
  const t3Color = trade.t3Hit ? successColor : errorColor;
  const successColor2 = trade.successRate >= 66.67 ? successColor : (trade.successRate >= 33.33 ? '#f59e0b' : errorColor);
  const rowBg = index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent';
  // Les colonnes T1/T2/T3 sont un poil plus petites que les autres pour
  // densifier visuellement (proportion gardée même quand fontSize scale up).
  const targetFontSize = Math.max(12, fontSize - Math.round(fontSize * 0.09));

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: TABLE_GRID,
      padding: '10px 12px',
      height: rowHeight,
      alignItems: 'center',
      color: '#fff',
      fontSize,
      fontWeight: 600,
      backgroundColor: rowBg,
      textAlign: 'center',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <div style={{ textAlign: 'left', fontWeight: 800, color: '#fff' }}>{trade.ticker}</div>
      <div style={{ color: '#cbd5e1' }}>{fmtPrice(trade.entryPrice)}</div>
      <div style={{ color: hodColor, fontWeight: 800 }}>{fmtPrice(trade.hodPrice)}</div>
      <div style={{ color: t1Color, fontSize: targetFontSize }}>{fmtPrice(trade.t1Price)}</div>
      <div style={{ color: t2Color, fontSize: targetFontSize }}>{fmtPrice(trade.t2Price)}</div>
      <div style={{ color: t3Color, fontSize: targetFontSize }}>{fmtPrice(trade.t3Price)}</div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
        <CheckMark hit={trade.t1Hit} successColor={successColor} errorColor={errorColor} size={checkSize} />
        <CheckMark hit={trade.t2Hit} successColor={successColor} errorColor={errorColor} size={checkSize} />
        <CheckMark hit={trade.t3Hit} successColor={successColor} errorColor={errorColor} size={checkSize} />
      </div>
      <div style={{ color: successColor2, fontWeight: 800 }}>{trade.successRate.toFixed(0)}%</div>
    </div>
  );
};

const CheckMark: React.FC<{ hit: boolean; successColor: string; errorColor: string; size: number }> = ({ hit, successColor, errorColor, size }) => (
  <div style={{
    width: size, height: size, borderRadius: size / 2,
    backgroundColor: hit ? successColor : errorColor,
    color: '#000', fontWeight: 900,
    fontSize: Math.max(12, Math.round(size * 0.72)),
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }}>
    {hit ? '✓' : '✗'}
  </div>
);

// ─── Phase 3 : AlertsParade — feed-style accumulation Discord ───────
// Les alertes s'empilent verticalement : la 1ère apparaît en haut, la 2e
// 1s plus tard juste en dessous, etc. Quand l'écran est plein, la stack
// scroll up smooth pour laisser place aux nouvelles ; les vieilles fade
// out en haut. Hold sur l'état final pour laisser le viewer lire.
const AlertsParadePhase: React.FC<{
  alertImages: { imagePath: string; ticker?: string | null }[];
  accentColor: string;
  bgColor: string;
  secondsPerAlert: number;
}> = ({ alertImages, accentColor, bgColor, secondsPerAlert }) => {
  const frame = useCurrentFrame();
  const { fps, height: canvasHeight } = useVideoConfig();

  if (alertImages.length === 0) {
    return (
      <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: accentColor, fontSize: 40, fontWeight: 700, opacity: 0.5 }}>
          Pas d&apos;alertes à afficher
        </div>
      </AbsoluteFill>
    );
  }

  // ── Layout constants (responsive au canvas) ──
  // L'aire utile va de y=HEADER_BOTTOM jusqu'à y=canvasHeight - BOTTOM_MARGIN.
  // Marche en 9:16 (1920), 1:1 (1080), 16:9 (1080).
  const SCREEN_HEIGHT = canvasHeight;
  const HEADER_BOTTOM = 180;          // sous le titre "TODAY'S ALERTS"
  const BOTTOM_MARGIN = 80;
  const USABLE_HEIGHT = Math.max(200, SCREEN_HEIGHT - HEADER_BOTTOM - BOTTOM_MARGIN);
  const ALERT_MAX_HEIGHT = 180;       // height max d'une carte d'alerte
  const ALERT_SPACING = 16;
  const STEP_Y = ALERT_MAX_HEIGHT + ALERT_SPACING;  // 196px
  const MAX_VISIBLE = Math.max(1, Math.floor(USABLE_HEIGHT / STEP_Y));

  const framesPerAlert = Math.max(1, Math.round(secondsPerAlert * fps));
  const APPEAR = 12;  // fade-in 0.4s

  // ── Scroll offset (smooth interpolation) ──
  // Quand la position fractionnaire dépasse MAX_VISIBLE-1, on commence
  // à scroller pour faire de la place aux nouvelles alertes.
  const fractionalIndex = frame / framesPerAlert;
  const overflow = Math.max(0, fractionalIndex - (MAX_VISIBLE - 1));
  const scrollOffset = overflow * STEP_Y;

  // Nombre d'alertes apparues (pour le counter affiché)
  const revealedCount = Math.min(
    Math.floor(frame / framesPerAlert) + 1,
    alertImages.length
  );

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily, overflow: 'hidden' }}>
      {/* Header sticky */}
      <div style={{
        position: 'absolute', top: 40, left: 0, right: 0,
        textAlign: 'center', zIndex: 10,
      }}>
        <div style={{ fontSize: 38, fontWeight: 900, color: accentColor, letterSpacing: 1, textShadow: '0 2px 12px rgba(251,191,36,0.4)' }}>
          TODAY&apos;S ALERTS
        </div>
        <div style={{ fontSize: 24, fontWeight: 600, color: '#94a3b8', marginTop: 4 }}>
          {revealedCount} / {alertImages.length}
        </div>
      </div>

      {/* Stack d'alertes — position absolute par index */}
      <div style={{ position: 'absolute', top: HEADER_BOTTOM, left: 0, right: 0, height: USABLE_HEIGHT }}>
        {alertImages.map((alert, i) => {
          const appearAtFrame = i * framesPerAlert;
          const localFrame = frame - appearAtFrame;
          if (localFrame < 0) return null;  // pas encore apparu

          // Fade-in + petit slide-up depuis +30px
          const fadeIn = interpolate(localFrame, [0, APPEAR], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const slideY = interpolate(localFrame, [0, APPEAR], [30, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          // Position finale dans le container (avant scroll)
          const naturalY = i * STEP_Y;
          const finalY = naturalY - scrollOffset + slideY;

          // Fade-out quand l'alerte scroll au-dessus du top (finalY < 0)
          const fadeOut = finalY < -ALERT_MAX_HEIGHT
            ? 0
            : finalY < 0
              ? Math.max(0, 1 + finalY / ALERT_MAX_HEIGHT)
              : 1;

          const opacity = fadeIn * fadeOut;
          if (opacity <= 0) return null;

          return (
            <div key={i} style={{
              position: 'absolute',
              top: finalY,
              left: '5%',
              width: '90%',
              opacity,
            }}>
              <Img
                src={alert.imagePath.startsWith('data:') ? alert.imagePath : staticFile(alert.imagePath)}
                style={{
                  width: '100%',
                  maxHeight: ALERT_MAX_HEIGHT,
                  objectFit: 'contain',
                  borderRadius: 12,
                  boxShadow: '0 6px 24px rgba(0,0,0,0.5), 0 0 16px rgba(251,191,36,0.08)',
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Gradient overlay au top pour fade visuel des alertes qui scroll out */}
      <div style={{
        position: 'absolute',
        top: HEADER_BOTTOM - 10,
        left: 0, right: 0,
        height: 40,
        background: `linear-gradient(180deg, ${bgColor} 0%, transparent 100%)`,
        pointerEvents: 'none',
        zIndex: 5,
      }} />
    </AbsoluteFill>
  );
};

// ─── Phase 4 : Stats panel (count-up boxes) ─────────────────────────
const StatsPhase: React.FC<{
  summary: Summary;
  accentColor: string;
  successColor: string;
  errorColor: string;
  bgColor: string;
}> = ({ summary, accentColor, successColor, errorColor, bgColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Count-up : 0 → final sur les 60 premières frames (2s)
  const COUNT_FRAMES = 60;
  const t = Math.min(frame / COUNT_FRAMES, 1);
  const eased = 1 - Math.pow(1 - t, 3);  // easeOutCubic

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily, padding: '40px 30px', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ opacity: titleOpacity, textAlign: 'center', marginBottom: 60 }}>
        <div style={{ fontSize: 56, fontWeight: 900, color: accentColor, letterSpacing: 1, textShadow: '0 2px 16px rgba(251,191,36,0.5)' }}>
          THE NUMBERS
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        <StatBox
          label="TOTAL CALLS"
          value={Math.round(summary.totalCalls * eased).toString()}
          subValue={null}
          accent={accentColor}
          delay={0}
        />
        <StatBox
          label="T3 HITS"
          value={Math.round(summary.callsWithT3Hit * eased).toString()}
          subValue={`(${(summary.callsWithT3HitPct * eased).toFixed(2)}%)`}
          accent={accentColor}
          delay={5}
        />
        <StatBox
          label="COMBINED"
          value={`+${(summary.combinedFinalPct * eased).toFixed(0)}%`}
          subValue={null}
          accent={successColor}
          delay={10}
        />
        <StatBox
          label="AVERAGE"
          value={`+${(summary.averageFinalPct * eased).toFixed(2)}%`}
          subValue={null}
          accent={successColor}
          delay={15}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        <StatBox
          label="HIGHEST"
          value={`+${(summary.highestFinalPct * eased).toFixed(2)}%`}
          subValue={summary.highestTicker}
          accent={successColor}
          delay={20}
        />
        <StatBox
          label="LOWEST"
          value={`${(summary.lowestFinalPct * eased).toFixed(2)}%`}
          subValue={summary.lowestTicker}
          accent={summary.lowestFinalPct < 0 ? errorColor : successColor}
          delay={25}
        />
      </div>

      {/* Hero box success rate, plein largeur */}
      <StatBoxHero
        label="SUCCESS RATE"
        value={`${(summary.successRate * eased).toFixed(2)}%`}
        subValue={`${summary.greenCount}/${summary.totalCalls}`}
        accent={successColor}
        delay={30}
      />
    </AbsoluteFill>
  );
};

const StatBox: React.FC<{
  label: string;
  value: string;
  subValue: string | null;
  accent: string;
  delay: number;
}> = ({ label, value, subValue, accent, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const popScale = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 12, stiffness: 120 }, durationInFrames: 20 });
  const opacity = interpolate(frame, [delay, delay + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{
      transform: `scale(${popScale})`,
      opacity,
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: `2px solid ${accent}44`,
      borderRadius: 16,
      padding: '20px 18px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#94a3b8', letterSpacing: 1, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 56, fontWeight: 900, color: accent, lineHeight: 1, textShadow: `0 2px 12px ${accent}66` }}>
        {value}
      </div>
      {subValue && (
        <div style={{ fontSize: 22, fontWeight: 700, color: accent, marginTop: 6, opacity: 0.8 }}>
          {subValue}
        </div>
      )}
    </div>
  );
};

const StatBoxHero: React.FC<{
  label: string;
  value: string;
  subValue: string;
  accent: string;
  delay: number;
}> = ({ label, value, subValue, accent, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const popScale = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 10, stiffness: 100 }, durationInFrames: 25 });
  const opacity = interpolate(frame, [delay, delay + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{
      transform: `scale(${popScale})`,
      opacity,
      background: `linear-gradient(135deg, rgba(16,185,129,0.15) 0%, rgba(251,191,36,0.08) 100%)`,
      border: `3px solid ${accent}`,
      borderRadius: 20,
      padding: '30px 24px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: '#fff', letterSpacing: 2, marginBottom: 10 }}>
        {label}
      </div>
      <div style={{ fontSize: 96, fontWeight: 900, color: accent, lineHeight: 1, textShadow: `0 4px 24px ${accent}77` }}>
        {value}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: accent, marginTop: 8 }}>
        {subValue}
      </div>
    </div>
  );
};

// ─── Phase 5 : Long-term investment highlight (1+ cartes) ───────────
type LongTerm = { ticker: string; entryPrice: number; currentPrice: number };

const LongTermCard: React.FC<{
  lt: LongTerm;
  accentColor: string;
  successColor: string;
  errorColor: string;
  compact: boolean;
  delay: number;
}> = ({ lt, accentColor, successColor, errorColor, compact, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const popScale = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 12, stiffness: 100 }, durationInFrames: 30 });
  const opacity = interpolate(frame, [delay, delay + 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const returnPct = ((lt.currentPrice - lt.entryPrice) / lt.entryPrice) * 100;
  const valueColor = returnPct >= 0 ? successColor : errorColor;

  // Pulse doré sur le % uniquement quand 1 seule carte (sinon trop chargé)
  const pulse = compact ? 1 : 1 + 0.05 * Math.sin(frame * 0.15);

  // Tailles ajustées : compact (≥2 cartes) vs hero (1 carte)
  const tickerFs = compact ? 56 : 80;
  const priceFs = compact ? 26 : 36;
  const pctFs = compact ? 72 : 110;
  const labelFs = compact ? 22 : 32;
  const cardPad = compact ? '28px 36px' : '50px 40px';
  const gapPrices = compact ? 28 : 40;

  return (
    <div style={{
      transform: `scale(${popScale})`,
      opacity,
      textAlign: 'center',
      background: `linear-gradient(135deg, rgba(251,191,36,0.18) 0%, rgba(245,158,11,0.10) 100%)`,
      border: `4px solid ${accentColor}`,
      borderRadius: 24,
      padding: cardPad,
      boxShadow: `0 8px 64px ${accentColor}55`,
      width: '92%',
    }}>
      <div style={{ fontSize: labelFs, fontWeight: 800, color: accentColor, letterSpacing: 3, marginBottom: 6 }}>
        ◆ LONG TERM INVESTMENT ◆
      </div>
      {!compact && (
        <div style={{ fontSize: 24, fontWeight: 600, color: '#94a3b8', marginBottom: 30 }}>
          (NOT INCLUDED IN STATS)
        </div>
      )}

      <div style={{ fontSize: tickerFs, fontWeight: 900, color: '#fff', marginBottom: compact ? 8 : 16, lineHeight: 1 }}>
        {lt.ticker}
      </div>

      <div style={{ display: 'flex', gap: gapPrices, justifyContent: 'center', marginBottom: compact ? 16 : 40 }}>
        <div>
          <div style={{ fontSize: compact ? 16 : 18, color: '#94a3b8', marginBottom: 2 }}>ENTRY</div>
          <div style={{ fontSize: priceFs, fontWeight: 800, color: '#fff' }}>{fmtPrice(lt.entryPrice)}</div>
        </div>
        <div>
          <div style={{ fontSize: compact ? 16 : 18, color: '#94a3b8', marginBottom: 2 }}>CURRENT</div>
          <div style={{ fontSize: priceFs, fontWeight: 800, color: '#fff' }}>{fmtPrice(lt.currentPrice)}</div>
        </div>
      </div>

      <div style={{
        fontSize: pctFs,
        fontWeight: 900,
        color: valueColor,
        transform: `scale(${pulse})`,
        textShadow: `0 4px 32px ${valueColor}88`,
        letterSpacing: -2,
        lineHeight: 1,
      }}>
        {fmtPct(returnPct)}
      </div>
    </div>
  );
};

const LongTermPhase: React.FC<{
  longTerms: LongTerm[];
  accentColor: string;
  successColor: string;
  errorColor: string;
  bgColor: string;
}> = ({ longTerms, accentColor, successColor, errorColor, bgColor }) => {
  if (!longTerms || longTerms.length === 0) {
    return <AbsoluteFill style={{ backgroundColor: bgColor }} />;
  }

  const compact = longTerms.length > 1;

  return (
    <AbsoluteFill style={{
      backgroundColor: bgColor,
      fontFamily,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: 24,
      padding: 24,
    }}>
      {longTerms.map((lt, i) => (
        <LongTermCard
          key={i}
          lt={lt}
          accentColor={accentColor}
          successColor={successColor}
          errorColor={errorColor}
          compact={compact}
          delay={i * 8}
        />
      ))}
    </AbsoluteFill>
  );
};

// ─── Composition principale ─────────────────────────────────────────
export const TobTradeRecap: React.FC<TobTradeRecapProps> = (props) => {
  const {
    dateLabel, trades, longTermInvestments, alertImages,
    secondsPerAlert,
    accentColor, successColor, errorColor, bgColor, outroSeed,
    narrationDataUrl, narrationText,
    logoUrl, logoCorner,
  } = props;
  // Pré-calcul de toutes les trades + summary une seule fois (mémoize ?)
  const computed = trades.map(computeTrade);
  const summary = computeSummary(computed);
  const alertsFrames = computeAlertsFrames(props);

  let cursor = 0;
  const introFrom = cursor; cursor += FRAMES_INTRO;
  const tableFrom = cursor; cursor += FRAMES_TABLE;
  const alertsFrom = cursor; cursor += alertsFrames;
  const statsFrom = cursor; cursor += FRAMES_STATS;
  const longTermFrom = cursor; cursor += FRAMES_LONGTERM;
  const outroFrom = cursor;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily }}>
      {/* Voice-over narration TTS (commence à l'intro, joue par-dessus tout).
          Volume plein (1.0) — la BG music devra être dim à ~0.3 dans les
          templates pour ne pas masquer la voix. Si pas de narrationDataUrl,
          l'<Audio> est skip. */}
      {narrationDataUrl && (
        <Audio src={narrationDataUrl} volume={1} />
      )}
      {/* Subtitles burned-in pour autoplay muet (TikTok/Reels). Affiché
          uniquement si narrationText fourni — il correspond au texte
          lu par la voix off. */}
      {narrationText && (
        <NarrationSubtitles
          text={narrationText}
          totalFrames={computeTradeRecapTotalFrames(props)}
        />
      )}
      {/* Logo watermark — visible toute la durée si logoUrl fourni. */}
      <LogoOverlay logoUrl={logoUrl} corner={logoCorner} />

      <Sequence from={introFrom} durationInFrames={FRAMES_INTRO}>
        <IntroPhase accentColor={accentColor} dateLabel={dateLabel} />
      </Sequence>

      <Sequence from={tableFrom} durationInFrames={FRAMES_TABLE}>
        <TablePhase
          trades={computed}
          accentColor={accentColor}
          successColor={successColor}
          errorColor={errorColor}
          bgColor={bgColor}
        />
      </Sequence>

      <Sequence from={alertsFrom} durationInFrames={alertsFrames}>
        <AlertsParadePhase
          alertImages={alertImages}
          accentColor={accentColor}
          bgColor={bgColor}
          secondsPerAlert={secondsPerAlert}
        />
      </Sequence>

      <Sequence from={statsFrom} durationInFrames={FRAMES_STATS}>
        <StatsPhase
          summary={summary}
          accentColor={accentColor}
          successColor={successColor}
          errorColor={errorColor}
          bgColor={bgColor}
        />
      </Sequence>

      <Sequence from={longTermFrom} durationInFrames={FRAMES_LONGTERM}>
        <LongTermPhase
          longTerms={longTermInvestments}
          accentColor={accentColor}
          successColor={successColor}
          errorColor={errorColor}
          bgColor={bgColor}
        />
      </Sequence>

      <Sequence from={outroFrom} durationInFrames={FRAMES_OUTRO}>
        <SharedOutro seed={outroSeed} />
      </Sequence>
    </AbsoluteFill>
  );
};
