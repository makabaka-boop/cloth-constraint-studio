# 离线二维布料实验台（React + TypeScript + Canvas + Web Worker）

固定时间步 Verlet 布料模拟。网格 8～20 × 8～20 节点，水平/垂直结构边做固定次数
约束修正；挂点可固定/释放/移动；与水平地面碰撞；边超阈值只撕裂一次且不可逆；
模拟最多推进 600 步。

## 运行

```bash
npm install
npm run dev       # 开发
npm test          # 单元测试（20 个）
npm run build     # 类型检查 + 生产构建（dist/ 可完全离线打开）
npm run preview   # 预览构建产物
```

无模块 Worker 的环境下（如 file:// 直开）自动退化为进程内确定性内核，行为一致。

## 架构

```
src/sim/
  types.ts        可序列化数据结构（节点/边/日志/状态/配置）
  core.ts         纯确定性内核（createInitialState / stepOnce / advance / 日志）
  protocol.ts     主线程 ⇄ Worker 消息
  workerKernel.ts Worker 处理内核（分块让出 + gen/token 过期帧作废），与 Worker 外壳解耦
  simWorker.ts    Worker 入口
  SimClient.ts    主线程唯一状态源：拥有 Worker、gen 校验、冻结快照、队列
src/ui/
  ClothCanvas.tsx Canvas 渲染 + 挂点点击/拖拽
  ControlPanel.tsx 参数、推进、重置、导出
  Inspector.tsx   单步检查（节点查询、撕裂/挂点统计、操作日志）
  App.tsx         装配
```

### 确定性如何保证

- `core.stepOnce` 顺序固定：到期日志 → Verlet 积分 → 撕裂检测 → 固定次数的
  水平扫描/垂直扫描（按边 id 固定顺序）→ 地面碰撞 → 固定点归位。
- 固定 `dt`，Worker 分块只影响“何时让出事件循环”，不改变任何数值计算；
  单元测试逐位比较 `[1,1,…]`、任意分批与一次性推进的完整状态。
- 操作日志条目 `atStep` 为“已完成步数”，在下一步物理计算前应用且只应用一次。
  实时交互（固定/移动挂点）写入的就是同一条日志通道，因此交互过程可由日志
  无损重放。
- 撕裂：积分后扫描一次，`torn=true` 永久生效，边保留在数组中但永不参与修正。
- 固定点在积分、约束、碰撞、收尾四个位置都钉在 `pinX/pinY`，速度恒为零。

### 过期帧隔离

- 编辑约束参数 / 重置 = 新实验：`terminate()` 旧 Worker、代际 `gen` 递增，
  Worker 侧 `advanceToken` 使旧分块回调静默退出，主线程对每条回复再做 gen
  校验。双重保险确保旧帧不可能覆盖新实验（见 `workerKernel.test.ts`）。

### 同源快照

`SimClient` 是唯一状态来源，快照被 `Object.freeze` 深冻结；Canvas 每帧、
Inspector、JSON 导出读取同一对象。

## 已覆盖的测试

- 固定挂点任意步数不漂移（位置与速度恒等于 pin 坐标）；
- 地面边界：节点不穿过地面，落地后垂直速度清零；
- 撕裂不可逆：撕裂集合单调不减；拉断后约束确实消失；
- 分批一致性：同一份日志，1 步连推/多种分批/一次性推进状态深相等；
  Worker 8 步分块与内核直推逐位相等；多次请求等价于一次请求；
- 实时交互结果 == 同日志纯回放结果；
- 600 步上限后物理状态冻结；
- reset 后旧 Worker 的迟到回复不污染新快照。
