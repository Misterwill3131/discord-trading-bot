// ─────────────────────────────────────────────────────────────────────
// LogoOverlay — Watermark logo persistant dans un coin de la vidéo
// ─────────────────────────────────────────────────────────────────────
// Affiche un logo (URL ou data URL) dans un coin configurable avec
// opacity, taille et position. Reste à l'écran sur toute la durée de
// la vidéo (z-index implicite via ordre du JSX). Si logoUrl null,
// renvoie null — pas de DOM ajouté.
//
// Use case principal : marquer chaque vidéo posted-on-socials avec le
// logo TOB pour les viewers qui découvrent en passant.
// ─────────────────────────────────────────────────────────────────────

import React from 'react';
import { AbsoluteFill, Img } from 'remotion';

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

type Props = {
  logoUrl: string | null | undefined;
  // Position : default top-right (zone "safe" qui n'overlap pas avec le
  // texte principal sur la majorité des templates).
  corner?: Corner;
  // Marge depuis le coin en px. Default 32.
  margin?: number;
  // Largeur du logo en px. Default 120 (assez visible pour mobile,
  // pas envahissant). La hauteur est calculée auto pour préserver
  // l'aspect ratio de l'image.
  width?: number;
  // Opacity 0..1. Default 0.85 (subtil mais visible).
  opacity?: number;
};

function cornerStyle(corner: Corner, margin: number): React.CSSProperties {
  switch (corner) {
    case 'top-left':     return { top: margin, left: margin, alignItems: 'flex-start', justifyContent: 'flex-start' };
    case 'top-right':    return { top: margin, right: margin, alignItems: 'flex-start', justifyContent: 'flex-end' };
    case 'bottom-left':  return { bottom: margin, left: margin, alignItems: 'flex-end', justifyContent: 'flex-start' };
    case 'bottom-right':
    default:             return { bottom: margin, right: margin, alignItems: 'flex-end', justifyContent: 'flex-end' };
  }
}

export const LogoOverlay: React.FC<Props> = ({
  logoUrl,
  corner = 'top-right',
  margin = 32,
  width = 120,
  opacity = 0.85,
}) => {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  const positionStyle = cornerStyle(corner, margin);

  return (
    <AbsoluteFill style={{
      pointerEvents: 'none',
      display: 'flex',
      flexDirection: 'column',
      ...positionStyle,
    }}>
      <Img
        src={logoUrl}
        style={{
          width,
          height: 'auto',
          opacity,
          // Subtle shadow pour décoller le logo du fond
          filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.4))',
        }}
      />
    </AbsoluteFill>
  );
};
