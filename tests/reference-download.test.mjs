import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Changed: run the actual browser utility in Node without generated source files.
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

const { createReferenceZip, referenceCaptureFilename, referenceZipFilename } = await import('../lib/reference-download.ts');
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const png = new Blob([Buffer.from(PNG_BASE64, 'base64')], { type: 'image/png' });
function captures() {
  return ['rear', 'top', 'side', 'front'].map(view => ({
    view, blob: png, width: 1, height: 1,
    frameWidthMm: 280, frameHeightMm: 160,
    modelDimensions: [253, 105.31, 145],
  }));
}

test('sanitizes cross-platform filenames without splitting Unicode or allowing paths', () => {
  assert.equal(referenceCaptureFilename('../../CON.glb', 'side'), 'model-CON_side.png');
  assert.equal(referenceCaptureFilename('CON.review.glb', 'side'), 'model-CON.review_side.png');
  assert.equal(referenceZipFilename('..\\shoe.glb'), 'shoe_references.zip');
  for (const name of ['../../신발:연구?.glb', '\u202eCON\u0000', '🥾가'.repeat(200), '...', '']) {
    for (const filename of [referenceCaptureFilename(name, 'front'), referenceZipFilename(name)]) {
      assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
      assert.ok(Buffer.byteLength(filename, 'utf8') < 200);
      assert.ok(!filename.startsWith('.'));
      assert.equal(Buffer.from(filename).toString('utf8'), filename);
    }
  }
});

// Changed: Python's standard ZIP reader independently verifies headers, UTF-8,
// stored payloads, CRC, member bounds, and the capture scale/direction metadata.
test('opens with Python zipfile and preserves all PNG bytes and registration metadata', async () => {
  const name = '연구 신발 🥾.glb';
  const zip = await createReferenceZip(captures(), name);
  assert.equal(zip.type, 'application/zip');
  const root = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(join(root, 'reference-zip-test-'));
  try {
    const archive = join(temporary, 'captures.zip');
    writeFileSync(archive, Buffer.from(await zip.arrayBuffer()));
    const script = `
import base64, json, pathlib, struct, sys, zipfile, zlib
archive, expected_png, model_name = sys.argv[1:]
raw = pathlib.Path(archive).read_bytes()
png = base64.b64decode(expected_png)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    infos = z.infolist()
    assert len(infos) == 5
    assert all(i.flag_bits & 0x800 for i in infos)
    assert all(i.compress_type == zipfile.ZIP_STORED for i in infos)
    assert all(pathlib.PurePosixPath(i.filename).name == i.filename for i in infos)
    assert infos[-1].filename == 'metadata.json'
    for info in infos:
        data = z.read(info.filename)
        assert info.CRC == zlib.crc32(data) & 0xffffffff
        assert info.compress_size == info.file_size == len(data)
        assert raw[info.header_offset:info.header_offset + 4] == b'PK\\x03\\x04'
        name_length, extra_length = struct.unpack_from('<HH', raw, info.header_offset + 26)
        assert info.header_offset + 30 + name_length + extra_length + info.compress_size <= z.start_dir
        if info.filename.endswith('.png'):
            assert data == png
            assert '연구-신발-🥾_' in info.filename
    metadata = json.loads(z.read('metadata.json'))
    assert metadata['modelName'] == model_name
    assert metadata['units'] == 'mm' and metadata['projection'] == 'orthographic'
    assert metadata['axes']['X'] == 'workspace length axis'
    assert 'toe orientation is not detected' in metadata['note']
    assert [v['view'] for v in metadata['views']] == ['side', 'top', 'front', 'rear']
    assert [v['filename'] for v in metadata['views']] == [i.filename for i in infos[:4]]
    for view in metadata['views']:
        assert view['widthPx'] == view['heightPx'] == 1
        assert view['frameWidthMm'] == view['mmPerPixelX'] == 280
        assert view['frameHeightMm'] == view['mmPerPixelY'] == 160
        assert view['modelDimensionsMm'] == {'x':253,'y':105.31,'z':145}
    directions = {v['view']:v['direction'] for v in metadata['views']}
    assert directions['side'] == {'cameraFrom':'-Y','lookingToward':'+Y','imageRight':'+X','imageUp':'+Z'}
    assert directions['rear']['imageRight'] == '-Y'
    assert directions['front']['imageRight'] == '+Y'
    assert directions['top']['imageUp'] == '+Y'
    end = struct.unpack('<IHHHHIIH', raw[-22:])
    assert end[0] == 0x06054b50 and end[3] == end[4] == 5
    assert end[6] == z.start_dir and end[5] + end[6] == len(raw) - 22
print('ZIP interoperability verified')
`;
    const result = spawnSync('python', ['-c', script, archive, PNG_BASE64, name], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /interoperability verified/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('rejects incomplete or duplicate view sets and a mismatched PNG size', async () => {
  await assert.rejects(() => createReferenceZip(captures().slice(0, 3), 'shoe'), /각각 한 장/);
  const duplicate = captures();
  duplicate[0].view = 'side';
  await assert.rejects(() => createReferenceZip(duplicate, 'shoe'), /각각 한 장/);
  const mismatched = captures();
  mismatched[0].width = 2;
  await assert.rejects(() => createReferenceZip(mismatched, 'shoe'), /일치하지 않습니다/);
});

test('rejects invalid physical scale and invalid image bytes before packaging', async () => {
  const invalidScale = captures();
  invalidScale[0].frameWidthMm = Number.NaN;
  await assert.rejects(() => createReferenceZip(invalidScale, 'shoe'), /실측 프레임/);
  const invalidPng = captures();
  invalidPng[0].blob = new Blob([new Uint8Array(32)], { type: 'image/png' });
  await assert.rejects(() => createReferenceZip(invalidPng, 'shoe'), /PNG 데이터/);
});
