import { MAX_PROJECT_BYTES, type LastProject } from './project';
import { estimateProjectBytes, validateProject } from './project-validation';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('last-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDraft(): Promise<LastProject | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('workspace', 'readonly').objectStore('workspace').get('draft');
      request.onsuccess = () => {
        try { resolve(request.result ? validateProject(request.result) : null); }
        catch { resolve(null); }
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function saveDraft(project: LastProject): Promise<void> {
  // Changed: keep the last valid draft when combined assets exceed the project budget.
  if (estimateProjectBytes(project) > MAX_PROJECT_BYTES) {
    throw new Error('프로젝트 전체 크기는 30 MB 이하여야 합니다. 이미지나 모델 용량을 줄인 후 다시 저장해 주세요.');
  }
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('workspace', 'readwrite');
      transaction.objectStore('workspace').put(project, 'draft');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
