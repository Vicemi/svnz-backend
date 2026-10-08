// RTT of ping messages through the real path.   BASE=https://host TOKEN=... node scripts/rtt.mjs
import WebSocket from 'ws';
const BASE = process.env.BASE, TOKEN = process.env.TOKEN, ORIGIN = process.env.ORIGIN ?? 'https://svnz-portweb.vicemi.dev';
const r = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', 'x-svnz-token': TOKEN, origin: ORIGIN }, body: JSON.stringify({ mode: 'coop' }) }).then((x) => x.json());
const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', ['svnz-v1', 'token.' + TOKEN], { headers: { origin: ORIGIN } });
const rt = [];
let t0 = 0;
w.on('open', () => w.send(JSON.stringify({ t: 'join', code: r.code, name: 'rtt', key: r.hostKey })));
w.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'joined' || m.t === 'pong') {
    if (m.t === 'pong') rt.push(performance.now() - t0);
    if (rt.length >= 30) { rt.sort((a, b) => a - b); console.log('RTT ms  min', rt[0].toFixed(0), 'median', rt[15].toFixed(0), 'p90', rt[27].toFixed(0), 'max', rt[29].toFixed(0)); process.exit(0); }
    setTimeout(() => { t0 = performance.now(); w.send(JSON.stringify({ t: 'ping' })); }, 100);
  }
});
