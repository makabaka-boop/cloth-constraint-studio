/**
 * 确定性布料模拟内核（纯函数式：仅对传入的 SimState 做原地修改）。
 *
 * 关键确定性约定：
 *  - 固定时间步长 dt，不累积真实时间；
 *  - 每步顺序固定：施加到期日志操作 → Verlet 积分 → 撕裂检测 →
 *    固定次数的水平/垂直约束修正 → 地面碰撞 → 强制固定点归位；
 *  - 所有边按固定 id 顺序扫描（先水平后垂直）；
 *  - 边一旦 torn=true 永不恢复，也不再参与约束；
 *  - 步数达到 maxSteps（600）后 advance 不再改变任何物理量。
 *
 * Worker 与单元测试调用的是同一份代码，因此“分批推进结果一致”
 * 在内核层即可验证。
 */

import type { ClothConfig, LogOp, SimEdge, SimNode, SimState } from './types';

export const MIN_GRID = 8;
export const MAX_GRID = 20;
export const MAX_STEPS = 600;

export function clampConfig(input: ClothConfig): ClothConfig {
  const clampInt = (v: number, lo: number, hi: number) => {
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  return {
    ...input,
    cols: clampInt(input.cols, MIN_GRID, MAX_GRID),
    rows: clampInt(input.rows, MIN_GRID, MAX_GRID),
    spacing: num(input.spacing, 20),
    origin: { x: num(input.origin?.x, 60), y: num(input.origin?.y, 40) },
    gravity: num(input.gravity, 900),
    dt: num(input.dt, 1 / 60),
    damping: num(input.damping, 0.99),
    iterations: clampInt(input.iterations, 1, 20),
    horizontalPasses: clampInt(input.horizontalPasses, 1, 8),
    verticalPasses: clampInt(input.verticalPasses, 1, 8),
    groundY: num(input.groundY, 560),
    tearFactor: Math.max(1.0001, num(input.tearFactor, 1.8)),
  };
}

export function nodeIndex(col: number, row: number, cols: number): number {
  return row * cols + col;
}

/**
 * 建立初始状态：rows×cols 网格；默认固定顶边整排挂点。
 */
export function createInitialState(rawConfig: ClothConfig, pinTopRow = true): SimState {
  const config = clampConfig(rawConfig);
  const { cols, rows, spacing, origin } = config;
  const nodes: SimNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = origin.x + c * spacing;
      const y = origin.y + r * spacing;
      const pinned = pinTopRow && r === 0;
      nodes.push({
        col: c,
        row: r,
        x,
        y,
        px: x,
        py: y,
        pinned,
        pinX: x,
        pinY: y,
      });
    }
  }

  const edges: SimEdge[] = [];
  let id = 0;
  // 水平边：按行优先
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      edges.push({
        id: id++,
        a: nodeIndex(c, r, cols),
        b: nodeIndex(c + 1, r, cols),
        orientation: 'h',
        restLength: spacing,
        torn: false,
      });
    }
  }
  // 垂直边：按列优先
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows - 1; r++) {
      edges.push({
        id: id++,
        a: nodeIndex(c, r, cols),
        b: nodeIndex(c, r + 1, cols),
        orientation: 'v',
        restLength: spacing,
        torn: false,
      });
    }
  }

  return {
    config,
    nodes,
    edges,
    step: 0,
    maxSteps: MAX_STEPS,
    log: [],
    logCursor: 0,
  };
}

/**
 * 施加单个日志操作（交互与回放共用此函数，保证语义一致）。
 * 注意：交互路径（SimClient→Worker 'op'）会立即调用一次本函数，
 * 该操作不会再进入 stepOnce 的到期消费通道（由 applyOpsAt 的游标保证）。
 */
export function applyOp(state: SimState, op: LogOp): void {
  const n = state.nodes[op.node];
  if (!n) return;
  switch (op.type) {
    case 'setPin':
      n.pinned = op.pinned;
      if (op.pinned) {
        n.pinX = op.x ?? n.x;
        n.pinY = op.y ?? n.y;
        n.x = n.pinX;
        n.y = n.pinY;
        // 固定点速度清零，移动挂点不会继承动量
        n.px = n.pinX;
        n.py = n.pinY;
      }
      break;
    case 'movePin':
      n.pinned = true;
      n.pinX = op.x ?? n.pinX;
      n.pinY = op.y ?? n.pinY;
      n.x = n.pinX;
      n.y = n.pinY;
      n.px = n.pinX;
      n.py = n.pinY;
      break;
  }
}

/**
 * 在第 (completedStep+1) 个物理步之前，应用所有“已到期且尚未消费”的日志条目。
 * 规则：atStep <= completedStep 即到期；每条操作恰好在推进中应用一次。
 * 已消费前缀由 logCursor 记录，因此交互路径立即生效的操作（已在游标之后才被
 * 消费过一次）不会被重复执行。乱序漏过的条目也会在到期时立即补执行，
 * 保证“同一份日志”无论插入时机都得到同一结果。
 */
export function applyOpsAt(state: SimState, completedStep: number): void {
  const { log } = state;
  let cursor = state.logCursor;
  while (cursor < log.length && log[cursor].atStep <= completedStep) {
    applyOp(state, log[cursor]);
    cursor++;
  }
  state.logCursor = cursor;
}

/** 将操作插入日志，保持 atStep 非递减、同 step 内保持提交顺序。 */
export function appendOp(state: SimState, op: LogOp): void {
  state.log.push(op);
  // 交互产生的 atStep 恒为当前 step，通常就在末尾；保险起见做一次稳定插入。
  for (let i = state.log.length - 1; i > 0 && state.log[i - 1].atStep > op.atStep; i--) {
    const tmp = state.log[i - 1];
    state.log[i - 1] = state.log[i];
    state.log[i] = tmp;
  }
  // 插入可能改变游标位置语义：游标是“前缀条数”，重排的都是未消费条目，
  // 已消费前缀（atStep < 当前 step）不受影响，无需调整。
}

function integrate(state: SimState): void {
  const { nodes, config } = state;
  const drag = config.damping;
  const stepGravity = config.gravity * config.dt * config.dt;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) {
      // 固定挂点：位置恒等于 pin 坐标，速度恒为零 —— 杜绝漂移。
      n.px = n.pinX;
      n.py = n.pinY;
      n.x = n.pinX;
      n.y = n.pinY;
      continue;
    }
    const vx = (n.x - n.px) * drag;
    const vy = (n.y - n.py) * drag;
    n.px = n.x;
    n.py = n.y;
    n.x += vx;
    n.y += vy + stepGravity;
  }
}

/** 撕裂检测：在约束修正之前扫描一次，超阈值即永久撕裂。 */
function tearCheck(state: SimState): void {
  const { nodes, edges, config } = state;
  const factor = config.tearFactor;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.torn) continue;
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > e.restLength * factor) {
      e.torn = true; // 只撕裂一次：标志位永久生效，之后整条边被跳过
    }
  }
}

/** 松弛一条完好的边；固定点权重为 0。 */
function relaxEdge(nodes: SimNode[], e: SimEdge): void {
  const a = nodes[e.a];
  const b = nodes[e.b];
  const wa = a.pinned ? 0 : 1;
  const wb = b.pinned ? 0 : 1;
  const wSum = wa + wb;
  if (wSum === 0) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1e-9;
  const diff = (dist - e.restLength) / dist;
  const ox = dx * diff;
  const oy = dy * diff;
  if (wa !== 0) {
    a.x += (wb / wSum) * ox;
    a.y += (wb / wSum) * oy;
  }
  if (wb !== 0) {
    b.x -= (wa / wSum) * ox;
    b.y -= (wa / wSum) * oy;
  }
}

/** 按固定方向与固定次数扫描边。边数组天然先 h 后 v，按 id 升序。 */
function satisfyConstraints(state: SimState): void {
  const { edges, nodes, config } = state;
  // 找到水平/垂直边分界
  let split = edges.length;
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].orientation === 'v') {
      split = i;
      break;
    }
  }
  for (let it = 0; it < config.iterations; it++) {
    for (let hp = 0; hp < config.horizontalPasses; hp++) {
      for (let i = 0; i < split; i++) {
        const e = edges[i];
        if (!e.torn) relaxEdge(nodes, e);
      }
    }
    for (let vp = 0; vp < config.verticalPasses; vp++) {
      for (let i = split; i < edges.length; i++) {
        const e = edges[i];
        if (!e.torn) relaxEdge(nodes, e);
      }
    }
  }
}

/** 与水平地面碰撞：钳制 y，消除向下速度分量，保留水平运动。 */
function collideGround(state: SimState): void {
  const { nodes, config } = state;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) {
      n.x = n.pinX;
      n.y = n.pinY;
      continue;
    }
    if (n.y > config.groundY) {
      n.y = config.groundY;
      // py = y ⇒ 垂直速度清零；px 不动 ⇒ 水平速度保留。
      n.py = n.y;
    }
  }
}

/** 推进单个物理步（假定 step < maxSteps）。 */
export function stepOnce(state: SimState): void {
  // 1) 对本步到期的操作先生效（如释放/移动挂点）
  applyOpsAt(state, state.step);
  // 2) Verlet 积分
  integrate(state);
  // 3) 撕裂检测（一次成型，不可逆）
  tearCheck(state);
  // 4) 固定次数的水平/垂直约束修正
  satisfyConstraints(state);
  // 5) 地面碰撞
  collideGround(state);
  // 6) 固定点最终归位（双保险：固定点坐标恒等于 pin 坐标）
  const { nodes } = state;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) {
      n.x = n.pinX;
      n.y = n.pinY;
      n.px = n.pinX;
      n.py = n.pinY;
    }
  }
  state.step++;
}

/**
 * 推进至多 steps 个物理步，到达 600 上限自动停止。
 * onProgress 在每个物理步后回调（Worker 用它分块让出事件循环），
 * 回调抛错/返回 false 都会中止本次推进（已完成的步保留）。
 * 返回实际推进的步数。
 */
export function advance(
  state: SimState,
  steps: number,
  onProgress?: (step: number) => void | boolean,
): number {
  let done = 0;
  for (let i = 0; i < steps; i++) {
    if (state.step >= state.maxSteps) break;
    stepOnce(state);
    done++;
    if (onProgress) {
      const cont = onProgress(state.step);
      if (cont === false) break;
    }
  }
  return done;
}

export function isFinished(state: SimState): boolean {
  return state.step >= state.maxSteps;
}

/** 深拷贝（结构化克隆语义的 JSON 版本；状态全部是可序列化数据）。 */
export function cloneState(state: SimState): SimState {
  return JSON.parse(JSON.stringify(state)) as SimState;
}
