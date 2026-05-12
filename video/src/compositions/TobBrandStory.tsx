import { AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
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
  caption: z.string().describe('Titre visible à l\'écran — court et percutant (ex: "The Downward Spiral")'),
  subCaption: z.string().nullable().optional().describe('2e ligne contextuelle plus petite (date, montant, URL). Optionnel.'),
  narration: z.string().nullable().optional().describe('Texte TTS-only (body paragraph plus long). Fallback sur caption+subCaption si absent.'),
  durationFrames: z.number().min(60).max(600).nullable().optional().describe('Override durée scène (défaut = global sceneDurationFrames). Permet de varier la longueur selon le narration.'),
  audioPath: z.string().nullable().optional().describe('Path TTS audio file (ex: "brand-story/scene1.mp3"). Null/undefined = silent.'),
});

export const tobBrandStorySchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(10),
  sceneDurationFrames: z.number().min(60).max(600).default(180),
  accentColor: zColor().default('#fbbf24'),
  captionStyle: z.enum(['bold', 'subtle']).default('bold'),
  outroSeed: z.string().default('brand-story'),
});

export type TobBrandStoryProps = z.infer<typeof tobBrandStorySchema>;

const OUTRO_FRAMES = 90;

export function computeBrandStoryTotalFrames(props: TobBrandStoryProps): number {
  // Per-scene durationFrames override le sceneDurationFrames global.
  // Permet aux scènes avec narration longue (ex: scène 1 = 28 mots) d'avoir
  // ~10s alors que les scènes courtes ont 6-7s.
  const scenesTotal = props.scenes.reduce(
    (sum, s) => sum + (s.durationFrames || props.sceneDurationFrames),
    0
  );
  return scenesTotal + OUTRO_FRAMES;
}

// ── Caption : pop-in word-by-word avec spring individuel ──
// Chaque mot apparaît un par un avec son propre spring bounce.
// Pas de typing cursor, pas de pulse global — chaque mot a sa propre
// micro-animation indépendante (scale 0 → ~1.1 → 1.0, opacity 0 → 1).
const START_DELAY_FRAMES = 8;       // delay avant le premier mot
const WORD_STAGGER_FRAMES = 5;      // gap entre 2 mots successifs
const SPRING_DURATION = 22;         // frames pour le spring complet

const WordPopIn: React.FC<{
  word: string;
  startFrame: number;
  fontSize: number;
  fontWeight: number;
}> = ({ word, startFrame, fontSize, fontWeight }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - startFrame;

  // Spring config : damping bas + stiffness mid → bounce visible mais pas
  // hystérique. Atteint ~1.1 max puis settle à 1.0 en ~22 frames.
  const popProgress = spring({
    frame: localFrame,
    fps,
    config: { damping: 9, stiffness: 140 },
    durationInFrames: SPRING_DURATION,
  });
  const scale = popProgress;

  // Fade-in rapide sur les 5 premières frames du mot
  const opacity = interpolate(localFrame, [0, 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <span
      style={{
        display: 'inline-block',
        transform: `scale(${scale})`,
        opacity,
        margin: '0 8px 0 0',
        fontSize,
        fontWeight,
        // transformOrigin: 'center' par défaut, garde l'alignement du baseline
      }}
    >
      {word}
    </span>
  );
};

const CaptionOverlay: React.FC<{
  text: string;
  subText?: string | null;
  accentColor: string;
  style: 'bold' | 'subtle';
}> = ({ text, subText, accentColor, style }) => {
  const frame = useCurrentFrame();
  const words = text.split(' ');
  const fontSize = style === 'bold' ? 72 : 56;
  const fontWeight = style === 'bold' ? 900 : 700;

  // SubCaption apparaît APRÈS le main caption (tous les words révélés).
  // Calcul du frame où ça commence = end of main caption animation.
  const subStartFrame = START_DELAY_FRAMES + words.length * WORD_STAGGER_FRAMES + 5;
  const subLocalFrame = frame - subStartFrame;
  const subOpacity = interpolate(subLocalFrame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // Slide-up subtle pour la subCaption
  const subTranslateY = interpolate(subLocalFrame, [0, 12], [20, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{
      position: 'absolute',
      bottom: subText ? 240 : 200,  // monte un peu plus haut si subCaption pour respirer
      left: 60,
      right: 60,
      textAlign: 'center',
      color: '#fff',
      fontFamily,
      letterSpacing: -1,
      lineHeight: 1.15,
      textShadow: '0 6px 24px rgba(0,0,0,0.9), 0 2px 8px rgba(0,0,0,0.7)',
    }}>
      <div>
        {words.map((word, i) => (
          <WordPopIn
            key={i}
            word={word}
            startFrame={START_DELAY_FRAMES + i * WORD_STAGGER_FRAMES}
            fontSize={fontSize}
            fontWeight={fontWeight}
          />
        ))}
      </div>
      {subText && (
        <div style={{
          marginTop: 20,
          fontSize: Math.round(fontSize * 0.55),  // ~40px si fontSize=72
          fontWeight: 600,
          color: accentColor,
          opacity: subOpacity,
          transform: `translateY(${subTranslateY}px)`,
          letterSpacing: 0,
          textShadow: '0 4px 16px rgba(0,0,0,0.85)',
        }}>
          {subText}
        </div>
      )}
    </div>
  );
};

// ── Scene : image fullscreen + Ken Burns + caption ──
const SceneRender: React.FC<{
  imagePath: string;
  caption: string;
  subCaption?: string | null;
  accentColor: string;
  captionStyle: 'bold' | 'subtle';
  audioPath?: string | null;
}> = ({ imagePath, caption, subCaption, accentColor, captionStyle, audioPath }) => {
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
      {/* Audio TTS de la caption — joue pendant la scène. Si audioPath null
          ou undefined (TTS a échoué pour cette scène), pas d'audio joué. */}
      {audioPath && (
        <Audio src={staticFile(audioPath)} volume={1.0} />
      )}
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
      <CaptionOverlay text={caption} subText={subCaption} accentColor={accentColor} style={captionStyle} />
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
        const sceneDur = scene.durationFrames || sceneDurationFrames;
        const startFrame = cursor;
        cursor += sceneDur;
        return (
          <Sequence
            key={i}
            from={startFrame}
            durationInFrames={sceneDur}
          >
            <SceneRender
              imagePath={scene.imagePath}
              caption={scene.caption}
              subCaption={scene.subCaption}
              accentColor={accentColor}
              captionStyle={captionStyle}
              audioPath={scene.audioPath}
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
