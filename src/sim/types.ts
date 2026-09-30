/**
 * 布料模拟的共享类型定义。
 * 这些数据结构同时用于：
 *  - 纯函数模拟内核（src/sim/core.ts）
 *  - Worker 与主线程之间的结构化克隆通信
 *  - JSON 导出
 * 因此全部为可序列化的普通对象，不含函数/类实例。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 布料与模拟参数（编辑参数 = 新实验） */
export interface ClothConfig {
  /** 水平方向节点数，范围 8~20 */
  cols: number;
  /** 垂直方向节点数，范围 8~20 */
  rows: number;
  /** 相邻节点初始间距（像素） */
  spacing: number;
  /** 布料左上角初始位置 */
  origin: Vec2;
  /** 重力加速度（像素/秒²），y 轴向下 */
  gravity: number;
  /** 固定时间步长（秒），Worker 恒以此步长推进 */
  dt: number;
  /** Verlet 阻尼系数，作用于 (pos - prevPos)，1 表示无阻尼 */
  damping: number;
  /** 每步约束修正迭代次数 */
  iterations: number;
  /** 每一步约束修正内，水平边扫描次数 */
  horizontalPasses: number;
  /** 每一步约束修正内，垂直边扫描次数 */
  verticalPasses: number;
  /** 水平地面 y 坐标（像素，y 轴向下） */
  groundY: number;
  /** 边长超过 restLength * tearFactor 即撕裂（必须 > 1） */
  tearFactor: number;
}

export interface SimNode {
  /** 网格列号 0..cols-1 */
  col: number;
  /** 网格行号 0..rows-1 */
  row: number;
  x: number;
  y: number;
  /** 上一帧位置（Verlet） */
  px: number;
  py: number;
  /** 是否为固定挂点。固定点恒等于 pinX/pinY，不会漂移 */
  pinned: boolean;
  pinX: number;
  pinY: number;
}

export interface SimEdge {
  id: number;
  a: number;
  b: number;
  /** 'h' = 水平边（同一行相邻列），'v' = 垂直边（同一列相邻行） */
  orientation: 'h' | 'v';
  restLength: number;
  /** 撕裂一次即永久为 true，后续步骤不再施加该边约束 */
  torn: boolean;
}

/**
 * 操作日志条目。同一份日志无论分几批推进，结果必然相同：
 * 操作在“已完成步数 == atStep”之后、下一个物理步之前施加。
 */
export interface LogOp {
  /** 操作生效时已完成的物理步数 */
  atStep: number;
  type: 'setPin' | 'movePin';
  node: number;
  /** setPin: false 时忽略 x/y；movePin 时目标坐标 */
  pinned: boolean;
  x?: number;
  y?: number;
}

/** 纯数据模拟状态 */
export interface SimState {
  config: ClothConfig;
  nodes: SimNode[];
  edges: SimEdge[];
  /** 已完成的物理步数，上限 600 */
  step: number;
  /** 固定步数上限 */
  maxSteps: number;
  /** 操作日志，按 atStep 升序（同一 step 内保持提交顺序） */
  log: LogOp[];
  /** log 中已被 applyOpsAt 消费的条数（推进指针，不参与哈希比较也无妨） */
  logCursor: number;
}

/** 导出用：模拟状态 + 摘要统计 */
export interface StateExport {
  format: 'cloth-lab-state';
  version: 1;
  exportedAt: string;
  state: SimState;
  stats: {
    totalEdges: number;
    tornEdges: number;
    pinnedNodes: number;
    finished: boolean;
  };
}
