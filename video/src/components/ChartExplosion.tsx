import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from 'remotion';

// Chart synthétique "rocket up" en bougies japonaises (candlesticks).
// 12 candles s'animent left-to-right (chaque 3 frames), pattern réaliste :
// petite consolidation → breakout → rally → final push.
// Coordonnées en SVG 600×300.

type Candle = {
  open: number;
  close: number;
  high: number;
  low: number;
};

// PRNG simple seedé pour générer des candles déterministes mais naturelles.
function makeRng(seedStr: string) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = ((h << 5) - h) + seedStr.charCodeAt(i);
    h |= 0;
  }
  let state = Math.abs(h) || 1;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

// Génère N candles d'une trade qui va de startPrice à endPrice avec des
// caractéristiques réalistes : drift up (avec noise), wicks asymétriques,
// quelques pullbacks rouges, doji-like en consolidation, gros candles
// d'impulse sur les phases de breakout.
function generateCandles(
  seed: string,
  count: number,
  startPrice: number,
  endPrice: number
): Candle[] {
  const rng = makeRng(seed);
  const candles: Candle[] = [];
  let lastClose = startPrice;
  const totalMove = endPrice - startPrice;
  const avgStep = totalMove / count;
  // Volatility (en absolu) — sert à dimensionner les wicks et le noise.
  const vol = Math.abs(totalMove) * 0.18;

  for (let i = 0; i < count; i++) {
    // Petit gap entre la close précédente et l'open courant (réaliste).
    const gap = (rng() - 0.5) * vol * 0.3;
    const open = lastClose + gap;

    // Phase visuelle : début (consolidation), milieu (breakout), fin (rally).
    const progress = i / (count - 1);
    const phase = progress < 0.25 ? 'consolidation'
                : progress < 0.6  ? 'breakout'
                : progress < 0.85 ? 'rally'
                : 'final';

    // Drift cible vers endPrice — accentué en breakout/rally, neutre en consolidation.
    let driftMult = 1.0;
    if (phase === 'consolidation') driftMult = 0.3 + rng() * 0.6;
    if (phase === 'breakout')      driftMult = 0.9 + rng() * 1.2;
    if (phase === 'rally')         driftMult = 1.1 + rng() * 1.0;
    if (phase === 'final')         driftMult = 1.4 + rng() * 1.5;

    const drift = avgStep * driftMult;
    // Noise local — peut faire devenir une candle rouge même en uptrend.
    const noise = (rng() - 0.5) * vol * 1.2;
    const close = open + drift + noise;

    // Wicks asymétriques : longueur 0.3-1.5x du body. Sometimes 0 (bald candle).
    const bodyAbs = Math.abs(close - open);
    const upperWickLen = rng() < 0.15 ? 0 : (0.2 + rng() * 1.4) * Math.max(bodyAbs, vol * 0.3);
    const lowerWickLen = rng() < 0.15 ? 0 : (0.2 + rng() * 1.4) * Math.max(bodyAbs, vol * 0.3);
    const high = Math.max(open, close) + upperWickLen;
    const low  = Math.min(open, close) - lowerWickLen;

    candles.push({ open, close, high, low });
    lastClose = close;
  }

  // Force la dernière candle à être un GREEN impulse qui clôt à endPrice
  // (le "money shot" — le trade se termine au target avec une bougie marquée).
  const last = candles[candles.length - 1];
  // Body size : ~1.5x la moyenne pour effet d'impulse final.
  const finalBodySize = Math.abs(avgStep) * 1.8;
  last.close = endPrice;
  last.open = endPrice - finalBodySize;
  // Wicks réduits pour un look "bald candle" qui inspire confiance.
  last.high = endPrice + Math.abs(avgStep) * 0.3;
  last.low  = last.open - Math.abs(avgStep) * 0.4;

  return candles;
}

// 15 candles d'une trade +12% (0.180 → 0.202) avec seed fixe.
// Pour rendre déterministe : seed fixe, mais on peut le varier par job
// via un prop seed plus tard si besoin.
const CANDLES: Candle[] = generateCandles('boom-trade-default', 15, 0.180, 0.202);

// Layout SVG.
const VW = 600;
const VH = 300;
const PADDING_LEFT = 50; // espace pour les labels prix
const PADDING_RIGHT = 10;
const PADDING_TOP = 20;
const PADDING_BOTTOM = 30;
const PLOT_W = VW - PADDING_LEFT - PADDING_RIGHT;
const PLOT_H = VH - PADDING_TOP - PADDING_BOTTOM;

// Min/max prices calculés depuis les candles (avec marge 5% au-dessus/dessous
// pour respirer). Adaptatif si on régénère les candles.
const RAW_MIN = Math.min(...CANDLES.map(c => c.low));
const RAW_MAX = Math.max(...CANDLES.map(c => c.high));
const PRICE_PADDING = (RAW_MAX - RAW_MIN) * 0.08;
const PRICE_MIN = RAW_MIN - PRICE_PADDING;
const PRICE_MAX = RAW_MAX + PRICE_PADDING;
const PRICE_RANGE = PRICE_MAX - PRICE_MIN;

// Convertit un prix en y SVG (inversé : prix haut = y bas).
function priceToY(price: number): number {
  const norm = (price - PRICE_MIN) / PRICE_RANGE;
  return PADDING_TOP + (1 - norm) * PLOT_H;
}

// Largeur d'une bougie + son x center.
const CANDLE_GAP = 4;
const CANDLE_W = (PLOT_W - CANDLE_GAP * (CANDLES.length - 1)) / CANDLES.length;
function candleX(index: number): number {
  return PADDING_LEFT + index * (CANDLE_W + CANDLE_GAP);
}

// Une bougie individuelle avec animation scale-in.
const CandleShape = ({
  candle,
  index,
  frame,
}: {
  candle: Candle;
  index: number;
  frame: number;
}) => {
  // Apparition : 3 frames de délai par candle, fade-in + scale-up sur 4 frames.
  const startFrame = index * 3;
  const opacity = interpolate(
    frame,
    [startFrame, startFrame + 3],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const scaleY = interpolate(
    frame,
    [startFrame, startFrame + 4],
    [0.2, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.back(1.5)),
    }
  );

  const isGreen = candle.close >= candle.open;
  const color = isGreen ? '#10b981' : '#ef4444';

  const x = candleX(index);
  const cx = x + CANDLE_W / 2;
  const yHigh = priceToY(candle.high);
  const yLow = priceToY(candle.low);
  const yOpen = priceToY(candle.open);
  const yClose = priceToY(candle.close);
  const bodyTop = Math.min(yOpen, yClose);
  const bodyH = Math.max(2, Math.abs(yClose - yOpen)); // min 2px pour visibilité doji

  // Pulse sur la dernière candle après qu'elle soit dessinée.
  const isLast = index === CANDLES.length - 1;
  const pulseGlow = isLast
    ? interpolate(
        frame,
        [startFrame + 4, startFrame + 14, 90],
        [0, 1, 0.5],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      )
    : 0;

  return (
    <g
      opacity={opacity}
      style={{
        transformOrigin: `${cx}px ${(yHigh + yLow) / 2}px`,
        transform: `scaleY(${scaleY})`,
      }}
    >
      {/* Wick (mèche) : ligne verticale de high à low */}
      <line
        x1={cx}
        y1={yHigh}
        x2={cx}
        y2={yLow}
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      {/* Body : rectangle de open à close */}
      <rect
        x={x}
        y={bodyTop}
        width={CANDLE_W}
        height={bodyH}
        fill={color}
        stroke={color}
        strokeWidth={1}
        rx={1}
      />
      {/* Glow halo sur la dernière */}
      {isLast && pulseGlow > 0 && (
        <rect
          x={x - 4}
          y={bodyTop - 4}
          width={CANDLE_W + 8}
          height={bodyH + 8}
          fill="none"
          stroke={color}
          strokeWidth={2}
          opacity={pulseGlow}
          rx={3}
        />
      )}
    </g>
  );
};

// Labels de prix sur l'axe Y (3 niveaux).
const PriceLabels = ({ opacity }: { opacity: number }) => {
  const levels = [PRICE_MAX, (PRICE_MIN + PRICE_MAX) / 2, PRICE_MIN];
  return (
    <g opacity={opacity}>
      {levels.map((p, i) => (
        <g key={i}>
          <text
            x={PADDING_LEFT - 8}
            y={priceToY(p) + 4}
            textAnchor="end"
            fill="rgba(255,255,255,0.45)"
            fontSize={11}
            fontFamily="monospace"
          >
            {p.toFixed(3)}
          </text>
          <line
            x1={PADDING_LEFT}
            y1={priceToY(p)}
            x2={VW - PADDING_RIGHT}
            y2={priceToY(p)}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={0.5}
            strokeDasharray="3,3"
          />
        </g>
      ))}
    </g>
  );
};

export const ChartExplosion = () => {
  const frame = useCurrentFrame();

  // Pulse global après que toutes les candles soient dessinées (frame 36+).
  const allDoneFrame = (CANDLES.length - 1) * 3 + 4;
  const globalPulse =
    frame > allDoneFrame ? 1 + Math.sin(frame * 0.1) * 0.02 : 1;

  // Labels apparaissent au début (0-15 frames).
  const labelOpacity = interpolate(
    frame,
    [0, 15],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        style={{
          width: VW,
          height: VH,
          transform: `scale(${globalPulse})`,
          filter: 'drop-shadow(0 0 16px rgba(16,185,129,0.5))',
        }}
      >
        <PriceLabels opacity={labelOpacity} />
        {CANDLES.map((c, i) => (
          <CandleShape key={i} candle={c} index={i} frame={frame} />
        ))}
      </svg>
    </AbsoluteFill>
  );
};
