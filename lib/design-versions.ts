import type { LastProject } from './project';
import { PROJECT_ID_PATTERN, validateProject } from './project-validation';
import { openStudioDatabase, STUDIO_STORES, studioStorageError } from './local-store';
import { SHOE_SAMPLES } from './shoe-sample-catalog';

export interface DesignVersion {
  id: string;
  name: string;
  createdAt: string;
  projectTitle: string;
  modelLabel: string;
  lastLabel: string | null;
}

export const MAX_DESIGN_VERSIONS = 20;
const VERSION_STORES = [STUDIO_STORES.versions, STUDIO_STORES.versionProjects];
const RESTORE_BACKUP_KEY = 'restore-backup';

// Changed: secure random bytes also work in preview contexts without randomUUID.
export function createDesignVersionId(random: (Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>) | undefined = globalThis.crypto): string {
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  if (typeof random?.getRandomValues !== 'function') throw new Error('안전한 버전 ID를 생성할 수 없습니다. 최신 브라우저에서 다시 시도해 주세요.');
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Changed: explicit snapshots validate and detach all mutable state before any
// database await. The same source is used for metadata and its project payload.
export function normalizeDesignVersionName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('버전 이름을 1~80자로 입력해 주세요.');
  const clean = name.normalize('NFC').trim();
  if (!clean || clean.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(clean)) {
    throw new Error('버전 이름은 제어 문자 없이 1~80자로 입력해 주세요.');
  }
  return clean;
}

export function createDesignVersionSnapshot(name: string, project: LastProject): { metadata: DesignVersion; project: LastProject } {
  const cleanName = normalizeDesignVersionName(name);
  const snapshot = structuredClone(validateProject(project));
  const sampleName = SHOE_SAMPLES.find(sample => sample.id === snapshot.settings.sampleKind)!.name;
  return {
    metadata: {
      id: createDesignVersionId(), name: cleanName, createdAt: new Date().toISOString(),
      projectTitle: snapshot.title,
      modelLabel: snapshot.model?.name ?? `${sampleName} 샘플`,
      lastLabel: snapshot.last.enabled ? snapshot.last.model?.name ?? '데모 라스트' : null,
    },
    project: snapshot,
  };
}

function requireId(id: string): void {
  if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) throw new Error('설계 버전 ID가 올바르지 않습니다. 목록에서 다시 선택해 주세요.');
}

function readMetadata(input: unknown): DesignVersion {
  const version = input as Partial<DesignVersion> | null;
  const label = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
  try {
    if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error();
    requireId(version.id!);
    if (version.name !== normalizeDesignVersionName(version.name)
      || !label(version.projectTitle, 100) || !label(version.modelLabel, 200)
      || (version.lastLabel !== null && !label(version.lastLabel, 200))
      || typeof version.createdAt !== 'string' || version.createdAt.length > 32
      || !Number.isFinite(Date.parse(version.createdAt)) || new Date(version.createdAt).toISOString() !== version.createdAt) throw new Error();
    return {
      id: version.id!, name: version.name, createdAt: version.createdAt,
      projectTitle: version.projectTitle!, modelLabel: version.modelLabel!, lastLabel: version.lastLabel!,
    };
  } catch { throw new Error('저장된 설계 버전 정보가 손상되어 읽을 수 없습니다.'); }
}

type TransactionAction<T> = (transaction: IDBTransaction, result: (value: T) => void, abort: (error: Error) => void) => void;

// Changed: completion is reported only after commit; every failure aborts the
// complete transaction so metadata and payload cannot become orphaned.
async function transact<T>(stores: string[], mode: IDBTransactionMode, action: TransactionAction<T>): Promise<T> {
  const db = await openStudioDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      let value: T;
      let failure: Error | null = null;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(failure ?? studioStorageError(transaction.error));
      const abort = (error: Error) => {
        failure = error;
        try { transaction.abort(); } catch { reject(error); }
      };
      try { action(transaction, result => { value = result; }, abort); }
      catch (cause) { abort(studioStorageError(cause)); }
    });
  } catch (cause) { throw studioStorageError(cause); }
  finally { db.close(); }
}

export async function listDesignVersions(): Promise<DesignVersion[]> {
  const rows = await transact<unknown[]>([STUDIO_STORES.versions], 'readonly', (transaction, result) => {
    const request = transaction.objectStore(STUDIO_STORES.versions).getAll();
    request.onsuccess = () => result(request.result);
  });
  return rows.map(readMetadata).sort((first, second) => second.createdAt.localeCompare(first.createdAt) || second.id.localeCompare(first.id));
}

export async function saveDesignVersion(name: string, project: LastProject): Promise<DesignVersion> {
  const snapshot = createDesignVersionSnapshot(name, project);
  return transact(VERSION_STORES, 'readwrite', (transaction, result, abort) => {
    const metadata = transaction.objectStore(STUDIO_STORES.versions);
    const count = metadata.count();
    count.onsuccess = () => {
      if (count.result >= MAX_DESIGN_VERSIONS) {
        abort(new Error(`설계 버전은 최대 ${MAX_DESIGN_VERSIONS}개까지 저장할 수 있습니다. 이전 버전을 삭제한 뒤 다시 저장해 주세요.`));
        return;
      }
      try {
        metadata.add(snapshot.metadata);
        transaction.objectStore(STUDIO_STORES.versionProjects).add(snapshot.project, snapshot.metadata.id);
        result(snapshot.metadata);
      } catch (cause) { abort(studioStorageError(cause)); }
    };
  });
}

export async function loadDesignVersion(id: string): Promise<LastProject> {
  requireId(id);
  const record = await transact<{ metadata: unknown; project: unknown }>(VERSION_STORES, 'readonly', (transaction, result) => {
    const pair = { metadata: undefined as unknown, project: undefined as unknown };
    const metadata = transaction.objectStore(STUDIO_STORES.versions).get(id);
    const project = transaction.objectStore(STUDIO_STORES.versionProjects).get(id);
    metadata.onsuccess = () => { pair.metadata = metadata.result; };
    project.onsuccess = () => { pair.project = project.result; };
    result(pair);
  });
  if (record.metadata === undefined && record.project === undefined) throw new Error('해당 설계 버전이 없거나 다른 탭에서 삭제되었습니다. 목록을 새로고침해 주세요.');
  if (record.metadata === undefined || record.project === undefined) throw new Error('설계 버전의 정보와 프로젝트 데이터가 일치하지 않습니다. 이 버전은 복원할 수 없습니다.');
  const metadata = readMetadata(record.metadata);
  if (metadata.id !== id) throw new Error('설계 버전 ID와 저장된 정보가 일치하지 않습니다.');
  try { return validateProject(record.project); }
  catch { throw new Error('저장된 설계 프로젝트가 손상되어 복원할 수 없습니다.'); }
}

export async function deleteDesignVersion(id: string): Promise<void> {
  requireId(id);
  await transact<void>(VERSION_STORES, 'readwrite', transaction => {
    transaction.objectStore(STUDIO_STORES.versions).delete(id);
    transaction.objectStore(STUDIO_STORES.versionProjects).delete(id);
  });
}

// Changed: one restore safety copy lives beside the draft, outside the 20-version
// limit. A failed replacement leaves the previous backup committed and intact.
export async function saveRestoreBackup(project: LastProject): Promise<void> {
  const snapshot = structuredClone(validateProject(project));
  await transact<void>([STUDIO_STORES.workspace], 'readwrite', transaction => {
    transaction.objectStore(STUDIO_STORES.workspace).put(snapshot, RESTORE_BACKUP_KEY);
  });
}

export async function loadRestoreBackup(): Promise<LastProject | null> {
  const snapshot = await transact<unknown>([STUDIO_STORES.workspace], 'readonly', (transaction, result) => {
    const request = transaction.objectStore(STUDIO_STORES.workspace).get(RESTORE_BACKUP_KEY);
    request.onsuccess = () => result(request.result);
  });
  if (snapshot === undefined) return null;
  try { return validateProject(snapshot); }
  catch { throw new Error('복원 직전 백업이 손상되어 읽을 수 없습니다. 저장한 프로젝트 파일이나 다른 설계 버전을 사용해 주세요.'); }
}
