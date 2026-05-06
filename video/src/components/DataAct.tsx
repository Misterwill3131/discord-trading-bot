import { DiscordCard } from './DiscordCard';

type Props = {
  author: string;
  message: string;
  timestamp: string;
};

// Phase 2 du SignalAlert. Refait en Phase 2.5 — affiche maintenant
// la carte Discord native (au lieu du LONG/Entry/Target/Stop abstrait).
// Wrapper pour DiscordCard avec position 'center' fixe.
export const DataAct = ({ author, message, timestamp }: Props) => {
  return <DiscordCard author={author} message={message} timestamp={timestamp} />;
};
