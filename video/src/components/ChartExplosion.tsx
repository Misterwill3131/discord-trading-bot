import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

// Chart synthétique "rocket up" : courbe SVG qui se dessine de gauche
// à droite sur 30 frames, puis l'aire sous la courbe s'allume.
// Pas de vraies données — purement décoratif pour Phase 2.5.
export const ChartExplosion = () => {
  const frame = useCurrentFrame();

  // Path : commence plat à gauche (y=260), monte exponentiellement vers la droite (y=10).
  // Coordonnées sur SVG 600×300.
  const PATH = 'M 0,260 L 60,255 L 120,245 L 180,225 L 240,195 L 300,155 L 360,110 L 420,65 L 480,30 L 540,10';
  const PATH_LENGTH = 700; // longueur approximative pour le stroke-dasharray

  // Draw line: stroke-dashoffset va de PATH_LENGTH (caché) à 0 (visible) sur 30 frames.
  const drawProgress = interpolate(
    frame,
    [0, 30],
    [PATH_LENGTH, 0],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Area fill: opacity 0→0.4 entre frames 25 et 40
  const fillOpacity = interpolate(
    frame,
    [25, 40],
    [0, 0.4],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Glow pulse après que la ligne soit dessinée (frames 30+)
  const pulseScale = 1 + Math.sin(frame * 0.1) * 0.03;

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg
        viewBox="0 0 600 300"
        style={{
          width: 600,
          height: 300,
          transform: `scale(${pulseScale})`,
          filter: 'drop-shadow(0 0 12px rgba(16,185,129,0.8))',
        }}
      >
        <defs>
          <linearGradient id="chartGradGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Fill area (sous la courbe) */}
        <path
          d={`${PATH} L 540,300 L 0,300 Z`}
          fill="url(#chartGradGreen)"
          opacity={fillOpacity}
        />
        {/* Line (la courbe elle-même) */}
        <path
          d={PATH}
          fill="none"
          stroke="#10b981"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={PATH_LENGTH}
          strokeDashoffset={drawProgress}
        />
      </svg>
    </AbsoluteFill>
  );
};
