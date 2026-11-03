import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Changed: exercise production modules without generated source or dependencies.
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

const { createDefaultProject } = await import('../lib/project.ts');
const { PROJECT_ID_PATTERN } = await import('../lib/project-validation.ts');
const { openStudioDatabase, STUDIO_STORES, studioStorageError } = await import('../lib/local-store.ts');
const { createDesignVersionId, normalizeDesignVersionName, createDesignVersionSnapshot, saveDesignVersion, saveRestoreBackup, MAX_DESIGN_VERSIONS } = await import('../lib/design-versions.ts');
const { compareProjects } = await import('../lib/project-diff.ts');
const obj = suffix => ({ name: '같은 파일.obj', format: 'obj', dataUrl: 'data:model/obj;base64,' + Buffer.from(`v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n#${suffix}`).toString('base64') });
const png = suffix => ({ name: '같은 이미지.png', dataUrl: 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\n' + suffix, 'binary').toString('base64') });

test('cleans version names and rejects empty, oversized, or embedded control text', () => {
  assert.equal(normalizeDesignVersionName('  e\u0301 검토  '), 'é 검토');
  assert.equal(normalizeDesignVersionName('가'.repeat(80)).length, 80);
  for (const value of ['', '   ', 'a'.repeat(81), '첫\n버전', 'bad\u0000name', null, 4]) assert.throws(() => normalizeDesignVersionName(value), /버전 이름/);
});

test('creates UUIDv4 IDs through native or secure-byte fallback paths', () => {
  const native = '12345678-1234-4234-8234-123456789abc';
  assert.equal(createDesignVersionId({ randomUUID: () => native, getRandomValues() { throw new Error('unused'); } }), native);
  let calls = 0;
  const fallback = createDesignVersionId({ getRandomValues(bytes) { calls++; assert.equal(bytes.length, 16); bytes.fill(255); return bytes; } });
  assert.equal(fallback, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.match(fallback, PROJECT_ID_PATTERN);
  assert.equal(calls, 1);
  assert.throws(() => createDesignVersionId({}), /안전한 버전 ID/);
  assert.throws(() => createDesignVersionId(null), /안전한 버전 ID/);
});

test('detaches complete snapshots and derives labels from the captured project', () => {
  const project = createDefaultProject();
  project.model = obj('A');
  project.last.enabled = true;
  project.last.model = obj('last');
  project.settings.referenceCenter = [3, -4, 50];
  project.planes.top.image = png('A');
  const expected = structuredClone(project);
  const snapshot = createDesignVersionSnapshot('  비교 A  ', project);
  assert.match(snapshot.metadata.id, PROJECT_ID_PATTERN);
  assert.equal(new Date(snapshot.metadata.createdAt).toISOString(), snapshot.metadata.createdAt);
  assert.equal(snapshot.metadata.name, '비교 A');
  assert.equal(snapshot.metadata.modelLabel, project.model.name);
  assert.equal(snapshot.metadata.lastLabel, project.last.model.name);
  project.title = '바뀐 제목';
  project.settings.sampleShape.length = 310;
  project.settings.modelPosition[0] = 100;
  project.settings.referenceCenter[1] = 999;
  project.last.position[2] = 888;
  project.model.dataUrl = obj('B').dataUrl;
  project.planes.top.image.dataUrl = png('B').dataUrl;
  assert.deepEqual(snapshot.project, expected);
  assert.equal(snapshot.metadata.projectTitle, expected.title);
  const demo = createDefaultProject();
  assert.equal(createDesignVersionSnapshot('샘플', demo).metadata.lastLabel, null);
  demo.last.enabled = true;
  assert.equal(createDesignVersionSnapshot('샘플', demo).metadata.lastLabel, '데모 라스트');
});

// Changed: request doubles verify await ordering and transaction scopes only.
// Actual IndexedDB upgrade/CRUD/concurrency semantics are checked in the browser.
function pausedDatabase(count = 0) {
  const previous = globalThis.indexedDB;
  const request = {};
  const writes = [];
  let countRequest, scope, closed = 0, aborted = false;
  const transaction = {
    objectStore(store) {
      return {
        count() { countRequest = { result: count }; return countRequest; },
        add(value, key) { writes.push({ store, key, value: structuredClone(value) }); },
        put(value, key) { writes.push({ store, key, value: structuredClone(value) }); },
      };
    },
    abort() { aborted = true; transaction.onabort(); },
  };
  const db = {
    transaction(stores, mode) { scope = { stores, mode }; return transaction; },
    close() { closed++; },
  };
  globalThis.indexedDB = { open(name, version) { assert.equal(name, 'last-studio'); assert.equal(version, 2); return request; } };
  return {
    writes, get scope() { return scope; }, get closed() { return closed; },
    async finish() {
      request.result = db;
      request.onsuccess();
      await Promise.resolve();
      countRequest?.onsuccess();
      if (!aborted) transaction.oncomplete();
    },
    restore() { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; },
  };
}

test('captures state before database await and writes metadata plus payload in one transaction', async () => {
  const database = pausedDatabase(19);
  try {
    const project = createDefaultProject();
    project.last.enabled = true;
    const expected = structuredClone(project);
    const pending = saveDesignVersion('버전 20', project);
    project.title = '기다리는 동안 변경';
    project.last.position[0] = 77;
    await database.finish();
    const saved = await pending;
    assert.deepEqual(database.scope, { stores: [STUDIO_STORES.versions, STUDIO_STORES.versionProjects], mode: 'readwrite' });
    assert.equal(database.writes.length, 2);
    assert.equal(database.writes[0].value.id, saved.id);
    assert.equal(database.writes[1].key, saved.id);
    assert.deepEqual(database.writes[1].value, expected);
    assert.equal(database.closed, 1);
  } finally { database.restore(); }
});

test('rejects a full 20-version store before either record is written', async () => {
  assert.equal(MAX_DESIGN_VERSIONS, 20);
  const database = pausedDatabase(20);
  try {
    const rejected = assert.rejects(saveDesignVersion('버전 21', createDefaultProject()), /최대 20개/);
    await database.finish();
    await rejected;
    assert.deepEqual(database.writes, []);
    assert.equal(database.scope.mode, 'readwrite');
    assert.equal(database.closed, 1);
  } finally { database.restore(); }
});

test('captures the restore backup before await and keeps it outside version stores', async () => {
  const database = pausedDatabase(20);
  try {
    const project = createDefaultProject(), expected = structuredClone(project);
    const pending = saveRestoreBackup(project);
    project.settings.sampleShape.length = 180;
    await database.finish();
    await pending;
    assert.deepEqual(database.scope, { stores: [STUDIO_STORES.workspace], mode: 'readwrite' });
    assert.equal(database.writes[0].key, 'restore-backup');
    assert.deepEqual(database.writes[0].value, expected);
  } finally { database.restore(); }
});

test('upgrades without recreating the draft store and closes on version changes', async () => {
  const previous = globalThis.indexedDB, request = {}, created = [];
  let closed = 0;
  const names = new Set([STUDIO_STORES.workspace]);
  const db = { objectStoreNames: { contains: name => names.has(name) }, createObjectStore(name, options) { names.add(name); created.push({ name, options }); }, close() { closed++; } };
  globalThis.indexedDB = { open: () => request };
  try {
    const pending = openStudioDatabase();
    request.result = db;
    request.onupgradeneeded();
    request.onsuccess();
    assert.equal(await pending, db);
    assert.deepEqual(created.map(item => item.name), [STUDIO_STORES.versions, STUDIO_STORES.versionProjects]);
    db.onversionchange();
    assert.equal(closed, 1);
  } finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});

test('rejects blocked upgrades and closes a late connection without creating stores', async () => {
  const previous = globalThis.indexedDB, request = {};
  let closed = 0, aborted = 0;
  const db = { close() { closed++; }, createObjectStore() { throw new Error('Must not upgrade after rejection'); } };
  globalThis.indexedDB = { open: () => request };
  try {
    const rejected = assert.rejects(openStudioDatabase(), /다른 탭/);
    request.onblocked();
    await rejected;
    request.result = db;
    request.transaction = { abort() { aborted++; } };
    request.onupgradeneeded();
    request.onsuccess();
    assert.equal(aborted, 1);
    assert.equal(closed, 2);
    assert.match(studioStorageError(new DOMException('full', 'QuotaExceededError')).message, /저장 공간이 부족/);
  } finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});

test('omits unchanged projects and save timestamps from design comparisons', () => {
  const before = createDefaultProject(), after = structuredClone(before);
  before.savedAt = '2026-11-02T01:00:00.000Z';
  after.savedAt = '2026-11-02T02:00:00.000Z';
  assert.deepEqual(compareProjects(before, after), []);
});

test('compares numeric settings with signed physical units and percentage points', () => {
  const before = createDefaultProject(), after = structuredClone(before);
  after.settings.sampleShape.length = 266.5;
  after.settings.modelPosition[0] = -12.5;
  after.settings.modelRotation[2] = 90;
  after.settings.modelScale = 1.25;
  after.last.opacity = 0.68;
  after.settings.section.percent = 70;
  const differences = compareProjects(before, after);
  const deltas = Object.fromEntries(differences.map(item => [item.key, item.delta]));
  assert.deepEqual(deltas, {
    'settings.sampleShape.length': '+13.5 mm', 'settings.modelPosition.x': '-12.5 mm',
    'settings.modelRotation.z': '+90°', 'settings.modelScale': '+0.25×',
    'last.opacity': '+10%p', 'settings.section.percent': '+3.3%p',
  });
  assert.equal(new Set(differences.map(item => item.key)).size, differences.length);
});

test('detects same-name asset contents without outputting data URLs or payloads', () => {
  const before = createDefaultProject(), after = createDefaultProject();
  before.model = obj('A'); after.model = obj('B');
  before.last.model = obj('C'); after.last.model = obj('D');
  before.planes.side.image = png('A'); after.planes.side.image = png('B');
  const changes = compareProjects(before, after);
  assert.deepEqual(changes.map(item => item.key), ['model.content', 'last.model.content', 'planes.side.image.content']);
  assert.ok(changes.every(item => item.delta === '내용 변경'));
  assert.doesNotMatch(JSON.stringify(changes), /data:|base64,/);
  assert.ok(!JSON.stringify(changes).includes(before.model.dataUrl.split(',')[1]));
});

test('reports explicit reference centers and dormant shape, layer, image, and section changes', () => {
  const before = createDefaultProject(), after = structuredClone(before);
  after.model = obj('A');
  after.settings.sampleShape.heelWidthDelta = 5;
  after.settings.referenceCenter = [0, 0, before.settings.dimensions[2] / 2];
  after.last.position[2] = 9;
  after.last.units = 'cm';
  after.planes.rear.visible = true;
  after.planes.top.flip = true;
  after.planes.side.image = { ...png('A'), name: '이미지 없음' };
  after.settings.section.enabled = true;
  after.settings.section.axis = 'z';
  const changes = compareProjects(before, after);
  for (const key of ['model.source', 'settings.sampleShape.heelWidthDelta', 'settings.referenceCenter', 'last.position.z', 'last.units', 'planes.rear.visible', 'planes.top.flip', 'planes.side.image.source', 'settings.section.enabled', 'settings.section.axis']) assert.ok(changes.some(item => item.key === key), key);
  const center = changes.find(item => item.key === 'settings.referenceCenter');
  assert.match(center.before, /자동/); assert.match(center.after, /지정/);
});
