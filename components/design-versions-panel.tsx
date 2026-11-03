'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { GitCompareArrows, History, Loader2, RotateCcw, Save, Trash2, X } from 'lucide-react';
import type { LastProject } from '@/lib/project';
import { deleteDesignVersion, listDesignVersions, loadDesignVersion, loadRestoreBackup, MAX_DESIGN_VERSIONS, saveDesignVersion, type DesignVersion } from '@/lib/design-versions';
import { compareProjects } from '@/lib/project-diff';

export interface VersionComparison { version: DesignVersion; project: LastProject }
const dateLabel = (value: string) => new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// Changed: named snapshots stay in this browser; project sharing remains explicit.
export default function DesignVersionsPanel({ project, canSave, comparison, onRestore, onCompare, onStopComparison }: {
  project: LastProject;
  canSave: boolean;
  comparison: VersionComparison | null;
  onRestore: (next: LastProject, label: string, isActive: () => boolean) => Promise<void>;
  onCompare: (next: VersionComparison) => void;
  onStopComparison: () => void;
}) {
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [hasBackup, setHasBackup] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false);
  const operation = useRef(0);
  const locked = useRef(false);
  const differences = useMemo(() => comparison ? compareProjects(comparison.project, project) : [], [comparison, project]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; operation.current++; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void Promise.allSettled([listDesignVersions(), loadRestoreBackup()]).then(([list, backup]) => {
      if (!active) return;
      if (list.status === 'fulfilled') setVersions(list.value);
      else setError(list.reason instanceof Error ? list.reason.message : '설계 버전을 읽지 못했습니다.');
      if (backup.status === 'fulfilled') setHasBackup(backup.value !== null);
      else setError(backup.reason instanceof Error ? backup.reason.message : '복원 전 작업을 읽지 못했습니다.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [refresh]);

  async function run(label: string, work: (isActive: () => boolean) => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    const id = ++operation.current;
    const isActive = () => alive.current && operation.current === id;
    setPending(label); setError(''); setMessage('');
    try { await work(isActive); }
    catch (cause) { if (isActive()) setError(cause instanceof Error ? cause.message : '버전 작업을 완료하지 못했습니다.'); }
    finally { locked.current = false; if (isActive()) setPending(''); }
  }

  function saveVersion() {
    void run('저장 중', async isActive => {
      const saved = await saveDesignVersion(name, project);
      if (!isActive()) return;
      setVersions(previous => [saved, ...previous]); setName('');
      setMessage(`‘${saved.name}’ 버전을 저장했습니다.`);
    });
  }

  function restore(version: DesignVersion) {
    void run('버전 복원 중', async isActive => {
      const next = await loadDesignVersion(version.id);
      if (isActive()) await onRestore(next, version.name, isActive);
    });
  }

  function compare(version: DesignVersion) {
    void run('비교 준비 중', async isActive => {
      const next = await loadDesignVersion(version.id);
      if (isActive()) onCompare({ version, project: next });
    });
  }

  function recover() {
    void run('복원 전 작업을 여는 중', async isActive => {
      const backup = await loadRestoreBackup();
      if (!backup) throw new Error('복원 전 작업이 없습니다.');
      if (isActive()) await onRestore(backup, '복원 전 작업', isActive);
    });
  }

  function remove(version: DesignVersion) {
    void run('버전 삭제 중', async isActive => {
      await deleteDesignVersion(version.id);
      if (!isActive()) return;
      setVersions(previous => previous.filter(item => item.id !== version.id)); setDeleteId(null);
      if (comparison?.version.id === version.id) onStopComparison();
      setMessage(`‘${version.name}’ 저장 버전을 삭제했습니다.`);
    });
  }

  const working = loading || !!pending;
  return <div className="design-versions-panel">
    <p className="dialog-description">신발·라스트·참조 이미지·치수·정렬값을 함께 보관합니다. 저장한 버전을 불러오거나 현재 설계 위에 겹쳐 비교하세요.</p>
    <form className="version-save-form" onSubmit={event => { event.preventDefault(); if (!working && canSave && name.trim()) saveVersion(); }}>
      <label>버전 이름<input value={name} maxLength={80} placeholder="예: A안 · 발볼 +8 mm" disabled={working} onChange={event => setName(event.target.value)} /></label>
      <button className="button button-primary" type="submit" disabled={working || !canSave || !name.trim() || versions.length >= MAX_DESIGN_VERSIONS}>{pending === '저장 중' ? <Loader2 size={16} className="spin" /> : <Save size={16} />}현재 설계 저장</button>
    </form>
    <div className="versions-storage-note"><History size={15} /><span>이 브라우저에 저장 · 최대 {MAX_DESIGN_VERSIONS}개. 다른 기기에는 ‘파일 저장’ 또는 ‘공유’로 현재 설계를 전달하세요.</span></div>
    {!canSave && <p className="section-description">모델 준비가 끝나면 현재 설계를 저장할 수 있습니다.</p>}
    {error && <div className="version-error" role="alert">{error}<button className="text-button" disabled={working} onClick={() => setRefresh(value => value + 1)}>다시 확인</button></div>}
    {(message || pending) && <p className="version-message" role="status">{pending || message}</p>}

    <div className={`versions-layout ${comparison ? 'with-comparison' : ''}`}>
      <section className="version-list-section"><div className="version-list-heading"><h3>저장한 버전<span>{versions.length}</span></h3>
        {hasBackup && <button className="text-button" disabled={working} onClick={recover}><RotateCcw size={13} />복원 전 작업 복구</button>}</div>
        {loading ? <div className="version-empty"><Loader2 className="spin" size={22} /><p>저장한 버전을 읽고 있습니다.</p></div> : versions.length === 0 ? <div className="version-empty"><History size={27} /><strong>첫 설계안을 저장해 보세요</strong><p>다음 변경 전의 형상을 이름으로 남길 수 있습니다.</p></div> : <div className="version-list">{versions.map(version => <article key={version.id} className={`version-item ${comparison?.version.id === version.id ? 'comparing' : ''}`}>
          <div className="version-item-heading"><strong>{version.name}</strong><time dateTime={version.createdAt}>{dateLabel(version.createdAt)}</time></div>
          <p className="version-project-title">{version.projectTitle}</p>
          <p className="version-model-label">{version.modelLabel}{version.lastLabel ? ` + ${version.lastLabel}` : ''}</p>
          {deleteId === version.id ? <div className="version-delete-confirm"><p>이 저장 버전을 삭제할까요?</p><button className="text-button" disabled={working} onClick={() => setDeleteId(null)}>취소</button><button className="text-button danger" disabled={working} onClick={() => remove(version)}>버전 삭제 확인</button></div> : <div className="version-actions">
            <button className="button button-outline" aria-label={`${version.name} 불러오기`} disabled={working} onClick={() => restore(version)}><RotateCcw size={13} />불러오기</button>
            <button className="button button-outline" aria-label={`${version.name} 겹쳐 비교`} disabled={working || comparison?.version.id === version.id} onClick={() => compare(version)}><GitCompareArrows size={13} />{comparison?.version.id === version.id ? '비교 중' : '겹쳐 비교'}</button>
            <button className="icon-button version-delete" aria-label={`${version.name} 삭제`} disabled={working} onClick={() => setDeleteId(version.id)}><Trash2 size={14} /></button>
          </div>}
        </article>)}</div>}
        <p className="version-list-note">불러오기 전에 현재 작업을 자동 백업합니다. 두 저장본을 비교하려면 하나를 불러온 뒤 다른 버전을 ‘겹쳐 비교’하세요.</p>
      </section>
      {comparison && <section className="version-differences"><div className="version-list-heading"><h3>변경된 설정<span>{differences.length}</span></h3><button className="icon-button" aria-label="버전 비교 종료" onClick={onStopComparison}><X size={16} /></button></div>
        <p className="section-description"><b>{comparison.version.name}</b> → 현재 설계</p>
        {differences.length ? <div className="version-difference-scroll"><table><thead><tr><th>항목</th><th>저장본</th><th>현재</th></tr></thead><tbody>{differences.map(item => <tr key={item.key}><th>{item.label}</th><td>{item.before}</td><td>{item.after}{item.delta && <small>{item.delta}</small>}</td></tr>)}</tbody></table></div> : <div className="version-empty"><p>저장된 설계와 현재 설정이 같습니다.</p></div>}
        <p className="version-list-note">보라색은 선택한 저장본의 모델입니다. 단면·PNG·STL은 현재 설계를 기준으로 계산합니다.</p>
      </section>}
    </div>
  </div>;
}
