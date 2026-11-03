import type { PlaneKey } from './project';
import type { ReferenceCaptureImage } from './reference-capture-types';

const VIEW_KEYS: readonly PlaneKey[] = ['side', 'top', 'front', 'rear'];
const MAX_UINT32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const encoder = new TextEncoder();

// Changed: directions match the capture cameras, including the reversed rear view.
const VIEW_DIRECTIONS = {
  side: { cameraFrom: '-Y', lookingToward: '+Y', imageRight: '+X', imageUp: '+Z' },
  top: { cameraFrom: '+Z', lookingToward: '-Z', imageRight: '+X', imageUp: '+Y' },
  front: { cameraFrom: '+X', lookingToward: '-X', imageRight: '+Y', imageUp: '+Z' },
  rear: { cameraFrom: '-X', lookingToward: '+X', imageRight: '-Y', imageUp: '+Z' },
} as const;

// Changed: use a bounded UTF-8 basename with no path separators or reserved names.
function modelBasename(modelName: string): string {
  const leaf = modelName.normalize('NFC').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const cleaned = leaf.replace(/\.(?:stl|obj|glb|gltf|png|jpe?g|webp|json|zip)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '-')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[. -]+|[. -]+$/g, '');
  let result = '';
  let bytes = 0;
  for (const character of cleaned) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > 160) break;
    result += character;
    bytes += size;
  }
  result = result.replace(/[. -]+$/g, '') || 'shoe';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `model-${result}` : result;
}

export function referenceCaptureFilename(modelName: string, view: PlaneKey): string {
  if (!VIEW_KEYS.includes(view)) throw new Error('지원하지 않는 참조 이미지 방향입니다.');
  return `${modelBasename(modelName)}_${view}.png`;
}

export function referenceZipFilename(modelName: string): string {
  return `${modelBasename(modelName)}_references.zip`;
}

// Changed: ZIP CRC-32 uses the standard reflected polynomial and unsigned result.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = MAX_UINT32;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ MAX_UINT32) >>> 0;
}

interface ZipEntry {
  name: Uint8Array<ArrayBuffer>;
  blob: Blob;
  checksum: number;
}

function dosTimestamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zipHeader(entry: ZipEntry, timestamp: ReturnType<typeof dosTimestamp>, offset?: number): Uint8Array<ArrayBuffer> {
  const central = offset !== undefined;
  const header = new Uint8Array((central ? 46 : 30) + entry.name.byteLength);
  const fields = new DataView(header.buffer);
  fields.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
  if (central) fields.setUint16(4, 20, true);
  const start = central ? 6 : 4;
  fields.setUint16(start, 20, true);
  fields.setUint16(start + 2, UTF8_FLAG, true);
  fields.setUint16(start + 4, 0, true); // Store method; PNG is already compressed.
  fields.setUint16(start + 6, timestamp.time, true);
  fields.setUint16(start + 8, timestamp.date, true);
  fields.setUint32(start + 10, entry.checksum, true);
  fields.setUint32(start + 14, entry.blob.size, true);
  fields.setUint32(start + 18, entry.blob.size, true);
  fields.setUint16(start + 22, entry.name.byteLength, true);
  if (central) fields.setUint32(42, offset, true);
  header.set(entry.name, central ? 46 : 30);
  return header;
}

function validateCapture(capture: ReferenceCaptureImage): void {
  if (!VIEW_KEYS.includes(capture.view)) throw new Error('지원하지 않는 참조 이미지 방향입니다.');
  if (!Number.isInteger(capture.width) || !Number.isInteger(capture.height) || capture.width < 1 || capture.height < 1) {
    throw new Error('참조 이미지의 픽셀 크기를 확인해 주세요.');
  }
  if (![capture.frameWidthMm, capture.frameHeightMm].every(value => Number.isFinite(value) && value > 0)
    || !Array.isArray(capture.modelDimensions) || capture.modelDimensions.length !== 3
    || !capture.modelDimensions.every(value => Number.isFinite(value) && value >= 0)
    || !capture.modelDimensions.some(value => value > 0)
    || !Array.isArray(capture.frameCenter) || capture.frameCenter.length !== 3
    || !Array.from(capture.frameCenter).every(Number.isFinite)) {
    throw new Error('참조 이미지의 실측 프레임과 모델 치수를 확인해 주세요.');
  }
  if (!(capture.blob instanceof Blob) || capture.blob.size < 24) throw new Error('저장할 PNG 이미지가 없습니다. 다시 캡처해 주세요.');
  if (capture.blob.size > MAX_UINT32) throw new Error('ZIP에 넣을 이미지가 너무 큽니다. 해상도를 낮춰 주세요.');
}

function assertPng(bytes: Uint8Array, capture: ReferenceCaptureImage): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const png = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!signature.every((value, index) => bytes[index] === value) || png.getUint32(12) !== 0x49484452
    || png.getUint32(16) !== capture.width || png.getUint32(20) !== capture.height) {
    throw new Error('PNG 데이터와 기록된 이미지 크기가 일치하지 않습니다. 다시 캡처해 주세요.');
  }
}

// Changed: create an interoperable UTF-8 ZIP containing four PNGs and scale metadata.
export async function createReferenceZip(captures: ReferenceCaptureImage[], modelName: string): Promise<Blob> {
  if (captures.length !== 4 || new Set(captures.map(capture => capture.view)).size !== 4) {
    throw new Error('측면·윗면·정면·후면 이미지를 각각 한 장씩 캡처해 주세요.');
  }
  captures.forEach(validateCapture);
  const ordered = VIEW_KEYS.map(view => captures.find(capture => capture.view === view)!);
  const createdAt = new Date();
  const entries: ZipEntry[] = [];
  for (const capture of ordered) {
    const bytes = new Uint8Array(await capture.blob.arrayBuffer());
    assertPng(bytes, capture);
    entries.push({ name: encoder.encode(referenceCaptureFilename(modelName, capture.view)), blob: capture.blob, checksum: crc32(bytes) });
  }
  const metadata = {
    schema: 'last-studio-reference-captures', version: 1,
    modelName: modelName.normalize('NFC').trim().slice(0, 500) || 'shoe',
    createdAt: createdAt.toISOString(), units: 'mm', projection: 'orthographic',
    axes: { X: 'workspace length axis', Y: 'workspace width axis', Z: 'workspace height axis' },
    note: 'Frame sizes include image padding. Model dimensions are the captured, transformed world-axis bounding box. View directions use workspace axes after the current alignment; toe orientation is not detected. These images do not certify manufacturing accuracy.',
    views: ordered.map(capture => ({
      view: capture.view, filename: referenceCaptureFilename(modelName, capture.view),
      widthPx: capture.width, heightPx: capture.height,
      frameWidthMm: capture.frameWidthMm, frameHeightMm: capture.frameHeightMm,
      frameCenterMm: { x: capture.frameCenter[0], y: capture.frameCenter[1], z: capture.frameCenter[2] }, // Changed
      mmPerPixelX: capture.frameWidthMm / capture.width,
      mmPerPixelY: capture.frameHeightMm / capture.height,
      modelDimensionsMm: { x: capture.modelDimensions[0], y: capture.modelDimensions[1], z: capture.modelDimensions[2] },
      direction: VIEW_DIRECTIONS[capture.view],
    })),
  };
  const metadataBytes = encoder.encode(JSON.stringify(metadata, null, 2));
  entries.push({ name: encoder.encode('metadata.json'), blob: new Blob([metadataBytes], { type: 'application/json' }), checksum: crc32(metadataBytes) });

  const timestamp = dosTimestamp(createdAt);
  const parts: BlobPart[] = [];
  const directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = zipHeader(entry, timestamp);
    const nextOffset = offset + header.byteLength + entry.blob.size;
    if (nextOffset > MAX_UINT32) throw new Error('ZIP 파일이 너무 큽니다. 이미지 해상도를 낮춰 주세요.');
    parts.push(header, entry.blob);
    directory.push(zipHeader(entry, timestamp, offset));
    offset = nextOffset;
  }
  const directorySize = directory.reduce((size, header) => size + header.byteLength, 0);
  if (offset + directorySize + 22 > MAX_UINT32) throw new Error('ZIP 파일이 너무 큽니다. 이미지 해상도를 낮춰 주세요.');
  const end = new Uint8Array(22);
  const fields = new DataView(end.buffer);
  fields.setUint32(0, 0x06054b50, true);
  fields.setUint16(8, entries.length, true);
  fields.setUint16(10, entries.length, true);
  fields.setUint32(12, directorySize, true);
  fields.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
