import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Point, Stroke } from '@canvas/shared';
import { createCanvas } from './api';
import { Canvas } from './Canvas';
import { CanvasConnection } from './connection';
import type { CanvasState } from './connection';
import { loadIdentity } from './identity';
import type { Identity } from './identity';
import { Cursors, PeerList } from './Presence';

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'];

type BoardId = { status: 'loading' } | { status: 'ready'; id: string } | { status: 'error' };

function canvasIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

// Shared across effect runs so StrictMode's double mount in development does
// not create two canvases.
let pendingCreate: Promise<string> | null = null;

/** The canvas id for the current URL: `/c/:id` uses it, `/` creates a canvas. */
function useBoardId(): BoardId {
  const [board, setBoard] = useState<BoardId>(() => {
    const id = canvasIdFromPath(window.location.pathname);
    return id ? { status: 'ready', id } : { status: 'loading' };
  });

  useEffect(() => {
    if (board.status !== 'loading') return;
    let cancelled = false;

    pendingCreate ??= createCanvas();
    pendingCreate
      .then((id) => {
        // Replace rather than push, so Back does not land on `/` and create another.
        window.history.replaceState(null, '', `/c/${encodeURIComponent(id)}`);
        if (!cancelled) setBoard({ status: 'ready', id });
      })
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) setBoard({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [board.status]);

  return board;
}

const IDLE_CONNECTION = {
  getState: (): CanvasState | null => null,
  subscribe: () => () => {},
};

interface CanvasActions {
  addStroke: (stroke: Stroke) => void;
  updateLiveStroke: (stroke: Stroke) => void;
  moveCursor: (position: Point | null) => void;
  undo: () => void;
  redo: () => void;
}

/** Opens a live connection to the canvas while it is shown. */
function useCanvasConnection(
  id: string | null,
  identity: Identity,
): { state: CanvasState | null; actions: CanvasActions } {
  const [connection, setConnection] = useState<CanvasConnection | null>(null);

  useEffect(() => {
    if (!id) return;
    const conn = new CanvasConnection(id, identity);
    setConnection(conn);
    return () => {
      conn.close();
      setConnection(null);
    };
  }, [id, identity]);

  const source = connection ?? IDLE_CONNECTION;
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const actions = useMemo<CanvasActions>(
    () => ({
      addStroke: (stroke) => connection?.addStroke(stroke),
      updateLiveStroke: (stroke) => connection?.updateLiveStroke(stroke),
      moveCursor: (position) => connection?.moveCursor(position),
      undo: () => connection?.undo(),
      redo: () => connection?.redo(),
    }),
    [connection],
  );
  return { state, actions };
}

/** Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS). */
function useUndoShortcuts({ undo, redo }: CanvasActions): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // Text fields keep their own undo.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.matches('textarea, input:not([type=range])')) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) undo();
      else if ((key === 'z' && e.shiftKey) || key === 'y') redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);
}

function syncLabel({ status, pending, rejected }: CanvasState): string {
  if (rejected > 0) return 'No se pudieron guardar algunos trazos';
  if (status !== 'online') {
    return pending > 0 ? `Sin conexión · ${pending} sin guardar` : 'Sin conexión · reconectando…';
  }
  return pending > 0 ? 'Guardando…' : 'Guardado';
}

export function App() {
  const [color, setColor] = useState(COLORS[0] ?? '#111827');
  const [width, setWidth] = useState(4);
  const board = useBoardId();
  const [identity] = useState(loadIdentity);
  const { state, actions } = useCanvasConnection(
    board.status === 'ready' ? board.id : null,
    identity,
  );

  useUndoShortcuts(actions);

  const loaded = state?.loaded === true;
  const notFound = state?.status === 'not-found';
  const syncFailed = state !== null && (state.rejected > 0 || state.status !== 'online');

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
          <div className="history">
            <button
              type="button"
              onClick={actions.undo}
              disabled={!state?.canUndo}
              title="Deshacer tu último trazo (Ctrl+Z)"
            >
              Deshacer
            </button>
            <button
              type="button"
              onClick={actions.redo}
              disabled={!state?.canRedo}
              title="Rehacer (Ctrl+Shift+Z)"
            >
              Rehacer
            </button>
          </div>
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
          {state?.status === 'online' && <PeerList me={identity} peers={state.peers} />}
          {state && loaded && !notFound && (
            <span className={syncFailed ? 'save-state failed' : 'save-state'} role="status">
              {syncLabel(state)}
            </span>
          )}
          {/* A full page load on purpose: `/` creates a fresh canvas. */}
          <a href="/">Nuevo lienzo</a>
        </div>
      </header>
      <main className="board">
        {board.status === 'ready' && state && loaded && !notFound && (
          <div className="surface">
            <Canvas
              key={board.id}
              color={color}
              width={width}
              strokes={state.strokes}
              live={state.live}
              onStrokeProgress={actions.updateLiveStroke}
              onStrokeEnd={actions.addStroke}
              onCursorMove={actions.moveCursor}
            />
            <Cursors peers={state.peers} />
          </div>
        )}
        {board.status !== 'error' && !loaded && !notFound && (
          <p className="notice">
            {state?.status === 'offline' ? 'Sin conexión, reintentando…' : 'Cargando lienzo…'}
          </p>
        )}
        {notFound && (
          <p className="notice">
            Este lienzo no existe. <a href="/">Crear uno nuevo</a>
          </p>
        )}
        {board.status === 'error' && (
          <p className="notice">
            No se pudo crear el lienzo. Comprueba la conexión y recarga la página.
          </p>
        )}
      </main>
    </div>
  );
}
