// What the server knows about the game: the playable characters and how they change the difficulty of the cooperative mode.
import { config } from './config.js';

/** Playable characters of the web port (the keys of characters.xml). `threat` = how much stronger they make the enemies. */
export const CHARACTERS = ['Mina', 'GenericNinja', 'DemonNinja', 'GoldDemonNinja', 'Bat', 'BigDemon', 'Dracula'] as const;
export type CharKey = (typeof CHARACTERS)[number];

export const THREAT: Record<CharKey, number> = {
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
