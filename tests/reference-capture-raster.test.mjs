import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const { rasterizeOpaqueTriangle } = await import('../lib/scene-software-renderer.ts');
const OUTER = [75, 84, 66];
const LINING = [184, 151, 101];
const meanDepth = points => points.reduce((sum, point) => sum + point[2], 0) / points.length;
const pixelAt = (surface, x, y) => Array.from(surface.pixels.slice((y * surface.width + x) * 4, (y * surface.width + x + 1) * 4));

function surface(width = 64, height = 64, background = 'transparent') {
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (background === 'white') pixels.fill(255);
  return { width, height, pixels, depths: new Float32Array(width * height).fill(Infinity) };
}

function draw(target, triangle, color) {
  rasterizeOpaqueTriangle(target.pixels, target.depths, target.width, target.height, triangle, color);
}

// Regression: the boot shell's corresponding outer/inner triangles share mean Z,
// but their XY offset means the outer surface is closer at overlapping pixels.
test('equal-mean-depth lining never overwrites the nearer shell, regardless of draw order', () => {
  const outer = [[10, 10, -.8], [54, 10, .4], [10, 54, .4]];
  const inner = [[6, 6, -.8], [50, 6, .4], [6, 50, .4]];
  assert.equal(meanDepth(outer), meanDepth(inner));
  const first = surface();
  draw(first, outer, OUTER);
  draw(first, inner, LINING);
  const reversed = surface();
  draw(reversed, inner, LINING);
  draw(reversed, outer, OUTER);
  for (const target of [first, reversed]) {
    assert.deepEqual(pixelAt(target, 20, 20), [...OUTER, 255], 'overlap must show the actual nearer shell');
    assert.deepEqual(pixelAt(target, 8, 8), [...LINING, 255], 'visible inner-only region keeps its material');
    assert.deepEqual(pixelAt(target, 52, 10), [...OUTER, 255], 'outer-only region remains visible');
  }
  assert.ok(first.pixels.every((value, i) => value === reversed.pixels[i]), 'the whole image must be order independent for these separated planes');
});

test('depth is resolved per pixel when two equal-mean triangles exchange front/back positions', () => {
  const a = [[8, 8, -.8], [56, 8, .8], [8, 56, 0]];
  const b = [[8, 8, .8], [56, 8, -.8], [8, 56, 0]];
  assert.equal(meanDepth(a), meanDepth(b));
  for (const reverse of [false, true]) {
    const target = surface();
    const ordered = reverse ? [[b, LINING], [a, OUTER]] : [[a, OUTER], [b, LINING]];
    for (const [triangle, color] of ordered) draw(target, triangle, color);
    assert.deepEqual(pixelAt(target, 14, 14), [...OUTER, 255], 'left region is nearer on the outer triangle');
    assert.deepEqual(pixelAt(target, 44, 12), [...LINING, 255], 'right region is nearer on the other triangle');
  }
});

test('opaque rasterization preserves uncovered transparent or white background and canvas dimensions', () => {
  for (const background of ['transparent', 'white']) {
    const target = surface(37, 23, background);
    draw(target, [[-4, 2, .2], [20, 1, .2], [3, 20, .2]], OUTER);
    assert.deepEqual(pixelAt(target, 4, 4), [...OUTER, 255]);
    assert.deepEqual(pixelAt(target, 36, 22), background === 'white' ? [255, 255, 255, 255] : [0, 0, 0, 0]);
    assert.equal(target.pixels.length, 37 * 23 * 4);
    assert.equal(target.depths.length, 37 * 23);
    assert.equal(target.depths[22 * 37 + 36], Infinity, 'uncovered depth stays clear');
  }
});
