# collaborative-canvas

Real-time collaborative canvas built with React, TypeScript and WebSockets.

**Demo:** https://collaborative-canvas-production-1837.up.railway.app

> **Estado:** en desarrollo (semana 2 de 8). Cada lienzo tiene su propia URL (`/c/<id>`) y sus trazos se guardan en PostgreSQL, así que sobreviven a recargar la página. La colaboración en tiempo real llega en las semanas 3 y 4.

## Estructura

```
packages/
  client/   React + TypeScript + Vite (canvas)
  server/   Node.js + TypeScript (API, PostgreSQL y servidor de estáticos)
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

| Método y ruta                    | Qué hace                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/canvases`             | Crea un lienzo. `201 { id }`                                                  |
| `GET /api/canvases/:id`          | Lienzo con sus trazos en orden. `200 { id, strokes }` o `404`                 |
| `POST /api/canvases/:id/strokes` | Guarda un trazo. `201` si es nuevo, `200` si ese `id` ya existía, `400`/`404` |
| `GET /api/health`                | Estado del servidor y de la base de datos. `200` o `503`                      |

Sin `DATABASE_URL`, el servidor se conecta a la base de datos de `docker-compose.yml`. Para usar otra, define `DATABASE_URL` (por ejemplo `postgres://usuario:clave@host:5432/bd`). Las migraciones se aplican solas al arrancar.

## Scripts

| Comando             | Qué hace                                 |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Arranca cliente y servidor en modo watch |
| `npm run build`     | Compila cliente y servidor               |
| `npm run lint`      | ESLint sobre todo el repo                |
| `npm run typecheck` | Comprobación de tipos en ambos paquetes  |
| `npm test`          | Tests (de momento, los del servidor)     |
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
