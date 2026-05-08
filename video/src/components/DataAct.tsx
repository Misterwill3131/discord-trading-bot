import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

type Props = {
  // Props legacy (auteur/message/timestamp) — ignorés visuellement, l'image
  // est servie en static via canvas/proof.js generateImage. Pour modifier
  // le contenu, édite SIGNAL_ALERT_DEFAULT dans
  // video/scripts/generate-brand-promo-cards.js puis npm run regen:brand-promo-cards.
  author?: string;
  message?: string;
  timestamp?: string;
};

// Phase 2 du SignalAlert. Affiche la carte Discord canvas-rendered
// (signal-alert/card-default.png) — mêmes avatars/BOOM tags/role pills
// que le bot poste réellement, vs un faux rendu React divs.
export const DataAct = (_props: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Spring entrée + slide-up sur 30 frames
  const entry = spring({ frame, fps, config: { damping: 14 }, durationInFrames: 30 });
  const translateY = interpolate(entry, [0, 1], [80, 0]);
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 30,
      }}
    >
      <Img
        src={staticFile('signal-alert/card-default.png')}
        style={{
          width: '100%',
          height: 'auto',
          opacity,
          transform: `translateY(${translateY}px)`,
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}
      />
    </AbsoluteFill>
  );
};
