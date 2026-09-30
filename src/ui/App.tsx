import { useEffect, useRef, useState } from 'react';
import { SimClient, createBrowserWorkerFactory, createInlineWorkerFactory } from '../sim/SimClient';
import type { ClothConfig, SimState } from '../sim/types';
import { ClothCanvas } from './ClothCanvas';
import { ControlPanel } from './ControlPanel';
import { Inspector } from './Inspector';
import { exportJSON } from '../sim/export';

const DEFAULT_CONFIG: ClothConfig = {
  cols: 14,
  rows: 12,
  spacing: 24,
  origin: { x: 90, y: 60 },
  gravity: 900,
  dt: 1 / 60,
  damping: 0.99,
  iterations: 4,
  horizontalPasses: 1,
  verticalPasses: 1,
  groundY: 580,
  tearFactor: 1.8,
};

function makeClientFactory() {
  try {
    // 探测模块 Worker 是否可构造（file:// 直开等场景会失败）
    const probe = new Worker(new URL('../sim/simWorker.ts', import.meta.url), { type: 'module' });
    probe.terminate();
    return createBrowserWorkerFactory();
  } catch {
    return createInlineWorkerFactory();
  }
}

export function App() {
  const [draft, setDraft] = useState<ClothConfig>(DEFAULT_CONFIG);
  const [pinTopRow, setPinTopRow] = useState(true);
  const [state, setState] = useState<SimState | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);

  const clientRef = useRef<SimClient | null>(null);
  const stateRef = useRef<SimState | null>(null);
  stateRef.current = state;

  // Client 随挂载创建、卸载销毁；StrictMode 双调用时第一个被 terminate，不泄漏。
  useEffect(() => {
    const client = new SimClient(makeClientFactory(), DEFAULT_CONFIG, true);
    clientRef.current = client;
    const update = () => {
      setState(client.getSnapshot());
      setBusy(client.isBusy());
    };
    update();
    const unsub = client.subscribe(update);
    return () => {
      unsub();
      client.destroy();
      clientRef.current = null;
    };
  }, []);

  // 连续播放：单循环顺序等待批次，不重复入队；重置导致 reject 时自动停。
  useEffect(() => {
    if (!playing) return;
    let stopped = false;
    const loop = async () => {
      const c = clientRef.current;
      if (!c) return;
      while (!stopped) {
        const s = c.getSnapshot();
        if (!s || s.step >= s.maxSteps) {
          setPlaying(false);
          return;
        }
        try {
          const r = await c.advance(16);
          if (r.finished) {
            setPlaying(false);
            return;
          }
        } catch {
          setPlaying(false);
          return;
        }
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }, [playing]);

  const handleAdvance = (steps: number) => {
    void clientRef.current?.advance(steps).catch((e) => console.warn(e));
  };

  const handleReset = () => {
    // 重置当前实验：沿用当前已应用的参数；旧 Worker 帧由 gen 拦截。
    const client = clientRef.current;
    if (!client || !client.getSnapshot()) return;
    setPlaying(false);
    const activeConfig = client.getSnapshot()!.config;
    setDraft(activeConfig);
    client.reset(activeConfig, pinTopRow);
  };

  const handleApplyParams = () => {
    // 编辑约束参数 = 新实验：旧 Worker 终止、gen 递增、操作日志清空
    setPlaying(false);
    clientRef.current?.reset(draft, pinTopRow);
  };

  const handleExport = () => {
    const s = stateRef.current;
    if (s) exportJSON(s);
  };

  const pinnedCount = state?.nodes.filter((n) => n.pinned).length ?? 0;

  return (
    <div style={{ fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif', color: '#2b2720' }}>
      <header style={{ padding: '12px 20px', borderBottom: '1px solid #ddd6c6' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>离线二维布料实验台</h1>
        <div style={{ fontSize: 12.5, color: '#6f6656' }}>
          Verlet 积分 · 固定时间步 · 水平/垂直约束固定次数修正 · 可撕裂 · Web Worker 确定性推进
          {pinnedCount > 0 && <> · 挂点 {pinnedCount} 个</>}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, padding: 16 }}>
        <div>
          {state && (
            <ClothCanvas stateRef={stateRef} clientRef={clientRef} busy={busy} onInteract={() => {}} />
          )}
          <p style={{ fontSize: 12.5, color: '#6f6656', margin: '8px 2px' }}>
            操作：点击节点 固定 / 释放挂点；按住橙色挂点拖动后松开可移动挂点（推进间隙可操作）。
            红虚线表示已撕裂边（仅撕裂一次、不可逆）。
          </p>
        </div>
        <aside
          style={{
            background: '#faf8f3',
            border: '1px solid #ddd6c6',
            borderRadius: 6,
            padding: 12,
          }}
        >
          {state && (
            <>
              <ControlPanel
                config={draft}
                pinTopRow={pinTopRow}
                step={state.step}
                maxSteps={state.maxSteps}
                busy={busy}
                onConfigChange={setDraft}
                onPinTopChange={setPinTopRow}
                onApply={handleApplyParams}
                onReset={handleReset}
                onStep={() => handleAdvance(1)}
                onAdvance={handleAdvance}
                playing={playing}
                onTogglePlay={() => setPlaying((v) => !v)}
                onExport={handleExport}
              />
              <hr style={{ border: 'none', borderTop: '1px solid #ddd6c6', margin: '12px 0' }} />
              <Inspector state={state} />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
