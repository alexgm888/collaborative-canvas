# Pruebas de carga

El generador está en `packages/loadtest`. Simula personas reales con clientes WebSocket del mismo protocolo que el navegador:

- **Cursor:** cada persona mueve el puntero y manda un `cursor` 20 veces por segundo.
- **Trazos:** dibuja un trazo cada 1-3 s, de 0,5-1,5 s de duración. Mientras dibuja manda `live` con los puntos nuevos cada 50 ms, igual que `connection.ts`.
- **Deshacer:** deshace el 10 % de sus trazos.

Al terminar, el generador espera a que se confirme todo lo pendiente. Después comprueba que **todos los clientes tienen exactamente las mismas operaciones con el mismo `seq`, sin huecos**, y que coinciden con lo que recibe un cliente nuevo que entra desde cero.

```bash
npm run build -w @canvas/server && node packages/server/dist/index.js   # en otra terminal
npm run loadtest -- --clients 50 --duration 60 --out docs/carga/resultado.json
npm run loadtest -- --help
```

Contra producción se lanza desde GitHub Actions con el workflow `Load test` (ver más abajo).

Cómo mide:

- **Hilos:** los clientes se reparten en _worker threads_ para que el generador no sea el cuello de botella. El informe incluye cuánto estuvo ocupado cada hilo.
- **Latencia de envío a recepción:** solo se mide entre clientes del mismo hilo, que comparten reloj. Es una muestra aleatoria de todas las entregas.
- **Sonda del servidor:** un `GET /api/health` cada 250 ms mide desde fuera cuánto tarda en responder el bucle de eventos del servidor.
- **Entrega de efímeros:** cuenta lo recibido frente a lo que llegaría si el servidor no descartase nada. En cursores es menor que 1 por diseño desde la semana 7, porque solo se envía el último de cada persona por intervalo. Los puntos en vivo deberían llegar todos.

## Resultados

Ejecutado el 2026-10-18 en un portátil con Windows 10, 4 núcleos y 8 GB, con el servidor compilado (`node dist/index.js`), PostgreSQL 17 y el generador en la misma máquina. La CPU es la del proceso servidor, en porcentaje de un núcleo. Los JSON completos están junto a este archivo.

### 50 personas en un lienzo, antes y después de agrupar los efímeros

| Métrica                               | Semana 6                  | Semana 7 (lotes cada 50 ms) |
| ------------------------------------- | ------------------------- | --------------------------- |
| `ack` de un trazo, p50 / p95          | > 60 s / > 60 s           | 19,5 / 53 ms                |
| Trazo visto por los demás, p50 / p95  | 52,7 / 54,9 s             | 18,2 / 51,9 ms              |
| Cursor visto por los demás, p50 / p95 | 6,1 / 12,2 s              | 25,5 / 80,8 ms              |
| Puntos en vivo entregados             | 44 %                      | 100 %                       |
| Sonda HTTP del servidor, p95          | > 10 s (sin respuesta)    | 16,5 ms                     |
| CPU del servidor, pico                | 108 %                     | 34 %                        |
| Mensajes WebSocket recibidos/s        | 30 660 (uno por evento)   | 2 005 (lotes)               |
| Consistencia final                    | 687 operaciones sin `ack` | ok, idéntica y sin huecos   |

Ficheros: `semana6-50-personas.json` y `semana7-50-personas.json`.

**Por qué colapsaba la semana 6:**

1. **El reenvío crece con el cuadrado de la sala.** Cada cursor y cada trozo en vivo se reenviaba uno a uno a cada persona: 50 personas × ~27 mensajes/s × 49 destinatarios son unos 66 000 envíos por segundo.
2. **Cada envío costaba trabajo propio.** Cada uno llevaba su propio `JSON.stringify` y su escritura en el socket, así que el proceso Node se quedaba al 100 % de un núcleo.
3. **Los mensajes guardados quedaban atascados detrás.** Con el bucle de eventos saturado, los `ack` y los trazos guardados esperaban detrás de segundos de cursores en el búfer de cada socket.
4. **PostgreSQL cortó las conexiones.** Las que esperaban en el bucle bloqueado se cortaron (`ECONNRESET`), los guardados fallaron con `1011` y quedaron operaciones sin confirmar. El protocolo no perdió nada: esos clientes las habrían reenviado al reconectar.

La solución está en la decisión 015.

### Hasta dónde llega (semana 7)

| Escenario                      | `ack` p95 | Trazo a otros p95 | Cursor a otros p95 | CPU servidor (pico) | Memoria | Consistencia |
| ------------------------------ | --------- | ----------------- | ------------------ | ------------------- | ------- | ------------ |
| 50 personas, 1 lienzo, 60 s    | 53 ms     | 51,9 ms           | 80,8 ms            | 34 %                | 68 MB   | ok           |
| 100 personas, 1 lienzo, 45 s   | 66,1 ms   | 63,5 ms           | 85,5 ms            | 40 %                | 76 MB   | ok           |
| 200 personas, 10 lienzos, 45 s | 54,2 ms   | 53,5 ms           | 81,3 ms            | 50 %                | 100 MB  | ok           |

- **Una sala de 100 personas** genera unos 44 MB/s de salida en total: unos 440 KB/s (~3,5 Mbit/s) por navegador, en su mayoría cursores. Ahí el límite pasa a ser el ancho de banda de cada cliente y el del servidor en la nube, más que su CPU; si hiciera falta, el siguiente paso sería mandar los cursores con menos frecuencia en salas grandes.
- **El máximo de 29 s en cursores** del escenario de 200 personas es un artefacto del medidor, ya corregido: dos cursores en la misma esquina exacta compartían clave.

### Producción (Railway), desde GitHub Actions

Ejecutado el 2026-10-18 con el workflow `Load test` (pestaña Actions → _Load test_ → _Run workflow_, o `gh workflow run loadtest.yml`). El generador corre en una máquina de GitHub y ataca el despliegue real de Railway, con su PostgreSQL gestionado y a través de internet. Fichero: `produccion-50-personas.json`.

| 50 personas, 1 lienzo, 60 s             | p50      | p95      | p99      |
| --------------------------------------- | -------- | -------- | -------- |
| Entrar en el lienzo (hasta el snapshot) | 110,6 ms | 133,1 ms | 158,9 ms |
| `ack` de un trazo                       | 33,9 ms  | 43,7 ms  | 73,3 ms  |
| Trazo visto por los demás               | 33,9 ms  | 43,7 ms  | 67,4 ms  |
| Deshacer visto por los demás            | 36,9 ms  | 47,5 ms  | 91,3 ms  |
| Cursor visto por los demás              | 44,3 ms  | 73,1 ms  | 78,1 ms  |
| Puntos en vivo vistos por los demás     | 47 ms    | 76,2 ms  | 82 ms    |
| Sonda HTTP (`/api/health`)              | 20,1 ms  | 23,8 ms  | 27,2 ms  |

Resultados:

- **Sin errores ni cortes, y consistencia ok:** los 50 clientes y uno nuevo tienen las mismas 1 065 operaciones, del `seq` 1 al 1 065.
- **Entregas:** llega el 100 % de los puntos en vivo y el 96 % de los cursores (el resto se fusiona por diseño).
- **El generador no fue el límite:** recibía 12,6 MB/s y sus hilos estuvieron ocupados un 10-11 % del tiempo.
- **Latencia de red:** la sonda HTTP marca unos 20 ms de ida y vuelta entre la máquina de GitHub y Railway, así que el servidor añade poco más que eso. Un trazo tarda ~34 ms en guardarse y llegar a los demás; un cursor, ~44 ms, que incluye esperar al siguiente lote.

En producción las latencias son incluso menores que en local, porque allí el servidor no comparte la CPU con PostgreSQL y el generador. La CPU y la memoria del servidor no se ven desde fuera; están en las métricas del servicio en Railway.

Desde una conexión doméstica esta prueba no sirve: 50 personas en un lienzo reciben ~12 MB/s (~100 Mbit/s) y la línea se satura antes que el servidor. Por eso existe el workflow.

### Limitaciones de estas medidas

- **Local: todo en la misma máquina.** Servidor, PostgreSQL y generador comparten 4 núcleos y la red es la local, así que esas latencias no incluyen internet.
- **Producción: medido desde un centro de datos.** Un usuario real añade la latencia de su conexión hasta Railway; desde la conexión doméstica de desarrollo se midieron ~120 ms de ida y vuelta.
- **Ritmo de dibujo exigente.** Un trazo cada 1-3 s por persona es más intenso que el uso normal, pero en el caso de los cursores es el peor caso: todo el mundo moviendo el ratón a la vez.
