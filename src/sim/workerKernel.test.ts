import { describe, expect, it } from 'vitest';
import { advance, createInitialState } from './core';
import { SimWorkerKernel } from './workerKernel';
import type { WorkerResponse } from './protocol';
import { digest, makeConfig } from './core.test';
import type { LogOp } from './types';

/** 排空全部微任务（kernel 用 queueMicrotask 分块让出）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    await Promise.resolve();
  }
}

function collectKernel() {
  const replies: WorkerResponse[] = [];
  const kernel = new SimWorkerKernel(
    { post: (m) => replies.push(m) },
    { yield: (cb) => queueMicrotask(cb) },
  );
  return { kernel, replies };
}

const SCRIPT: LogOp[] = [
  { type: 'setPin', atStep: 25, node: 2, pinned: false },
  { type: 'movePin', atStep: 60, node: 0, pinned: true, x: 30, y: 20 },
  { type: 'setPin', atStep: 60, node: 45, pinned: true, x: 150, y: 200 },
];

describe('Worker 分块推进 = 内核直推', () => {
  it('携带同一份日志，8步分块推进 150 步与一次性直推逐位相同', async () => {
    const { kernel, replies } = collectKernel();
    kernel.handle({ type: 'init', gen: 0, config: makeConfig({ tearFactor: 1.6 }), pinTopRow: true, log: SCRIPT });
    kernel.handle({ type: 'advance', gen: 0, advanceId: 1, steps: 150 });
    await flushMicrotasks();

    const last = replies.filter((m) => m.type === 'progress').slice(-1)[0];
    expect(last).toBeDefined();
    expect(last.type).toBe('progress');
    if (last.type !== 'progress') throw new Error('unreachable');
    expect(last.done).toBe(150);

    const ref = createInitialState(makeConfig({ tearFactor: 1.6 }), true);
    ref.log = SCRIPT.map((o) => ({ ...o }));
    advance(ref, 150);
    expect(digest(last.state)).toEqual(digest(ref));
  });

  it('分多次请求推进（60+60+30）等价于一次性 150 步', async () => {
    const { kernel, replies } = collectKernel();
    kernel.handle({ type: 'init', gen: 0, config: makeConfig({ tearFactor: 1.6 }), pinTopRow: true, log: SCRIPT });
    kernel.handle({ type: 'advance', gen: 0, advanceId: 1, steps: 60 });
    await flushMicrotasks();
    kernel.handle({ type: 'advance', gen: 0, advanceId: 2, steps: 60 });
    await flushMicrotasks();
    kernel.handle({ type: 'advance', gen: 0, advanceId: 3, steps: 30 });
    await flushMicrotasks();

    const last = replies.filter((m) => m.type === 'progress').slice(-1)[0];
    if (last.type !== 'progress') throw new Error('unreachable');
    const ref = createInitialState(makeConfig({ tearFactor: 1.6 }), true);
    ref.log = SCRIPT.map((o) => ({ ...o }));
    advance(ref, 150);
    expect(digest(last.state)).toEqual(digest(ref));
  });

  it('init 回放日志时从游标 0 开始消费，step 0 的操作也生效', async () => {
    const log: LogOp[] = [{ type: 'setPin', atStep: 0, node: 5, pinned: false }];
    const { kernel, replies } = collectKernel();
    kernel.handle({ type: 'init', gen: 0, config: makeConfig(), pinTopRow: true, log });
    const initSnap = replies.find((m) => m.type === 'snapshot')!;
    if (initSnap.type !== 'snapshot') throw new Error('unreachable');
    expect(initSnap.state.nodes[5].pinned).toBe(true); // step 0 尚未执行
    kernel.handle({ type: 'advance', gen: 0, advanceId: 1, steps: 1 });
    await flushMicrotasks();
    const prog = replies.filter((m) => m.type === 'progress').slice(-1)[0];
    if (prog.type !== 'progress') throw new Error('unreachable');
    expect(prog.state.nodes[5].pinned).toBe(false); // step 0 操作在第 1 步前生效
  });

  it('SimClient 实时交互产生的状态 == 同日志纯回放直推状态', async () => {
    const { SimClient, createInlineWorkerFactory } = await import('./SimClient');
    const client = new SimClient(createInlineWorkerFactory(), makeConfig({ tearFactor: 1.6 }), true);
    await flushMicrotasks();

    await client.advance(25);
    client.applyInteractiveOp({ type: 'setPin', node: 2, pinned: false });
    await flushMicrotasks();
    await client.advance(35); // 到 step 60
    client.applyInteractiveOp({ type: 'movePin', node: 0, pinned: true, x: 30, y: 20 });
    client.applyInteractiveOp({ type: 'setPin', node: 45, pinned: true, x: 150, y: 200 });
    await flushMicrotasks();
    await client.advance(90); // 到 step 150
    await flushMicrotasks();

    const live = client.getSnapshot()!;
    expect(live.step).toBe(150);

    // 取实时交互实际生成的日志，用全新状态直推，应完全相同
    const ref = createInitialState(makeConfig({ tearFactor: 1.6 }), true);
    ref.log = live.log.map((o) => ({ ...o }));
    advance(ref, 150);
    expect(digest(live)).toEqual(digest(ref));
    client.destroy();
  });
});

describe('旧 Worker 帧不能覆盖新实验', () => {
  it('旧 gen 的消息在 kernel 中被忽略', async () => {
    const { kernel, replies } = collectKernel();
    kernel.handle({ type: 'init', gen: 0, config: makeConfig(), pinTopRow: true });
    kernel.handle({ type: 'advance', gen: 0, advanceId: 1, steps: 100 });
    // 推进尚未跑完时重置为新实验
    kernel.handle({ type: 'init', gen: 1, config: makeConfig({ cols: 12, rows: 9 }), pinTopRow: false });
    await flushMicrotasks();

    const gen0Progress = replies.filter((m) => m.gen === 0 && m.type === 'progress');
    expect(gen0Progress.length).toBe(0); // 旧任务被 token 作废，不产生任何 progress
    const gen1Snaps = replies.filter((m) => m.gen === 1);
    expect(gen1Snaps.length).toBeGreaterThan(0);

    // gen=-1 / gen=0 的杂散消息不会影响新实验
    const before = replies.length;
    kernel.handle({ type: 'snapshot', gen: 0 });
    kernel.handle({ type: 'advance', gen: 0, advanceId: 99, steps: 10 });
    expect(replies.length).toBe(before);
  });

  it('SimClient.reset 后旧 Worker 的迟到回复不会污染新快照', async () => {
    const { SimClient, createInlineWorkerFactory } = await import('./SimClient');
    const client = new SimClient(createInlineWorkerFactory(), makeConfig(), true);
    await flushMicrotasks();

    // 发起一大段推进，分块微任务会陆续到达
    const p = client.advance(120);
    await Promise.resolve();
    await Promise.resolve(); // 让前几块 progress 已投递

    // 中途编辑参数重置（新实验：12x9、无默认挂点）
    client.reset(makeConfig({ cols: 12, rows: 9 }), false);
    await expect(p).rejects.toBeTruthy();
    await flushMicrotasks();

    const snap = client.getSnapshot()!;
    expect(snap.config.cols).toBe(12);
    expect(snap.config.rows).toBe(9);
    expect(snap.step).toBe(0);
    expect(snap.nodes.length).toBe(12 * 9);
    expect(snap.nodes.some((n) => n.pinned)).toBe(false);

    // 新实验自身推进正常
    const r = await client.advance(10);
    expect(r.done).toBe(10);
    expect(snap.step).toBeLessThanOrEqual(10);
    client.destroy();
  });
});
