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
