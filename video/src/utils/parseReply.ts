// Parse le markdown Discord d'un message qui est une réponse à un autre.
//
// Format Discord brut :
//   `> *Replying to <author> [message](<url>)* <actual content>`
//
// Exemple :
//   `> *Replying to ZZ [message](https://discord.com/channels/...)* RPGL +34%`
//   →  { content: 'RPGL +34%', replyAuthor: 'ZZ' }
//
// Si le message n'est pas une réponse, retourne le message tel quel
// avec replyAuthor = null.
export type ParsedReply = {
  content: string;
  replyAuthor: string | null;
};

const REPLY_REGEX = /^>\s*\*Replying to\s+(.+?)\s+\[message\]\([^)]+\)\*\s*(.*)$/s;

export function parseReplyMarkdown(message: string): ParsedReply {
  if (!message) return { content: message, replyAuthor: null };
  const m = message.match(REPLY_REGEX);
  if (!m) return { content: message, replyAuthor: null };
  return {
    content: m[2].trim() || message, // fallback au message brut si content vide
    replyAuthor: m[1].trim(),
  };
}
