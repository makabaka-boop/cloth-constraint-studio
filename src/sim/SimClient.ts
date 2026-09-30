/**
 * 主线程模拟客户端：Worker 的唯一拥有者，也是应用的唯一状态来源。
 *
 * 不变量：
 *  1. 画面（Canvas）、单步检查面板、JSON 导出读取的是同一个冻结快照对象；
 *  2. 每次 reset / 编辑参数都会 terminate 旧 Worker 并递增 gen，
 *     即便旧 Worker 的消息意外到达也会被 gen 校验丢弃；
 *  3. 交互操作（固定/移动挂点）进入与回放相同的操作日志通道。
 */

import { createInitialState } from './core';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { SimWorkerKernel, type WorkerHost } from './workerKernel';
import type { ClothConfig, LogOp, SimState } from './types';

type Listener = () => void;

interface QueuedAdvance {
  steps: number;
  advanceId: number;
  resolve: (r: { done: number; finished: boolean }) => void;
  reject: (err: Error) => void;
}

export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  terminate(): void;
  onmessage: ((ev: { data: WorkerResponse }) => void) | null;
}
export type WorkerFactory = () => WorkerLike;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export class SimClient {
  private worker: WorkerLike | null = null;
  private gen = 0;
  private state: SimState | null = null;
  private busy = false;
  private listeners = new Set<Listener>();
  private nextAdvanceId = 1;
  private current: QueuedAdvance | null = null;
  private queue: QueuedAdvance[] = [];

  constructor(
    private factory: WorkerFactory,
    private config: ClothConfig,
    private pinTopRow: boolean,
  ) {
    // 先用本地内核生成第 0 步快照，首帧不依赖 Worker 往返。
    this.state = deepFreeze(createInitialState(config, pinTopRow));
    this.emit();
    this.spawnWorker();
  }

  getSnapshot(): SimState | null {
    return this.state;
  }

  isBusy(): boolean {
    return this.busy;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 新实验：编辑约束参数或重置。旧 Worker 立即终止，gen 递增。 */
  reset(config: ClothConfig = this.config, pinTopRow = this.pinTopRow): void {
    this.config = config;
    this.pinTopRow = pinTopRow;
    this.failPending(new Error('实验已重置：旧推进任务作废'));
    this.worker?.terminate();
    this.gen++;
    this.busy = false;
    this.state = deepFreeze(createInitialState(config, pinTopRow));
    this.emit();
    this.spawnWorker();
  }

  /** 按指定步数推进；busy 时自动排队，reset 后排队任务被拒绝。 */
  advance(steps: number): Promise<{ done: number; finished: boolean }> {
    return new Promise((resolve, reject) => {
      const item: QueuedAdvance = { steps, advanceId: 0, resolve, reject };
      if (this.busy || this.current) {
        this.queue.push(item);
      } else {
        this.dispatch(item);
      }
    });
  }

  /**
   * 交互操作：固定/释放/移动挂点。atStep 记为当前已完成步数，
   * 与批量回放走完全相同的日志语义。
   */
  applyInteractiveOp(op: Omit<LogOp, 'atStep'>): LogOp | null {
    if (!this.state) return null;
    const full: LogOp = { ...op, atStep: this.state.step };
    this.send({ type: 'op', gen: this.gen, op: full });
    return full;
  }

  requestSnapshot(): void {
    this.send({ type: 'snapshot', gen: this.gen });
  }

  destroy(): void {
    this.failPending(new Error('客户端已销毁'));
    this.worker?.terminate();
    this.worker = null;
    this.listeners.clear();
  }

  // ---- 内部实现 -------------------------------------------------------

  private spawnWorker(): void {
    const gen = this.gen;
    const worker = this.factory();
    this.worker = worker;
    worker.onmessage = (ev) => this.onMessage(ev.data, gen);
    worker.postMessage({ type: 'init', gen, config: this.config, pinTopRow: this.pinTopRow });
  }

  private dispatch(item: QueuedAdvance): void {
    if (!this.state || this.state.step >= this.state.maxSteps) {
      const finished = !!this.state && this.state.step >= this.state.maxSteps;
      item.resolve({ done: 0, finished });
      this.pumpQueue();
      return;
    }
    item.advanceId = this.nextAdvanceId++;
    this.current = item;
    this.busy = true;
    this.emit();
    this.send({ type: 'advance', gen: this.gen, advanceId: item.advanceId, steps: item.steps });
  }

  private pumpQueue(): void {
    this.current = null;
    const next = this.queue.shift();
    if (next) {
      this.dispatch(next);
    } else {
      this.busy = false;
      this.emit();
    }
  }

  private onMessage(msg: WorkerResponse, workerGen: number): void {
    // 过期代际的任何帧一律不得覆盖当前实验。
    if (workerGen !== this.gen || msg.gen !== this.gen) return;

    switch (msg.type) {
      case 'ready':
        return;
      case 'progress': {
        const cur = this.current;
        const matches = cur && msg.advanceId === cur.advanceId;
        // 中间进度帧与终帧都携带完整快照：任何时刻画面/检查/导出同源。
        this.state = deepFreeze(msg.state);
        this.emit();
        if (matches) {
          const terminal = msg.finished || msg.done >= msg.requested || msg.done === 0;
          if (terminal) {
            const resolve = cur.resolve;
            this.pumpQueue();
            resolve({ done: msg.done, finished: msg.finished });
          }
        }
        return;
      }
      case 'snapshot': {
        this.state = deepFreeze(msg.state);
        this.emit();
        return;
      }
    }
  }

  private send(msg: WorkerRequest): void {
    this.worker?.postMessage(msg);
  }

  private failPending(err: Error): void {
    this.current?.reject(err);
    this.current = null;
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * 供测试与“无 Worker 降级”使用的进程内 Worker 工厂。
 * 直接复用 SimWorkerKernel（微任务让出），与真 Worker 同一份确定性内核。
 */
export function createInlineWorkerFactory(): WorkerFactory {
  return () => {
    const w: WorkerLike = { onmessage: null, postMessage: () => {}, terminate() {} };
    const host: WorkerHost = {
      post(msg) {
        w.onmessage?.({ data: msg });
      },
    };
    const kernel = new SimWorkerKernel(host, { yield: (cb) => queueMicrotask(cb) });
    w.postMessage = (msg) => kernel.handle(msg);
    // 进程内替身无需真正销毁；即便旧分块微任务继续回调，
    // SimClient 的 gen 双重校验也会丢弃旧代际回复。
    w.terminate = () => {};
    return w;
  };
}

/** 浏览器中创建真实 Worker（ES module worker，Vite 原生支持）。 */
export function createBrowserWorkerFactory(): WorkerFactory {
  return () => new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
