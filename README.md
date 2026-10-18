# collaborative-canvas

Real-time collaborative canvas built with React, TypeScript and WebSockets.

**Demo:** https://collaborative-canvas-production-1837.up.railway.app

> **Estado:** en desarrollo (semana 6 de 8). Cada lienzo tiene su propia URL (`/c/<id>`) y quien la abra dibuja en el mismo lienzo en tiempo real: se ven los trazos de los demás mientras los dibujan, sus cursores con nombre y quién está conectado. Cada trazo terminado se guarda en PostgreSQL con un número de secuencia propio del lienzo; si se corta la conexión, los pendientes se reenvían al volver y solo se descargan los trazos que faltan. Cada persona puede deshacer y rehacer sus propios trazos (Ctrl+Z, Ctrl+Shift+Z) sin tocar los de los demás.

## Estructura

```
packages/
  client/   React + TypeScript + Vite (canvas)
  server/   Node.js + TypeScript (API, WebSockets, PostgreSQL y estáticos)
  shared/   Tipos compartidos entre cliente y servidor
DECISIONES.md   Registro de decisiones técnicas
```

## Requisitos

- Node.js 20 o superior
- PostgreSQL 17, con Docker o instalado en el sistema

## Base de datos local

El servidor espera por defecto `postgres://canvas:canvas@localhost:5432/canvas`.

**Con Docker:**

```bash
docker compose up -d   # PostgreSQL local en el puerto 5432
```

**Con PostgreSQL instalado** (por ejemplo el instalador de Windows, que deja el servicio `postgresql-x64-17` en marcha): crea una vez el usuario y la base de datos con el superusuario `postgres`.

```bash
psql -h localhost -U postgres -c "CREATE ROLE canvas LOGIN PASSWORD 'canvas'" -c "CREATE DATABASE canvas OWNER canvas"
```

En Windows, `psql` está en `C:\Program Files\PostgreSQL\17\bin` si no lo tienes en el `PATH`.

## Desarrollo

```bash
npm install
npm run dev
```

- Cliente: http://localhost:5173
- Servidor: http://localhost:3001 (`/api/health`)

Al abrir `/` se crea un lienzo nuevo y la URL pasa a `/c/<id>`; comparte esa URL para volver al mismo lienzo.

### API

| Método y ruta                    | Qué hace                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /api/canvases`             | Crea un lienzo. `201 { id }`                                                                    |
| `GET /api/canvases/:id`          | Lienzo con sus trazos visibles en orden (cada uno con su `seq`). `200 { id, strokes }` o `404`  |
| `POST /api/canvases/:id/strokes` | Guarda un trazo. `201 { id, seq }` si es nuevo, `200` si ese `id` ya existía, `400`/`404`/`409` |
| `GET /api/health`                | Estado del servidor y de la base de datos. `200` o `503`                                        |

### Tiempo real

El cliente abre un WebSocket en `/api/canvases/:id/ws?name=…&color=…&user=…&since=…` por lienzo; `name` y `color` son el seudónimo con el que le ven los demás, `user` es un UUID secreto de la pestaña que identifica sus trazos para poder deshacerlos y `since`, el último `seq` hasta el que tiene todas las operaciones (0 la primera vez). Los mensajes son JSON y sus tipos están en `packages/shared` (`ClientMessage` y `ServerMessage`):

| Dirección          | Mensaje                                        | Cuándo                                                           |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| servidor → cliente | `welcome { peers }`                            | Al entrar en la sala: quién más está y dónde tiene el cursor     |
| servidor → cliente | `snapshot { since, strokes, changes }`         | Después: trazos y cambios con `seq` mayor que `since`, en orden  |
| cliente → servidor | `stroke { stroke }`                            | Al terminar un trazo, y otra vez al reconectar si no hubo ack    |
| cliente → servidor | `visibility { change }`                        | Deshacer (`visible: false`) o rehacer un trazo propio            |
| servidor → cliente | `ack { id, seq }`                              | El trazo o el cambio está guardado con ese `seq`                 |
| servidor → cliente | `stroke { stroke }`                            | Otro usuario del mismo lienzo terminó un trazo (con su `seq`)    |
| servidor → cliente | `visibility { change }`                        | Otro usuario deshizo o rehízo uno de sus trazos (con su `seq`)   |
| servidor → cliente | `rejected { id, error }`                       | El trazo o el cambio no es válido y no se guardará               |
| servidor → cliente | `not-found` y cierre `4404`                    | El lienzo no existe                                              |
| cliente → servidor | `live { stroke }`                              | Mientras se dibuja, hasta 20 por segundo, solo los puntos nuevos |
| servidor → cliente | `live { peerId, stroke }`                      | Puntos nuevos del trazo que otro está dibujando (no guardados)   |
| servidor → cliente | `live-cancel { peerId, id }`                   | Ese trazo en curso fue rechazado y no se guardará                |
| cliente → servidor | `cursor { position }`                          | El puntero se mueve (hasta 20 por segundo) o sale (`null`)       |
| servidor → cliente | `cursor { peerId, position }`                  | Otro movió el puntero                                            |
| servidor → cliente | `peer-joined { peer }`, `peer-left { peerId }` | Alguien abre o cierra el lienzo                                  |

`live` y `cursor` son efímeros: no se guardan, no esperan a la base de datos y el servidor los descarta si un cliente envía demasiados o no da abasto para recibirlos (decisión 011).

Cada lienzo numera sus trazos guardados 1, 2, 3… sin huecos, y todos los clientes los dibujan en ese orden. Al reconectar, el cliente pide los posteriores al último número que tiene sin huecos, no al mayor que ha visto (decisión 012).

Deshacer no borra: oculta el trazo con un cambio de visibilidad que se numera en la misma secuencia, y rehacer lo vuelve a mostrar en su sitio. Solo el autor puede cambiar sus trazos (decisión 013).

Sin `DATABASE_URL`, el servidor se conecta a la base de datos de `docker-compose.yml`. Para usar otra, define `DATABASE_URL` (por ejemplo `postgres://usuario:clave@host:5432/bd`). Las migraciones se aplican solas al arrancar.

## Scripts

| Comando             | Qué hace                                 |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Arranca cliente y servidor en modo watch |
| `npm run build`     | Compila cliente y servidor               |
| `npm run lint`      | ESLint sobre todo el repo                |
| `npm run typecheck` | Comprobación de tipos en ambos paquetes  |
| `npm test`          | Tests del servidor y del cliente         |
| `npm run format`    | Formatea el código con Prettier          |

## Docker

```bash
docker build -t collaborative-canvas .
docker run -p 3001:3001 -e DATABASE_URL=postgres://... collaborative-canvas
```

La imagen contiene el servidor y el cliente compilado; abre http://localhost:3001.

## Despliegue

En [Railway](https://railway.com), con el repositorio enlazado: cada push a `main` construye el `Dockerfile` y despliega. PostgreSQL es un servicio del mismo proyecto y el servidor recibe su `DATABASE_URL` como variable de entorno. Los motivos están en la decisión 006 de `DECISIONES.md`.

## Licencia

MIT
