# collaborative-canvas

Real-time collaborative canvas built with React, TypeScript and WebSockets.

[![CI](https://github.com/alexgm888/collaborative-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/alexgm888/collaborative-canvas/actions/workflows/ci.yml)

**Demo:** https://collaborative-canvas-production-1837.up.railway.app — abre el enlace, copia la URL del lienzo y ábrela en otra pestaña u otro dispositivo.

Una pizarra compartida: cada lienzo tiene su URL (`/c/<id>`) y quien la abre dibuja con los demás en tiempo real. Ves los trazos ajenos mientras se dibujan, los cursores con nombre y quién está conectado. Cada uno deshace y rehace sus propios trazos sin tocar los de los demás. Si se corta la conexión no se pierde nada: lo pendiente se reenvía y solo se descarga lo que falta.

El proyecto no busca tener muchas funciones, sino resolver bien las partes difíciles de la colaboración en tiempo real y poder explicar cada decisión. Las 15 decisiones, con sus alternativas descartadas, están en [DECISIONES.md](DECISIONES.md).

## En cifras

- **50 personas dibujando en el mismo lienzo en producción:** un trazo se guarda y llega a los demás en 44 ms (p95), un cursor en 73 ms. Al terminar, los 50 clientes tienen las mismas 1 065 operaciones en el mismo orden y sin huecos. [Resultados](docs/carga/README.md).
- **100 personas en un lienzo o 200 en diez** en local, con el servidor por debajo del 50 % de un núcleo.
- **La primera prueba de carga tumbó el servidor** (los `ack` tardaban más de un minuto). Medirlo, encontrar la causa y arreglarlo está documentado en la [decisión 015](DECISIONES.md#015--cursores-y-trazos-en-vivo-agrupados-por-sala-cada-50-ms).
- **105 tests:** unitarios, del protocolo en tiempo real, del SQL contra PostgreSQL real y del cliente con un WebSocket falso. CI los ejecuta en cada PR con un PostgreSQL 17.

## Arquitectura

```mermaid
flowchart LR
  subgraph Navegador["Navegador (React + Canvas 2D)"]
    UI[Lienzo en dos capas<br/>guardado + en vivo]
    CC[CanvasConnection<br/>bandeja de salida, deshacer,<br/>reconexión con backoff]
    UI <--> CC
  end
  subgraph Servidor["Servidor Node (un contenedor)"]
    WS[Sala por lienzo<br/>cola por conexión]
    B[Lote de efímeros<br/>cada 50 ms]
    API[REST + estáticos]
  end
  DB[(PostgreSQL<br/>strokes, stroke_visibility,<br/>canvases.last_seq)]

  CC -- "stroke / visibility (duraderos)" --> WS
  CC -- "live / cursor (efímeros)" --> B
  WS -- "guardar en transacción" --> DB
  WS -- "ack + difusión con seq" --> CC
  B -- "batch" --> CC
  API --> DB
```

Hay dos clases de mensajes por el mismo WebSocket, y la mayor parte del diseño sale de tratarlas distinto:

|                             | Duraderos: trazos terminados, deshacer y rehacer                   | Efímeros: trazo en curso, cursores           |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| **Se guardan**              | Sí, en PostgreSQL, antes de enseñárselos a nadie                   | Nunca                                        |
| **Orden**                   | Total, decidido por el servidor con un `seq` sin huecos por lienzo | Da igual: el siguiente sustituye al anterior |
| **Si se pierden**           | Se reenvían hasta recibir `ack`; reenviar no duplica               | No pasa nada                                 |
| **Si el servidor va justo** | Esperan en la cola de su conexión                                  | Se descartan (_token bucket_, búfer lleno)   |
| **Reparto**                 | Uno a uno, en cuanto se guardan                                    | Agrupados por sala, un `batch` cada 50 ms    |

### Cómo funciona un trazo

1. **Dibujas.** El trazo aparece al instante en tu pantalla y sus puntos nuevos salen como `live` cada 50 ms, que los demás pintan en una capa superior.
2. **Sueltas el puntero.** El trazo completo, con un UUID generado en el cliente, entra en la bandeja de salida y se envía como `stroke`.
3. **El servidor lo guarda.** En una transacción incrementa `canvases.last_seq`, inserta el trazo con ese número y confirma. Si falla, el `ROLLBACK` deshace también el contador: no quedan huecos.
4. **Lo reparte.** Los demás reciben el trazo con su `seq` y tú, un `ack`. Hasta ese `ack` sigue en tu bandeja de salida.
5. **Si se corta la conexión,** el cliente reconecta con _backoff_ y _jitter_, pide `?since=<último seq sin huecos>` y reenvía su bandeja. Como el id es del cliente, un reenvío de algo ya guardado devuelve el `seq` original en lugar de duplicarlo.

Deshacer sigue el mismo camino: es una operación `visibility` con su propio `seq`, no un borrado.

## Trade-offs

Las decisiones que más se discuten en una entrevista. Cada una enlaza a su entrada completa en [DECISIONES.md](DECISIONES.md).

| Decisión                                                                                                                                                                                         | Lo que gano                                                                                       | Lo que pago                                                                                                   | Descartado                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Guardar y después difundir** ([010](DECISIONES.md#010--sincronización-por-websocket-una-sala-por-lienzo-guardar-y-después-difundir))                                                           | Lo que ve otro siempre está guardado; una recarga nunca lo pierde                                 | Una ida y vuelta a la base de datos antes de que otros vean el trazo terminado (el trazo en vivo lo disimula) | Difundir antes de guardar                                             |
| **Secuencia sin huecos por lienzo** ([012](DECISIONES.md#012--reconexión-sin-pérdidas-secuencia-sin-huecos-por-lienzo))                                                                          | Reconectar descarga solo lo que falta; todos ven el mismo orden; un cliente sabe si le falta algo | Las escrituras de un mismo lienzo se serializan en su fila (milisegundos a esta escala)                       | Identidad global de PostgreSQL (tiene huecos), marcas de tiempo, CRDT |
| **Deshacer como operación, no como borrado** ([013](DECISIONES.md#013--deshacer-y-rehacer-por-usuario-como-operaciones-de-visibilidad))                                                          | Deshacer viaja, se confirma y se recupera igual que un trazo; rehacer lo devuelve a su sitio      | El registro solo crece; una carga completa trae todos los cambios                                             | Borrar; deshacer global; OT o CRDT                                    |
| **Sin CRDT ni OT** ([012](DECISIONES.md#012--reconexión-sin-pérdidas-secuencia-sin-huecos-por-lienzo), [013](DECISIONES.md#013--deshacer-y-rehacer-por-usuario-como-operaciones-de-visibilidad)) | Un modelo que se explica en una frase: trazos inmutables, un orden total que decide el servidor   | No serviría para editar el mismo objeto a la vez ni para trabajar sin conexión durante horas                  | Yjs, Automerge                                                        |
| **Efímeros agrupados cada 50 ms** ([015](DECISIONES.md#015--cursores-y-trazos-en-vivo-agrupados-por-sala-cada-50-ms))                                                                            | El reparto deja de ser cuadrático en mensajes: de 108 % de CPU a 34 % con 50 personas             | Hasta 50 ms más de latencia en cursores                                                                       | MessagePack, compresión, Redis                                        |
| **WebSocket a mano con `ws`** ([010](DECISIONES.md#010--sincronización-por-websocket-una-sala-por-lienzo-guardar-y-después-difundir))                                                            | Entender y poder explicar salas, reconexión, _backpressure_ y _heartbeat_                         | Escribirlo y probarlo yo                                                                                      | Socket.IO, Liveblocks, Ably                                           |
| **SQL a mano, sin ORM** ([007](DECISIONES.md#007--postgresql-con-pg-y-sql-a-mano-sin-orm))                                                                                                       | El SQL que se ejecuta es el que se lee: transacciones y bloqueos a la vista                       | Tipos de filas escritos a mano                                                                                | Prisma, Drizzle, Kysely                                               |
| **Un contenedor, una instancia** ([005](DECISIONES.md#005--un-único-contenedor-para-desplegar), [006](DECISIONES.md#006--despliegue-en-railway))                                                 | Desplegar no cuesta nada; sin CORS                                                                | Las salas viven en la memoria de un proceso                                                                   | Varias instancias con Redis pub/sub                                   |
| **Tests contra PostgreSQL real** ([014](DECISIONES.md#014--tests-contra-postgresql-real-y-del-cliente-con-un-websocket-falso))                                                                   | El contador y los bloqueos se prueban en el motor de verdad                                       | Necesitan una base de datos (opcional en local, siempre en CI)                                                | pg-mem, PGlite, Testcontainers                                        |

## Limitaciones conocidas

Lo que no está resuelto, a propósito o por tiempo:

- **Una sola instancia del servidor.** Para crecer en número de lienzos haría falta repartir salas entre procesos con Redis pub/sub. Para una sala muy grande no basta: el límite pasa a ser el ancho de banda de cursores (~440 KB/s por navegador con 100 personas).
- **Sin cuentas.** El id del lienzo es la credencial: quien tiene el enlace dibuja. La identidad para deshacer es un UUID por pestaña en `sessionStorage`; duplicar la pestaña la comparte.
- **El historial de deshacer se pierde al recargar.** Los trazos siguen siendo tuyos, pero la pila empieza vacía.
- **Sin compactación.** Una carga completa trae todos los cambios de visibilidad, cuando bastaría el último de cada trazo.
- **Redibujar escala con el número de trazos.** La capa de trazos guardados se repinta entera cuando cambia; con miles de trazos haría falta repintado incremental o _tiles_.

## Si siguiera

En orden de lo que más aportaría:

1. **Exportar a PNG.** Pequeño y útil.
2. **Redis pub/sub** para varias instancias, con una prueba de carga que lo demuestre.
3. **Guardar el lienzo en IndexedDB** para abrir al instante y pedir solo lo nuevo también tras recargar.
4. **Cursores adaptativos:** menos frecuencia en salas grandes.

## Stack

- **Cliente:** React 18, TypeScript, Vite, Canvas 2D, Pointer Events. Sin librerías de estado ni de dibujo.
- **Servidor:** Node.js con `node:http` y `ws`, sin framework. PostgreSQL 17 con `pg` y migraciones propias.
- **Calidad:** `node:test`, ESLint, Prettier, GitHub Actions con un PostgreSQL de servicio.
- **Carga:** generador propio con _worker threads_ que habla el mismo protocolo que el navegador (`packages/loadtest`).
- **Despliegue:** imagen Docker multi-stage en Railway, desplegada en cada push a `main`.

```
packages/
  client/   React + TypeScript + Vite (canvas)
  server/   Node.js + TypeScript (API, WebSockets, PostgreSQL y estáticos)
  shared/   Tipos del protocolo compartidos entre cliente y servidor
  loadtest/ Generador de carga: clientes WebSocket simulados
docs/carga/     Resultados de las pruebas de carga
DECISIONES.md   Registro de decisiones técnicas
```

---

## Desarrollo

### Requisitos

- Node.js 20 o superior
- PostgreSQL 17, con Docker o instalado en el sistema

### Base de datos local

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

Para usar otra base de datos, define `DATABASE_URL` (por ejemplo `postgres://usuario:clave@host:5432/bd`). Las migraciones se aplican solas al arrancar.

### Arrancar

```bash
npm install
npm run dev
```

- Cliente: http://localhost:5173
- Servidor: http://localhost:3001 (`/api/health`)

Al abrir `/` se crea un lienzo nuevo y la URL pasa a `/c/<id>`; comparte esa URL para volver al mismo lienzo.

### Scripts

| Comando             | Qué hace                                 |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Arranca cliente y servidor en modo watch |
| `npm run build`     | Compila cliente y servidor               |
| `npm run lint`      | ESLint sobre todo el repo                |
| `npm run typecheck` | Comprobación de tipos en ambos paquetes  |
| `npm test`          | Tests del servidor y del cliente         |
| `npm run loadtest`  | Prueba de carga (`-- --help`)            |
| `npm run format`    | Formatea el código con Prettier          |

### Tests

`npm test` ejecuta los tests unitarios y los del tiempo real con un almacén en memoria. Los que necesitan PostgreSQL (`*.db.test.ts`: el SQL de secuencias, deshacer y un recorrido REST + WebSocket completo) solo corren si se define `TEST_DATABASE_URL`; cada archivo trabaja en un esquema propio que borra al terminar, así que puede apuntar a la base de desarrollo (decisión 014). CI los ejecuta siempre con un PostgreSQL 17.

```bash
TEST_DATABASE_URL=postgres://canvas:canvas@localhost:5432/canvas npm test
```

### Docker

```bash
docker build -t collaborative-canvas .
docker run -p 3001:3001 -e DATABASE_URL=postgres://... collaborative-canvas
```

La imagen contiene el servidor y el cliente compilado; abre http://localhost:3001.

### Despliegue

En [Railway](https://railway.com), con el repositorio enlazado: cada push a `main` construye el `Dockerfile` y despliega. PostgreSQL es un servicio del mismo proyecto y el servidor recibe su `DATABASE_URL` como variable de entorno (decisión 006).

## Protocolo

### API REST

| Método y ruta                    | Qué hace                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /api/canvases`             | Crea un lienzo. `201 { id }`                                                                    |
| `GET /api/canvases/:id`          | Lienzo con sus trazos visibles en orden (cada uno con su `seq`). `200 { id, strokes }` o `404`  |
| `POST /api/canvases/:id/strokes` | Guarda un trazo. `201 { id, seq }` si es nuevo, `200` si ese `id` ya existía, `400`/`404`/`409` |
| `GET /api/health`                | Estado del servidor y de la base de datos. `200` o `503`                                        |

### Tiempo real

El cliente abre un WebSocket en `/api/canvases/:id/ws?name=…&color=…&user=…&since=…` por lienzo; `name` y `color` son el seudónimo con el que le ven los demás, `user` es un UUID secreto de la pestaña que identifica sus trazos para poder deshacerlos y `since`, el último `seq` hasta el que tiene todas las operaciones (0 la primera vez). Los mensajes son JSON y sus tipos están en `packages/shared` (`ClientMessage` y `ServerMessage`):

| Dirección          | Mensaje                                        | Cuándo                                                               |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| servidor → cliente | `welcome { you, peers }`                       | Al entrar en la sala: tu id y quién más está y dónde tiene el cursor |
| servidor → cliente | `snapshot { since, strokes, changes }`         | Después: trazos y cambios con `seq` mayor que `since`, en orden      |
| cliente → servidor | `stroke { stroke }`                            | Al terminar un trazo, y otra vez al reconectar si no hubo ack        |
| cliente → servidor | `visibility { change }`                        | Deshacer (`visible: false`) o rehacer un trazo propio                |
| servidor → cliente | `ack { id, seq }`                              | El trazo o el cambio está guardado con ese `seq`                     |
| servidor → cliente | `stroke { stroke }`                            | Otro usuario del mismo lienzo terminó un trazo (con su `seq`)        |
| servidor → cliente | `visibility { change }`                        | Otro usuario deshizo o rehízo uno de sus trazos (con su `seq`)       |
| servidor → cliente | `rejected { id, error }`                       | El trazo o el cambio no es válido y no se guardará                   |
| servidor → cliente | `not-found` y cierre `4404`                    | El lienzo no existe                                                  |
| cliente → servidor | `live { stroke }`                              | Mientras se dibuja, hasta 20 por segundo, solo los puntos nuevos     |
| servidor → cliente | `live-cancel { peerId, id }`                   | Ese trazo en curso fue rechazado y no se guardará                    |
| cliente → servidor | `cursor { position }`                          | El puntero se mueve (hasta 20 por segundo) o sale (`null`)           |
| servidor → cliente | `batch { messages }`                           | Cada 50 ms: último cursor de cada uno y puntos en vivo nuevos        |
| servidor → cliente | `peer-joined { peer }`, `peer-left { peerId }` | Alguien abre o cierra el lienzo                                      |

## Licencia

MIT
