# Guion del vídeo demo

Objetivo: un vídeo de **2-3 minutos** para el README, LinkedIn y el CV. Quien lo vea tiene que llevarse tres ideas: funciona en tiempo real, no pierde nada aunque se corte la red y está medido con carga.

## Preparación

- **Dos ventanas lado a lado** con el mismo lienzo de producción (no `localhost`): una normal y otra en ventana privada, para que tengan identidades distintas. Opcional: el móvil en una tercera, grabado o en una esquina.
- **Lienzo nuevo y vacío.** Abre la raíz de la demo y copia la URL `/c/<id>`.
- **DevTools abiertas en una de las dos ventanas,** pestaña _Network_, para cortar la red con el desplegable _Offline_. En el ensayo comprueba que la barra del lienzo pasa a desconectado; si tu versión de Chrome no corta el WebSocket, usa el móvil en modo avión para la escena 4.
- **Grabación:** OBS o la Xbox Game Bar de Windows (Win+Alt+R) a 1080p. Cursor del sistema visible. Sin música; voz en off o subtítulos.
- **Ensayo:** hazlo una vez sin grabar. Las tomas cortas se montan mejor que una larga.

## Escenas

| #   | Tiempo    | Qué se ve                                                                                                                                                                                                                                    | Qué se dice                                                                                                                                                                                                                                                                                                              |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 0:00-0:15 | La demo en una ventana. Pegas la URL en la segunda.                                                                                                                                                                                          | «Una pizarra colaborativa en tiempo real, hecha desde cero con React, Node, WebSockets y PostgreSQL. Cada lienzo tiene su URL.»                                                                                                                                                                                          |
| 2   | 0:15-0:40 | Dibujas en la izquierda y el trazo aparece en la derecha mientras lo haces. Mueves el ratón: se ve tu cursor con nombre en la otra. Los dos dibujan a la vez.                                                                                | «Se ve lo que dibuja el otro mientras lo dibuja, y su cursor. Lo que está en curso viaja como mensajes efímeros que no se guardan; el trazo terminado se guarda antes de enseñárselo a nadie.»                                                                                                                           |
| 3   | 0:40-1:05 | Cada ventana dibuja un trazo. La izquierda pulsa Ctrl+Z: desaparece solo su trazo, en las dos pantallas. Ctrl+Shift+Z lo devuelve a su sitio, debajo del otro.                                                                               | «Cada uno deshace lo suyo sin tocar lo de los demás. Deshacer no borra: es una operación más, numerada como un trazo, y rehacer lo devuelve a su sitio original.»                                                                                                                                                        |
| 4   | 1:05-1:45 | DevTools → _Offline_ en la izquierda. Dibujas tres trazos sin conexión mientras la derecha también dibuja. Vuelves a _Online_: los tres aparecen en la derecha y los de la derecha en la izquierda. Recargas las dos: el dibujo es idéntico. | «Corto la red y sigo dibujando. Al volver, el cliente reenvía lo pendiente y pide solo lo que le falta desde el último número que tiene sin huecos. Reenviar no duplica nada porque cada trazo lleva un id generado por el cliente. Las dos pantallas acaban iguales.»                                                   |
| 5   | 1:45-2:20 | `docs/carga/README.md` en GitHub: la tabla de semana 6 frente a semana 7 y la de producción.                                                                                                                                                 | «Lo probé con 50 personas simuladas en el mismo lienzo. La primera vez tumbó el servidor: el reparto de cursores crecía con el cuadrado de la sala. Agrupándolos en un lote cada 50 ms, en producción un trazo llega a los demás en 44 ms en el p95, y los 50 clientes terminan con exactamente las mismas operaciones.» |
| 6   | 2:20-2:40 | El README: la tabla de trade-offs y `DECISIONES.md`.                                                                                                                                                                                         | «Cada decisión, con lo que descarté y por qué, está en el repositorio. El enlace está en la descripción.»                                                                                                                                                                                                                |

## Después de grabar

1. **Vídeo completo** en YouTube como _oculto_ (o _público_) y enlazado desde el README, LinkedIn y el CV.
2. **GIF corto** (escena 2, 6-8 s, 800 px de ancho, < 5 MB) en `docs/demo/demo.gif`, para que se vea en la cabecera del README sin hacer clic. Se puede sacar del vídeo con ScreenToGif o con `ffmpeg`:

   ```bash
   ffmpeg -ss 0:18 -t 7 -i demo.mp4 -vf "fps=12,scale=800:-1:flags=lanczos" docs/demo/demo.gif
   ```

3. **Añadir al README,** debajo del enlace a la demo:

   ```markdown
   ![Dos ventanas dibujando en el mismo lienzo](docs/demo/demo.gif)

   [Vídeo de 2 minutos](https://youtu.be/...)
   ```
