import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Compile the actual production validators for Node without producing build files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const { createDefaultProject, MAX_ASSET_BYTES } = await import('../lib/project.ts');
const { SAMPLE_KINDS } = await import('../lib/shoe-sample-catalog.ts');
const { validateProject, validateImageAsset, validateModelAsset, estimateProjectBytes } = await import('../lib/project-validation.ts');
const png = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\n', 'binary').toString('base64');

test('round-trips default and self-contained image project; size calculation includes UTF-8 names', () => {
  const project = createDefaultProject();
  project.planes.top.image = { name: '윗면 사진.png', dataUrl: png };
  const clean = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(clean, project);
  assert.equal(estimateProjectBytes(clean), Buffer.byteLength(JSON.stringify(clean), 'utf8'));
});

test('rejects non-finite transforms, impossible reference dimensions and invalid view enum', () => {
  for (const update of [
    { modelScale: Number.NaN },
    { modelPosition: [0, Infinity, 0] },
    { dimensions: [0, 100, 110] },
    { view: 'unexpected' },
  ]) {
    const project = createDefaultProject();
    Object.assign(project.settings, update);
    assert.throws(() => validateProject(project));
  }
});

test('rejects remote image URLs, SVG images, corrupt base64, and mismatched image magic', () => {
  for (const dataUrl of [
    'https://example.com/private.png',
    'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
    'data:image/png;base64,***=',
    'data:image/png;base64,' + Buffer.from('not an image').toString('base64'),
  ]) assert.throws(() => validateImageAsset({ name: 'bad.png', dataUrl }));
});

test('rejects a file larger than 15 MiB before attempting to decode it', () => {
  const tooLarge = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((MAX_ASSET_BYTES + 3) / 3) * 4);
  assert.throws(() => validateImageAsset({ name: 'large.png', dataUrl: tooLarge }), (error) => error.code === 'too-large');
});

test('rejects a project exceeding 30 MiB even when each asset fits', () => {
  const bytes = Buffer.alloc(12 * 1024 * 1024);
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary').copy(bytes);
  const image = { name: 'valid-header.png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64') };
  const project = createDefaultProject();
  project.planes.side.image = image;
  project.planes.top.image = image;
  assert.throws(() => validateProject(project), (error) => error.code === 'too-large');
});

test('rejects invalid GLB header and unsupported project versions', () => {
  assert.throws(() => validateModelAsset({ name: 'bad.glb', format: 'glb', dataUrl: 'data:model/gltf-binary;base64,' + Buffer.from('not a model').toString('base64') }));
  const project = createDefaultProject();
  project.version = 2;
  assert.throws(() => validateProject(project));
});

// Changed: saved projects from before shoe selection remain valid without migrations.
test('loads a legacy project with loafer selected and preserves its reference data', () => {
  const legacy = createDefaultProject();
  delete legacy.settings.sampleKind;
  legacy.planes.side.image = { name: 'original-reference.png', dataUrl: png };
  legacy.settings.modelPosition = [12, -3, 1.5];
  const clean = validateProject(JSON.parse(JSON.stringify(legacy)));
  assert.equal(clean.settings.sampleKind, 'loafer');
  assert.deepEqual(clean.settings.dimensions, [253, 105.31, 79.4]);
  assert.deepEqual(clean.settings.modelPosition, [12, -3, 1.5]);
  assert.deepEqual(clean.planes, legacy.planes);
});

test('round-trips all five shoe selections with saved project metadata and transforms', () => {
  assert.equal(SAMPLE_KINDS.length, 5);
  for (const sampleKind of SAMPLE_KINDS) {
    const project = createDefaultProject();
    project.settings.sampleKind = sampleKind;
    project.settings.modelRotation = [0, 0, 45];
    project.settings.modelScale = 1.25;
    project.title = `샘플 비교 ${sampleKind}`;
    project.savedAt = '2026-11-02T08:00:00.000Z';
    assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  }
});

test('rejects unknown or malformed explicit shoe selections', () => {
  for (const sampleKind of ['foot', 'boot', '', null, 1, {}]) {
    const project = createDefaultProject();
    project.settings.sampleKind = sampleKind;
    assert.throws(() => validateProject(project));
  }
});

test('preserves an uploaded model when normalizing a legacy or selected-sample project', () => {
  const model = {
    name: 'original-last.obj', format: 'obj',
    dataUrl: 'data:application/octet-stream;base64,' + Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').toString('base64'),
  };
  for (const sampleKind of [undefined, 'ankle-boot']) {
    const project = createDefaultProject();
    project.model = model;
    project.settings.sampleKind = sampleKind;
    project.settings.modelUnits = 'cm';
    project.settings.modelUp = 'y';
    const clean = validateProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(clean.model, model);
    assert.equal(clean.settings.modelUnits, 'cm');
    assert.equal(clean.settings.modelUp, 'y');
    assert.equal(clean.settings.sampleKind, sampleKind ?? 'loafer');
  }
});
