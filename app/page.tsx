'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import {
  ArrowUpRight, Box, Camera, Check, ChevronDown, CircleHelp, Copy, Download,
  Eye, EyeOff, FileJson, FlipHorizontal2, FolderOpen, Grid3X3, Image as ImageIcon,
  Layers, Link2, Loader2, Maximize2, Move, Plus, RotateCcw, RotateCw, Ruler,
  Share2, SlidersHorizontal, Upload, X,
} from 'lucide-react';
import LastViewport from '@/components/last-viewport';
import ReferenceDimensions from '@/components/reference-dimensions';
import { ShoeSampleGallery, ShoeSampleQuickbar } from '@/components/shoe-sample-picker';
import ReferenceCapturePanel from '@/components/reference-capture-panel'; // Changed
import type { ReferenceCaptureFunction } from '@/lib/reference-capture-types'; // Changed
import {
  createDefaultProject, PLANE_LABELS, type LastProject, type ModelInfo,
  type PlaneKey, type SceneSettings, type Vec3, type ViewKey,
} from '@/lib/project';
import {
  downloadProject, loadProjectSnapshot, readImageFile, readModelFile,
  readProjectFile, saveProjectSnapshot,
} from '@/lib/project-io';
import { loadDraft, saveDraft } from '@/lib/local-store';
import { createReferenceProject } from '@/lib/reference-preset';
import { REFERENCE_DIMENSIONS } from '@/lib/reference-data';
import { SHOE_SAMPLES, DEFAULT_SAMPLE_KIND, type SampleKind } from '@/lib/shoe-sample-catalog';

const PLANE_KEYS: PlaneKey[] = ['side', 'top', 'front', 'rear'];
const VIEWS: { key: ViewKey; label: string; axis: string }[] = [
  { key: 'iso', label: '입체', axis: '3D' }, { key: 'side', label: '측면', axis: 'XZ' },
  { key: 'top', label: '윗면', axis: 'XY' }, { key: 'front', label: '정면', axis: 'YZ' },
  { key: 'rear', label: '후면', axis: 'YZ' },
];
type ModalKind = 'share' | 'help' | 'references' | 'dimensions' | 'samples' | 'capture' | 'reset' | null; // Changed
type Notice = { message: string; type: 'success' | 'error' };

function NumberField({ label, value, onChange, min = -10000, max = 10000, step = 1, suffix }: {
  label: string; value: number; onChange: (value: number) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Math.round(value * 1000) / 1000)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() && Number.isFinite(n)) {
      const next = Math.min(max, Math.max(min, n)); onChange(next); setText(String(next));
    } else setText(String(value));
  };
  return <label className="number-field" htmlFor={id}><span>{label}</span><div>
    <input id={id} type="number" inputMode="decimal" min={min} max={max} step={step}
      value={text} onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    {suffix && <small>{suffix}</small>}</div></label>;
}

function VectorFields({ label, value, onChange, unit, min, max, step = 1 }: {
  label: string; value: Vec3; onChange: (value: Vec3) => void;
  unit: string; min?: number; max?: number; step?: number;
}) {
  return <div className="vector-fields">{['X', 'Y', 'Z'].map((axis, index) =>
    <NumberField key={axis} label={`${axis} ${label}`} value={value[index]} suffix={unit}
      min={min} max={max} step={step} onChange={n => {
        const next = [...value] as Vec3; next[index] = n; onChange(next);
      }} />,
  )}</div>;
}

function RangeField({ label, value, min = 0, max = 100, step = 1, unit = '', onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number;
  unit?: string; onChange: (value: number) => void;
}) {
  const id = useId();
  return <label className="range-field" htmlFor={id}>
    <span>{label}<output>{Math.round(value * 10) / 10}<small>{unit}</small></output></span>
    <input id={id} type="range" min={min} max={max} step={step} value={value}
      style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      onChange={e => onChange(Number(e.target.value))} />
  </label>;
}

function Toggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked}
    onChange={e => onChange(e.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label>;
}

function Dialog({ open, title, onClose, children, wide = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-content"><div className="dialog-heading"><h2 id={titleId}>{title}</h2>
      <button className="icon-button" onClick={onClose} aria-label="닫기"><X size={20} /></button></div>{children}</div>
  </dialog>;
}

function PlaneThumbnail({ plane, project }: { plane: PlaneKey; project: LastProject }) {
  const image = project.planes[plane].image;
  if (image) return <img src={image.dataUrl} alt={`${PLANE_LABELS[plane].name} 참조 이미지`}
    style={{ transform: project.planes[plane].flip ? 'scaleX(-1)' : undefined }} />;
  const paths: Record<PlaneKey, string> = {
    side: 'M12 43 C12 35 28 32 40 27 L51 9 Q59 6 69 11 L75 41 Q50 50 12 43Z',
    top: 'M12 25 C12 12 33 10 47 16 C60 23 65 15 74 19 C80 22 80 33 74 36 C64 40 59 31 47 38 C30 45 12 39 12 25Z',
    front: 'M25 44 C17 41 20 32 28 24 L34 13 Q45 9 56 13 L62 24 C70 32 73 41 65 44Z',
    rear: 'M29 43 L31 13 Q45 7 59 13 L61 43 Q45 48 29 43Z',
  };
  return <svg viewBox="0 0 90 55" role="img" aria-label={`${PLANE_LABELS[plane].name} 샘플 윤곽 아이콘`}>
    <path d="M8 27.5H82M45 5V50" stroke="currentColor" strokeOpacity=".16" strokeDasharray="2 3" />
    <path d={paths[plane]} fill="currentColor" fillOpacity=".06" stroke="currentColor" strokeWidth="1.2" />
  </svg>;
}

export default function Home() {
  const [project, setProject] = useState<LastProject>(createDefaultProject);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [inspector, setInspector] = useState<'view' | 'transform'>('view');
  const [mobilePanel, setMobilePanel] = useState<'sources' | 'settings' | null>(null);
  const [selectedPlane, setSelectedPlane] = useState<PlaneKey>('side');
  const [modelInfo, setModelInfo] = useState<ModelInfo>({ dimensions: [253, 105.31, 79.4], triangles: 0, sample: true });
  const [renderMode, setRenderMode] = useState<'webgl' | 'software'>('webgl');
  const [measure, setMeasure] = useState(false);
  const [distance, setDistance] = useState<number | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [screenshotToken, setScreenshotToken] = useState(0);
  const [captureAvailable, setCaptureAvailable] = useState(false); // Changed
  const [draftStatus, setDraftStatus] = useState<'saving' | 'saved' | 'unavailable'>('saving');
  const [shareUrl, setShareUrl] = useState('');
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const modelInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<ReferenceCaptureFunction | null>(null); // Changed
  const uploadPlane = useRef<PlaneKey>('side');
  const dragCount = useRef(0);
  const mounted = useRef(true);
  const currentProject = useRef(project);
  currentProject.current = project;
  const previousModel = useRef<{ model: LastProject['model']; settings: SceneSettings } | null>(null);

  const notify = useCallback((message: string, type: Notice['type'] = 'success') => setNotice({ message, type }), []);
  const reportError = useCallback((message: string) => {
    if (previousModel.current) {
      const previous = previousModel.current; previousModel.current = null;
      setProject(current => ({ ...current, ...previous }));
    }
    notify(message, 'error');
  }, [notify]);
  const modelChanged = useCallback((info: ModelInfo) => setModelInfo(info), []);
  const modelLoaded = useCallback(() => { previousModel.current = null; }, []);
  const measurementChanged = useCallback((n: number | null) => setDistance(n), []);
  // Changed: keep the renderer API stable while the export dialog owns its previews.
  const captureReady = useCallback((capture: ReferenceCaptureFunction | null) => {
    captureRef.current = capture; setCaptureAvailable(capture !== null);
  }, []);
  const captureReferences = useCallback<ReferenceCaptureFunction>(async options => {
    if (!captureRef.current) throw new Error('3D 모델을 준비하는 중입니다. 잠시 후 다시 캡처해 주세요.');
    return captureRef.current(options);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    async function initialize() {
      const id = new URL(window.location.href).searchParams.get('project');
      try {
        if (id) {
          setBusy('공유 프로젝트를 불러오는 중');
          const saved = await loadProjectSnapshot(id);
          if (!cancelled) {
            if (saved.model) previousModel.current = { model: null, settings: { ...saved.settings, modelUnits: 'mm', modelUp: 'z', modelScale: 1, modelPosition: [0, 0, 0], modelRotation: [0, 0, 0] } };
            setProject(saved); notify('저장된 공유 프로젝트를 불러왔습니다.');
          }
        } else {
          let draft: LastProject | null = null;
          try { draft = await loadDraft(); } catch { if (!cancelled) setDraftStatus('unavailable'); }
          const initial = draft ?? await createReferenceProject();
          if (!cancelled) {
            if (initial.model) previousModel.current = { model: null, settings: { ...initial.settings, modelUnits: 'mm', modelUp: 'z', modelScale: 1, modelPosition: [0, 0, 0], modelRotation: [0, 0, 0] } };
            setProject(initial);
          }
        }
      } catch (error) {
        if (!cancelled) {
          if (id) notify(error instanceof Error ? error.message : '프로젝트를 불러오지 못했습니다.', 'error');
          else notify('기본 참조 이미지를 불러오지 못했습니다. 새 샘플 프로젝트로 다시 열어 주세요.', 'error');
        }
      } finally { if (!cancelled) { setBusy(''); setReady(true); } }
    }
    void initialize();
    return () => { cancelled = true; mounted.current = false; };
  }, [notify]);

  useEffect(() => {
    if (!ready) return;
    setShareUrl(''); setCopied(false); setDraftStatus('saving');
    let active = true;
    const timer = setTimeout(() => {
      void saveDraft(project).then(() => { if (active) setDraftStatus('saved'); })
        .catch(() => { if (active) setDraftStatus('unavailable'); });
    }, 650);
    return () => { active = false; clearTimeout(timer); };
  }, [project, ready]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.type === 'error' ? 8500 : 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  const updateSettings = useCallback((patch: Partial<SceneSettings>) => {
    setProject(previous => ({ ...previous, settings: { ...previous.settings, ...patch } }));
  }, []);

  function updatePlane(key: PlaneKey, patch: Partial<LastProject['planes'][PlaneKey]>) {
    setProject(previous => ({ ...previous, planes: { ...previous.planes, [key]: { ...previous.planes[key], ...patch } } }));
  }

  async function runTask(label: string, task: () => Promise<void>) {
    setBusy(label);
    try { await task(); }
    catch (error) { notify(error instanceof Error ? error.message : '작업을 완료하지 못했습니다.', 'error'); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function importModel(file: File) {
    await runTask('라스트를 불러오는 중', async () => {
      const model = await readModelFile(file);
      previousModel.current = { model: project.model, settings: project.settings };
      setProject(previous => ({ ...previous, model, settings: {
        ...previous.settings, modelPosition: [0, 0, 0], modelRotation: [0, 0, 0], modelScale: 1,
        modelUp: model.format === 'glb' || model.format === 'obj' ? 'y' : 'z',
        modelUnits: model.format === 'glb' ? 'm' : 'mm', showLast: true,
      } }));
      setInspector('transform'); setResetToken(n => n + 1);
      notify('라스트를 읽었습니다. 원본 단위와 축 방향을 확인하세요.');
    });
  }

  async function importProject(file: File) {
    await runTask('프로젝트를 여는 중', async () => {
      const next = await readProjectFile(file);
      previousModel.current = next.model || project.model || next.settings.sampleKind !== project.settings.sampleKind ? { model: project.model, settings: project.settings } : null;
      setProject(next); setMeasure(false);
      setResetToken(n => n + 1);
      window.history.replaceState(null, '', window.location.pathname);
      notify('이미지와 모델을 포함한 프로젝트를 열었습니다.');
    });
  }

  async function importImage(file: File, key: PlaneKey) {
    await runTask('참조 이미지를 불러오는 중', async () => {
      const image = await readImageFile(file); updatePlane(key, { image, visible: true });
      setSelectedPlane(key); notify(`${PLANE_LABELS[key].name} 이미지를 적용했습니다.`);
    });
  }

  function selectImage(key: PlaneKey) { uploadPlane.current = key; imageInput.current?.click(); }

  function chooseSample(kind: SampleKind) {
    const sample = SHOE_SAMPLES.find(item => item.id === kind)!;
    previousModel.current = project.model || project.settings.sampleKind !== kind ? { model: project.model, settings: project.settings } : null;
    setProject(previous => ({ ...previous, model: null,
      settings: { ...previous.settings, sampleKind: kind, modelPosition: [0, 0, 0], modelRotation: [0, 0, 0], modelScale: 1, modelUnits: 'mm', modelUp: 'z', showLast: true, view: 'iso' },
      planes: Object.fromEntries(PLANE_KEYS.map(key => [key, { ...previous.planes[key], visible: false }])) as LastProject['planes'],
    }));
    setMeasure(false); setDistance(null); setResetToken(n => n + 1); setModal(null); setMobilePanel(null);
    notify(`${sample.name} 신발 샘플을 적용했습니다.`);
  }

  function toggleReferences() {
    setProject(previous => {
      const show = !PLANE_KEYS.some(key => previous.planes[key].visible);
      return { ...previous, planes: Object.fromEntries(PLANE_KEYS.map(key => [key, { ...previous.planes[key], visible: show }])) as LastProject['planes'] };
    });
  }

  async function acceptFile(e: ChangeEvent<HTMLInputElement>, type: 'model' | 'project' | 'image') {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (type === 'model') await importModel(file);
    else if (type === 'project') await importProject(file);
    else await importImage(file, uploadPlane.current);
  }

  async function handleDrop(file: File) {
    if (/\.(stl|obj|glb)$/i.test(file.name)) await importModel(file);
    else if (/\.json$/i.test(file.name)) await importProject(file);
    else if (/\.(png|jpe?g|webp)$/i.test(file.name)) await importImage(file, selectedPlane);
    else notify('STL·OBJ·GLB, PNG·JPG·WebP 또는 프로젝트 JSON 파일을 사용하세요.', 'error');
  }

  function exportFile() {
    try { downloadProject(project); notify('이미지와 모델이 포함된 프로젝트 파일을 저장했습니다.'); }
    catch (error) { reportError(error instanceof Error ? error.message : '파일을 저장하지 못했습니다.'); }
  }

  async function createShare() {
    const snapshot = project;
    setSharing(true);
    try {
      const saved = await saveProjectSnapshot(snapshot);
      if (!mounted.current) return;
      if (currentProject.current !== snapshot) {
        notify('저장 중 프로젝트가 변경되었습니다. 현재 상태로 링크를 다시 만들어 주세요.');
        return;
      }
      const url = new URL(window.location.pathname, window.location.origin);
      url.searchParams.set('project', saved.id); setShareUrl(url.href);
      notify('현재 형상과 이미지가 함께 저장되었습니다.');
    } catch (error) { reportError(error instanceof Error ? error.message : '공유 프로젝트를 저장하지 못했습니다.'); }
    finally { if (mounted.current) setSharing(false); }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl); setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { reportError('링크를 길게 누르거나 선택해 직접 복사하세요.'); }
  }

  async function resetSample() {
    setModal(null);
    await runTask('기준 이미지와 샘플을 불러오는 중', async () => {
      const next = await createReferenceProject();
      setProject(next); setMeasure(false); setDistance(null); setResetToken(n => n + 1);
      window.history.replaceState(null, '', window.location.pathname);
      notify('제공된 치수와 네 방향 이미지로 초기화했습니다.');
    });
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageRef.current?.requestFullscreen) await stageRef.current.requestFullscreen();
      else notify('이 브라우저는 전체 화면을 지원하지 않습니다.', 'error');
    } catch { reportError('전체 화면을 열지 못했습니다.'); }
  }

  const settings = project.settings;
  const sampleDefinition = SHOE_SAMPLES.find(sample => sample.id === (settings.sampleKind ?? DEFAULT_SAMPLE_KIND))!;
  const modelName = project.model?.name ?? `${sampleDefinition.name} · 샘플`;
  const referencesVisible = PLANE_KEYS.some(key => project.planes[key].visible);
  const selected = project.planes[selectedPlane];
  const importedCount = PLANE_KEYS.filter(key => project.planes[key].image).length;

  return <div className="studio-app">
    <input ref={modelInput} type="file" accept=".stl,.obj,.glb" className="hidden-input" onChange={e => void acceptFile(e, 'model')} />
    <input ref={projectInput} type="file" accept=".json,.laststudio.json" className="hidden-input" onChange={e => void acceptFile(e, 'project')} />
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden-input" onChange={e => void acceptFile(e, 'image')} />
    <header className="app-header">
      <a className="brand" href="/" aria-label="Last Studio 홈"><span className="brand-mark"><Box size={22} strokeWidth={1.5} /></span>
        <span>last<span className="brand-light">studio</span><small>FOOTWEAR DESIGN WORKSPACE</small></span></a>
      <div className="header-divider" />
      <div className="header-project"><span className="tiny-dot" /><span>형상 검토</span><span className="version-pill">BETA</span></div>
      <nav className="header-actions" aria-label="프로젝트 작업">
        <button className="button button-quiet" onClick={() => projectInput.current?.click()} disabled={!!busy}><FolderOpen size={16} /><span>열기</span></button>
        <button className="button button-outline save-button" onClick={exportFile} disabled={!ready || !!busy}><Download size={16} /><span>파일 저장</span></button>
        <button className="button button-primary" onClick={() => setModal('share')} disabled={!ready || !!busy}><Share2 size={16} /><span>공유</span></button>
      </nav>
    </header>
    <div className="workspace-shell">
      <aside className={`sources-panel ${mobilePanel === 'sources' ? 'mobile-open' : ''}`} aria-label="모델과 참조 이미지">
        <div className="panel-top"><span className="eyebrow">WORKSPACE</span>
          <button className="icon-button mobile-only" onClick={() => setMobilePanel(null)} aria-label="자료 패널 닫기"><X size={18} /></button>
          <button className="icon-button desktop-only" onClick={() => setModal('reset')} aria-label="새 샘플 프로젝트"><Plus size={17} /></button>
        </div>
        <div className="workspace-item"><span className="workspace-icon"><Layers size={18} /></span><div><strong>신발 디자인</strong><span>다측면 & 라스트</span></div><ChevronDown size={14} /></div>
        <div className="section-label"><span>3D 모델</span><span className="count-badge">01</span></div>
        <div className="model-card">
          <div className="model-card-head"><span className="file-icon"><Box size={21} strokeWidth={1.4} /></span>
            <div><strong title={modelName}>{modelName}</strong><span>{project.model ? `${project.model.format.toUpperCase()} · 사용자 모델` : `${sampleDefinition.englishName} · 개념 모델`}</span></div>
            <button className={`icon-button ${settings.showLast ? 'is-visible' : ''}`} onClick={() => updateSettings({ showLast: !settings.showLast })}
              aria-label={settings.showLast ? '모델 숨기기' : '모델 표시'} aria-pressed={settings.showLast}>{settings.showLast ? <Eye size={16} /> : <EyeOff size={16} />}</button>
          </div>
          <div className="model-dimensions">{modelInfo.dimensions.map(n => n.toFixed(1)).join(' × ')} <span>mm</span></div>
          <button className="button model-upload" onClick={() => modelInput.current?.click()} disabled={!!busy}><Upload size={14} />모델 불러오기<ArrowUpRight size={14} /></button>
          <div className="file-formats">STL · OBJ · GLB<span>최대 15 MB</span></div>
        </div>
        <button className="button sample-library-button" onClick={() => setModal('samples')}><Grid3X3 size={14} />신발 샘플 5종<ArrowUpRight size={14} /></button>
        <div className="section-label"><span>참조 이미지</span><span className="count-badge">{String(importedCount).padStart(2, '0')} / 04</span></div>
        <div className="plane-list">{PLANE_KEYS.map(key => <div key={key} className={`plane-row ${selectedPlane === key ? 'selected' : ''}`}>
          <button className="plane-select" onClick={() => { setSelectedPlane(key); setInspector('view'); }} aria-pressed={selectedPlane === key}>
            <span className="plane-thumb"><PlaneThumbnail plane={key} project={project} /></span>
            <span className="plane-text"><strong>{PLANE_LABELS[key].name}<small>{PLANE_LABELS[key].axis}</small></strong><span>{project.planes[key].image?.name ?? '샘플 윤곽'}</span></span>
          </button>
          <button className="icon-button plane-eye" onClick={() => updatePlane(key, { visible: !project.planes[key].visible })}
            aria-label={`${PLANE_LABELS[key].name} ${project.planes[key].visible ? '숨기기' : '표시'}`} aria-pressed={project.planes[key].visible}>
            {project.planes[key].visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
        </div>)}</div>
        <button className="button add-reference" onClick={() => selectImage(selectedPlane)} disabled={!!busy}><Plus size={15} />{PLANE_LABELS[selectedPlane].name} 이미지 추가</button>
        <p className="sidebar-tip">이미지는 원본 비율을 유지합니다.<br />대상 외곽에 맞춰 자른 이미지를 사용하세요.</p>
        <div className="sidebar-bottom"><button onClick={() => setModal('dimensions')}><Ruler size={16} />기준 치수표<ArrowUpRight size={14} /></button>
          <button onClick={() => setModal('references')}><ImageIcon size={16} />요청 참고 화면<ArrowUpRight size={14} /></button>
          <button onClick={() => setModal('help')}><CircleHelp size={16} />사용 가이드<ArrowUpRight size={14} /></button>
          <div className="coordinate-note"><span className="axis-dot axis-x" />X 길이<span className="axis-dot axis-y" />Y 폭<span className="axis-dot axis-z" />Z 높이</div>
        </div>
      </aside>
      <main className="main-workspace">
        <div className="workspace-heading"><div><div className="workspace-breadcrumb">프로젝트<span>/</span>형상 연구</div>
          <input className="project-title" aria-label="프로젝트 이름" value={project.title} maxLength={100}
            onChange={e => setProject(previous => ({ ...previous, title: e.target.value }))}
            onBlur={() => { if (!project.title.trim()) setProject(previous => ({ ...previous, title: '이름 없는 프로젝트' })); }} />
          <p>다측면 이미지와 입체 형상을 한 공간에서 검토하세요.</p></div>
          <div className="project-state"><span className="state-dot" />{project.model ? '사용자 모델' : `${sampleDefinition.name} 샘플`}<small>{project.model ? '실측 단위를 확인하세요' : '다섯 가지 신발 형태를 비교하세요'}</small></div>
        </div>
        <div className="mobile-panel-buttons"><button className="button button-outline" onClick={() => setMobilePanel('sources')}><Layers size={16} />모델·이미지</button>
          <button className="button button-outline" onClick={() => setMobilePanel('settings')}><SlidersHorizontal size={16} />보기·정렬</button></div>
        <ShoeSampleQuickbar selected={project.model ? null : sampleDefinition.id} disabled={!ready || !!busy} onSelect={chooseSample} onDetails={() => setModal('samples')} />
        <div className="viewport-shell" ref={stageRef}
          onDragEnter={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) { dragCount.current++; setIsDragging(true); } }}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDragLeave={e => { e.preventDefault(); dragCount.current--; if (dragCount.current <= 0) setIsDragging(false); }}
          onDrop={e => { e.preventDefault(); dragCount.current = 0; setIsDragging(false); const file = e.dataTransfer.files[0]; if (file && !busy) void handleDrop(file); }}>
          <div className="viewport-toolbar"><div className="view-tabs" role="group" aria-label="시점 선택">{VIEWS.map(view =>
            <button key={view.key} className={settings.view === view.key ? 'active' : ''} aria-pressed={settings.view === view.key}
              onClick={() => updateSettings({ view: view.key })}>{view.key === 'iso' && <Box size={14} />}{view.label}</button>)}</div>
            <div className="viewport-tools"><button className={`icon-button ${settings.orthographic || settings.view !== 'iso' ? 'active' : ''}`} aria-label="정사영 전환" aria-pressed={settings.orthographic || settings.view !== 'iso'}
              disabled={settings.view !== 'iso'} title={settings.view !== 'iso' ? '다측면 뷰는 정사영입니다' : '정사영 전환'} onClick={() => updateSettings({ orthographic: !settings.orthographic })}><Grid3X3 size={17} /></button>
              <button className="icon-button" aria-label="화면에 맞추기" title="화면에 맞추기" onClick={() => setResetToken(n => n + 1)}><RotateCcw size={17} /></button>
              <button className="icon-button fullscreen-button" aria-label="전체 화면" title="전체 화면" onClick={() => void fullscreen()}><Maximize2 size={17} /></button></div>
          </div>
          <div className="viewport-canvas-area">
            {ready && <LastViewport project={project} onModelInfo={modelChanged} onError={reportError}
              measure={measure} onMeasure={measurementChanged} resetToken={resetToken} screenshotToken={screenshotToken} onModelLoaded={modelLoaded} onRenderMode={setRenderMode} onCaptureReady={captureReady} />}
            <div className="viewport-top-label"><span className="view-dot" /><span>{VIEWS.find(v => v.key === settings.view)?.axis}</span><span className="label-divider" />{settings.orthographic || settings.view !== 'iso' ? '정사영' : '원근 뷰'}{renderMode === 'software' && <span title="이 브라우저에서는 3D 형상을 호환 모드로 표시합니다"> · 호환 렌더링</span>}</div>
            {!project.model && <div className="sample-label">{sampleDefinition.englishName.toUpperCase()}<span>신발 개념 샘플 · 제조 검증 전</span></div>}
            {(!ready || busy) && <div className="loading-overlay"><Loader2 className="spin" size={24} /><span>{busy || '작업 공간을 준비하는 중'}</span></div>}
            {isDragging && <div className="drop-overlay"><Upload size={34} /><strong>여기에 파일을 놓으세요</strong><span>3D 모델 · 프로젝트 · {PLANE_LABELS[selectedPlane].name} 참조 이미지</span></div>}
            <div className="canvas-actionbar"><button className={referencesVisible ? 'active' : ''} onClick={toggleReferences} aria-pressed={referencesVisible}><Layers size={17} /><span>참조 이미지</span></button><span className="toolbar-separator" /><button className={measure ? 'active' : ''} onClick={() => setMeasure(v => !v)} aria-pressed={measure}><Ruler size={17} /><span>거리 측정</span></button>
              <span className="toolbar-separator" /><button onClick={() => setModal('capture')} disabled={!ready || !!busy || !captureAvailable}><Camera size={17} /><span>PNG 저장</span></button></div>
            {measure && <div className="measure-readout" role="status"><Ruler size={15} />{distance === null ? '모델 표면에서 두 점을 선택하세요' : <><strong>{distance.toFixed(2)}</strong> mm<span>다시 선택하면 새로 측정합니다</span></>}</div>}
          </div>
          <div className="viewport-footer"><span className="mouse-hint"><Move size={13} />드래그: 회전<span>·</span>휠: 확대<span>·</span>우클릭: 이동</span>
            <span className="touch-hint">한 손가락: 회전 · 두 손가락: 확대·이동</span><span className="unit-indicator">단위 <b>mm</b></span></div>
        </div>
        <div className="bottom-strip"><div className="strip-title"><span className="eyebrow">REFERENCE VIEWS</span><button className="reference-capture-trigger" onClick={() => setModal('capture')} disabled={!ready || !!busy || !captureAvailable}><Camera size={14} />참조 이미지 캡처</button></div>
          <div className="reference-tiles">{PLANE_KEYS.map(key => <button key={key} className={`reference-tile ${settings.view === key ? 'active' : ''}`}
            onClick={() => { updateSettings({ view: key }); setSelectedPlane(key); }} aria-label={`${PLANE_LABELS[key].name} 시점으로 보기`}>
            <span className="tile-image"><PlaneThumbnail plane={key} project={project} /></span><span className="tile-name">{PLANE_LABELS[key].name}<small>{PLANE_LABELS[key].axis}</small></span><ArrowUpRight size={14} />
          </button>)}</div>
        </div>
        <footer className="workspace-status"><span className={`save-status ${draftStatus}`}><span />{draftStatus === 'saved' ? '이 브라우저에 자동 저장됨' : draftStatus === 'saving' ? '작업 저장 중' : '자동 저장 불가 · 파일로 저장하세요'}</span>
          <span>마지막 변경은 공유본에 자동 반영되지 않습니다</span></footer>
      </main>
      <aside className={`inspector-panel ${mobilePanel === 'settings' ? 'mobile-open' : ''}`} aria-label="보기 및 정렬 설정">
        <div className="panel-top"><span className="eyebrow">INSPECTOR</span><SlidersHorizontal size={15} className="desktop-only" />
          <button className="icon-button mobile-only" onClick={() => setMobilePanel(null)} aria-label="설정 패널 닫기"><X size={18} /></button></div>
        <div className="inspector-tabs" role="group" aria-label="설정 종류"><button className={inspector === 'view' ? 'active' : ''} onClick={() => setInspector('view')}>보기 설정</button>
          <button className={inspector === 'transform' ? 'active' : ''} onClick={() => setInspector('transform')}>모델 정렬</button></div>
        {inspector === 'view' ? <>
          <section className="inspector-section"><h2>평면 배치<span className="subtle-icon"><Layers size={15} /></span></h2>
            <RangeField label="면 간격" value={settings.gap} max={120} unit="mm" onChange={gap => updateSettings({ gap })} />
            <RangeField label="이미지 불투명도" value={settings.imageOpacity * 100} unit="%" onChange={v => updateSettings({ imageOpacity: v / 100 })} />
            <RangeField label="모델 불투명도" value={settings.lastOpacity * 100} min={5} unit="%" onChange={v => updateSettings({ lastOpacity: v / 100 })} />
          </section>
          <section className="inspector-section"><h2>기준 프레임<span className="unit-label">mm</span></h2>
            <p className="section-description">이미지가 배치되는 공간의 실제 크기</p>
            <VectorFields label="크기" unit="" value={settings.dimensions} min={1} max={10000} onChange={dimensions => updateSettings({ dimensions })} />
            <button className="text-button fit-frame" onClick={() => { updateSettings({ dimensions: modelInfo.dimensions.map(n => Math.max(1, Math.round(n * 10) / 10)) as Vec3 }); notify('기준 프레임을 모델 크기에 맞췄습니다.'); }}><Box size={13} />모델 크기에 맞추기</button>
          </section>
          <section className="inspector-section"><h2>{PLANE_LABELS[selectedPlane].name} 이미지<span className="axis-pill">{PLANE_LABELS[selectedPlane].axis}</span></h2>
            <button className="selected-image" onClick={() => selectImage(selectedPlane)} disabled={!!busy}><span className="selected-image-preview"><PlaneThumbnail plane={selectedPlane} project={project} /></span>
              <span>{selected.image ? '이미지 교체' : '이미지 불러오기'}<small>{selected.image?.name ?? 'PNG · JPG · WebP'}</small></span><Upload size={15} /></button>
            <div className="image-actions"><button className={selected.flip ? 'selected' : ''} aria-pressed={selected.flip} onClick={() => updatePlane(selectedPlane, { flip: !selected.flip })}><FlipHorizontal2 size={14} />좌우 반전</button>
              {selected.image && <button onClick={() => updatePlane(selectedPlane, { image: null })}><X size={14} />제거</button>}</div>
          </section>
          <section className="inspector-section"><h2>화면 표시</h2><Toggle label="바닥 그리드" checked={settings.grid} onChange={grid => updateSettings({ grid })} />
            <Toggle label="XYZ 좌표축" checked={settings.axes} onChange={axes => updateSettings({ axes })} />
            <Toggle label="기준 프레임" checked={settings.bounds} onChange={bounds => updateSettings({ bounds })} />
            <Toggle label="모델 와이어프레임" checked={settings.wireframe} onChange={wireframe => updateSettings({ wireframe })} />
          </section>
        </> : <>
          <section className="inspector-section"><h2>원본 좌표계<span className="subtle-icon"><Box size={15} /></span></h2>
            <div className="select-row"><label>파일 단위<select value={settings.modelUnits} onChange={e => updateSettings({ modelUnits: e.target.value as SceneSettings['modelUnits'] })}>
              <option value="mm">밀리미터 (mm)</option><option value="cm">센티미터 (cm)</option><option value="m">미터 (m)</option><option value="in">인치 (in)</option></select></label></div>
            <div className="select-row"><label>원본의 위쪽 방향<select value={settings.modelUp} onChange={e => updateSettings({ modelUp: e.target.value as 'z' | 'y' })}>
              <option value="z">Z축 위쪽</option><option value="y">Y축 위쪽</option></select></label></div>
            <p className="section-description">불러온 형상은 XY 중심과 바닥 Z=0에 정렬됩니다. STL·OBJ의 단위를 확인하세요.</p>
          </section>
          <section className="inspector-section"><h2>위치<span className="subtle-icon"><Move size={15} /></span></h2>
            <VectorFields label="위치" unit="" value={settings.modelPosition} onChange={modelPosition => updateSettings({ modelPosition })} />
            <p className="section-description">X 길이 · Y 폭 · Z 높이 / mm</p>
          </section>
          <section className="inspector-section"><h2>회전<span className="unit-label">°</span></h2>
            <VectorFields label="회전" unit="" value={settings.modelRotation} min={-360} max={360} onChange={modelRotation => updateSettings({ modelRotation })} />
            <div className="rotate-buttons">{['X', 'Y', 'Z'].map((axis, index) => <button key={axis} onClick={() => {
              const next = [...settings.modelRotation] as Vec3; next[index] = (next[index] + 90) % 360; updateSettings({ modelRotation: next });
            }}><RotateCw size={12} />{axis} 90°</button>)}</div>
          </section>
          <section className="inspector-section"><h2>균일 배율</h2><NumberField label="전체 배율" value={settings.modelScale} min={0.001} max={1000} step={0.01} suffix="×" onChange={modelScale => updateSettings({ modelScale })} />
            <p className="section-description">가로·세로·높이의 비율을 유지합니다.</p></section>
          <section className="inspector-section"><h2>현재 모델 크기</h2><div className="size-readout">{['길이 X', '폭 Y', '높이 Z'].map((label, i) => <div key={label}><span>{label}</span><strong>{modelInfo.dimensions[i].toFixed(2)}<small>mm</small></strong></div>)}</div>
            {modelInfo.triangles > 0 && <p className="section-description">{modelInfo.triangles.toLocaleString('ko-KR')} triangles</p>}
            <button className="button button-outline reset-transform" onClick={() => updateSettings({ modelPosition: [0, 0, 0], modelRotation: [0, 0, 0], modelScale: 1 })}><RotateCcw size={14} />정렬값 초기화</button>
          </section>
        </>}
        <div className="inspector-note"><span className="note-symbol">i</span><p>이미지 윤곽과 라스트를 비교하는 도구입니다. 실제 설계에는 치수와 여유 공간을 함께 검토하세요.</p></div>
      </aside>
    </div>
    {mobilePanel && <button className="mobile-scrim" aria-label="패널 닫기" onClick={() => setMobilePanel(null)} />}
    {notice && <div className={`toast ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.type === 'success' ? <Check size={17} /> : <CircleHelp size={17} />}<span>{notice.message}</span><button aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    <Dialog open={modal === 'share'} title="같은 형상을, 함께 검토하세요" onClose={() => setModal(null)}>
      <p className="dialog-description">현재 이미지, 3D 모델 또는 선택한 샘플 종류, 정렬값을 하나의 프로젝트로 저장합니다.</p>
      <div className="share-preview"><span className="share-icon"><Box size={28} strokeWidth={1.3} /></span><div><strong>{project.title}</strong><p>{modelName}<span>참조 이미지 {importedCount}개</span></p></div></div>
      <div className="share-section"><h3><Link2 size={17} />저장된 프로젝트 링크</h3><p>현재 상태를 서버에 저장합니다. 이후 수정한 내용은 새 링크로 공유하세요.</p>
        {shareUrl ? <div className="share-link-row"><input aria-label="공유 링크" readOnly value={shareUrl} onFocus={e => e.target.select()} /><button className="button button-primary" onClick={() => void copyLink()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '복사됨' : '복사'}</button></div> :
          <button className="button button-primary full-width" onClick={() => void createShare()} disabled={sharing}>{sharing ? <Loader2 className="spin" size={16} /> : <Share2 size={16} />}{sharing ? '프로젝트를 저장하는 중' : '프로젝트 저장 · 링크 만들기'}</button>}
        <p className="sharing-access-note">프로젝트 링크의 접근 범위는 사이트의 공유 설정을 따릅니다. 공유 전에 사이트 공개 범위를 확인하세요.</p>
      </div>
      <div className="share-section file-share"><div><h3><FileJson size={17} />프로젝트 파일</h3><p>이미지와 모델을 포함한 파일을 전달할 수도 있습니다.</p></div><button className="button button-outline" onClick={exportFile}><Download size={16} />파일 저장</button></div>
    </Dialog>
    <Dialog open={modal === 'help'} title="Last Studio 사용 가이드" onClose={() => setModal(null)}>
      <p className="dialog-description">네 방향의 이미지와 신발 샘플 또는 실제 라스트를 같은 좌표계에서 검토합니다.</p>
      <ol className="guide-steps"><li><span>01</span><div><h3>신발 샘플을 고르거나 모델을 불러옵니다</h3><p>화면 위에서 신발 5종을 선택하거나 STL·OBJ·GLB를 불러오세요. GLB는 미터·Y축, STL은 mm·Z축을 기본으로 제안합니다. 실제 파일의 단위와 축을 확인하세요.</p></div></li>
        <li><span>02</span><div><h3>각 방향의 이미지를 배치합니다</h3><p>측면·윗면·정면·후면을 선택해 이미지를 넣으세요. 대상 외곽에 맞춰 자른 정사영 이미지가 비교하기 좋습니다.</p></div></li>
        <li><span>03</span><div><h3>크기와 위치를 맞춥니다</h3><p>기준 프레임은 이미지의 실제 크기입니다. 모델 정렬에서 위치·회전·균일 배율을 조절하고, 면 간격과 투명도로 형상을 비교하세요.</p></div></li>
        <li><span>04</span><div><h3>이미지를 캡처하고 프로젝트를 공유합니다</h3><p>‘PNG 저장’에서 모델의 네 방향 이미지를 개별 PNG 또는 ZIP으로 저장하세요. ‘공유’에서는 현재 프로젝트의 링크를 만들 수 있고, 프로젝트 파일은 ‘열기’로 복원합니다.</p></div></li></ol>
      <div className="guide-note"><Ruler size={18} /><p>거리 측정은 모델 표면의 두 점 사이 직선거리입니다. 둘레·곡면 길이나 착화 적합성을 판정하지 않습니다.</p></div>
      <div className="guide-note"><ImageIcon size={18} /><p>기본 이미지는 제공된 치수표의 도면 영역입니다. 신발 5종은 독립적인 개념 샘플이며, 참조 사진이나 실제 라스트를 복원한 형상이 아닙니다.</p></div>
    </Dialog>
    <Dialog open={modal === 'samples'} title="신발 샘플 컬렉션 · 5종" onClose={() => setModal(null)} wide>
      <ShoeSampleGallery selected={project.model ? null : sampleDefinition.id} disabled={!ready || !!busy} onSelect={chooseSample} />
    </Dialog>
    {/* Changed: mount only while open, so captured PNG previews are released on close. */}
    <Dialog open={modal === 'capture'} title="모델 참조 이미지 · PNG" onClose={() => setModal(null)} wide>
      {modal === 'capture' ? <ReferenceCapturePanel modelName={project.model?.name ?? sampleDefinition.name} capture={captureReferences} onScreenshot={() => setScreenshotToken(n => n + 1)} /> : null}
    </Dialog>
    <Dialog open={modal === 'dimensions'} title="SHOOB F240 · 기준 치수표" onClose={() => setModal(null)} wide>
      <ReferenceDimensions onApply={() => { updateSettings({ dimensions: [REFERENCE_DIMENSIONS.length, REFERENCE_DIMENSIONS.width, REFERENCE_DIMENSIONS.height] }); notify('기준 프레임에 제공하신 외곽 치수를 적용했습니다.'); }} />
    </Dialog>
    <Dialog open={modal === 'references'} title="요청 참고 화면" onClose={() => setModal(null)} wide>
      <p className="dialog-description">제공하신 원본 자료입니다. 치수표 이미지는 기준 프레임과 수치 조회에 반영했습니다. 실제 라스트 비교에는 3D 파일을 불러오세요.</p>
      <h3 className="source-section-title">네 방향 치수표</h3>
      <div className="reference-gallery">{PLANE_KEYS.map(key => <figure key={key}><a href={`/references/dimensions-${key}.png`} target="_blank" rel="noreferrer"><img src={`/references/dimensions-${key}.png`} alt={`${PLANE_LABELS[key].name} 원본 치수표`} loading="lazy" /></a><figcaption>{PLANE_LABELS[key].name} · 원본 치수표</figcaption></figure>)}</div>
      <h3 className="source-section-title">다측면 배치와 라스트 참고</h3>
      <div className="reference-gallery">{[1, 2, 3, 4, 5].map(n => <figure key={n}><img src={`/references/reference-${n}.png`} alt={n <= 3 ? `제공된 다측면 뷰 참고 ${n}` : `제공된 라스트 참고 ${n - 3}`} loading="lazy" /><figcaption>{n <= 3 ? `다측면 뷰 0${n}` : `라스트 0${n - 3}`}</figcaption></figure>)}</div>
    </Dialog>
    <Dialog open={modal === 'reset'} title="샘플 프로젝트로 초기화할까요?" onClose={() => setModal(null)}>
      <p className="dialog-description">현재 작업 공간이 샘플로 바뀝니다. 현재 형상이 필요하면 먼저 프로젝트 파일을 저장하세요. 이미 만든 공유 링크는 유지됩니다.</p>
      <div className="dialog-actions"><button className="button button-outline" onClick={exportFile}><Download size={16} />현재 파일 저장</button><button className="button button-primary" onClick={() => void resetSample()}>샘플로 초기화</button></div>
    </Dialog>
  </div>;
}
