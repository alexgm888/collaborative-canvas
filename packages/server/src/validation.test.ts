import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PROFILE,
  MAX_NAME_LENGTH,
  MAX_POINTS_PER_STROKE,
  isCanvasId,
  parseCursor,
  parseProfile,
  parseStroke,
} from './validation.js';

const valid = {
  id: '3f1c2b7e-9a4d-4e8f-b123-0a1b2c3d4e5f',
  color: '#2563eb',
  width: 4,
  points: [
    { x: 10, y: 20 },
    { x: 11.5, y: 22.25 },
  ],
};

describe('parseStroke', () => {
  it('accepts a valid stroke', () => {
    assert.deepEqual(parseStroke(valid), { ok: true, value: valid });
  });

  it('drops unknown properties from the stroke and its points', () => {
    const result = parseStroke({
      ...valid,
      author: 'mallory',
      points: [{ x: 1, y: 2, pressure: 0.5 }],
    });
    assert.deepEqual(result, { ok: true, value: { ...valid, points: [{ x: 1, y: 2 }] } });
  });

  it('normalizes id and color to lower case', () => {
    const result = parseStroke({ ...valid, id: valid.id.toUpperCase(), color: '#ABCDEF' });
    assert.ok(result.ok);
    assert.equal(result.value.id, valid.id);
    assert.equal(result.value.color, '#abcdef');
  });

  const invalid: [string, unknown][] = [
    ['null', null],
    ['an array', [valid]],
    ['a non-UUID id', { ...valid, id: 'abc' }],
    ['a named color', { ...valid, color: 'red' }],
    ['a CSS expression as color', { ...valid, color: '#fff;background:url(x)' }],
    ['zero width', { ...valid, width: 0 }],
    ['a huge width', { ...valid, width: 1000 }],
    ['a string width', { ...valid, width: '4' }],
    ['NaN width', { ...valid, width: NaN }],
    ['no points', { ...valid, points: [] }],
    ['points that are not an array', { ...valid, points: { x: 1, y: 1 } }],
    ['a point without y', { ...valid, points: [{ x: 1 }] }],
    ['an infinite coordinate', { ...valid, points: [{ x: Infinity, y: 1 }] }],
    ['a coordinate out of range', { ...valid, points: [{ x: 1e9, y: 1 }] }],
    [
      'too many points',
      {
        ...valid,
        points: Array.from({ length: MAX_POINTS_PER_STROKE + 1 }, () => ({ x: 0, y: 0 })),
      },
    ],
  ];

  for (const [name, input] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(parseStroke(input).ok, false);
    });
  }
});

describe('isCanvasId', () => {
  it('accepts base64url ids', () => {
    assert.ok(isCanvasId('aB3_x-9Qz0Lk'));
  });

  it('rejects empty, long or unsafe ids', () => {
    assert.ok(!isCanvasId(''));
    assert.ok(!isCanvasId('a'.repeat(65)));
    assert.ok(!isCanvasId('../etc'));
    assert.ok(!isCanvasId("x' OR '1'='1"));
  });
});

describe('parseStroke with a point limit', () => {
  it('applies the given limit instead of the default one', () => {
    assert.equal(parseStroke(valid, 1).ok, false);
    assert.equal(parseStroke(valid, 2).ok, true);
  });
});

describe('parseCursor', () => {
  it('accepts a point or null', () => {
    assert.deepEqual(parseCursor({ x: 1, y: 2, extra: true }), { ok: true, value: { x: 1, y: 2 } });
    assert.deepEqual(parseCursor(null), { ok: true, value: null });
  });

  it('rejects anything else', () => {
    assert.equal(parseCursor(undefined).ok, false);
    assert.equal(parseCursor({ x: Infinity, y: 0 }).ok, false);
    assert.equal(parseCursor([1, 2]).ok, false);
  });
});

describe('parseProfile', () => {
  const profile = (query: string) => parseProfile(new URLSearchParams(query));

  it('keeps a valid name and color', () => {
    assert.deepEqual(profile('name=Nutria%20audaz&color=%23DC2626'), {
      name: 'Nutria audaz',
      color: '#dc2626',
    });
  });

  it('falls back to defaults when missing or invalid', () => {
    assert.deepEqual(profile(''), DEFAULT_PROFILE);
    assert.deepEqual(profile('name=%20%20&color=red'), DEFAULT_PROFILE);
  });

  it('strips control characters, collapses spaces and caps the length', () => {
    assert.equal(profile('name=a%0Ab%E2%80%AEc%20%20%20d').name, 'abc d');
    const long = profile(`name=${'🦦'.repeat(MAX_NAME_LENGTH + 5)}`).name;
    assert.equal([...long].length, MAX_NAME_LENGTH);
  });
});
