import { MAX_PROJECT_BYTES, type LastProject } from './project';
import { estimateProjectBytes, validateProject } from './project-validation';

// Changed: version metadata stays small; full portable projects live separately.
export const STUDIO_STORES = {
  workspace: 'workspace',
  versions: 'design-versions',
  versionProjects: 'design-version-projects',
} as const;

export function studioStorageError(cause: unknown, fallback = '브라우저 저장소 작업을 완료하지 못했습니다. 다시 시도해 주세요.'): Error {
  if (cause instanceof Error && cause.name === 'QuotaExceededError') {
    return new Error('브라우저 저장 공간이 부족합니다. 필요한 프로젝트를 파일로 보관한 뒤 이전 설계 버전을 삭제해 주세요.');
  }
  return cause instanceof Error && cause.name === 'Error' ? cause : new Error(fallback);
}

// Changed: preserve v1's draft while adding v2 stores. A blocked request may
// finish after rejection, so every late connection is explicitly closed.
export function openStudioDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('이 환경에서는 브라우저 저장소를 사용할 수 없습니다. 프로젝트 파일로 보관해 주세요.'));
      return;
    }
    let settled = false;
    let upgrading: IDBDatabase | null = null;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      reject(studioStorageError(cause, '브라우저 저장소를 열지 못했습니다. 브라우저의 저장소 설정을 확인해 주세요.'));
    };
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open('last-studio', 2); }
    catch (cause) { fail(cause); return; }
    request.onblocked = () => fail(new Error('다른 탭이 이전 저장소를 사용하고 있습니다. Last Studio의 다른 탭을 닫거나 새로고침한 뒤 다시 시도해 주세요.'));
    request.onupgradeneeded = () => {
      const db = request.result;
      upgrading = db;
      db.onversionchange = () => db.close();
      if (settled) { request.transaction?.abort(); db.close(); return; }
      try {
        if (!db.objectStoreNames.contains(STUDIO_STORES.workspace)) db.createObjectStore(STUDIO_STORES.workspace);
        if (!db.objectStoreNames.contains(STUDIO_STORES.versions)) db.createObjectStore(STUDIO_STORES.versions, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STUDIO_STORES.versionProjects)) db.createObjectStore(STUDIO_STORES.versionProjects);
      } catch (cause) {
        fail(cause);
        request.transaction?.abort();
        db.close();
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => db.close();
      settled = true;
      resolve(db);
    };
    request.onerror = () => { upgrading?.close(); fail(request.error); };
  });
}

export async function loadDraft(): Promise<LastProject | null> {
  const db = await openStudioDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STUDIO_STORES.workspace, 'readonly').objectStore(STUDIO_STORES.workspace).get('draft');
      request.onsuccess = () => {
        try { resolve(request.result ? validateProject(request.result) : null); }
        catch { resolve(null); }
      };
      request.onerror = () => reject(studioStorageError(request.error));
    });
  } finally { db.close(); }
}

export async function saveDraft(project: LastProject): Promise<void> {
  // Changed: keep the last valid draft when combined assets exceed the project budget.
  if (estimateProjectBytes(project) > MAX_PROJECT_BYTES) {
    throw new Error('프로젝트 전체 크기는 30 MB 이하여야 합니다. 이미지나 모델 용량을 줄인 후 다시 저장해 주세요.');
  }
  const db = await openStudioDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STUDIO_STORES.workspace, 'readwrite');
      transaction.objectStore(STUDIO_STORES.workspace).put(project, 'draft');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(studioStorageError(transaction.error));
    });
  } catch (cause) { throw studioStorageError(cause); }
  finally { db.close(); }
}
