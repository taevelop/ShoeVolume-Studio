import {
  MAX_ASSET_BYTES,
  MAX_PROJECT_BYTES,
  projectFilename,
  type ImageAsset,
  type LastProject,
  type ModelAsset,
} from './project';
import {
  PROJECT_ID_PATTERN,
  validateImageAsset,
  validateModelAsset,
  validateProject,
} from './project-validation';

export { validateProject } from './project-validation';

function checkFileSize(file: File, maximum = MAX_ASSET_BYTES): void {
  if (!file.size) throw new Error('비어 있는 파일은 불러올 수 없습니다.');
  if (file.size > maximum) {
    throw new Error(`파일 크기는 ${maximum / 1024 / 1024} MB 이하여야 합니다.`);
  }
}

function fileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('파일을 읽지 못했습니다.'));
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다. 다시 선택해 주세요.'));
    reader.onabort = () => reject(new Error('파일 읽기가 취소되었습니다.'));
    reader.readAsDataURL(file);
  });
}

export async function readImageFile(file: File): Promise<ImageAsset> {
  checkFileSize(file);
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let mime: string;
  if (header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71) mime = 'image/png';
  else if (header[0] === 255 && header[1] === 216 && header[2] === 255) mime = 'image/jpeg';
  else if (String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP') mime = 'image/webp';
  else throw new Error('PNG, JPG, WebP 이미지를 선택해 주세요.');
  return validateImageAsset({ name: file.name, dataUrl: await fileDataUrl(file.slice(0, file.size, mime)) });
}

export async function readModelFile(file: File): Promise<ModelAsset> {
  checkFileSize(file);
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension !== 'stl' && extension !== 'obj' && extension !== 'glb') {
    throw new Error('STL, OBJ, GLB 파일을 선택해 주세요.');
  }
  const bytes = await file.arrayBuffer();
  if (extension === 'obj') {
    const content = new TextDecoder().decode(bytes);
    if (!/^\s*v\s+[-+\d.]/m.test(content) || !/^\s*f\s+[-+]?\d/m.test(content)) {
      throw new Error('OBJ 파일에 표시할 꼭짓점과 면이 없습니다. 메시 형태로 내보내 주세요.');
    }
  } else if (extension === 'stl') {
    const binaryCount = bytes.byteLength >= 84 ? new DataView(bytes).getUint32(80, true) : 0;
    const isBinary = binaryCount > 0 && 84 + binaryCount * 50 <= bytes.byteLength;
    if (!isBinary) {
      const content = new TextDecoder().decode(bytes);
      if (!/^\s*solid\b/i.test(content) || !/\bfacet\s+normal\b/i.test(content) || !/\bvertex\s+[-+\d.]/i.test(content)) {
        throw new Error('STL 파일에 표시할 삼각형 형상이 없습니다. STL로 다시 내보내 주세요.');
      }
    }
  }
  return validateModelAsset({
    name: file.name,
    format: extension,
    dataUrl: await fileDataUrl(new Blob([bytes], { type: extension === 'glb' ? 'model/gltf-binary' : 'application/octet-stream' })),
  });
}

export async function readProjectFile(file: File): Promise<LastProject> {
  checkFileSize(file, MAX_PROJECT_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); }
  catch { throw new Error('프로젝트 파일을 읽을 수 없습니다. .laststudio.json 파일을 선택해 주세요.'); }
  return validateProject(parsed);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function downloadProject(project: LastProject): void {
  const clean = validateProject({ ...project, savedAt: new Date().toISOString() });
  downloadBlob(new Blob([JSON.stringify(clean)], { type: 'application/json' }), projectFilename(clean.title));
}

async function apiRequest(url: string, options: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error(response.ok ? '서버 응답을 해석할 수 없습니다.' : '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '프로젝트를 처리하지 못했습니다.';
      throw new Error(message);
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('연결 시간이 초과되었습니다. 파일을 내려받아 보관한 뒤 다시 시도해 주세요.');
    }
    if (error instanceof TypeError) throw new Error('네트워크 연결을 확인해 주세요. 프로젝트는 파일로 내려받아 보관할 수 있습니다.');
    throw error;
  } finally { window.clearTimeout(timer); }
}

export async function saveProjectSnapshot(project: LastProject): Promise<{ id: string; savedAt: string }> {
  const body = await apiRequest('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validateProject(project)),
  });
  if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string' || !PROJECT_ID_PATTERN.test(body.id) || !('savedAt' in body) || typeof body.savedAt !== 'string') {
    throw new Error('공유 링크를 확인하지 못했습니다. 다시 시도해 주세요.');
  }
  return { id: body.id, savedAt: body.savedAt };
}

export async function loadProjectSnapshot(id: string): Promise<LastProject> {
  if (!PROJECT_ID_PATTERN.test(id)) throw new Error('프로젝트 공유 주소가 올바르지 않습니다.');
  return validateProject(await apiRequest(`/api/projects/${encodeURIComponent(id)}`));
}
