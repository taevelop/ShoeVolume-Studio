'use client';

import { useEffect, useRef, useState } from 'react';
import type { LastProject, ModelInfo } from '@/lib/project';
import type { LastSceneController } from '@/lib/last-scene';

export interface LastViewportProps {
  project: LastProject;
  onModelInfo: (info: ModelInfo) => void;
  onError: (message: string) => void;
  measure: boolean;
  onMeasure: (distance: number | null) => void;
  onModelLoaded?: (name: string | null) => void;
  onRenderMode?: (mode: 'webgl' | 'software') => void;
  resetToken: number;
  screenshotToken: number;
}

export default function LastViewport({ project, onModelInfo, onError, measure, onMeasure, onModelLoaded, onRenderMode, resetToken, screenshotToken }: LastViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<LastSceneController | null>(null);
  const callbacksRef = useRef({ onModelInfo, onError, onMeasure, onModelLoaded, onRenderMode });
  const projectRef = useRef(project);
  const measureRef = useRef(measure);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [renderNotice, setRenderNotice] = useState<string | null>(null);
  callbacksRef.current = { onModelInfo, onError, onMeasure, onModelLoaded, onRenderMode };
  projectRef.current = project;
  measureRef.current = measure;

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    void import('@/lib/last-scene').then(({ createLastScene }) => {
      if (cancelled) return;
      const controller = createLastScene(host, {
        onModelInfo: (info) => callbacksRef.current.onModelInfo(info),
        onError: (message) => callbacksRef.current.onError(message),
        onMeasure: (distance) => callbacksRef.current.onMeasure(distance),
        onModelLoaded: (name) => callbacksRef.current.onModelLoaded?.(name),
        onRenderMode: (mode) => callbacksRef.current.onRenderMode?.(mode),
        onNotice: setRenderNotice,
        onLoading: setLoading,
      });
      controllerRef.current = controller;
      controller.setProject(projectRef.current);
      controller.setMeasure(measureRef.current);
    }).catch(() => {
      if (cancelled) return;
      const message = '3D 화면을 시작할 수 없습니다. WebGL을 지원하는 최신 브라우저에서 열어 주세요.';
      setFatalError(message);
      setLoading(false);
      callbacksRef.current.onError(message);
    });
    return () => {
      cancelled = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => { controllerRef.current?.setProject(project); }, [project]);
  useEffect(() => { controllerRef.current?.setMeasure(measure); }, [measure]);
  useEffect(() => { if (resetToken > 0) controllerRef.current?.fit(); }, [resetToken]);
  useEffect(() => { if (screenshotToken > 0) controllerRef.current?.screenshot(); }, [screenshotToken]);

  return (
    <div className="last-viewport" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 300 }}>
      <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 300 }} />
      {loading && !fatalError && <div className="viewport-loading" role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', pointerEvents: 'none', background: 'rgba(243,244,240,.45)' }}><span>3D 형상을 준비하고 있습니다…</span></div>}
      {fatalError && <div role="alert" className="viewport-error" style={{ position: 'absolute', inset: 20, display: 'grid', placeContent: 'center', textAlign: 'center', color: '#6a705f' }}>{fatalError}</div>}
      {renderNotice && !fatalError && <div role="status" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, fontSize: 12, padding: '8px 10px', background: 'rgba(255,250,236,.92)', color: '#785f38', borderRadius: 8, pointerEvents: 'none' }}>{renderNotice}</div>}
    </div>
  );
}
