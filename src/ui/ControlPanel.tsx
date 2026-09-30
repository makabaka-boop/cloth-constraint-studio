import { useState } from 'react';
import type { ClothConfig } from '../sim/types';
import { MAX_GRID, MIN_GRID } from '../sim/core';

interface Props {
  config: ClothConfig;
  pinTopRow: boolean;
  step: number;
  maxSteps: number;
  busy: boolean;
  onConfigChange: (next: ClothConfig) => void;
  onPinTopChange: (v: boolean) => void;
  onApply: () => void;
  onReset: () => void;
  onStep: () => void;
  onAdvance: (steps: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onExport: () => void;
}

const fieldCls = { width: 72 };

export function ControlPanel(p: Props) {
  const { config: c } = p;
  const [batch, setBatch] = useState(30);
  const finished = p.step >= p.maxSteps;

  const patch = (partial: Partial<ClothConfig>) => p.onConfigChange({ ...c, ...partial });

  return (
    <div style={panelStyle}>
      <section>
        <h3 style={h3}>推进</h3>
        <div style={row}>
          <button style={btn} onClick={p.onStep} disabled={p.busy || finished}>
            单步 +1
          </button>
          <input
            type="number"
            min={1}
            max={600}
            value={batch}
            onChange={(e) => setBatch(Math.max(1, Number(e.target.value) || 1))}
            style={{ ...fieldCls, ...input }}
          />
          <button style={btn} onClick={() => p.onAdvance(batch)} disabled={p.busy || finished}>
            推进 {batch} 步
          </button>
          <button style={btn} onClick={p.onTogglePlay} disabled={finished}>
            {p.playing ? '暂停' : '连续播放'}
          </button>
        </div>
        <div style={{ ...row, color: '#5b5448', fontSize: 13 }}>
          步数 {p.step} / {p.maxSteps}
          {p.busy ? '（计算中…）' : finished ? '（已达上限）' : '（空闲）'}
        </div>
      </section>

      <section>
        <h3 style={h3}>网格与约束（修改后开新实验）</h3>
        <div style={grid2}>
          <label>
            水平节点 {MIN_GRID}~{MAX_GRID}
            <input
              type="number"
              min={MIN_GRID}
              max={MAX_GRID}
              value={c.cols}
              onChange={(e) => patch({ cols: clampGrid(Number(e.target.value)) })}
              style={input}
            />
          </label>
          <label>
            垂直节点 {MIN_GRID}~{MAX_GRID}
            <input
              type="number"
              min={MIN_GRID}
              max={MAX_GRID}
              value={c.rows}
              onChange={(e) => patch({ rows: clampGrid(Number(e.target.value)) })}
              style={input}
            />
          </label>
          <label>
            迭代次数
            <input
              type="number"
              min={1}
              max={20}
              value={c.iterations}
              onChange={(e) => patch({ iterations: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
              style={input}
            />
          </label>
          <label>
            水平扫描
            <input
              type="number"
              min={1}
              max={8}
              value={c.horizontalPasses}
              onChange={(e) => patch({ horizontalPasses: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
              style={input}
            />
          </label>
          <label>
            垂直扫描
            <input
              type="number"
              min={1}
              max={8}
              value={c.verticalPasses}
              onChange={(e) => patch({ verticalPasses: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
              style={input}
            />
          </label>
          <label>
            撕裂倍数
            <input
              type="number"
              step={0.05}
              min={1.01}
              value={c.tearFactor}
              onChange={(e) => patch({ tearFactor: Math.max(1.01, Number(e.target.value) || 1.8) })}
              style={input}
            />
          </label>
          <label>
            重力 px/s²
            <input
              type="number"
              value={c.gravity}
              onChange={(e) => patch({ gravity: Number(e.target.value) || 0 })}
              style={input}
            />
          </label>
          <label>
            地面 y
            <input
              type="number"
              value={c.groundY}
              onChange={(e) => patch({ groundY: Number(e.target.value) || 600 })}
              style={input}
            />
          </label>
        </div>
        <div style={row}>
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={p.pinTopRow}
              onChange={(e) => p.onPinTopChange(e.target.checked)}
            />{' '}
            初始固定顶边挂点
          </label>
        </div>
        <div style={row}>
          <button style={btnPrimary} onClick={p.onApply}>
            应用参数 / 新实验
          </button>
          <button style={btn} onClick={p.onReset}>
            重置当前实验
          </button>
          <button style={btn} onClick={p.onExport} disabled={false}>
            导出状态 JSON
          </button>
        </div>
      </section>
    </div>
  );
}

function clampGrid(v: number): number {
  if (!Number.isFinite(v)) return MIN_GRID;
  return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(v)));
}

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};
const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 14, color: '#3d382e' };
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' };
const grid2: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '6px 12px',
  marginBottom: 8,
  fontSize: 12,
  color: '#5b5448',
};
const input: React.CSSProperties = {
  width: '100%',
  padding: '3px 6px',
  border: '1px solid #c9c2b4',
  borderRadius: 4,
  marginTop: 2,
};
const btn: React.CSSProperties = {
  padding: '5px 12px',
  border: '1px solid #b5ac9a',
  borderRadius: 4,
  background: '#f3efe6',
  cursor: 'pointer',
};
const btnPrimary: React.CSSProperties = { ...btn, background: '#33566f', color: '#fff', borderColor: '#274457' };
