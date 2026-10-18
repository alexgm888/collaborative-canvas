import { useCallback, useEffect, useState } from 'react';
import type { Stroke } from '@canvas/shared';
import { HttpError, createCanvas, loadCanvas, saveStroke } from './api';
import { Canvas } from './Canvas';

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'];

type Board =
  | { status: 'loading' }
  | { status: 'ready'; id: string; strokes: Stroke[] }
  | { status: 'not-found' }
  | { status: 'error' };

function canvasIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

// Shared across effect runs so StrictMode's double mount in development does
// not create two canvases.
let pendingCreate: Promise<string> | null = null;

/** Resolves the canvas for the current URL: `/c/:id` loads it, `/` creates one. */
function useBoard(): Board {
  const [board, setBoard] = useState<Board>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function resolve(): Promise<void> {
      let id = canvasIdFromPath(window.location.pathname);
      if (!id) {
        pendingCreate ??= createCanvas();
        id = await pendingCreate;
        // Replace rather than push, so Back does not land on `/` and create another.
        window.history.replaceState(null, '', `/c/${encodeURIComponent(id)}`);
      }
      const { strokes } = await loadCanvas(id);
      if (!cancelled) setBoard({ status: 'ready', id, strokes });
    }

    resolve().catch((err: unknown) => {
      if (cancelled) return;
      console.error(err);
      setBoard({ status: err instanceof HttpError && err.status === 404 ? 'not-found' : 'error' });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return board;
}

type SaveState = { pending: number; failed: boolean };

function saveLabel({ pending, failed }: SaveState): string {
  if (failed) return 'No se pudieron guardar algunos trazos';
  return pending > 0 ? 'Guardando…' : 'Guardado';
}

export function App() {
  const [color, setColor] = useState(COLORS[0] ?? '#111827');
  const [width, setWidth] = useState(4);
  const board = useBoard();
  const [save, setSave] = useState<SaveState>({ pending: 0, failed: false });

  const boardId = board.status === 'ready' ? board.id : null;

  const onStrokeEnd = useCallback(
    (stroke: Stroke) => {
      if (!boardId) return;
      setSave((s) => ({ ...s, pending: s.pending + 1 }));
      saveStroke(boardId, stroke)
        .then(() => setSave((s) => ({ ...s, pending: s.pending - 1 })))
        .catch((err: unknown) => {
          console.error(err);
          setSave((s) => ({ pending: s.pending - 1, failed: true }));
        });
    },
    [boardId],
  );

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Collaborative Canvas</h1>
        <div className="tools">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              className={c === color ? 'swatch selected' : 'swatch'}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <label className="width">
            Grosor
            <input
              type="range"
              min={1}
              max={24}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="meta">
          {board.status === 'ready' && (
            <span className={save.failed ? 'save-state failed' : 'save-state'} role="status">
              {saveLabel(save)}
            </span>
          )}
          {/* A full page load on purpose: `/` creates a fresh canvas. */}
          <a href="/">Nuevo lienzo</a>
        </div>
      </header>
      <main className="board">
        {board.status === 'ready' && (
          <Canvas
            key={board.id}
            color={color}
            width={width}
            initialStrokes={board.strokes}
            onStrokeEnd={onStrokeEnd}
          />
        )}
        {board.status === 'loading' && <p className="notice">Cargando lienzo…</p>}
        {board.status === 'not-found' && (
          <p className="notice">
            Este lienzo no existe. <a href="/">Crear uno nuevo</a>
          </p>
        )}
        {board.status === 'error' && (
          <p className="notice">
            No se pudo cargar el lienzo. Comprueba la conexión y recarga la página.
          </p>
        )}
      </main>
    </div>
  );
}
