import type { SimState, StateExport } from './types';

export function buildExport(state: SimState): StateExport {
  const tornEdges = state.edges.filter((e) => e.torn).length;
  return {
    format: 'cloth-lab-state',
    version: 1,
    exportedAt: new Date().toISOString(),
    // 直接引用冻结快照（序列化时读取）：保证导出的就是当前画面/检查的同一快照
    state,
    stats: {
      totalEdges: state.edges.length,
      tornEdges,
      pinnedNodes: state.nodes.filter((n) => n.pinned).length,
      finished: state.step >= state.maxSteps,
    },
  };
}

export function exportJSON(state: SimState): void {
  const payload = buildExport(state);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cloth-step-${state.step}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
