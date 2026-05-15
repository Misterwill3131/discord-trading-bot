// ─────────────────────────────────────────────────────────────────────
// Sting — Court clip vidéo prepended/appended à la composition
// ─────────────────────────────────────────────────────────────────────
// Affiche un clip vidéo court (~1-3s) typique d'intro de marque ou de
// outro de logo. La composition parent décide où le placer dans sa
// timeline (<Sequence from={0} duration={STING_FRAMES}><Sting .../></Sequence>).
//
// Le clip doit être hosté sur une URL publique ou être un data URL.
// Le composant utilise <Video> de Remotion qui supporte les 2.
//
// Si stingUrl null, renvoie null — pas de DOM, le slot peut être ignoré.
// ─────────────────────────────────────────────────────────────────────

import React from 'react';
import { AbsoluteFill, Video } from 'remotion';

type Props = {
  stingUrl: string | null | undefined;
  // Volume audio du sting (default 0.7 — fort mais pas saturé).
  volume?: number;
  // Background pendant le clip (au cas où le clip a des bords transparents).
  backgroundColor?: string;
};

export const Sting: React.FC<Props> = ({
  stingUrl,
  volume = 0.7,
  backgroundColor = '#000000',
}) => {
  if (!stingUrl || typeof stingUrl !== 'string') return null;
  return (
    <AbsoluteFill style={{ backgroundColor }}>
      <Video
        src={stingUrl}
        volume={volume}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
      />
    </AbsoluteFill>
  );
};
