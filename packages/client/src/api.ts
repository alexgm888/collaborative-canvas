import type { Stroke } from '@canvas/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `${init?.method ?? 'GET'} ${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function createCanvas(): Promise<string> {
  const { id } = await request<{ id: string }>('/api/canvases', { method: 'POST' });
  return id;
}

export function loadCanvas(id: string): Promise<{ id: string; strokes: Stroke[] }> {
  return request(`/api/canvases/${encodeURIComponent(id)}`);
}

const RETRY_DELAYS_MS = [500, 2000, 5000];

/**
 * Saves a stroke, retrying on network or server errors. Retrying is safe
 * because the server ignores a stroke whose id it already has.
 */
export async function saveStroke(canvasId: string, stroke: Stroke): Promise<void> {
  const path = `/api/canvases/${encodeURIComponent(canvasId)}/strokes`;
  for (let attempt = 0; ; attempt++) {
    try {
      await request(path, { method: 'POST', body: JSON.stringify(stroke) });
      return;
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      // A 4xx will not fix itself; network errors and 5xx may be transient.
      const permanent = err instanceof HttpError && err.status < 500;
      if (permanent || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
