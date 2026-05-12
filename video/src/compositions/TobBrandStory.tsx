import { AbsoluteFill, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { zColor } from '@remotion/zod-types';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { SharedOutro } from '../components/SharedOutro';

const { fontFamily } = loadInter('normal', { weights: ['700', '900'] });

// ─────────────────────────────────────────────────────────────────────
// TobBrandStory — Pitch marketing storytelling
// ─────────────────────────────────────────────────────────────────────
// Composition pour la nouvelle template "Brand Story" : 6 scènes Imagen 4
// (générées par scripts/generate-brand-story.js) avec Ken Burns zoom,
// captions kinetic typing-style, et outro lion partagé.
//
// Workflow d'utilisation :
//   1. npm run generate:brand-story (génère les 6 PNG + lance Remotion render)
//   2. MP4 final dans video/out/tob-brand-story-{timestamp}.mp4
//   3. User post manuellement sur socials
//
// Durée totale = (6 × sceneDurationFrames) + outro (90f) + transition
// fades. Avec default 150f/scène = 6×150 + 90 = 990 frames = 33s @ 30fps.
// ─────────────────────────────────────────────────────────────────────

const sceneSchema = z.object({
  imagePath: z.string().describe('Path Remotion staticFile (ex: "brand-story/scene1.png")'),
  caption: z.string().describe('Texte narratif overlay (1 ligne courte)'),
});

export const tobBrandStorySchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(10),
  sceneDurationFrames: z.number().min(60).max(300).default(150),
  accentColor: zColor().default('#fbbf24'),
  captionStyle: z.enum(['bold', 'subtle']).default('bold'),
  outroSeed: z.string().default('brand-story'),
});

export type TobBrandStoryProps = z.infer<typeof tobBrandStorySchema>;

const OUTRO_FRAMES = 90;

export function computeBrandStoryTotalFrames(props: TobBrandStoryProps): number {
  return props.scenes.length * props.sceneDurationFrames + OUTRO_FRAMES;
}

// ── Caption : fade-in word reveal sur les ~25 premières frames ──
const CaptionOverlay: React.FC<{ text: string; accentColor: string; style: 'bold' | 'subtle' }> = ({
  text, accentColor, style,
}) => {
  const frame = useCurrentFrame();

  // Word-by-word reveal : 1 mot toutes les 5 frames après 8f de delay
  const words = text.split(' ');
  const wordsRevealed = Math.max(0, Math.floor((frame - 8) / 5));
  const visible = words.slice(0, Math.min(wordsRevealed, words.length)).join(' ');

  // Subtle bounce sur le dernier mot révélé
  const bounceScale = interpolate(frame % 5, [0, 2, 5], [0.95, 1.05, 1.0], { extrapolateRight: 'clamp' });

  const fontSize = style === 'bold' ? 72 : 56;
  const fontWeight = style === 'bold' ? 900 : 700;

  return (
    <div style={{
      position: 'absolute',
      bottom: 200,
      left: 60,
      right: 60,
      textAlign: 'center',
      color: '#fff',
      fontSize,
      fontWeight,
      fontFamily,
      letterSpacing: -1,
      lineHeight: 1.15,
      textShadow: '0 6px 24px rgba(0,0,0,0.9), 0 2px 8px rgba(0,0,0,0.7)',
      transform: `scale(${bounceScale})`,
    }}>
      {visible}
      {wordsRevealed > 0 && wordsRevealed < words.length && (
        <span style={{ color: accentColor, opacity: 0.7 }}>|</span>
      )}
    </div>
  );
};

// ── Scene : image fullscreen + Ken Burns + caption ──
const SceneRender: React.FC<{
  imagePath: string;
  caption: string;
  accentColor: string;
  captionStyle: 'bold' | 'subtle';
}> = ({ imagePath, caption, accentColor, captionStyle }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Ken Burns zoom 1.0 → 1.08 sur toute la durée
  const scale = interpolate(frame, [0, durationInFrames], [1.0, 1.08], {
    extrapolateRight: 'clamp',
  });

  // Fade in/out aux bords pour transition douce entre scènes
  const opacity = interpolate(
    frame,
    [0, 12, durationInFrames - 12, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      <Img
        src={staticFile(imagePath)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale})`,
          opacity,
        }}
      />
      {/* Dark gradient overlay au bas pour readability de la caption */}
      <AbsoluteFill style={{
        background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.6) 85%, rgba(0,0,0,0.85) 100%)',
        opacity,
      }} />
      <CaptionOverlay text={caption} accentColor={accentColor} style={captionStyle} />
    </AbsoluteFill>
  );
};

// ── Main composition ──
export const TobBrandStory: React.FC<TobBrandStoryProps> = ({
  scenes, sceneDurationFrames, accentColor, captionStyle, outroSeed,
}) => {
  let cursor = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000', fontFamily }}>
      {scenes.map((scene, i) => {
        const startFrame = cursor;
        cursor += sceneDurationFrames;
        return (
          <Sequence
            key={i}
            from={startFrame}
            durationInFrames={sceneDurationFrames}
          >
            <SceneRender
              imagePath={scene.imagePath}
              caption={scene.caption}
              accentColor={accentColor}
              captionStyle={captionStyle}
            />
          </Sequence>
        );
      })}

      {/* Outro : SharedOutro lion brandé TOB (Ken Burns + fade) */}
      <Sequence from={cursor} durationInFrames={OUTRO_FRAMES}>
        <SharedOutro seed={outroSeed} />
      </Sequence>
    </AbsoluteFill>
  );
};
