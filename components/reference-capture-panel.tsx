'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Download, FileArchive, Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react';
import { PLANE_LABELS } from '@/lib/project';
import { downloadBlob } from '@/lib/project-io';
import type { CaptureBackground, ReferenceCaptureFunction, ReferenceCaptureImage } from '@/lib/reference-capture-types';
import { createReferenceZip, referenceCaptureFilename, referenceZipFilename } from '@/lib/reference-download';

type CapturePreview = ReferenceCaptureImage & { url: string };

// Changed: isolated export panel owns preview URLs and discards unfinished captures on close.
export default function ReferenceCapturePanel({ modelName, capture, onScreenshot }: {
  modelName: string;
  capture: ReferenceCaptureFunction;
  onScreenshot: () => void;
}) {
  const [background, setBackground] = useState<CaptureBackground>('white');
  const [maxSize, setMaxSize] = useState<1024 | 2048>(2048);
  const [revision, setRevision] = useState(0);
  const [previews, setPreviews] = useState<CapturePreview[]>([]);
  const [pending, setPending] = useState(true);
  const [zipPending, setZipPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setPending(true); setPreviews([]); setError(''); setMessage('');
    void capture({ background, maxSize }).then(images => {
      if (!active) return;
      const next = images.map(image => {
        const url = URL.createObjectURL(image.blob);
        urls.push(url);
        return { ...image, url };
      });
      setPreviews(next);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '참조 이미지를 캡처하지 못했습니다. 다시 시도해 주세요.');
    }).finally(() => { if (active) setPending(false); });
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [capture, background, maxSize, revision]);

  function saveImage(image: CapturePreview) {
    downloadBlob(image.blob, referenceCaptureFilename(modelName, image.view));
    setMessage(`${PLANE_LABELS[image.view].name} PNG 저장을 요청했습니다.`);
  }

  async function saveAll() {
    if (pending || zipPending || previews.length !== 4) return;
    setZipPending(true); setError(''); setMessage('');
    try {
      const archive = await createReferenceZip(previews, modelName);
      if (!alive.current) return;
      downloadBlob(archive, referenceZipFilename(modelName));
      setMessage('PNG 4장과 프레임 치수 정보가 담긴 ZIP 저장을 요청했습니다.');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '파일을 묶지 못했습니다. 개별 PNG 저장을 이용해 주세요.');
    } finally { if (alive.current) setZipPending(false); }
  }

  const working = pending || zipPending;
  return <div className="reference-capture-panel">
    <p className="dialog-description">현재 모델의 측면·윗면·정면·후면을 정사영 PNG로 저장합니다. 모델의 정렬값을 적용하고, 배경의 참조 이미지와 그리드는 제외합니다.</p>
    <div className="capture-controls">
      <div className="capture-model-name"><span className="eyebrow">CURRENT MODEL</span><strong>{modelName}</strong></div>
      <label>배경<select aria-label="캡처 배경" value={background} disabled={working} onChange={e => setBackground(e.target.value as CaptureBackground)}>
        <option value="white">흰색</option><option value="transparent">투명</option>
      </select></label>
      <label>최대 해상도<select aria-label="캡처 최대 해상도" value={maxSize} disabled={working} onChange={e => setMaxSize(Number(e.target.value) as 1024 | 2048)}>
        <option value={1024}>1024 px</option><option value={2048}>2048 px</option>
      </select></label>
    </div>

    {pending ? <div className="capture-loading" role="status"><Loader2 size={27} className="spin" /><strong>네 방향을 캡처하는 중</strong><span>모델의 형태와 색상을 PNG로 만들고 있습니다.</span></div> : null}
    {error ? <div className="capture-error" role="alert"><p>{error}</p>{!previews.length ? <button className="button button-outline" onClick={() => setRevision(n => n + 1)} disabled={working}><RefreshCw size={15} />다시 캡처</button> : null}</div> : null}

    {!pending && previews.length ? <div className="capture-preview-grid">{previews.map(image => <article className="capture-preview-card" key={image.view}>
      <div className={`capture-preview-image ${background === 'transparent' ? 'transparent' : ''}`}>
        <img src={image.url} alt={`${modelName} ${PLANE_LABELS[image.view].name} 정사영 캡처`} width={image.width} height={image.height} />
      </div>
      <div className="capture-preview-details"><div><h3>{PLANE_LABELS[image.view].name}<small>{PLANE_LABELS[image.view].axis}</small></h3>
        <p>{image.width} × {image.height} px</p><p>프레임 {image.frameWidthMm.toFixed(2)} × {image.frameHeightMm.toFixed(2)} mm</p></div>
        <button className="button button-outline" aria-label={`${PLANE_LABELS[image.view].name} PNG 저장`} disabled={zipPending} onClick={() => saveImage(image)}><Download size={14} />PNG</button>
      </div>
    </article>)}</div> : null}

    <div className="capture-export-footer">
      <div className="capture-export-note"><ImageIcon size={16} /><p>네 뷰의 mm당 픽셀 수는 같습니다. 프레임 치수에는 여백이 포함됩니다. 모델은 원래 색상과 표면으로 캡처됩니다.</p></div>
      <div className="capture-export-actions">
        <button className="button button-outline" disabled={working} onClick={() => { onScreenshot(); setMessage('현재 작업 화면 PNG 저장을 요청했습니다.'); }}><Camera size={15} />현재 화면 PNG</button>
        <button className="button button-primary" disabled={working || previews.length !== 4} onClick={() => void saveAll()}>{zipPending ? <Loader2 className="spin" size={16} /> : <FileArchive size={16} />}PNG 4면 일괄 저장<small>ZIP</small></button>
      </div>
    </div>
    <p className="capture-download-status" role="status">{message || '각 PNG를 저장하거나, 네 장을 ZIP 파일 하나로 내려받으세요.'}</p>
  </div>;
}
