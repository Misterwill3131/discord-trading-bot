import { staticFile } from 'remotion';

// Mapping author → avatar path. Mirroite canvas/config.js CUSTOM_AVATARS.
// Si l'auteur n'est pas dans ce mapping, le composant DiscordCard tombe
// sur les initiales (2 premières lettres) sur cercle bleu Discord (#5865f2).
// Ajouter un nouvel avatar nécessite : (1) copier le PNG dans
// video/public/avatars/ et avatar/ ; (2) ajouter une entrée ici ET
// dans canvas/config.js.
export const CUSTOM_AVATARS: Record<string, string> = {
  'Z':                staticFile('avatars/z-avatar.jpg'),
  'ZZ':               staticFile('avatars/z-avatar.jpg'),
  'templeofboom':     staticFile('avatars/z-avatar.jpg'),
  'AR':               staticFile('avatars/AR_AVATAR.png'),
  'beppels':          staticFile('avatars/beppels_avatar.png'),
  'L':                staticFile('avatars/L_avatar.png'),
  'RF':               staticFile('avatars/RF_AVATAR.png'),
  'Viking':           staticFile('avatars/Viking_avatar.png'),
  'ProTrader':        staticFile('avatars/ProTrader_avatar.png'),
  'Gaz':              staticFile('avatars/Gaz_avatar.png'),
  'CapitalGains':     staticFile('avatars/CapitalGains_avatar.png'),
  'THE REVERSAL':     staticFile('avatars/THE REVERSAL_avatar.png'),
  'kestrel':          staticFile('avatars/kestrel_avatar.png'),
  'the1albatross':    staticFile('avatars/the1albatross_avatar.png'),
  'Bora':             staticFile('avatars/Bora_avatar.png'),
  'Michael':          staticFile('avatars/Michael_avatar.png'),
  'thedutchess1':     staticFile('avatars/thedutchess1_avatar.png'),
  'Legacy Trading':   staticFile('avatars/Legacy Trading_avatar.png'),
  'Protrader Alerts': staticFile('avatars/Protrader Alerts_avatar.png'),
  'MsKim':            staticFile('avatars/MsKim.png'),
};
