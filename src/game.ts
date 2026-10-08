// What the server knows about the game: the playable characters and how they change the difficulty of the cooperative mode.
import { config } from './config.js';

/** Playable characters of the web port (the keys of characters.xml). `threat` = how much stronger they make the enemies. */
export const CHARACTERS = ['Mina', 'GenericNinja', 'DemonNinja', 'GoldDemonNinja', 'Bat', 'BigDemon', 'Dracula', 'XaHero', 'XaBoss'] as const;
export type CharKey = (typeof CHARACTERS)[number];

/** The XA characters can only be picked in VS (they have no place in the story co-op). */
export const VS_ONLY: readonly CharKey[] = ['XaHero', 'XaBoss'];

/** Power-ups the room's host can switch on or off. `heart` (revive a fallen friend) only exists in co-op. */
export const ITEM_TYPES = ['star', 'heart', 'bolt', 'shield', 'fist', 'fang'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export interface Settings { powerups: boolean; items: ItemType[]; lives: number }

export function defaultSettings(mode: 'coop' | 'vs'): Settings {
  return { powerups: true, items: ITEM_TYPES.filter((i) => mode === 'coop' || i !== 'heart'), lives: 3 };
}
/** Keeps only valid items, in a fixed order, with no heart in VS. */
export function cleanSettings(mode: 'coop' | 'vs', s: { powerups: boolean; items: string[]; lives: number }): Settings {
  const items = ITEM_TYPES.filter((i) => s.items.includes(i) && (mode === 'coop' || i !== 'heart'));
  return { powerups: !!s.powerups, items, lives: Math.max(1, Math.min(3, Math.floor(s.lives))) };
}

export const THREAT: Record<CharKey, number> = {
  XaHero: 0,
  XaBoss: 0,
  Mina: 0,
  GenericNinja: 0,
  Bat: -0.02,
  DemonNinja: 0.04,
  GoldDemonNinja: 0.08,
  BigDemon: 0.1,
  Dracula: 0.12,
};

export interface Difficulty {
  players: number;
  /** multiplier of the life of the enemies */
  hp: number;
  /** multiplier of how many enemies show up (on screen and per wave) */
  count: number;
  /** multiplier of the life of the bosses (already includes `hp`) */
  boss: number;
}

/** Cooperative difficulty: +6 % per extra player and the threat of the chosen characters; more enemies; much tougher bosses. */
export function difficultyOf(chars: string[]): Difficulty {
  const d = config.difficulty;
  const n = Math.max(1, chars.length);
  const threat = chars.reduce((s, c) => s + (THREAT[c as CharKey] ?? 0), 0);
  const hp = Math.min(d.cap, 1 + d.hpPerPlayer * (n - 1) + threat);
  const count = 1 + d.countPerPlayer * (n - 1);
  const boss = Math.min(d.cap * 2, (1 + d.bossHpPerPlayer * (n - 1)) * hp);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { players: n, hp: r(hp), count: r(count), boss: r(boss) };
}
