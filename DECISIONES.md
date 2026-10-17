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
