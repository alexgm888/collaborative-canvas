/** How this tab appears to others: a random pseudonym, since there are no accounts. */
export interface Identity {
  name: string;
  color: string;
}

const ANIMALS = [
  'Nutria',
  'Zorro',
  'Búho',
  'Lince',
  'Koala',
  'Panda',
  'Tortuga',
  'Delfín',
  'Ardilla',
  'Colibrí',
  'Pingüino',
  'Erizo',
  'Mapache',
  'Ballena',
];
// Adjectives with the same form in masculine and feminine, so any pair agrees.
const ADJECTIVES = ['audaz', 'veloz', 'feliz', 'alegre', 'valiente', 'amable', 'tenaz', 'ágil'];
// Distinct from each other and readable as a label background with white text.
const COLORS = ['#e11d48', '#d97706', '#059669', '#0891b2', '#2563eb', '#7c3aed', '#c026d3'];

const STORAGE_KEY = 'canvas.identity';

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

function isIdentity(value: unknown): value is Identity {
  const v = value as Partial<Identity> | null;
  return typeof v?.name === 'string' && typeof v.color === 'string';
}

/**
 * The identity of this tab. It lives in sessionStorage, so a reload keeps it
 * but two tabs are two different people, which is what presence should show.
 */
export function loadIdentity(): Identity {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isIdentity(stored)) return stored;
  } catch {
    // Unavailable storage or a corrupt value: make a new identity.
  }
  const identity = { name: `${pick(ANIMALS)} ${pick(ADJECTIVES)}`, color: pick(COLORS) };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Without storage the name changes on reload; nothing else depends on it.
  }
  return identity;
}
