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

const { createDefaultProject, createDefaultLastLayer, createDefaultSampleShape, MAX_ASSET_BYTES } = await import('../lib/project.ts');
const { SAMPLE_KINDS } = await import('../lib/shoe-sample-catalog.ts');
const { validateProject, validateImageAsset, validateModelAsset, estimateProjectBytes } = await import('../lib/project-validation.ts');
const png = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\n', 'binary').toString('base64');
const obj = {
  name: '신발 원본.obj', format: 'obj',
  dataUrl: 'data:application/octet-stream;base64,' + Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').toString('base64'),
};

// Changed: a complete minimal GLB container exercises secondary-model headers.
function glbBytes() {
  const json = JSON.stringify({ asset: { version: '2.0' } });
  const chunk = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const bytes = Buffer.alloc(20 + chunk.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(chunk.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(bytes, 20);
  return bytes;
}

function glbAsset(bytes = glbBytes()) {
  return { name: '검토용 신골.glb', format: 'glb', dataUrl: 'data:model/gltf-binary;base64,' + bytes.toString('base64') };
}

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

// Changed: older version-1 files gain a disabled independent layer without moving
// or replacing the existing shoe, reference images, or primary display settings.
test('migrates a missing last layer while preserving the entire legacy project', () => {
  const legacy = createDefaultProject();
  delete legacy.last;
  legacy.model = obj;
  legacy.settings.modelPosition = [15, -3, 7];
  legacy.settings.modelRotation = [90, 0, 45];
  legacy.settings.modelScale = 0.5;
  legacy.settings.modelUnits = 'cm';
  legacy.settings.modelUp = 'y';
  legacy.settings.showLast = false;
  legacy.settings.lastOpacity = 0.3;
  legacy.planes.side.image = { name: '기존 측면.png', dataUrl: png };
  const clean = validateProject(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(clean, { ...legacy, last: createDefaultLastLayer() });
  assert.equal(clean.version, 1);
  assert.equal(clean.last.enabled, false);
});

test('round-trips two independent model assets, transforms, units, and display states', () => {
  const project = createDefaultProject();
  project.model = obj;
  project.settings.modelPosition = [1, 2, 3];
  project.settings.modelRotation = [0, 90, 0];
  project.settings.modelScale = 1.2;
  project.settings.modelUnits = 'cm';
  project.settings.modelUp = 'y';
  project.last = {
    enabled: true, model: glbAsset(), visible: false, opacity: 0.42, wireframe: true,
    position: [-4, 5, 6], rotation: [0, 0, 12], scale: 0.9, units: 'm', up: 'z',
  };
  const clean = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(clean, project);
  assert.equal(estimateProjectBytes(clean), Buffer.byteLength(JSON.stringify(clean), 'utf8'));
  project.last.model = null;
  const demo = validateProject(project);
  assert.equal(demo.last.enabled, true);
  assert.equal(demo.last.model, null);
  assert.deepEqual(demo.model, obj);
});

test('rejects the combined two-model byte budget even when the secondary layer is disabled', () => {
  const bytes = Buffer.alloc(12 * 1024 * 1024, ' ');
  Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n#').copy(bytes);
  const model = { name: 'large.obj', format: 'obj', dataUrl: 'data:model/obj;base64,' + bytes.toString('base64') };
  assert.doesNotThrow(() => validateModelAsset(model));
  const project = createDefaultProject();
  project.model = model;
  assert.doesNotThrow(() => validateProject(project));
  project.last.model = { ...model, name: '두 번째 모델.obj' };
  assert.equal(estimateProjectBytes(project), Buffer.byteLength(JSON.stringify(project), 'utf8'));
  assert.throws(() => validateProject(project), (error) => error.code === 'too-large');
});

test('rejects incomplete secondary layers, unsafe transforms, and malformed display choices', () => {
  for (const last of [null, [], {}, { enabled: true }]) {
    assert.throws(() => validateProject({ ...createDefaultProject(), last }));
  }
  for (const update of [
    { position: [0, Number.NaN, 5] },
    { position: [0, 0] },
    { position: [100001, 0, 0] },
    { rotation: [0, Infinity, 0] },
    { rotation: [0, 0, 36001] },
    { scale: 0 },
    { scale: Number.NaN },
    { opacity: 1.01 },
    { enabled: 1 },
    { visible: 'true' },
    { wireframe: null },
    { units: 'ft' },
    { up: 'x' },
    { model: undefined },
  ]) {
    const project = createDefaultProject();
    Object.assign(project.last, update);
    assert.throws(() => validateProject(project));
  }
});

test('validates secondary GLB headers and rejects remote or oversized secondary model data', () => {
  const project = createDefaultProject();
  project.last.enabled = true;
  project.last.model = glbAsset();
  assert.deepEqual(validateProject(project).last.model, project.last.model);
  for (const corrupt of [
    bytes => bytes.write('oops'),
    bytes => bytes.writeUInt32LE(1, 4),
    bytes => bytes.writeUInt32LE(bytes.length + 4, 8),
  ]) {
    const bytes = glbBytes();
    corrupt(bytes);
    project.last.model = glbAsset(bytes);
    assert.throws(() => validateProject(project), /GLB/);
  }
  project.last.model = { ...obj, dataUrl: 'https://example.com/last.obj' };
  assert.throws(() => validateProject(project));
  project.last.model = {
    ...obj,
    dataUrl: 'data:model/obj;base64,' + 'A'.repeat(Math.ceil((MAX_ASSET_BYTES + 3) / 3) * 4),
  };
  assert.throws(() => validateProject(project), (error) => error.code === 'too-large');
});

// Changed: reference centers are optional in old v1 files and explicit in new
// registered captures, independent of both model transforms.
test('migrates a missing reference center to the legacy null convention', () => {
  const legacy = createDefaultProject();
  delete legacy.settings.referenceCenter;
  legacy.settings.dimensions = [300, 120, 95];
  legacy.settings.modelPosition = [15, -7, 32];
  const clean = validateProject(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(clean, {
    ...legacy,
    settings: { ...legacy.settings, referenceCenter: null },
  });
});

test('round-trips explicit reference centers without changing either model pose', () => {
  for (const referenceCenter of [null, [-100000, 0, 100000], [12.25, -3.5, 72.75]]) {
    const project = createDefaultProject();
    project.settings.referenceCenter = referenceCenter;
    project.settings.modelPosition = [4, 5, 6];
    project.last.enabled = true;
    project.last.position = [-7, 8, 9];
    assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  }
});

test('rejects non-finite, missing, malformed, or out-of-bounds center coordinates', () => {
  for (const referenceCenter of [
    [0, Number.NaN, 0], [0, 0, Infinity], [-100001, 0, 0], [0, 100001, 0],
    [0, 0], [0, 0, 0, 0], new Array(3), [0, undefined, 0], '0,0,0', {},
  ]) {
    const project = createDefaultProject();
    project.settings.referenceCenter = referenceCenter;
    assert.throws(() => validateProject(project), /참조면 중심/);
  }
});

// Changed: section review survives a project round-trip without enabling it in
// existing files or allowing invalid positions into the geometry calculation.
test('migrates a missing section configuration without changing legacy content', () => {
  const legacy = createDefaultProject();
  delete legacy.settings.section;
  legacy.settings.referenceCenter = [12, -4, 63];
  legacy.model = obj;
  legacy.last.enabled = true;
  const clean = validateProject(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(clean, {
    ...legacy,
    settings: { ...legacy.settings, section: { enabled: false, axis: 'x', percent: 66.7 } },
  });
});

test('round-trips section axes and endpoint or fractional percentages', () => {
  for (const axis of ['x', 'y', 'z']) {
    for (const percent of [0, 66.7, 100]) {
      const project = createDefaultProject();
      project.settings.section = { enabled: percent !== 0, axis, percent };
      assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
    }
  }
});

test('rejects incomplete sections and invalid enabled, axis, or percentage values', () => {
  for (const section of [null, [], {}, { enabled: false, axis: 'x' }]) {
    const project = createDefaultProject();
    project.settings.section = section;
    assert.throws(() => validateProject(project), /단면/);
  }
  for (const update of [
    { enabled: 1 }, { enabled: 'false' }, { axis: 'X' }, { axis: 'xy' },
    { percent: Number.NaN }, { percent: Infinity }, { percent: -0.001 },
    { percent: 100.001 }, { percent: '66.7' },
  ]) {
    const project = createDefaultProject();
    Object.assign(project.settings.section, update);
    assert.throws(() => validateProject(project), /단면/);
  }
});

// Changed: stored sample adjustments must not mutate imported models, registered
// reference frames, or section settings, including when the controls are dormant.
test('creates independent default sample shapes matching the original sample', () => {
  const expected = { length: 253, ballWidthDelta: 0, heelWidthDelta: 0, toeHeightDelta: 0, instepHeightDelta: 0 };
  assert.deepEqual(createDefaultSampleShape(), expected);
  assert.deepEqual(createDefaultProject().settings.sampleShape, expected);
  const changed = createDefaultSampleShape();
  changed.length = 280;
  assert.deepEqual(createDefaultSampleShape(), expected);
});

test('migrates missing sample adjustments while preserving both models, references, and sections', () => {
  const legacy = createDefaultProject();
  delete legacy.settings.sampleShape;
  legacy.model = obj;
  legacy.last.enabled = true;
  legacy.last.model = glbAsset();
  legacy.last.position = [-3, 4, 8];
  legacy.settings.modelPosition = [1, 2, 3];
  legacy.settings.modelUnits = 'cm';
  legacy.settings.referenceCenter = [12, -4, 63];
  legacy.settings.dimensions = [280, 120, 98];
  legacy.settings.section = { enabled: true, axis: 'y', percent: 43.5 };
  legacy.planes.side.image = { name: '등록한 측면.png', dataUrl: png };
  const clean = validateProject(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(clean, { ...legacy, settings: { ...legacy.settings, sampleShape: createDefaultSampleShape() } });
});

test('round-trips all sample adjustment limits and fractional values while an uploaded shoe is active', () => {
  for (const sampleShape of [
    { length: 180, ballWidthDelta: -16, heelWidthDelta: -12, toeHeightDelta: -8, instepHeightDelta: -8 },
    { length: 330, ballWidthDelta: 24, heelWidthDelta: 18, toeHeightDelta: 20, instepHeightDelta: 20 },
    { length: 266.5, ballWidthDelta: 3.25, heelWidthDelta: -1.5, toeHeightDelta: 2.75, instepHeightDelta: 6.5 },
  ]) {
    const project = createDefaultProject();
    project.model = obj;
    project.last.enabled = true;
    project.last.model = glbAsset();
    project.last.position = [-4, 7, 9];
    project.settings.referenceCenter = [15, -7, 100];
    project.settings.section = { enabled: true, axis: 'z', percent: 25 };
    project.planes.top.image = { name: '윗면.png', dataUrl: png };
    project.settings.sampleShape = sampleShape;
    assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  }
});

test('rejects incomplete, non-finite, or out-of-range sample settings even with imported models', () => {
  for (const sampleShape of [null, [], {}, { length: 253 }]) {
    const project = createDefaultProject();
    project.model = obj;
    project.settings.sampleShape = sampleShape;
    assert.throws(() => validateProject(project), /샘플/);
  }
  for (const [key, lower, upper] of [
    ['length', 180, 330], ['ballWidthDelta', -16, 24], ['heelWidthDelta', -12, 18],
    ['toeHeightDelta', -8, 20], ['instepHeightDelta', -8, 20],
  ]) {
    for (const value of [lower - 0.001, upper + 0.001, Number.NaN, Infinity, '0']) {
      const project = createDefaultProject();
      project.model = obj;
      project.settings.sampleShape[key] = value;
      assert.throws(() => validateProject(project), /샘플/);
    }
  }
});
