'use client';

import { useState } from 'react';
import { ArrowUpRight, Ruler } from 'lucide-react';
import type { PlaneKey } from '@/lib/project';
import {
  REFERENCE_DIMENSIONS, SIDE_POINTS, SECTIONS, REAR_LEVELS, REAR_GAPS, REAR_BLOCKS,
  REFERENCE_NOTES, REFERENCE_AMBIGUITIES, FRONT_REGISTRATION, TOP_REGISTRATION,
} from '@/lib/reference-data';

const titles: Record<PlaneKey, string> = { side: '측면 A–E', top: '탑뷰 단면', front: '정면 등록', rear: '후면 상세' };
const mm = (n: number) => n.toFixed(2);
const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;
const statusLabels = { exact: '등록 기준', reference: '참고값', provisional: '임시값' };

export default function ReferenceDimensions({ onApply }: { onApply: () => void }) {
  const [view, setView] = useState<PlaneKey>('side');
  return <div className="dimension-content">
    <p className="dialog-description">제공하신 SHOOB F240 치수표의 전사값입니다. 신발 외곽의 기준이며, 라스트 자체의 실측 치수가 아닙니다. 모든 수치는 mm입니다.</p>
    <div className="dimension-summary">{[
      ['외곽 길이 · X', REFERENCE_DIMENSIONS.length],
      ['최대 외곽 폭 · Y', REFERENCE_DIMENSIONS.width],
      ['최고 높이 · Z', REFERENCE_DIMENSIONS.height],
    ].map(([label, value]) => <div className="dimension-stat" key={label}><small>{label}</small><strong>{value}<span>mm</span></strong></div>)}</div>
    <button className="button button-outline" onClick={onApply}><Ruler size={15} />기준 프레임에 이 치수 적용</button>
    <p className="section-description">이미지 프레임만 253 × 105.31 × 79.4 mm로 설정합니다. 불러온 라스트 크기는 별도로 유지됩니다.</p>
    <div className="dimension-tabs" role="group" aria-label="치수표 선택">{(Object.keys(titles) as PlaneKey[]).map(key =>
      <button key={key} className={key === view ? 'active' : ''} aria-pressed={key === view} onClick={() => setView(key)}>{titles[key]}</button>,
    )}</div>
    <section className="dimension-section">
      {view === 'side' && <>
        <h3>측면 기준점</h3>
        <div className="dimension-table-wrap"><table className="dimension-table"><thead><tr><th>점</th><th>힐부터 길이</th><th>높이</th><th>길이 대비</th><th>최고 높이 대비</th></tr></thead>
          <tbody>{SIDE_POINTS.map(p => <tr key={p.label}><th>{p.label}</th><td>{mm(p.length)}</td><td>{mm(p.height)}</td><td>{pct(p.lengthRatio)}</td><td>{pct(p.heightRatio)}</td></tr>)}</tbody></table></div>
        <p className="section-description">측면 B점은 길이 75.90 mm에 있습니다. 탑뷰 B단면(168.75 mm)과 다른 위치입니다.</p>
      </>}
      {view === 'top' && <>
        <h3>길이별 내측·외측 거리와 투영폭</h3>
        <div className="dimension-table-wrap"><table className="dimension-table"><thead><tr><th>단면</th><th>길이비</th><th>힐부터 길이</th><th>내측 거리</th><th>외측 거리</th><th>전체 폭</th></tr></thead>
          <tbody>{SECTIONS.map(p => <tr key={p.label}><th>{p.label}</th><td>{pct(p.ratio)}</td><td>{mm(p.length)}</td><td>{mm(p.medial)}</td><td>{mm(p.lateral)}</td><td>{mm(p.width)}</td></tr>)}</tbody></table></div>
        <p className="section-description">최대 폭 위치는 약 {pct(TOP_REGISTRATION.maxWidthPositionRatio)} / 힐부터 약 {TOP_REGISTRATION.maxWidthPositionMm} mm입니다. S3 폭은 원문 69.20 mm를 보존했으며, 내·외측 합과 0.01 mm의 반올림 차이가 있습니다.</p>
      </>}
      {view === 'front' && <>
        <h3>정면에 대응한 좌우 거리</h3>
        <p className="section-description">아래 위치는 탑뷰의 길이축 좌표입니다. 정면 이미지의 높이나 실제 3D 단면으로 해석하지 않습니다.</p>
        <div className="dimension-table-wrap"><table className="dimension-table"><thead><tr><th>단면</th><th>힐부터 길이</th><th>왼쪽 · 외측</th><th>오른쪽 · 내측</th><th>전체 폭</th></tr></thead>
          <tbody>{SECTIONS.map(p => <tr key={p.label}><th>{p.label}</th><td>{mm(p.length)}</td><td>{mm(p.frontLeft)}</td><td>{mm(p.frontRight)}</td><td>{mm(p.width)}</td></tr>)}</tbody></table></div>
        <p className="section-description">등록 폭 {FRONT_REGISTRATION.totalWidthMm} mm · 등록 높이 {FRONT_REGISTRATION.maxHeightMm} mm · 등록 전 환산 높이 약 {FRONT_REGISTRATION.unregisteredHeightMm} mm · 원문 세로 축척 보정 ×{FRONT_REGISTRATION.verticalScaleCorrection}</p>
      </>}
      {view === 'rear' && <>
        <h3>공통 기준과 이미지 환산값</h3>
        <div className="dimension-table-wrap"><table className="dimension-table"><thead><tr><th>항목</th><th>기준</th><th>이미지 환산</th><th>표의 비율</th><th>기준값 구분</th></tr></thead>
          <tbody>{REAR_LEVELS.map(p => <tr key={p.name}><th>{p.name}</th><td>{mm(p.standardMm)}</td><td>{p.measuredApproximate ? '약 ' : ''}{mm(p.measuredMm)}</td><td>{p.kind === 'width' ? '폭 ' : ''}{pct(p.ratio)}</td><td>{statusLabels[p.status]}</td></tr>)}</tbody></table></div>
        <h3>중앙 분할 홈 · 보이는 경계의 환산값</h3>
        <div className="dimension-table-wrap"><table className="dimension-table"><thead><tr><th>측정선</th><th>높이</th><th>홈 폭</th><th>홈 중심 X</th></tr></thead>
          <tbody>{REAR_GAPS.map(p => <tr key={p.label}><th>{p.label}</th><td>{mm(p.height)}</td><td>{mm(p.width)}</td><td>+{mm(p.centerX)}</td></tr>)}</tbody></table></div>
        <h3>블록별 투영폭</h3>
        <div className="dimension-table-wrap"><table className="dimension-table"><thead><tr><th>블록</th><th>측정 높이</th><th>왼쪽 X</th><th>오른쪽 X</th><th>투영폭</th><th>전체 폭 대비</th></tr></thead>
          <tbody>{REAR_BLOCKS.map(p => <tr key={p.name}><th>{p.name} · {p.side === 'medial' ? '내측' : '외측'}</th><td>{mm(p.height)}</td><td>{mm(p.leftX)}</td><td>{mm(p.rightX)}</td><td>{mm(p.width)}</td><td>{pct(p.ratio)}</td></tr>)}</tbody></table></div>
        <p className="section-description">여기의 X는 원본 후면 도면의 가로축입니다. 홈 깊이, 곡면 길이와 내부 두께는 제공된 값으로 결정할 수 없습니다.</p>
      </>}
      <a className="dimension-source-link" href={`/references/dimensions-${view}.png`} target="_blank" rel="noreferrer">{titles[view]} 원본 치수표 열기<ArrowUpRight size={14} /></a>
    </section>
    <div className="dimension-notes"><h3>좌표 적용 기준</h3><p>작업실 좌표는 X=길이, Y=폭, Z=높이입니다. 길이 중심이 X=0이므로, 표의 힐 기준 길이에서 126.5 mm를 빼면 기본 프레임의 X 위치가 됩니다. 바닥은 Z=0입니다.</p>
      <p>기본 이미지는 치수표의 도면 영역을 외곽 치수에 맞춰 배치한 참고 자료입니다. 원근·단면 곡률·각 뷰의 같은 공간점 대응은 별도 확인이 필요합니다.</p>
      <details><summary>원문 주의사항과 값의 구분</summary>{REFERENCE_NOTES.filter((_, i) => i !== 0 && i !== 1).map(note => <p key={note}>{note}</p>)}
        <h4>반올림·근사값</h4>{REFERENCE_AMBIGUITIES.slice(2).map(note => <p key={note}>{note}</p>)}</details>
    </div>
  </div>;
}
