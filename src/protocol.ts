// Message schemas (TypeBox, the validator of Elysia). Everything a client sends is checked against one of these before it is used.
import { t } from 'elysia';
import { Value } from '@sinclair/typebox/value';
import { CHARACTERS, ITEM_TYPES } from './game.js';

export const Name = t.String({ minLength: 1, maxLength: 32 });   // raw; cleanName() trims it to 10
export const Code = t.String({ pattern: '^[A-Z2-9]{5}$' });
export const Char = t.Union(CHARACTERS.map((c) => t.Literal(c)));
export const Mode = t.Union([t.Literal('coop'), t.Literal('vs')]);

/** Anything the host / guests relay to each other (game state). The server never looks inside, only at its size. */
const Blob = t.Any();

const PadBits = t.Integer({ minimum: 0, maximum: 1023 });
const Sid = t.String({ pattern: '^[0-9a-f]{48}$' });

export const ClientMessage = t.Union([
  t.Object({ t: t.Literal('join'), code: Code, name: Name, key: t.Optional(t.String({ maxLength: 64 })) }),
  t.Object({ t: t.Literal('resume'), code: Code, sid: Sid }),
  t.Object({ t: t.Literal('settings'), powerups: t.Boolean(), items: t.Array(t.Union(ITEM_TYPES.map((i) => t.Literal(i))), { maxItems: 6 }), lives: t.Integer({ minimum: 1, maximum: 3 }) }),
  t.Object({ t: t.Literal('kick'), id: t.Integer({ minimum: 0, maximum: 7 }) }),
  t.Object({ t: t.Literal('char'), char: Char }),
  t.Object({ t: t.Literal('variant'), v: t.Integer({ minimum: 0, maximum: 3 }) }),
  t.Object({ t: t.Literal('ready'), ready: t.Boolean() }),
  t.Object({ t: t.Literal('mode'), mode: Mode }),
  t.Object({ t: t.Literal('start') }),
  // WebRTC signalling between the host and a guest (offer / answer / ICE candidate); the server only forwards it
  t.Object({ t: t.Literal('rtc'), to: t.Integer({ minimum: 0, maximum: 7 }), d: t.Object({ k: t.Union([t.Literal('offer'), t.Literal('answer'), t.Literal('ice')]), s: t.Optional(t.String({ maxLength: 12000 })), c: t.Optional(t.Any()) }) }),
  t.Object({ t: t.Literal('in'), d: t.Object({ m: PadBits, tp: PadBits }) }),
  t.Object({ t: t.Literal('snap'), d: Blob }),
  t.Object({ t: t.Literal('end'), d: t.Optional(Blob) }),
  t.Object({ t: t.Literal('ping'), n: t.Optional(t.Number()) }),
  t.Object({ t: t.Literal('leave') }),
]);
export type ClientMessageT = { t: string; [k: string]: unknown };

export function parseClientMessage(raw: string): ClientMessageT | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  return Value.Check(ClientMessage as never, data) ? (data as ClientMessageT) : null;
}

export const CreateRoomBody = t.Object({ mode: Mode });
export const CodeParams = t.Object({ code: Code });

/** Cleans a nickname: printable characters only, collapsed spaces. */
export function cleanName(s: string): string {
  const out = s.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 10);
  return out || 'Ninja';
}
