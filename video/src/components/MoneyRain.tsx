import { AbsoluteFill, useCurrentFrame, interpolate, useVideoConfig } from 'remotion';

type Props = {
  count?: number;       // Default 40 particles
  seed?: string;        // Pour déterminisme (mêmes particules à chaque render)
};

// PRNG simple basé sur hash de string (déterministe).
function pseudoRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash = hash & hash;
  }
  const x = Math.sin(hash) * 10000;
  return x - Math.floor(x);
}

// Génère un nombre dans [min, max] depuis un seed.
function randRange(seed: string, min: number, max: number): number {
  return min + pseudoRandom(seed) * (max - min);
}

// Emojis utilisés en alternance.
const EMOJIS = ['💵', '💰', '💸', '🤑'];

type Particle = {
  emoji: string;
  startX: number;       // x de départ (px)
  driftX: number;       // déplacement horizontal pendant la chute (px)
  size: number;         // px
  spawnDelay: number;   // frames avant apparition
  fallDuration: number; // frames pour traverser l'écran
  rotateStart: number;  // deg
  rotateRate: number;   // deg/frame
};

function generateParticle(index: number, seed: string, width: number): Particle {
  const s = `${seed}-${index}`;
  const emojiIdx = Math.floor(pseudoRandom(`${s}-emoji`) * EMOJIS.length);
  return {
    emoji: EMOJIS[emojiIdx],
    startX: randRange(`${s}-x`, -50, width + 50),
    driftX: randRange(`${s}-drift`, -60, 60),
    size: randRange(`${s}-size`, 40, 90),
    spawnDelay: randRange(`${s}-delay`, 0, 30),
    fallDuration: randRange(`${s}-fall`, 70, 110),
    rotateStart: randRange(`${s}-rot0`, 0, 360),
    rotateRate: randRange(`${s}-rotrate`, -3, 3),
  };
}

export const MoneyRain = ({ count = 40, seed = 'rain' }: Props) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Génère toutes les particules une fois (paramètres fixés par seed).
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    particles.push(generateParticle(i, seed, width));
  }

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', overflow: 'hidden' }}>
      {particles.map((p, i) => {
        const t = frame - p.spawnDelay;
        if (t < 0) return null;

        const progress = Math.min(1, t / p.fallDuration);
        const y = interpolate(progress, [0, 1], [-100, height + 100]);
        const x = p.startX + p.driftX * progress;
        const rotate = p.rotateStart + p.rotateRate * t;
        const opacity = interpolate(
          progress,
          [0, 0.05, 0.95, 1],
          [0, 1, 1, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              fontSize: p.size,
              transform: `rotate(${rotate}deg)`,
              opacity,
              filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.5))',
            }}
          >
            {p.emoji}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
