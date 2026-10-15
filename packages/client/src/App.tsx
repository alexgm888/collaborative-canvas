import { useState } from 'react';
import { Canvas } from './Canvas';

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'];

export function App() {
  const [color, setColor] = useState(COLORS[0] ?? '#111827');
  const [width, setWidth] = useState(4);

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
      </header>
      <main className="board">
        <Canvas color={color} width={width} />
      </main>
    </div>
  );
}
