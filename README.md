# collaborative-canvas

Real-time collaborative canvas built with React, TypeScript and WebSockets.

> **Estado:** en desarrollo (semana 1 de 8). De momento se puede pintar en local; la colaboración en tiempo real llega en las semanas 3 y 4.

## Estructura

```
packages/
  client/   React + TypeScript + Vite (canvas)
  server/   Node.js + TypeScript (API y servidor de estáticos)
DECISIONES.md   Registro de decisiones técnicas
```

## Requisitos

- Node.js 20 o superior

## Desarrollo

```bash
npm install
npm run dev
```

- Cliente: http://localhost:5173
- Servidor: http://localhost:3001 (`/api/health`)

## Scripts

| Comando             | Qué hace                                  |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Arranca cliente y servidor en modo watch  |
| `npm run build`     | Compila cliente y servidor                |
| `npm run lint`      | ESLint sobre todo el repo                 |
| `npm run typecheck` | Comprobación de tipos en ambos paquetes   |
| `npm run format`    | Formatea el código con Prettier           |

## Docker

```bash
docker build -t collaborative-canvas .
docker run -p 3001:3001 collaborative-canvas
```

La imagen contiene el servidor y el cliente compilado; abre http://localhost:3001.

## Licencia

MIT
