// ─────────────────────────────────────────────────────────────────────
// NarrationSubtitles — Burned-in captions for muted autoplay
// ─────────────────────────────────────────────────────────────────────
// Split la narration en chunks de ~6 mots et les affiche timés sur la
// durée totale de la vidéo. Style readability-first : grand texte blanc
// avec outline noir pour rester lisible peu importe le fond.
//
// Activé conditionnellement par les compositions parentes : si le user
// a opt-in au TTS narration (donc on a un texte de narration), on
// affiche aussi les subtitles à l'écran. Sinon NarrationSubtitles
// renvoie null.
// ─────────────────────────────────────────────────────────────────────

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

const WORDS_PER_CHUNK = 6;

function splitIntoChunks(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  // Découpe par ponctuation forte (phrases) puis re-split les phrases longues
  // en chunks de ~WORDS_PER_CHUNK mots pour lisibilité.
  const sentences = text.split(/([.!?]+\s+)/).reduce<string[]>((acc, seg, i, arr) => {
    if (i % 2 === 0) {
      const punct = arr[i + 1] || '';
      const full = (seg + punct).trim();
      if (full) acc.push(full);
    }
    return acc;
  }, []);

  const chunks: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    if (words.length <= WORDS_PER_CHUNK + 2) {
      chunks.push(sentence);
    } else {
      // Split par tranches de WORDS_PER_CHUNK
      for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
        chunks.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
      }
    }
  }
  return chunks.filter(c => c.length > 0);
}

type Props = {
  text: string | null | undefined;
  // Total frames de la vidéo (chaque chunk = totalFrames / chunks.length).
  totalFrames: number;
  // Position vertical en % depuis le bas (default 18 = vers le bas mais
  // pas collé au bord).
  bottomPercent?: number;
  // Couleur du texte (default blanc).
  color?: string;
  // Font size (default 48 — large pour mobile autoplay).
  fontSize?: number;
};

export const NarrationSubtitles: React.FC<Props> = ({
  text,
  totalFrames,
  bottomPercent = 18,
  color = '#ffffff',
  fontSize = 48,
}) => {
  const frame = useCurrentFrame();
  const { width: canvasWidth } = useVideoConfig();
  const chunks = splitIntoChunks(text || '');
  if (chunks.length === 0 || totalFrames <= 0) return null;

  const framesPerChunk = Math.max(1, Math.floor(totalFrames / chunks.length));
  const currentIdx = Math.min(chunks.length - 1, Math.floor(frame / framesPerChunk));
  const chunkStart = currentIdx * framesPerChunk;
  const localFrame = frame - chunkStart;
  // Fade in 6 frames, fade out 6 frames avant le next chunk.
  const fadeInOpacity = interpolate(localFrame, [0, 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fadeOutOpacity = interpolate(localFrame, [framesPerChunk - 8, framesPerChunk], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeInOpacity, fadeOutOpacity);

  // Scale font selon canvas width (responsive 9:16 / 1:1 / 16:9). 1080 = base.
  const scaledFontSize = Math.round(fontSize * (canvasWidth / 1080));

  return (
    <AbsoluteFill style={{
      pointerEvents: 'none',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingBottom: `${bottomPercent}%`,
    }}>
      <div style={{
        opacity,
        maxWidth: '92%',
        textAlign: 'center',
        fontSize: scaledFontSize,
        fontWeight: 900,
        color,
        lineHeight: 1.1,
        letterSpacing: 0.5,
        // Multi-shadow pour outline noir épais — lisible sur tout fond.
        textShadow: [
          '0 0 8px rgba(0,0,0,0.95)',
          '2px 2px 0 #000',
          '-2px -2px 0 #000',
          '2px -2px 0 #000',
          '-2px 2px 0 #000',
          '0 4px 16px rgba(0,0,0,0.8)',
        ].join(', '),
        textTransform: 'uppercase',
      }}>
        {chunks[currentIdx]}
      </div>
    </AbsoluteFill>
  );
};
