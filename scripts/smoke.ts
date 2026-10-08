// End-to-end check: starts the server, then plays the part of a host and guests.   npm test
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const PORT = 18787;
const TOKEN = 'smoke-test-token-0123456789';
const OLD_TOKEN = 'smoke-old-token-0123456789';
const ADMIN = 'smoke-admin-token-0123456789';
const ORIGIN = 'http://localhost:4321';
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env, PORT: String(PORT), GAME_TOKEN: `${TOKEN},${OLD_TOKEN}`, ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY: '0', LOG_LEVEL: 'warn',
  CREATE_ROOM_PER_MINUTE: '100', HTTP_RATE_PER_MINUTE: '1000', WS_MESSAGES_PER_SECOND: '100', MAX_CONNECTIONS_PER_IP: '100', MAX_ROOMS_PER_IP: '40',
  RECONNECT_GRACE_SECONDS: '5', HOST_PLAY_GRACE_SECONDS: '3', JOIN_FAIL_LIMIT: '12', MAX_STRIKES: '5',
};
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'inherit', 'inherit'] });

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`); if (!ok) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = (path: string, init: RequestInit & { token?: string | null; origin?: string | null; headers2?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers2 ?? {}) };
  if (init.token !== null) headers['x-svnz-token'] = init.token ?? TOKEN;
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return fetch(base + path, { ...init, headers });
};

type Msg = { t: string; [k: string]: any };
class Client {
  ws: WebSocket;
  inbox: Msg[] = [];
  closed: number | null = null;
  constructor(origin = ORIGIN, token = TOKEN) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['svnz-v1', 'token.' + token], { headers: { origin } });
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString())));
    this.ws.on('close', (code) => { this.closed = code; });
  }
  ready() { return once(this.ws, 'open'); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async wait(t: string, ms = 2000, pred: (m: Msg) => boolean = () => true): Promise<Msg> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.inbox.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + t);
  }
  has(t: string, pred: (m: Msg) => boolean = () => true) { return this.inbox.some((m) => m.t === t && pred(m)); }
}
const mk = async (code: string, name: string, key?: string) => {
  const c = new Client(); await c.ready();
  c.send({ t: 'join', code, name, key });
  const j = await c.wait('joined');
  return { c, j };
};
const room = async (mode: 'coop' | 'vs') => (await (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode }) })).json()) as any;

async function main() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* starting */ } await sleep(100); }

  console.log('HTTP');
  check((await api('/health', { token: null, origin: null })).status === 200, 'GET /health is public');
  check((await api('/api/info', { token: null })).status === 401, 'API without token -> 401');
  check((await api('/api/info', { token: 'wrong-token-wrong-token' })).status === 401, 'API with wrong token -> 401');
  check((await api('/api/info', { token: OLD_TOKEN })).status === 200, 'a second (old) token is also accepted: tokens can be rotated');
  check((await api('/api/info', { origin: 'https://evil.example' })).status === 403, 'API from another origin -> 403');
  const info = await (await api('/api/info')).json() as any;
  check(info.characters.length === 9 && info.vsOnly.length === 2 && info.items.length === 6 && info.limits.vs === 4, 'GET /api/info lists 9 characters (2 VS-only), 6 items, 4 VS players');
  check((await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'nope' }) })).status === 422, 'POST /api/rooms validates the body');
  const created = await room('coop');
  check(/^[A-Z2-9]{5}$/.test(created.code) && created.hostKey.length === 48, `room created with code ${created.code}`);
  check((await (await api('/api/rooms/' + created.code)).json() as any).joinable === true, 'GET /api/rooms/:code says joinable');
  check((await api('/api/rooms/ZZZZZ')).status === 404, 'unknown room -> 404');
  check((await api('/api/admin/stats')).status === 404, 'admin stats need the admin token');
  const st = await (await api('/api/admin/stats', { headers2: { 'x-admin-token': ADMIN } })).json() as any;
  check(st.rooms >= 1 && typeof st.sockets === 'number', 'admin stats with the admin token');

  console.log('WebSocket');
  const bad = new Client(ORIGIN, 'wrong-token-wrong-token');
  check(await new Promise((res) => { bad.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 401)); bad.ws.on('open', () => res(false)); }), 'socket with a wrong token is refused (401)');
  const evil = new Client('https://evil.example');
  check(await new Promise((res) => { evil.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 403)); evil.ws.on('open', () => res(false)); }), 'socket from another origin is refused (403)');

  const host = new Client(); await host.ready();
  host.send({ t: 'join', code: created.code, name: '  Host<script>  ', key: created.hostKey });
  const hj = await host.wait('joined');
  check(hj.host === true && hj.room.players[0].name === 'Hostscript' && /^[0-9a-f]{48}$/.test(hj.sid), 'host joins with the key, nickname cleaned (10 chars max), gets a session id');

  const g1 = new Client(); await g1.ready();
  g1.send({ t: 'join', code: created.code, name: 'Ana' });
  const g1j = await g1.wait('joined');
  check(g1j.host === false && g1j.you === 1, 'guest joins');
  g1.send({ t: 'char', char: 'Dracula' });
  await host.wait('room'); await host.wait('room'); await host.wait('room');
  g1.send({ t: 'char', char: 'Hacker' });
  check((await g1.wait('error')).code === 'invalid', 'unknown character rejected');
  g1.send({ t: 'char', char: 'XaBoss' });
  check((await g1.wait('error')).code === 'invalid', 'the XA characters cannot be picked in co-op');
  g1.send({ t: 'start' });
  check((await g1.wait('error')).code === 'forbidden', 'a guest cannot start');
  g1.send({ t: 'settings', powerups: false, items: [], lives: 1 });
  check((await g1.wait('error')).code === 'forbidden', 'a guest cannot change the settings');
  host.send({ t: 'start' });
  check((await host.wait('error')).code === 'not_ready', 'host cannot start until guests are ready');
  g1.send({ t: 'ready', ready: true });
  await sleep(100);

  console.log('Settings');
  host.inbox.length = 0;
  host.send({ t: 'settings', powerups: true, items: ['star', 'bolt', 'heart'], lives: 2 });
  const sv = await host.wait('room');
  check(JSON.stringify(sv.room.settings.items) === '["star","heart","bolt"]' && sv.room.settings.lives === 2, 'host chooses the power-ups (valid ones, fixed order)');
  host.send({ t: 'settings', powerups: true, items: ['star'], lives: 9 });
  check((await host.wait('error')).code === 'invalid', 'settings are validated (lives 1-3)');
  host.send({ t: 'settings', powerups: false, items: [], lives: 3 });
  const off = await host.wait('room');
  check(off.room.settings.powerups === false, 'power-ups can be switched off');

  console.log('Sessions');
  const sid = g1j.sid as string;
  g1.ws.terminate();
  const lostView = await host.wait('room', 2000, (m) => m.room.players.some((p: any) => p.id === 1 && p.online === false));
  check(!!lostView, 'a dropped connection keeps the seat (shown as offline)');
  const back = new Client(); await back.ready();
  back.send({ t: 'resume', code: created.code, sid });
  const rj = await back.wait('joined');
  check(rj.resumed === true && rj.you === 1 && rj.room.players[1].char === 'Dracula', 'resume with the session id: same seat, same character');
  await host.wait('room', 2000, (m) => m.room.players.every((p: any) => p.online));
  const wrong = new Client(); await wrong.ready();
  wrong.send({ t: 'resume', code: created.code, sid: '0'.repeat(48) });
  check((await wrong.wait('error')).code === 'bad_session', 'resume with a wrong session id is refused');
  const twin = new Client(); await twin.ready();
  twin.send({ t: 'resume', code: created.code, sid });
  await twin.wait('joined');
  await sleep(150);
  check(back.closed === 4009 || back.has('replaced'), 'resuming from another tab replaces the old connection');

  // seat taken back by joining again with the same nickname
  twin.ws.terminate();
  await host.wait('room', 2000, (m) => m.room.players.some((p: any) => p.id === 1 && p.online === false));
  const claim = new Client(); await claim.ready();
  claim.send({ t: 'join', code: created.code, name: 'ana' });
  const cj = await claim.wait('joined');
  check(cj.claimed === true && cj.you === 1, 'knowing the room code and the nickname is enough to take a lost seat back');
  await sleep(100);

  // a seat nobody comes back for is freed
  claim.ws.terminate();
  await host.wait('room', 2000, (m) => m.room.players.some((p: any) => p.id === 1 && p.online === false));
  const freed = await host.wait('room', 9000, (m) => m.room.players.length === 1);
  check(!!freed, 'a seat nobody comes back for is freed after the grace period (no ghost players)');

  console.log('Match');
  const g2 = await mk(created.code, 'Bea');
  g2.c.send({ t: 'ready', ready: true });
  await sleep(100);
  host.inbox.length = 0;
  host.send({ t: 'start' });
  const start = await host.wait('start');
  check(start.room.players.length === 2 && start.difficulty.players === 2, `start sends the room, the settings and difficulty ${JSON.stringify(start.difficulty)}`);
  await g2.c.wait('start');
  g2.c.send({ t: 'in', d: { m: 8, tp: 1 } });
  const inp = await host.wait('in');
  check(inp.from === 1 && inp.d.m === 8, 'guest input reaches the host');
  g2.c.send({ t: 'in', d: { m: 99999, tp: 0 } });
  check((await g2.c.wait('error')).code === 'invalid', 'an input with an out-of-range value is refused');
  host.send({ t: 'snap', d: { f: [1, 2, 3] } });
  check((await g2.c.wait('snap')).d.f.length === 3, 'host snapshot reaches the guest');
  g2.c.send({ t: 'snap', d: { evil: true } });
  await sleep(150);
  check(!host.inbox.some((m) => m.t === 'snap'), 'a guest cannot send snapshots');
  const late = new Client(); await late.ready();
  late.send({ t: 'join', code: created.code, name: 'Late' });
  check((await late.wait('error')).code === 'started', 'nobody new can join a match in progress');

  // a guest reloads in the middle of the match: the host hears about it, and the guest gets its seat back
  const g2sid = g2.j.sid as string;
  g2.c.ws.terminate();
  check((await host.wait('peer', 2000, (m) => m.online === false)).id === 1, 'host is told when a guest loses the connection');
  const g2b = new Client(); await g2b.ready();
  g2b.send({ t: 'resume', code: created.code, sid: g2sid });
  const g2r = await g2b.wait('joined');
  check(g2r.resumed && g2r.room.status === 'playing', 'a guest resumes in the middle of the match');
  check((await host.wait('peer', 2000, (m) => m.online === true)).id === 1, 'host is told when the guest is back');

  // the host loses the connection: the match is ended for everybody after a few seconds
  const hostSid = hj.sid as string;
  host.ws.terminate();
  const aborted = await g2b.wait('ended', 8000);
  check(aborted.d.aborted === true, 'a match whose host is lost is ended for everybody');
  const host2 = new Client(); await host2.ready();
  host2.send({ t: 'resume', code: created.code, sid: hostSid });
  const h2 = await host2.wait('joined');
  check(h2.host === true && h2.room.status === 'lobby', 'the host comes back (as host) to the lobby');

  console.log('Kick');
  const g3 = await mk(created.code, 'Cy');
  host2.send({ t: 'kick', id: g3.j.you });
  await g3.c.wait('kicked');
  const again = new Client(); await again.ready();
  again.send({ t: 'join', code: created.code, name: 'Cy' });
  check((await again.wait('error')).code === 'banned', 'a kicked player cannot come back to that room');
  g2b.send({ t: 'kick', id: 0 });
  check((await g2b.wait('error')).code === 'forbidden', 'a guest cannot kick');

  console.log('VS');
  const vs = await room('vs');
  const vh = new Client(); await vh.ready();
  vh.send({ t: 'join', code: vs.code, name: 'A', key: vs.hostKey });
  const vhj = await vh.wait('joined');
  check(!vhj.room.settings.items.includes('heart') && vhj.room.settings.lives === 3, 'VS rooms start with 3 lives and no heart (nobody can be revived in VS)');
  vh.inbox.length = 0;
  vh.send({ t: 'char', char: 'XaBoss' });
  check((await vh.wait('room')).room.players[0].char === 'XaBoss', 'the XA boss can be picked in VS');
  vh.send({ t: 'mode', mode: 'coop' });
  const back2 = await vh.wait('room');
  check(back2.room.players[0].char === 'Mina' && back2.room.settings.items.includes('heart'), 'switching to co-op resets the XA characters and brings the heart');
  vh.send({ t: 'mode', mode: 'vs' });
  await vh.wait('room');
  vh.inbox.length = 0;
  const vguests: Client[] = [];
  for (let i = 0; i < 3; i++) { const c = new Client(); await c.ready(); c.send({ t: 'join', code: vs.code, name: 'P' + i }); await c.wait('joined'); vguests.push(c); }
  const fifth = new Client(); await fifth.ready();
  fifth.send({ t: 'join', code: vs.code, name: 'Five' });
  check((await fifth.wait('error')).code === 'full', 'VS is a free-for-all of 4 players at most: the 5th is refused');
  await sleep(100);
  vh.inbox.length = 0;
  vguests[0]!.send({ t: 'char', char: 'XaHero' });
  const tv = await vh.wait('room');
  const teams = tv.room.players.map((p: any) => p.team);
  check(new Set(teams).size === 4, 'in VS every player is their own team (everybody against everybody)');
  check(tv.room.players.some((p: any) => p.char === 'XaHero'), 'the XA characters can be picked in VS');
  vguests[0]!.send({ t: 'team', team: 1 });
  check((await vguests[0]!.wait('error')).code === 'invalid', 'there are no teams to choose');

  console.log('Abuse');
  const spam = new Client(); await spam.ready();
  const closed = new Promise<number>((res) => spam.ws.on('close', (code) => res(code)));
  for (let i = 0; i < 400; i++) spam.ws.send(JSON.stringify({ t: 'ping', n: i }));
  check((await closed) === 4008, 'flooding a socket closes it (4008)');
  const junk = new Client(); await junk.ready();
  const jc = new Promise<number>((res) => junk.ws.on('close', (code) => res(code)));
  for (let i = 0; i < 6; i++) junk.ws.send('{"t":"nonsense"}');
  check((await jc) === 4003, 'too many invalid messages close the socket (4003)');
  // guessing codes: the address gets blocked
  let blocked = false;
  for (let i = 0; i < 20 && !blocked; i++) blocked = (await api('/api/rooms/AAAA' + 'BCDEFGHJKMNPQRSTUVWXYZ'[i % 22])).status === 429;
  check(blocked, 'guessing room codes gets the address blocked (429)');
  const blockedWs = new Client();
  check(await new Promise((res) => { blockedWs.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 429)); blockedWs.ws.on('open', () => res(false)); }), 'a blocked address cannot open sockets either');

  for (const c of [host, g1, back, twin, claim, wrong, late, again, g2.c, g2b, host2, g3.c, vh, fifth, ...vguests]) c.ws.terminate();
}

main().catch((e) => { console.error(e); fails++; }).finally(() => {
  console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
  child.kill();
  setTimeout(() => process.exit(fails ? 1 : 0), 200);
});
