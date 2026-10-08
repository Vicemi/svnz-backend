# svnz-backend

Servidor de **salas y retransmisión** para los modos online (**Coop de hasta 4** y **VS de hasta 4 contra 4**) de la versión web de *Super Vampire Ninja Zero*: [svnz-portweb](https://github.com/Vicemi/svnz-portweb) · [svnz-portweb.vicemi.dev](https://svnz-portweb.vicemi.dev).

- **Express** es la capa de afuera: cabeceras de seguridad (helmet), CORS, límites de tasa, IP real detrás de Cloudflare, verificación opcional de Cloudflare Access y el servidor HTTP/WebSocket.
- **Elysia** define la API HTTP con rutas y cuerpos validados (TypeBox); se monta dentro de Express. Los mensajes del WebSocket se validan con los mismos esquemas.
- Es **usable por cualquiera**: este repositorio es todo lo que hace falta para montar tu propio servidor y apuntar el juego hacia él.

> **Cómo funciona una partida.** El navegador del **anfitrión** (quien crea la sala) simula la pelea y manda el estado ~30 veces por segundo; los **invitados** mandan sus controles y dibujan lo que reciben. El servidor solo guarda el lobby (personajes, equipos, "listo") y reenvía mensajes, así que no necesita nada del juego y casi no gasta CPU.

---

## Inicio rápido (local)

Necesitás Node 22 o superior.

```sh
git clone https://github.com/Vicemi/svnz-backend.git
cd svnz-backend
npm install
cp .env.example .env        # y editá GAME_TOKEN (npm run token genera uno)
npm run dev                 # http://localhost:8787
```

Comprobar que anda:

```sh
curl http://localhost:8787/health          # {"ok":true,...}
npm test                                   # prueba de punta a punta: salas, relé, límites, 4 contra 4
```

Producción:

```sh
npm run build && npm start
# o con Docker:
docker compose up -d --build
```

---

## Variables de entorno del backend (`.env`)

Todo se configura en el archivo `.env` (hay un modelo comentado en [`.env.example`](.env.example)). El servidor **no arranca** si falta `GAME_TOKEN`.

| Variable | Por defecto | Para qué sirve |
| :--- | :--- | :--- |
| `PORT` | `8787` | Puerto en el que escucha. |
| `HOST` | `0.0.0.0` | Dirección de escucha. Con un túnel de Cloudflare en la misma máquina podés usar `127.0.0.1`. |
| `GAME_TOKEN` | *(obligatorio)* | Clave compartida con el juego (`PUBLIC_SVNZ_BACKEND_TOKEN`). 16–128 caracteres `A-Z a-z 0-9 . _ -`. `npm run token` genera una. |
| `ALLOWED_ORIGINS` | `*` | Sitios que pueden usar el servidor, separados por coma y sin `/` final. Poné ahí el dominio del juego. `*` solo para desarrollo. |
| `TRUST_PROXY` | `1` | Cantidad de proxies delante del servidor (Express *trust proxy*). Con Cloudflare Tunnel: `1`. |
| `TRUST_CLOUDFLARE` | `false` | `true` = la IP del visitante sale de `CF-Connecting-IP`. Activalo **solo** si todo el tráfico entra por Cloudflare. |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `CF_ACCESS_REQUIRED` | vacío / `false` | Verificación opcional del JWT de Cloudflare Access (ver más abajo). |
| `MAX_ROOMS` | `200` | Salas simultáneas. |
| `ROOM_IDLE_MINUTES` | `30` | Una sala sin actividad se cierra. |
| `MAX_COOP_PLAYERS` | `4` | Jugadores por sala coop (máx. 4). |
| `MAX_VS_PLAYERS` | `8` | Jugadores por sala VS (8 = 4 contra 4). |
| `MAX_CONNECTIONS_PER_IP` | `8` | WebSockets abiertos por IP. |
| `HTTP_RATE_PER_MINUTE` | `60` | Pedidos HTTP por minuto y por IP. |
| `CREATE_ROOM_PER_MINUTE` | `6` | Salas creadas por minuto y por IP. |
| `WS_MESSAGES_PER_SECOND` | `90` | Mensajes por segundo de cada conexión (el juego usa ~30). Si se pasa, se cierra el socket. |
| `WS_MAX_PAYLOAD_BYTES` | `32768` | Tamaño máximo de un mensaje. |
| `DIFFICULTY_PER_PLAYER` | `0.06` | Cada jugador extra hace a los enemigos un 6 % más duros (ver *Dificultad*). |
| `ENEMY_COUNT_PER_PLAYER` | `0.75` | Enemigos extra por jugador extra (2 jugadores = ×1,75). |
| `BOSS_HP_PER_PLAYER` | `0.5` | Vida extra de los jefes por jugador extra. |
| `DIFFICULTY_CAP` | `2` | Tope del multiplicador de vida. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` o `error`. |

---

## Conectar el juego (frontend)

El juego se compila con **dos variables de entorno** que le dicen dónde está tu backend. Son las únicas que hay que crear en el frontend:

| Variable del **frontend** | Valor |
| :--- | :--- |
| `PUBLIC_SVNZ_BACKEND_URL` | La dirección https de este servidor, sin `/` final. Ej.: `https://svnz-api.tudominio.com` |
| `PUBLIC_SVNZ_BACKEND_TOKEN` | El mismo valor que `GAME_TOKEN` del `.env` del backend. |

**En Cloudflare Pages:** proyecto → *Settings* → *Variables and Secrets* → agregalas (en *Production* y, si querés, en *Preview*) y **volvé a desplegar**: las variables `PUBLIC_*` se incorporan a la página al compilar, no se leen en el navegador en tiempo de ejecución.

**En local:** creá un `.env` en la raíz del frontend (hay un `.env.example`):

```env
PUBLIC_SVNZ_BACKEND_URL=http://127.0.0.1:8787
PUBLIC_SVNZ_BACKEND_TOKEN=el-mismo-token-del-backend
```

> **Sobre el token.** Como las variables `PUBLIC_*` terminan dentro de la página, el token **no es una contraseña**: es una clave del juego que mantiene afuera el tráfico casual y otros sitios (junto con `ALLOWED_ORIGINS`). La protección real contra abusos son los límites de tasa, el tope de salas/conexiones, la validación de cada mensaje y que el servidor no ejecuta nada de lo que recibe. Si el token se filtra y alguien lo abusa, cambialo en el `.env` y en las variables de Cloudflare Pages y volvé a desplegar.

Si las variables no están definidas, el juego muestra «Backend sin configurar» en los modos online; el **coop local** sigue funcionando.

---

## Detrás de Cloudflare (Tunnel + Zero Trust)

Esta es la forma recomendada: el servidor no expone ningún puerto a internet y Cloudflare hace de proxy.

1. **Backend en tu servidor** (Docker o `npm start`), escuchando en `127.0.0.1:8787`.
2. **Cloudflare Tunnel** (`cloudflared`) en la misma máquina:
   ```sh
   cloudflared tunnel login
   cloudflared tunnel create svnz
   cloudflared tunnel route dns svnz svnz-api.tudominio.com
   ```
   `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: svnz
   credentials-file: /home/usuario/.cloudflared/<ID-del-túnel>.json
   ingress:
     - hostname: svnz-api.tudominio.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```
   ```sh
   cloudflared tunnel run svnz        # o instalalo como servicio: cloudflared service install
   ```
   Los WebSockets pasan por el proxy de Cloudflare sin configurar nada. El servidor manda un *ping* cada 20 s, así que la conexión no se corta por inactividad (Cloudflare corta a ~100 s sin tráfico).
3. En el `.env`: `TRUST_PROXY=1`, `TRUST_CLOUDFLARE=true` y `ALLOWED_ORIGINS=https://svnz-portweb.vicemi.dev` (el dominio donde está el juego).
4. En el frontend: `PUBLIC_SVNZ_BACKEND_URL=https://svnz-api.tudominio.com`.

### Cloudflare Zero Trust / Access

Una aplicación de **Access** sobre el hostname pide iniciar sesión en cada pedido, y un navegador que juega desde *otro* sitio (el del juego) no puede completar ese inicio de sesión en una llamada `fetch`/WebSocket. Por eso, para un juego público:

- Creá la aplicación Access sobre el hostname **con una política `Bypass` (Everyone)** para `/api/*` y `/ws` (o no pongas Access sobre ese hostname). La protección la dan el token, los orígenes permitidos y los límites del servidor.
- Reforzalo en Cloudflare con **reglas de límite de tasa (WAF → Rate limiting)** sobre `/api/rooms` y con *Bot Fight Mode*.
- Podés proteger rutas administrativas o de monitoreo con una política de Access normal (por ejemplo `/health` para tu equipo).

Si, en cambio, querés una instalación **privada** (solo tu grupo), activá Access sobre todo el hostname con una política de correos/IdP y configurá `CF_ACCESS_TEAM_DOMAIN` (`tuequipo.cloudflareaccess.com`), `CF_ACCESS_AUD` (el *Application Audience tag* de la aplicación) y `CF_ACCESS_REQUIRED=true`: el servidor valida entonces el JWT `Cf-Access-Jwt-Assertion` contra las claves públicas de tu equipo antes de aceptar cualquier pedido (salvo `/health`). Esto es avanzado y requiere que el navegador ya tenga la sesión de Access en ese dominio.

---

## Reglas del juego que aplica el servidor

- **Salas**: un código de 5 caracteres (`A-Z` sin `O/I/L` y `2-9`, aleatorio con `crypto`). Se crea con `POST /api/rooms`, que también devuelve una **clave de anfitrión** secreta; solo quien la tiene puede ser el anfitrión.
- **Coop**: hasta 4 jugadores (`MAX_COOP_PLAYERS`). **VS**: hasta 8 (`MAX_VS_PLAYERS`), repartidos en dos equipos de máximo 4; cada jugador elige su equipo y se equilibran solos al entrar.
- **Lobby**: cada jugador elige personaje y marca «listo»; el anfitrión puede cambiar el modo y empieza la partida cuando todos están listos (en VS, con jugadores en los dos equipos). No se puede entrar a una partida ya empezada.
- Si el anfitrión se va, la sala se cierra. Si un invitado se va en plena partida, su personaje sale de la pelea.

### Personajes y dificultad del coop

Personajes: Mina, Ninja, Demon Ninja, Gold Demon, Murciélago, Big Demon y Drácula. Cada uno aporta una *amenaza* (`src/game.ts`): los más fuertes hacen el juego más difícil.

| Personaje | Amenaza | | Personaje | Amenaza |
| :--- | ---: | --- | :--- | ---: |
| Mina | 0 | | Murciélago | −0,02 |
| Ninja | 0 | | Demon Ninja | +0,04 |
| Gold Demon | +0,08 | | Big Demon | +0,10 |
| Drácula | +0,12 | | | |

Con `n` jugadores y `T` = suma de las amenazas:

- **Vida de los enemigos** × `1 + 0,06·(n−1) + T` (tope `DIFFICULTY_CAP`).
- **Cantidad de enemigos**, en pantalla y por oleada, × `1 + 0,75·(n−1)` (con 2 jugadores, una fase de 2 enemigos tiene 4). El juego limita a 10 enemigos a la vez y a 8 acompañantes de jefe para que la arena siga siendo jugable.
- **Vida de los jefes** × `(1 + 0,5·(n−1)) ·` el multiplicador de vida.
- Entre oleadas, los caídos vuelven con la mitad de su vida y los demás recuperan un cuarto. Se pierde cuando caen todos.

El servidor calcula el resultado al empezar y lo manda al anfitrión, así que cambiar los valores del `.env` basta para ajustarlo.

---

## API y protocolo

HTTP (todas salvo `/health` exigen el token en `x-svnz-token: <token>` o `Authorization: Bearer <token>`, y un `Origin` permitido):

| Ruta | Descripción |
| :--- | :--- |
| `GET /health` | Sonda de estado (pública). |
| `GET /api/info` | Personajes, amenazas, límites y dificultad. |
| `POST /api/rooms` `{ "mode": "coop" \| "vs" }` | Crea una sala: `{ code, hostKey, mode, max }`. |
| `GET /api/rooms/:code` | Estado público de una sala (existe, modo, jugadores, si se puede entrar). |

WebSocket: `wss://tu-servidor/ws`, con los sub-protocolos `svnz-v1` y `token.<GAME_TOKEN>` (el navegador no puede mandar cabeceras, por eso el token viaja ahí y no en la URL). Mensajes JSON; el primero debe ser `join` dentro de los 10 s.

| Cliente → servidor | Quién | Efecto |
| :--- | :--- | :--- |
| `{t:"join", code, name, key?}` | todos | Entra a la sala (`key` = clave de anfitrión, solo del creador). |
| `{t:"char", char}` / `{t:"team", team}` / `{t:"ready", ready}` | jugador | Personaje, equipo (VS) y «listo». |
| `{t:"mode", mode}` / `{t:"start"}` | anfitrión | Cambia el modo / empieza la partida. |
| `{t:"in", d}` | invitado | Estado de sus controles → llega solo al anfitrión. |
| `{t:"snap", d}` | anfitrión | Estado del mundo → llega a los invitados. |
| `{t:"end", d?}` | anfitrión | Termina la partida: todos vuelven al lobby. |

El servidor responde con `joined`, `room` (estado del lobby), `start` (con la dificultad), `in`, `snap`, `ended`, `left`, `closed`, `error` y `pong`. Los mensajes del lobby se validan con TypeBox; de `in`/`snap` solo se mira el tamaño: el servidor nunca interpreta ni ejecuta su contenido.

## Seguridad, en resumen

Token comparado en tiempo constante · orígenes permitidos (HTTP y WebSocket) · límite de pedidos por IP · límite de salas creadas por IP · tope de salas y de conexiones por IP · tope de mensajes por segundo y de tamaño por conexión (se cierra el socket si se pasa) · todos los mensajes validados · apodos limpiados · acciones de anfitrión comprobadas en el servidor · `helmet` · cuerpo JSON de máx. 2 kB · sin estado en disco · IP real solo de `CF-Connecting-IP` cuando lo activás.

## Limitaciones conocidas

- La pelea corre en el navegador del anfitrión: **tiene que mantener la pestaña visible** (si el navegador la suspende, la partida se congela y los invitados ven «se perdió la conexión» a los 12 s).
- Los invitados juegan con la latencia de ida y vuelta al anfitrión (se muestra el *ping* en el lobby); en VS el anfitrión tiene la ventaja de no tener retraso.
- El anfitrión es quien manda: es un juego entre amigos, no hay protección contra un anfitrión tramposo.

## Estructura

```text
src/
  index.ts      arranque
  config.ts     variables de entorno
  http.ts       Express: seguridad, CORS, límites, puente hacia Elysia
  api.ts        Elysia: /health y /api/*
  ws.ts         WebSocket: lobby y retransmisión
  rooms.ts      salas, equipos, reglas del lobby
  protocol.ts   esquemas de los mensajes
  security.ts   token, orígenes, IP real, Cloudflare Access, presupuesto de mensajes
  game.ts       personajes y dificultad
scripts/smoke.ts   prueba de punta a punta (npm test)
```

## Créditos

Servidor escrito por **Claude** con [Vicemi](https://vicemi.dev) como director del proyecto. *Super Vampire Ninja Zero* es de Batoví Games Studio; este es un proyecto de fans sin fines de lucro.
