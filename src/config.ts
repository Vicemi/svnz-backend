// Everything the server needs comes from the environment (a .env file next to package.json, see .env.example).
import 'dotenv/config';

function str(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    if (def === undefined) throw new Error(`Missing environment variable ${name} (see .env.example)`);
    return def;
  }
  return v.trim();
}
function int(name: string, def: number, min: number, max: number): number {
  const n = Number(str(name, String(def)));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return Math.floor(n);
}
function num(name: string, def: number, min: number, max: number): number {
  const n = Number(str(name, String(def)));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  return ['1', 'true', 'yes', 'on'].includes(str(name, def ? 'true' : 'false').toLowerCase());
}
function list(name: string, def: string): string[] {
  return str(name, def).split(',').map((s) => s.trim()).filter(Boolean);
}

const token = str('GAME_TOKEN');
// The token travels as a WebSocket sub-protocol, so it can only use "token" characters.
if (!/^[A-Za-z0-9._-]{16,128}$/.test(token)) throw new Error('GAME_TOKEN must be 16-128 characters of A-Z a-z 0-9 . _ - (run `npm run token` to make one)');

export const config = {
  port: int('PORT', 8787, 1, 65535),
  host: str('HOST', '0.0.0.0'),
  /** Shared secret the frontend sends (PUBLIC_SVNZ_BACKEND_TOKEN). */
  token,
  /** Browser origins allowed to call the API / open the socket. `*` = any (development only). */
  allowedOrigins: list('ALLOWED_ORIGINS', '*'),
  /** Express "trust proxy" (number of proxies in front of the server, or true/false). Behind a Cloudflare Tunnel use 1. */
  trustProxy: str('TRUST_PROXY', '1'),
  /** Take the real client address from Cloudflare's CF-Connecting-IP header (only when ALL traffic comes through Cloudflare). */
  trustCloudflare: bool('TRUST_CLOUDFLARE', false),
  /** Optional Cloudflare Access (Zero Trust) JWT check, for deployments where the whole host is behind an Access policy. */
  cfAccessTeamDomain: str('CF_ACCESS_TEAM_DOMAIN', ''),
  cfAccessAud: str('CF_ACCESS_AUD', ''),
  cfAccessRequired: bool('CF_ACCESS_REQUIRED', false),

  maxRooms: int('MAX_ROOMS', 200, 1, 100000),
  roomIdleMinutes: int('ROOM_IDLE_MINUTES', 30, 1, 1440),
  maxCoopPlayers: int('MAX_COOP_PLAYERS', 4, 2, 4),
  /** VS: players per team x 2 (4 vs 4 = 8). */
  maxVsPlayers: int('MAX_VS_PLAYERS', 8, 2, 8),
  maxConnectionsPerIp: int('MAX_CONNECTIONS_PER_IP', 8, 1, 100),
  httpRatePerMinute: int('HTTP_RATE_PER_MINUTE', 60, 1, 10000),
  createRoomPerMinute: int('CREATE_ROOM_PER_MINUTE', 6, 1, 1000),
  /** Per-connection messages per second (the game sends about 30 a second while playing). */
  wsMessagesPerSecond: int('WS_MESSAGES_PER_SECOND', 90, 10, 1000),
  wsMaxPayloadBytes: int('WS_MAX_PAYLOAD_BYTES', 32768, 1024, 1048576),

  /** Difficulty tuning of the cooperative mode (the host game reads the result from the room). */
  difficulty: {
    /** Every extra player makes the enemies this much tougher (0.06 = +6 %). */
    hpPerPlayer: num('DIFFICULTY_PER_PLAYER', 0.06, 0, 1),
    /** Extra enemies on screen / per wave for every extra player (0.75: two players = 1.75x the enemies). */
    countPerPlayer: num('ENEMY_COUNT_PER_PLAYER', 0.75, 0, 2),
    /** Extra life of the bosses for every extra player. */
    bossHpPerPlayer: num('BOSS_HP_PER_PLAYER', 0.5, 0, 3),
    cap: num('DIFFICULTY_CAP', 2, 1, 10),
  },
  logLevel: str('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
