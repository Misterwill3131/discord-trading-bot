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

// 3 dots animés : chacun bounce avec un délai (Discord-style typing indicator).
const TypingDot = ({ delay, frame }: { delay: number; frame: number }) => {
  // Cycle 18 frames (0.6s @ 30fps) : up 9f, down 9f.
  const cycleFrame = (frame + delay) % 18;
  const opacity = interpolate(
    cycleFrame,
    [0, 4, 9, 14, 18],
    [0.3, 1, 1, 0.3, 0.3],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const translateY = interpolate(
    cycleFrame,
    [0, 4, 9, 14, 18],
    [0, -6, 0, 0, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: '#dcddde',
        opacity,
        transform: `translateY(${translateY}px)`,
        margin: '0 2px',
      }}
    />
  );
};

// Indicateur "X is typing..." à la Discord (apparaît avant le message).
const TypingIndicator = ({ author, frame, opacity }: { author: string; frame: number; opacity: number }) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        color: '#80848e',
        fontSize: 22,
        fontStyle: 'italic',
        opacity,
        marginTop: 8,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center' }}>
        <TypingDot delay={0} frame={frame} />
        <TypingDot delay={6} frame={frame} />
        <TypingDot delay={12} frame={frame} />
      </span>
      <span>{author} is typing</span>
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

// Phase 1 : typing indicator (frames 0-12 = 0.4s)
// Phase 2 : transition typing → message (frames 12-24)
// Phase 3 : message visible (frames 24+)
const TYPING_END = 12;
const MESSAGE_START = 12;

export const DiscordCard = ({ author, message, timestamp, scale = 1, position = 'center' }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Typing indicator : visible 0-12, fade out 12-18.
  const typingOpacity = interpolate(
    frame,
    [0, 2, 12, 18],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Message : spring bouncy à partir de frame 12.
  // Damping plus bas (10) pour overshoot visible.
  const messageEntry = spring({
    frame: Math.max(0, frame - MESSAGE_START),
    fps,
    config: { damping: 10, stiffness: 120, mass: 0.8 },
    durationInFrames: 18,
  });
  const messageScale = interpolate(messageEntry, [0, 1], [0.85, 1]) * scale;
  const messageOpacity = interpolate(
    frame,
    [MESSAGE_START, MESSAGE_START + 4],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Couleur du nom : dégradé rose/violet, sauf Legacy Trading rouge
  const nameStyle: React.CSSProperties = author === 'Legacy Trading'
    ? { color: '#e84040' }
    : {
        background: 'linear-gradient(90deg, #ff79f2 0%, #d649cc 100%)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };

  // Card opacity = typing OR message (les deux apparaissent au même endroit)
  const cardOpacity = Math.max(typingOpacity * 0.7, messageOpacity);

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
          opacity: cardOpacity,
          transform: `${positionStyle(position).transform} scale(${messageScale})`,
        }}
      >
        {/* Header row (toujours visible quand la carte est là) */}
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

        {/* Conteneur body : typing indicator (0-18) puis message (12+) */}
        <div style={{ minHeight: 80, position: 'relative' }}>
          {/* Typing indicator (frames 0-18) */}
          {frame < 20 && (
            <div style={{ position: 'absolute', top: 0, left: 0 }}>
              <TypingIndicator author={author} frame={frame} opacity={typingOpacity} />
            </div>
          )}

          {/* Message (à partir du frame 12) */}
          <div
            style={{
              color: '#dcddde',
              fontSize: 36,
              fontWeight: 600,
              lineHeight: 1.4,
              wordBreak: 'break-word',
              opacity: messageOpacity,
            }}
          >
            {message}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
