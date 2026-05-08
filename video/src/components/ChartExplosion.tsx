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

// Pattern hardcodé : ~+11% sur 12 candles avec mini pullback.
const CANDLES: Candle[] = [
  { open: 0.181, close: 0.180, high: 0.182, low: 0.179 }, // small red
  { open: 0.180, close: 0.182, high: 0.183, low: 0.179 }, // small green
  { open: 0.182, close: 0.181, high: 0.183, low: 0.180 }, // small red (consolidation)
  { open: 0.181, close: 0.184, high: 0.185, low: 0.181 }, // green breakout
  { open: 0.184, close: 0.187, high: 0.188, low: 0.183 }, // medium green
  { open: 0.187, close: 0.190, high: 0.191, low: 0.187 }, // medium green
  { open: 0.190, close: 0.193, high: 0.194, low: 0.189 }, // medium green
  { open: 0.193, close: 0.195, high: 0.196, low: 0.193 }, // small green
  { open: 0.195, close: 0.197, high: 0.198, low: 0.194 }, // small green
  { open: 0.197, close: 0.200, high: 0.201, low: 0.197 }, // big green (impulse)
  { open: 0.200, close: 0.199, high: 0.201, low: 0.198 }, // tiny red (pullback)
  { open: 0.199, close: 0.202, high: 0.203, low: 0.199 }, // final push
];

// Layout SVG.
const VW = 600;
const VH = 300;
const PADDING_LEFT = 50; // espace pour les labels prix
const PADDING_RIGHT = 10;
const PADDING_TOP = 20;
const PADDING_BOTTOM = 30;
const PLOT_W = VW - PADDING_LEFT - PADDING_RIGHT;
const PLOT_H = VH - PADDING_TOP - PADDING_BOTTOM;

// Min/max prices pour normaliser. Légère marge au-dessus/dessous pour respirer.
const PRICE_MIN = 0.178;
const PRICE_MAX = 0.205;
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
