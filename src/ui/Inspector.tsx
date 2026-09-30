import { useMemo, useState } from 'react';
import type { SimState } from '../sim/types';

interface Props {
  state: SimState;
}

/**
 * 单步检查面板：读取的与画面、导出完全相同的冻结快照。
 */
export function Inspector({ state }: Props) {
  const [query, setQuery] = useState('');

  const stats = useMemo(() => {
    const pinned = state.nodes.filter((n) => n.pinned).length;
    const tornH = state.edges.filter((e) => e.orientation === 'h' && e.torn).length;
    const tornV = state.edges.filter((e) => e.orientation === 'v' && e.torn).length;
    return {
      pinned,
      torn: tornH + tornV,
      tornH,
      tornV,
      totalEdges: state.edges.length,
    };
  }, [state]);

  const node = useMemo(() => {
    const q = query.trim();
    if (!/^\d+$/.test(q)) return null;
    const idx = Number(q);
    return state.nodes[idx] ? { idx, n: state.nodes[idx] } : null;
  }, [query, state]);

  const recent = state.log.slice(-8);

  return (
    <div style={{ fontSize: 12.5, color: '#3d382e' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>单步检查（当前快照）</h3>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 10 }}>
        <tbody>
          <Row k="物理步 step" v={`${state.step} / ${state.maxSteps}`} />
          <Row k="节点数" v={`${state.nodes.length}（${state.config.cols} × ${state.config.rows}）`} />
          <Row k="固定挂点" v={stats.pinned} />
          <Row k="撕裂边" v={`${stats.torn} / ${stats.totalEdges}（水平 ${stats.tornH}，垂直 ${stats.tornV}）`} />
          <Row k="日志条数" v={state.log.length} />
          <Row k="固定时间步 dt" v={`${state.config.dt} s`} />
          <Row k="每步迭代 / H / V" v={`${state.config.iterations} / ${state.config.horizontalPasses} / ${state.config.verticalPasses}`} />
        </tbody>
      </table>

      <label style={{ display: 'block', marginBottom: 4 }}>
        查询节点索引
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="如 0、45"
          style={{ width: '100%', padding: '3px 6px', border: '1px solid #c9c2b4', borderRadius: 4, marginTop: 2 }}
        />
      </label>
      {node && (
        <pre
          style={{
            background: '#f3efe6',
            border: '1px solid #ddd6c6',
            borderRadius: 4,
            padding: 6,
            fontSize: 11.5,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(
            {
              idx: node.idx,
              col: node.n.col,
              row: node.n.row,
              x: round(node.n.x),
              y: round(node.n.y),
              px: round(node.n.px),
              py: round(node.n.py),
              vx: round(node.n.x - node.n.px),
              vy: round(node.n.y - node.n.py),
              pinned: node.n.pinned,
              pinX: round(node.n.pinX),
              pinY: round(node.n.pinY),
            },
            null,
            1,
          )}
        </pre>
      )}

      <div style={{ marginTop: 8 }}>
        <strong>最近操作日志（最多显示末 8 条）</strong>
        {recent.length === 0 && <div style={{ color: '#8a8170' }}>（空）</div>}
        {recent.map((op, i) => (
          <div key={i} style={{ fontFamily: 'monospace', color: '#5b5448' }}>
            step={op.atStep} {op.type} node={op.node}
            {op.pinned ? ` pin=(${round(op.x ?? 0)}, ${round(op.y ?? 0)})` : ' released'}
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <tr>
      <td style={{ padding: '2px 6px 2px 0', color: '#6f6656' }}>{k}</td>
      <td style={{ padding: '2px 0' }}>{v}</td>
    </tr>
  );
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
