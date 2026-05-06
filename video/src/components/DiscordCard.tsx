import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { CUSTOM_AVATARS } from '../avatars';

type Props = {
  author: string;
  message: string;
  timestamp: string;            // ISO 8601
  scale?: number;               // Default 1
  position?: 'center' | 'top-left' | 'bottom-right';  // Default 'center'
};

// Format heure NY 24h, ex: "9:32am" → "09:32"
function formatTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}

// Initiales (2 premières lettres en majuscules) pour fallback avatar.
function initials(author: string): string {
  return (author || 'W').slice(0, 2).toUpperCase();
}

// Composant interne : avatar circulaire (image custom ou initiales).
const Avatar = ({ author }: { author: string }) => {
  const customSrc = CUSTOM_AVATARS[author];
  if (customSrc) {
    return (
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: '50%',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <Img
          src={customSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        width: 80,
        height: 80,
        borderRadius: '50%',
        backgroundColor: '#5865f2',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontWeight: 700,
        fontSize: 28,
        flexShrink: 0,
      }}
    >
      {initials(author)}
    </div>
  );
};

// Mapping position → CSS top/left/right/bottom + transform
function positionStyle(position: 'center' | 'top-left' | 'bottom-right'): React.CSSProperties {
  if (position === 'top-left') {
    return { top: '15%', left: '5%', transform: 'translate(0, 0)' };
  }
  if (position === 'bottom-right') {
    return { bottom: '15%', right: '5%', top: 'auto', left: 'auto', transform: 'translate(0, 0)' };
  }
  // center
  return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
}

export const DiscordCard = ({ author, message, timestamp, scale = 1, position = 'center' }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Slide-up + fade-in via spring (durationInFrames 20)
  const entry = spring({
    frame,
    fps,
    config: { damping: 14 },
    durationInFrames: 20,
  });
  const translateY = interpolate(entry, [0, 1], [120, 0]);

  // Couleur du nom : dégradé rose/violet, sauf Legacy Trading rouge
  const nameStyle: React.CSSProperties = author === 'Legacy Trading'
    ? { color: '#e84040' }
    : {
        background: 'linear-gradient(90deg, #ff79f2 0%, #d649cc 100%)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
      <div
        style={{
          position: 'absolute',
          ...positionStyle(position),
          width: 920,
          maxWidth: '90%',
          background: '#1e1f22',
          borderRadius: 24,
          padding: '36px 40px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          opacity: entry,
          transform: `${positionStyle(position).transform} translateY(${translateY}px) scale(${scale})`,
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <Avatar author={author} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ ...nameStyle, fontWeight: 700, fontSize: 36 }}>{author}</span>
            <Img
              src={staticFile('tag_boom.png')}
              style={{ height: 36, width: 'auto' }}
            />
            <Img
              src={staticFile('logo_boom.png')}
              style={{ width: 36, height: 36, borderRadius: '50%' }}
            />
            <span style={{ color: '#80848e', fontSize: 24 }}>{formatTime(timestamp)}</span>
          </div>
        </div>

        {/* Message body */}
        <div style={{ color: '#dcddde', fontSize: 36, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>
          {message}
        </div>
      </div>
    </AbsoluteFill>
  );
};
