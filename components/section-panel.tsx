'use client';

import { useMemo } from 'react';
import { Layers, Ruler } from 'lucide-react';
import type { SectionSettings } from '@/lib/project';
import type { SectionResult, SectionSegment } from '@/lib/section-analysis';

const sectionPath = (segments: SectionSegment[]) => segments.map(([a, b]) => `M${a[0].toFixed(3)} ${(-a[1]).toFixed(3)}L${b[0].toFixed(3)} ${(-b[1]).toFixed(3)}`).join('');

// Changed: exact mesh intersections are displayed as a separate 2D section.
export default function SectionPanel({ settings, result, hasLast, onChange }: {
  settings: SectionSettings;
  result: SectionResult | null;
  hasLast: boolean;
  onChange: (patch: Partial<SectionSettings>) => void;
}) {
  const hasContours = !!result && (result.shoe.length > 0 || result.last.length > 0);
  const bounds = result?.bounds ?? [0, 0, 100, 100];
  const [uMin, vMin, uMax, vMax] = bounds;
  const span = Math.max(uMax - uMin, vMax - vMin, 1);
  const padding = span * 0.08;
  const paths = useMemo(() => result ? { shoe: sectionPath(result.shoe), last: sectionPath(result.last), closest: result.closest ? sectionPath([result.closest]) : '' } : null, [result]);

  return <div className="section-panel">
    <section className="inspector-section"><h2>단면 검사<Layers size={15} /></h2>
      <label className="toggle-row"><span>단면 표시</span><input type="checkbox" checked={settings.enabled} onChange={e => onChange({ enabled: e.target.checked })} /><span className="toggle-track" aria-hidden="true" /></label>
      <p className="section-description">같은 평면에서 신발과 라스트의 실제 메시를 잘라 비교합니다. 숨긴 모델도 계산에 포함됩니다.</p>
      <div className="section-axis-buttons" role="group" aria-label="단면 축">{(['x', 'y', 'z'] as const).map(axis =>
        <button key={axis} className={settings.axis === axis ? 'active' : ''} aria-pressed={settings.axis === axis} onClick={() => onChange({ axis, percent: axis === 'x' ? 66.7 : 50, enabled: true })}>{axis.toUpperCase()}<small>{axis === 'x' ? '길이' : axis === 'y' ? '폭' : '높이'}</small></button>)}</div>
      <label className="section-position-label" htmlFor="section-position">단면 위치<output>{settings.percent.toFixed(1)}<small>%</small></output></label>
      <input id="section-position" className="section-position-slider" aria-label="단면 위치" type="range" min={0} max={100} step={0.1} value={settings.percent} disabled={!settings.enabled} onChange={e => onChange({ percent: Number(e.target.value) })} />
      <div className="section-presets">{[15, 40, 66.7, 90].map(percent => <button key={percent} disabled={!settings.enabled} onClick={() => onChange({ percent })}>{percent}%</button>)}</div>
      <p className="section-description">현재 신발의 {settings.axis.toUpperCase()} 최솟값에서 최댓값까지의 위치입니다. 기본 정렬의 X축은 뒤꿈치 → 앞코 방향입니다.</p>
    </section>

    {!settings.enabled ? <div className="section-empty">단면 표시를 켜면 절단 위치와 2D 윤곽이 나타납니다.</div> : !result ? <div className="section-empty" role="status">단면을 계산하고 있습니다…</div> : <>
      <section className="inspector-section section-result"><h2>{result.error ? '단면 계산 중단' : <>{result.axis.toUpperCase()} = {result.coordinate.toFixed(2)}<span className="unit-label">mm</span></>}</h2>
        {result.error ? <p className="section-error" role="alert">{result.error}</p> : <>
          <div className="section-plot-wrap">
            {hasContours ? <svg className="section-plot" role="img" aria-label={`${result.axis.toUpperCase()} 단면: 신발과 라스트 윤곽`} viewBox={`${uMin - padding} ${-vMax - padding} ${Math.max(uMax - uMin, 1) + 2 * padding} ${Math.max(vMax - vMin, 1) + 2 * padding}`}>
              <g stroke="#dde3da" strokeWidth="0.7" vectorEffect="non-scaling-stroke">{[0, 1, 2, 3, 4].map(i => <g key={i}><line x1={uMin + (uMax - uMin) * i / 4} y1={-vMax} x2={uMin + (uMax - uMin) * i / 4} y2={-vMin} vectorEffect="non-scaling-stroke" /><line x1={uMin} y1={-vMin - (vMax - vMin) * i / 4} x2={uMax} y2={-vMin - (vMax - vMin) * i / 4} vectorEffect="non-scaling-stroke" /></g>)}</g>
              <path d={paths?.shoe} fill="none" stroke="#86684b" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
              <path d={paths?.last} fill="none" stroke="#3e91b4" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
              {result.closest && <g><path d={paths?.closest} stroke="#d77939" strokeWidth="2.2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />{result.closest.map((p, index) => <circle key={index} cx={p[0]} cy={-p[1]} r={span / 100} fill="#d77939" />)}</g>}
            </svg> : <p className="section-empty">이 위치에는 단면 윤곽이 없습니다.</p>}
            <div className="section-plot-axes">가로 {result.uAxis.toUpperCase()} · 세로 {result.vAxis.toUpperCase()} <span>mm</span></div>
          </div>
          <div className="section-legend"><span><i className="shoe-legend-dot" />신발</span><span><i className="last-legend-dot" />라스트</span><span><i className="gap-legend-dot" />최근접</span></div>
          <div className={`section-gap ${result.intersects ? 'intersects' : ''}`}><span><Ruler size={14} />최소 단면 경계 거리</span><strong>{result.minimumGap === null ? '—' : result.minimumGap.toFixed(2)}<small>mm</small></strong><p>{result.intersects ? '단면 경계가 교차하거나 접촉합니다.' : result.minimumGap !== null ? '주황색 표시가 가장 가까운 경계 쌍입니다.' : !hasLast ? '라스트를 추가하면 간격을 계산합니다.' : '두 모델 모두에 단면 윤곽이 있어야 합니다.'}</p></div>
        </>}
      </section>
      <div className="section-method-note">이 값은 2D 절단면의 경계 간 직선거리입니다. 거리만으로 내외부 관계, 전체 여유 공간이나 착화 적합성을 판정하지 않습니다.</div>
    </>}
  </div>;
}
