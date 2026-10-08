// End-to-end check: starts the server, then plays the part of a host and three guests.   npm test
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const PORT = 18787;
const TOKEN = 'smoke-test-token-0123456789';
const ORIGIN = 'http://localhost:4321';
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT: String(PORT), GAME_TOKEN: TOKEN, ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY: '0', LOG_LEVEL: 'warn', CREATE_ROOM_PER_MINUTE: '100', HTTP_RATE_PER_MINUTE: '1000', WS_MESSAGES_PER_SECOND: '100', MAX_CONNECTIONS_PER_IP: '100' };
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'inherit', 'inherit'] });

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`); if (!ok) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = (path: string, init: RequestInit & { token?: string | null; origin?: string | null } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token !== null) headers['x-svnz-token'] = init.token ?? TOKEN;
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return fetch(base + path, { ...init, headers });
};

type Msg = { t: string; [k: string]: any };
class Client {
  ws: WebSocket;
  inbox: Msg[] = [];
  constructor(origin = ORIGIN, token = TOKEN) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['svnz-v1', 'token.' + token], { headers: { origin } });
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString())));
  }
  ready() { return once(this.ws, 'open'); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async wait(t: string, ms = 2000): Promise<Msg> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + t);
  }
}

async function main() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* starting */ } await sleep(100); }

  console.log('HTTP');
  check((await api('/health', { token: null, origin: null })).status === 200, 'GET /health is public');
  check((await api('/api/info', { token: null })).status === 401, 'API without token -> 401');
  check((await api('/api/info', { token: 'wrong-token-wrong-token' })).status === 401, 'API with wrong token -> 401');
  check((await api('/api/info', { origin: 'https://evil.example' })).status === 403, 'API from another origin -> 403');
  const info = await (await api('/api/info')).json() as any;
  check(info.characters.length === 7 && info.limits.vs === 8, 'GET /api/info lists 7 characters, 8 VS players');
  check((await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'nope' }) })).status === 422, 'POST /api/rooms validates the body');
  const created = await (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'coop' }) })).json() as any;
  check(/^[A-Z2-9]{5}$/.test(created.code) && created.hostKey.length === 48, `room created with code ${created.code}`);
  check((await (await api('/api/rooms/' + created.code)).json() as any).joinable === true, 'GET /api/rooms/:code says joinable');
  check((await api('/api/rooms/ZZZZZ')).status === 404, 'unknown room -> 404');

  console.log('WebSocket');
  const bad = new Client(ORIGIN, 'wrong-token-wrong-token');
  check(await new Promise((res) => { bad.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 401)); bad.ws.on('open', () => res(false)); }), 'socket with a wrong token is refused (401)');
  const evil = new Client('https://evil.example');
  check(await new Promise((res) => { evil.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 403)); evil.ws.on('open', () => res(false)); }), 'socket from another origin is refused (403)');

  const host = new Client(); await host.ready();
  host.send({ t: 'join', code: created.code, name: '  Host<script>  ', key: created.hostKey });
  const hj = await host.wait('joined');
  check(hj.host === true && hj.room.players[0].name === 'Hostscript', 'host joins with the key, nickname is cleaned');

  const g1 = new Client(); await g1.ready();
  g1.send({ t: 'join', code: created.code, name: 'Ana' });
  const g1j = await g1.wait('joined');
  check(g1j.host === false && g1j.you === 1, 'guest joins');
  g1.send({ t: 'char', char: 'Dracula' });
  const r1 = await host.wait('room'); await host.wait('room'); await host.wait('room');
  void r1;
  g1.send({ t: 'char', char: 'Hacker' });
  check((await g1.wait('error')).code === 'invalid', 'unknown character rejected');
  g1.send({ t: 'start' });
  check((await g1.wait('error')).code === 'forbidden', 'a guest cannot start');
  host.send({ t: 'start' });
  check((await host.wait('error')).code === 'not_ready', 'host cannot start until guests are ready');
  g1.send({ t: 'ready', ready: true });
  await sleep(100);
  host.inbox.length = 0;
  host.send({ t: 'start' });
  const st = await host.wait('start');
  check(st.room.players.length === 2 && st.difficulty.players === 2 && Math.abs(st.difficulty.hp - 1.18) < 1e-9 && st.difficulty.count === 1.75, `start sends difficulty ${JSON.stringify(st.difficulty)}`);
  await g1.wait('start');

  g1.send({ t: 'in', d: { x: 1, y: 0, b: 5 } });
  const inp = await host.wait('in');
  check(inp.from === 1 && inp.d.x === 1, 'guest input reaches the host');
  host.send({ t: 'snap', d: { f: [1, 2, 3] } });
  check((await g1.wait('snap')).d.f.length === 3, 'host snapshot reaches the guest');
  g1.send({ t: 'snap', d: { evil: true } });
  await sleep(150);
  check(!host.inbox.some((m) => m.t === 'snap'), 'a guest cannot send snapshots');

  const late = new Client(); await late.ready();
  late.send({ t: 'join', code: created.code, name: 'Late' });
  check((await late.wait('error')).code === 'started', 'nobody can join a match in progress');

  host.send({ t: 'end', d: { won: true } });
  const ended = await g1.wait('ended');
  check(ended.d.won === true, 'host ends the match, guests go back to the lobby');
  await sleep(100); host.inbox.length = 0;
  g1.ws.close();
  const after = await host.wait('room');
  check(after.room.players.length === 1, 'a leaving guest is removed');

  console.log('VS');
  const vs = await (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'vs' }) })).json() as any;
  const vh = new Client(); await vh.ready();
  vh.send({ t: 'join', code: vs.code, name: 'A', key: vs.hostKey });
  await vh.wait('joined');
  const vguests: Client[] = [];
  for (let i = 0; i < 7; i++) { const c = new Client(); await c.ready(); c.send({ t: 'join', code: vs.code, name: 'P' + i }); await c.wait('joined'); vguests.push(c); }
  const eighth = new Client(); await eighth.ready();
  eighth.send({ t: 'join', code: vs.code, name: 'Nine' });
  check((await eighth.wait('error')).code === 'full', '8 players fit in VS, the 9th is refused');
  await sleep(100);
  vh.inbox.length = 0;
  vguests[0]!.send({ t: 'team', team: 2 });
  const tv = await vh.wait('room');
  const teams = tv.room.players.map((p: any) => p.team);
  check(teams.filter((x: number) => x === 1).length <= 4 && teams.filter((x: number) => x === 2).length <= 4, 'teams are balanced 4 vs 4');

  console.log('Rate limit');
  const spam = new Client(); await spam.ready();
  const closed = new Promise<number>((res) => spam.ws.on('close', (code) => res(code)));
  for (let i = 0; i < 400; i++) spam.ws.send(JSON.stringify({ t: 'ping', n: i }));
  check((await closed) === 4008, 'flooding a socket closes it (4008)');

  for (const c of [host, g1, late, vh, eighth, ...vguests]) c.ws.terminate();
}

main().catch((e) => { console.error(e); fails++; }).finally(() => {
  console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
  child.kill();
  setTimeout(() => process.exit(fails ? 1 : 0), 200);
});
