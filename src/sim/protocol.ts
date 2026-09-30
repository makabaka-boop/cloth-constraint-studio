/**
 * 主线程 ⇄ Worker 消息协议。所有消息均携带 gen（实验代际）：
 * 编辑约束/重置会产生新 gen，旧 gen 的回复一律丢弃。
 */

import type { ClothConfig, LogOp, SimState } from './types';

export type WorkerRequest =
  | { type: 'init'; gen: number; config: ClothConfig; pinTopRow: boolean; log?: LogOp[] }
  | { type: 'snapshot'; gen: number }
  | { type: 'advance'; gen: number; advanceId: number; steps: number }
  | { type: 'op'; gen: number; op: LogOp }
  | { type: 'cancelAdvance'; gen: number; advanceId: number };

export type WorkerResponse =
  | { type: 'snapshot'; gen: number; state: SimState }
  | {
      type: 'progress';
      gen: number;
      advanceId: number;
      state: SimState;
      done: number;
      requested: number;
      finished: boolean;
    }
  | { type: 'ready'; gen: number };
