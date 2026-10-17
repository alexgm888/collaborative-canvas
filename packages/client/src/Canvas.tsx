import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Point, Stroke } from '@canvas/shared';

interface CanvasProps {
  color: string;
  width: number;
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

export function Canvas({ color, width }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);

  const redraw = useCallback((all: Stroke[], current: Stroke | null) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of all) drawStroke(ctx, s);
    if (current) drawStroke(ctx, current);
  }, []);

  // Keep the canvas bitmap in sync with its CSS size (and the device pixel ratio).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      // Resizing resets the context; scale it so strokes keep using CSS pixels.
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw(strokes, currentRef.current);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw, strokes]);

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
    redraw(strokes, currentRef.current);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = currentRef.current;
    if (!current) return;
    current.points.push(toPoint(e));
    redraw(strokes, current);
  };

  const finishStroke = () => {
    const current = currentRef.current;
    if (!current) return;
    currentRef.current = null;
    setStrokes((prev) => [...prev, current]);
  };

  return (
    <canvas
      ref={canvasRef}
      className="canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
    />
  );
}
