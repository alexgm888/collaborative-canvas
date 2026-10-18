import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Point, Stroke } from '@canvas/shared';

interface CanvasProps {
  color: string;
  width: number;
  /** Every stroke to show, own and remote. The stroke being drawn is not included. */
  strokes: Stroke[];
  /** Strokes others are drawing right now, shown above `strokes`. */
  live: Stroke[];
  /** Called on every new point of the stroke being drawn, always with the same object. */
  onStrokeProgress: (stroke: Stroke) => void;
  /** Called once per finished stroke; the parent adds it to `strokes`. */
  onStrokeEnd: (stroke: Stroke) => void;
  /** The pointer position, or null when it leaves the canvas. */
  onCursorMove: (position: Point | null) => void;
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const [first, ...rest] = stroke.points;
  if (!first) return;

  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // A single point is drawn as a dot, otherwise a click would leave no mark.
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const p of rest) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function clear(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

/**
 * Two stacked canvases. The bottom one holds saved strokes and is repainted
 * only when they change; the top one holds strokes in progress (own and
 * others'), which change on every pointer move. Repainting a whole drawing at
 * pointer rate would get slower with every stroke added.
 */
export function Canvas({
  color,
  width,
  strokes,
  live,
  onStrokeProgress,
  onStrokeEnd,
  onCursorMove,
}: CanvasProps) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const currentRef = useRef<Stroke | null>(null);
  // Read by the resize observer and pointer handlers without re-subscribing.
  const strokesRef = useRef(strokes);
  const liveStrokesRef = useRef(live);
  const frameRef = useRef(0);

  const redrawBase = useCallback(() => {
    const ctx = baseRef.current && clear(baseRef.current);
    if (!ctx) return;
    for (const s of strokesRef.current) drawStroke(ctx, s);
  }, []);

  const redrawLive = useCallback(() => {
    const ctx = liveRef.current && clear(liveRef.current);
    if (!ctx) return;
    for (const s of liveStrokesRef.current) drawStroke(ctx, s);
    // Your own stroke stays on top of the ones others are drawing.
    if (currentRef.current) drawStroke(ctx, currentRef.current);
  }, []);

  // Pointer events can fire several times per frame; paint once per frame.
  const scheduleLive = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      redrawLive();
    });
  }, [redrawLive]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      // Otherwise a remount (StrictMode does one) would never paint again.
      frameRef.current = 0;
    },
    [],
  );

  useEffect(() => {
    strokesRef.current = strokes;
    redrawBase();
  }, [strokes, redrawBase]);

  useEffect(() => {
    liveStrokesRef.current = live;
    scheduleLive();
  }, [live, scheduleLive]);

  // Keep the canvas bitmaps in sync with their CSS size (and the device pixel ratio).
  useEffect(() => {
    const base = baseRef.current;
    if (!base) return;

    const resize = () => {
      const { width: w, height: h } = base.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of [base, liveRef.current]) {
        if (!canvas) continue;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        // Resizing resets the context; scale it so strokes keep using CSS pixels.
        canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      redrawBase();
      redrawLive();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(base);
    return () => observer.disconnect();
  }, [redrawBase, redrawLive]);

  const toPoint = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    currentRef.current = {
      id: crypto.randomUUID(),
      color,
      width,
      points: [toPoint(e)],
    };
    onStrokeProgress(currentRef.current);
    scheduleLive();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toPoint(e);
    onCursorMove(point);
    const current = currentRef.current;
    if (!current) return;
    current.points.push(point);
    onStrokeProgress(current);
    scheduleLive();
  };

  const finishStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // A finger lifting off leaves no pointer behind to show.
    if (e.pointerType === 'touch') onCursorMove(null);
    const current = currentRef.current;
    if (!current) return;
    currentRef.current = null;
    onStrokeEnd(current);
    scheduleLive();
  };

  return (
    <>
      <canvas ref={baseRef} className="canvas" />
      <canvas
        ref={liveRef}
        className="canvas canvas-live"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onPointerLeave={() => onCursorMove(null)}
      />
    </>
  );
}
