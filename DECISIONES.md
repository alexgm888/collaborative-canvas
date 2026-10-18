# Decisiones técnicas

Registro de decisiones del proyecto: qué se decidió, por qué y qué se descartó. Es la base del apartado de _trade-offs_ del README y material para entrevistas.

Formato de cada entrada: **contexto → decisión → alternativas → consecuencias**.

---

## 001 · Monorepo con npm workspaces

- **Contexto:** cliente y servidor comparten tipos y se despliegan juntos.
- **Decisión:** un único repositorio con `packages/client` y `packages/server`, gestionado con npm workspaces.
- **Alternativas:** dos repositorios (más fricción para cambios que tocan ambos lados); pnpm/Turborepo/Nx (más potentes, pero innecesarios para dos paquetes).
- **Consecuencias:** un solo `npm install`, una sola CI. Si crece, se puede migrar a pnpm sin cambiar la estructura.

## 002 · Los trazos son datos, no píxeles

- **Contexto:** el lienzo tiene que sincronizarse entre usuarios, reproducirse al entrar tarde y permitir deshacer.
- **Decisión:** el dibujo se modela como una lista de `Stroke` (id, color, grosor, puntos) y el canvas se redibuja a partir de ella.
- **Alternativas:** enviar la imagen o diferencias de píxeles (pesado, sin posibilidad de deshacer por autor ni de reconciliar).
- **Consecuencias:** cada trazo tiene identidad, lo que permitirá numeración de secuencia, reconexión y deshacer por usuario (semanas 5 y 6). A cambio, redibujar todo en cada evento no escala: habrá que medirlo y, si hace falta, usar capas o repintado incremental.

## 003 · Pointer Events en lugar de mouse/touch

- **Contexto:** el lienzo debe funcionar con ratón, táctil y lápiz.
- **Decisión:** usar `pointerdown/move/up` con `setPointerCapture` y `touch-action: none`.
- **Alternativas:** manejar `mouse*` y `touch*` por separado (código duplicado).
- **Consecuencias:** una sola ruta de código para todos los dispositivos.

## 004 · Servidor Node sin framework por ahora

- **Contexto:** en la semana 1 solo hace falta un endpoint de salud y servir el cliente compilado.
- **Decisión:** `node:http` y cero dependencias de runtime. WebSockets (`ws`) llegarán en la semana 3.
- **Alternativas:** Express/Fastify/NestJS desde el inicio.
- **Consecuencias:** esqueleto mínimo y fácil de entender. Si el servidor crece (rutas, validación, auth), se reevalúa Fastify.

## 005 · Un único contenedor para desplegar

- **Contexto:** simplificar el despliegue y evitar CORS entre cliente y API.
- **Decisión:** el servidor sirve también el cliente compilado (`client/dist`) y se empaqueta todo en una imagen Docker multi-stage.
- **Alternativas:** cliente en un hosting estático y servidor aparte (más piezas y CORS/WebSockets entre orígenes).
- **Consecuencias:** un solo servicio que desplegar. Sin CDN para estáticos; aceptable para este proyecto.

## 006 · Despliegue en Railway

- **Contexto:** hace falta un contenedor siempre encendido (WebSockets desde la semana 3) y PostgreSQL desde la semana 2, con poco presupuesto y 8-10 h semanales.
- **Decisión:** Railway, con el repo de GitHub enlazado: construye el `Dockerfile` y despliega en cada push a `main`. Se empieza en el plan gratuito y se pasa a Hobby (5 $/mes) al añadir PostgreSQL.
- **Alternativas:** Fly.io (sin capa gratuita y PostgreSQL gestionado desde 38 $/mes); Azure Container Apps + PostgreSQL Flexible Server (más configuración y hay que fijar una réplica para no cortar los WebSockets); un VPS propio (más barato a precio fijo, pero el sistema, HTTPS, reinicios y copias de seguridad corren de mi cuenta).
- **Consecuencias:** desplegar no cuesta tiempo y PostgreSQL vive en el mismo proyecto. A cambio hay menos control sobre la infraestructura y dependencia de un proveedor pequeño, mitigada por el contenedor: mudarse a otra plataforma solo cambia la configuración.

## 007 · PostgreSQL con `pg` y SQL a mano, sin ORM

- **Contexto:** hay que persistir lienzos y trazos. Son dos tablas y unas pocas consultas, pero de las que más se ejecutan (cargar un lienzo, guardar cada trazo).
- **Decisión:** driver `pg` (node-postgres) con un pool de conexiones y consultas SQL parametrizadas en un módulo de repositorio (`server/src/db`). Migraciones propias: una lista de SQL en código, numerada y solo de añadir, registrada en `schema_migrations` y aplicada al arrancar dentro de una transacción por migración y bajo un _advisory lock_ de PostgreSQL.
- **Alternativas:** Prisma o Drizzle (tipos generados y migraciones automáticas, pero una capa más que aprender y depurar para dos tablas); Kysely (constructor de consultas tipado, razonable si las consultas crecen); node-pg-migrate (migraciones maduras, pero otra dependencia para algo que hoy son 40 líneas).
- **Consecuencias:** el SQL que se ejecuta es exactamente el que se lee, y no hay paso de generación. El lock evita que dos contenedores apliquen la misma migración durante un despliegue solapado. A cambio, los tipos de las filas se escriben a mano y no hay migraciones hacia atrás: un error se corrige con una migración nueva. Si el esquema crece, se reevalúa Kysely.

## 008 · Esquema de trazos: un trazo por fila, puntos en JSONB

- **Contexto:** al abrir un lienzo hay que leer todos sus trazos en orden; cada trazo puede tener cientos de puntos.
- **Decisión:** tabla `strokes` con una fila por trazo y los puntos en una columna `jsonb`. El `id` (UUID) lo genera el cliente y es único, así que guardar el mismo trazo dos veces no lo duplica (`ON CONFLICT DO NOTHING`). Una columna `seq` de identidad fija el orden de repintado, con índice `(canvas_id, seq)`.
- **Alternativas:** una fila por punto (miles de filas por lienzo y reconstruir los trazos al leer); los puntos como `bytea` empaquetado (más compacto, pero opaco al consultar y a depurar); guardar el lienzo entero como un único documento (cada trazo reescribiría todo y habría conflictos entre usuarios).
- **Consecuencias:** cargar un lienzo es una sola consulta indexada y cada trazo es una inserción independiente, lo que encaja con sincronizar trazo a trazo en la semana 3. Los puntos `{x, y}` en JSONB ocupan más que un formato binario; si el tamaño importa se pueden guardar como pares `[x, y]`. `seq` es global; la secuencia por lienzo para la reconexión (semana 5) se decidirá entonces.

## 009 · API REST de lienzos y guardado trazo a trazo

- **Contexto:** cada lienzo necesita una URL que se pueda compartir y sus trazos tienen que sobrevivir a recargar la página. Aún no hay WebSockets (semana 3).
- **Decisión:** tres rutas sobre `node:http`: `POST /api/canvases` crea un lienzo con un id aleatorio de 72 bits en base64url (12 caracteres), `GET /api/canvases/:id` devuelve sus trazos en orden y `POST /api/canvases/:id/strokes` guarda un trazo en cuanto el usuario levanta el puntero. El servidor valida cada trazo (UUID, color `#rrggbb`, grosor y coordenadas acotadas, máximo 10 000 puntos, cuerpo de 1 MiB) y guarda solo los campos conocidos. El cliente reintenta los fallos de red y 5xx; como el id del trazo es suyo, un reintento no duplica nada. Un lienzo inexistente se detecta con la clave foránea, sin consulta previa.
- **Alternativas:** guardar el lienzo entero cada pocos segundos (reescribe todo y pierde trazos si se cierra la pestaña); ids secuenciales o legibles (cualquiera podría recorrer los lienzos de otros); una librería de validación como Zod (cómoda, pero para un único tipo bastan 50 líneas probadas); pasar ya a Fastify (decisión 004: aún son tres rutas).
- **Consecuencias:** cada trazo es una petición pequeña e independiente, el mismo modelo que se enviará por WebSocket en la semana 3, donde la validación se reutilizará tal cual. El id del lienzo funciona como enlace secreto: quien lo tiene puede dibujar; no hay cuentas ni permisos. Un trazo que falla tras los reintentos queda dibujado en pantalla pero no guardado, y la barra lo indica.

## 010 · Sincronización por WebSocket: una sala por lienzo, guardar y después difundir

- **Contexto:** varios usuarios con la misma URL tienen que ver los trazos de los demás sin recargar. La semana 3 cubre trazos terminados; los trazos en vivo, cursores y presencia son de la semana 4 y la reconexión incremental, de la 5.
- **Decisión:** librería `ws` montada sobre el mismo servidor `node:http`, en `/api/canvases/:id/ws`. El servidor guarda en memoria una sala (un `Set` de conexiones) por lienzo. Al conectar envía un `snapshot` con todos los trazos; el cliente manda cada trazo terminado, el servidor lo valida con el mismo `parseStroke` que la API REST, lo guarda en PostgreSQL y solo entonces lo difunde al resto de la sala y confirma al autor con un `ack`. El cliente dibuja su trazo al instante y lo guarda en una bandeja de salida hasta el `ack`; en cada reconexión (backoff de 0,5 s a 10 s con _jitter_) reenvía la bandeja y recibe un `snapshot` nuevo que fusiona por id. Un error de base de datos cierra la conexión con `1011`, de modo que el reintento usa el mismo camino que un corte de red. Un ping cada 30 s detecta conexiones muertas y evita que el proxy de Railway corte las inactivas; un cliente con más de 8 MiB sin enviar se desconecta en lugar de acumular memoria.
- **Alternativas:** Socket.IO (salas, reconexión y _fallback_ incluidos, pero un protocolo propio encima de WebSocket y más peso en el cliente; el objetivo aquí es entender y explicar esas piezas); seguir guardando por REST y usar el WebSocket o SSE solo para difundir (dos canales que pueden desordenarse entre sí); difundir antes de guardar (menos latencia, pero otros verían trazos que una recarga perdería); un servicio gestionado como Liveblocks o Ably (resuelve el problema que el proyecto quiere demostrar).
- **Consecuencias:** un trazo visible para otros siempre está guardado, y reenviar es seguro porque el id del trazo es del cliente (decisión 008). Cada mensaje de una conexión se procesa en orden, así que los trazos de un mismo autor se guardan en el orden en que se dibujaron. Limitaciones conocidas: el orden entre autores puede diferir en pantalla hasta la siguiente reconexión (cada cliente añade al final lo que recibe, PostgreSQL ordena por `seq`); reconectar descarga el lienzo entero, lo que la semana 5 sustituirá por una resincronización desde la última secuencia vista; y las salas viven en la memoria de un solo proceso, así que escalar a varias instancias requiere un bus como Redis pub/sub (opcional en el plan). No hay comprobación de `Origin`: no hay cookies ni sesiones que secuestrar, y el id del lienzo ya es la credencial.
