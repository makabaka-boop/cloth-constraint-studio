import { describe, expect, it } from 'vitest';
import {
  MAX_GRID,
  MAX_STEPS,
  MIN_GRID,
  advance,
  appendOp,
  clampConfig,
  cloneState,
  createInitialState,
  stepOnce,
} from './core';
import type { ClothConfig, SimState } from './types';

export function makeConfig(overrides: Partial<ClothConfig> = {}): ClothConfig {
  return {
    cols: 10,
    rows: 10,
    spacing: 20,
    origin: { x: 60, y: 40 },
    gravity: 900,
    dt: 1 / 60,
    damping: 0.99,
    iterations: 4,
    horizontalPasses: 1,
    verticalPasses: 1,
    groundY: 560,
    tearFactor: 1.8,
    ...overrides,
  };
}

export function digest(s: SimState): unknown {
  // 画面/导出看到的全部物理内容（logCursor 是纯内部推进指针，不影响物理结果）
  const { config, nodes, edges, step, maxSteps, log } = s;
  return { config, nodes, edges, step, maxSteps, log };
}

describe('固定挂点不漂移', () => {
  it('顶边挂点经过任意步数后坐标与速度恒等于 pin 坐标', () => {
    const state = createInitialState(makeConfig());
    const topPins = state.nodes
      .filter((n) => n.pinned)
      .map((n) => ({ i: n.row * state.config.cols + n.col, pinX: n.pinX, pinY: n.pinY }));
    expect(topPins.length).toBe(10);

    advance(state, 17);
    advance(state, 63);
    advance(state, 200);

    for (const p of topPins) {
      const n = state.nodes[p.i];
      expect(n.x).toBe(p.pinX);
      expect(n.y).toBe(p.pinY);
      expect(n.px).toBe(p.pinX);
      expect(n.py).toBe(p.pinY);
      expect(n.pinned).toBe(true);
    }
  });

  it('movePin 移动挂点后仍不漂移、且不继承速度', () => {
    const state = createInitialState(makeConfig());
    const idx = 0; // 左上角
    appendOp(state, { type: 'movePin', atStep: state.step, node: idx, pinned: true, x: 100, y: 50 });
    // 让 movePin 走正常的“日志到期”通道
    advance(state, 50);
    const n = state.nodes[idx];
    expect([n.x, n.y, n.px, n.py]).toEqual([100, 50, 100, 50]);
  });
});

describe('水平地面边界', () => {
  it('任何节点任何时刻都不会穿过地面，落地后垂直速度清零', () => {
    const state = createInitialState(
      makeConfig({ groundY: 200, cols: 8, rows: 8, tearFactor: 5 }),
      false, // 没有挂点，整块布自由落体
    );
    // 预先撕裂全部边：让节点彼此独立，隔离验证地面碰撞本身
    for (const e of state.edges) e.torn = true;
    for (let s = 0; s < 120; s++) {
      stepOnce(state);
      for (const n of state.nodes) {
        expect(n.y).toBeLessThanOrEqual(state.config.groundY + 1e-9);
      }
    }
    // 充分落地后，全部静止在地面，垂直速度为 0
    advance(state, 120);
    for (const n of state.nodes) {
      expect(n.y).toBeCloseTo(state.config.groundY, 6);
      expect(n.y - n.py).toBeCloseTo(0, 9);
    }
  });
});

describe('撕裂不可逆', () => {
  it('边超过阈值只撕裂一次，撕裂集合单调不减且永不愈合', () => {
    // 8x8，只固定左上角一个点；tearFactor 较小，垂边会被拉断
    const state = createInitialState(
      makeConfig({ cols: 8, rows: 8, tearFactor: 1.15, gravity: 2600 }),
      false,
    );
    appendOp(state, { type: 'setPin', atStep: 0, node: 0, pinned: true });

    const totalBefore = state.edges.filter((e) => !e.torn).length;
    advance(state, 120);
    const tornIds = new Set(state.edges.filter((e) => e.torn).map((e) => e.id));
    expect(tornIds.size).toBeGreaterThan(0);
    expect(state.edges.length).toBe(totalBefore); // 边不删除，只标记

    advance(state, 120);
    advance(state, 120);
    for (const e of state.edges) {
      if (tornIds.has(e.id)) expect(e.torn).toBe(true); // 旧裂口永不恢复
      if (e.torn) tornIds.add(e.id);
    }
  });

  it('单条边被拉断后不再对两端施加约束（自由端继续下坠远离）', () => {
    const state = createInitialState(makeConfig({ cols: 8, rows: 8, tearFactor: 1.05 }), false);
    const n0 = state.nodes[0];
    const n1 = state.nodes[1];
    n0.pinned = true;
    n0.pinX = n0.x;
    n0.pinY = n0.y;
    n1.x = n0.x + state.config.spacing * 1.2;
    n1.y = n0.y;
    const edge = state.edges.find((e) => e.a === 0 && e.b === 1 && e.orientation === 'h')!;
    expect(edge.torn).toBe(false);

    stepOnce(state);
    expect(edge.torn).toBe(true);
    const distAfterTear = Math.hypot(state.nodes[1].x - n0.x, state.nodes[1].y - n0.y);

    advance(state, 60);
    const distLater = Math.hypot(state.nodes[1].x - n0.x, state.nodes[1].y - n0.y);
    // 约束已消失：自由节点受重力下坠，距离不会被拉回到 restLength
    expect(distLater).toBeGreaterThan(distAfterTear);
    expect(edge.torn).toBe(true);
  });
});

describe('分批推进一致性（同一份操作日志）', () => {
  function scripted(): SimState {
    const s = createInitialState(makeConfig({ tearFactor: 1.6 }));
    // 第 25 步释放顶边左数第三个挂点
    appendOp(s, { type: 'setPin', atStep: 25, node: 2, pinned: false });
    // 第 60 步把左上角挂点移到新位置
    appendOp(s, { type: 'movePin', atStep: 60, node: 0, pinned: true, x: 30, y: 20 });
    // 同一步内再固定一个内部节点（验证同 step 多操作的提交顺序）
    appendOp(s, { type: 'setPin', atStep: 60, node: 45, pinned: true, x: 150, y: 200 });
    return s;
  }

  const TOTAL = 150;
  const batches: number[][] = [
    Array.from({ length: TOTAL }, () => 1),
    [37, 83, 30],
    [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 6],
    [149, 1],
    [TOTAL],
  ];

  it('1步、各种分批、一次性推进产生完全相同的状态', () => {
    const refs = batches.map((plan) => {
      const s = scripted();
      for (const b of plan) advance(s, b);
      return s;
    });
    const expected = digest(refs[0]);
    expect(refs[0].step).toBe(TOTAL);
    for (let i = 1; i < refs.length; i++) {
      expect(refs[i].step).toBe(TOTAL);
      expect(digest(refs[i])).toEqual(expected);
    }
  });
});

describe('网格范围 8~20', () => {
  it('越界/非法的行列数被钳制到 8~20', () => {
    expect(clampConfig(makeConfig({ cols: 4, rows: 99 })).cols).toBe(MIN_GRID);
    expect(clampConfig(makeConfig({ cols: 4, rows: 99 })).rows).toBe(MAX_GRID);
    const s = createInitialState(makeConfig({ cols: 2, rows: 3 }));
    expect(s.config.cols).toBe(MIN_GRID);
    expect(s.config.rows).toBe(MIN_GRID);
    expect(s.nodes).toHaveLength(MIN_GRID * MIN_GRID);
  });
});

describe('步数上限 600', () => {
  it('达到 600 步后物理状态冻结，再次推进返回 0 步', () => {
    const s = createInitialState(makeConfig());
    const made = advance(s, 1000);
    expect(s.step).toBe(MAX_STEPS);
    expect(made).toBe(MAX_STEPS);
    const frozen = cloneState(s);
    expect(advance(s, 50)).toBe(0);
    expect(digest(s)).toEqual(digest(frozen));
  });
});
