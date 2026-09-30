/**
 * Worker 端消息处理内核（与 Worker 全局对象解耦，便于单元测试）。
 *
 * 防过期帧设计：
 *  - init 携带新的 gen 时，旧的推进任务通过 advanceToken 失效，
 *    即使旧任务的 setTimeout 已经排队，回调里也会直接退出；
 *  - Worker 外壳收到回复后仍会附带 gen，主线程 SimClient 再做一次 gen 校验，
 *    双保险确保“旧 Worker 帧不能覆盖新实验”。
 */

import { advance, appendOp, applyOpsAt, createInitialState } from './core';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { ClothConfig, LogOp, SimState } from './types';

/** 每个分块推进的物理步数；小步让出事件循环，使 op/cancel 能及时插入。 */
export const CHUNK_STEPS = 8;

export interface WorkerHost {
  post(msg: WorkerResponse): void;
}

/**
 * 可注入的调度器：生产环境用 setTimeout(…, 0)，测试可替换为同步收集器。
 */
export interface Scheduler {
  yield(cb: () => void): void;
}

export class SimWorkerKernel {
  private state: SimState | null = null;
  private gen = -1;
  /** 每次推进任务自增；旧 token 的分块回调整体作废。 */
  private advanceToken = 0;
  private busy = false;

  constructor(
    private host: WorkerHost,
    private scheduler: Scheduler = { yield: (cb) => setTimeout(cb, 0) },
  ) {}

  get currentGen(): number {
    return this.gen;
  }

  handle(msg: WorkerRequest): void {
    // 任何非 init 消息，gen 不匹配都必须忽略（旧实验的残留消息）。
    if (msg.type !== 'init' && msg.gen !== this.gen) return;

    switch (msg.type) {
      case 'init': {
        this.advanceToken++; // 使一切旧推进任务作废
        this.gen = msg.gen;
        this.state = createInitialState(msg.config, msg.pinTopRow);
        if (msg.log && msg.log.length > 0) {
          this.state.log = msg.log.map((op) => ({ ...op }));
        }
        this.busy = false;
        this.host.post({ type: 'ready', gen: this.gen });
        this.postSnapshot();
        break;
      }
      case 'snapshot': {
        this.postSnapshot();
        break;
      }
      case 'advance': {
        if (!this.state || this.busy) return;
        this.busy = true;
        const myToken = ++this.advanceToken;
        this.runChunk(msg.advanceId, msg.steps, 0, myToken, msg.gen);
        break;
      }
      case 'cancelAdvance': {
        // 仅取消指定任务；当前实现同一时刻只有一个推进任务。
        if (!this.busy) return;
        this.advanceToken++;
        this.busy = false;
        this.postSnapshot();
        break;
      }
      case 'op': {
        if (!this.state) return;
        // 交互操作与回放操作共用日志通道：先追加，再立即消费所有到期条目。
        // 这样同一条 op 在“实时交互”和“按日志重放”下执行点完全一致且只执行一次。
        appendOp(this.state, msg.op);
        applyOpsAt(this.state, this.state.step);
        this.postSnapshot();
        break;
      }
    }
  }

  private runChunk(
    advanceId: number,
    requested: number,
    completed: number,
    token: number,
    gen: number,
  ): void {
    this.scheduler.yield(() => {
      // 过期任务（init/cancel 之后）直接退出，绝不产生回复帧。
      if (token !== this.advanceToken || gen !== this.gen || !this.state) return;
      const remaining = requested - completed;
      const n = Math.min(CHUNK_STEPS, remaining);
      const made = advance(this.state, n);
      completed += made;
      const finished = this.state.step >= this.state.maxSteps;
      const doneNow = completed >= requested || made < n || finished;
      if (doneNow) {
        this.busy = false;
        this.host.post({
          type: 'progress',
          gen,
          advanceId,
          state: this.snapshot(),
          done: completed,
          requested,
          finished,
        });
      } else {
        this.host.post({
          type: 'progress',
          gen,
          advanceId,
          state: this.snapshot(),
          done: completed,
          requested,
          finished,
        });
        // 让出事件循环后继续下一块；回调内再次校验 token/gen。
        this.runChunk(advanceId, requested, completed, token, gen);
      }
    });
  }

  private snapshot(): SimState {
    // 结构化克隆会在线程边界自动发生；这里再给一份防御性拷贝，
    // 使得测试环境（无克隆）下也不会泄漏内部引用。
    return JSON.parse(JSON.stringify(this.state)) as SimState;
  }

  private postSnapshot(): void {
    if (!this.state) return;
    this.host.post({ type: 'snapshot', gen: this.gen, state: this.snapshot() });
  }
}

/** 把普通日志重放到全新状态（编辑参数后重建时使用）。 */
export function replayLog(config: ClothConfig, pinTopRow: boolean, log: LogOp[]): SimState {
  const state = createInitialState(config, pinTopRow);
  state.log = log.map((op) => ({ ...op }));
  return state;
}
