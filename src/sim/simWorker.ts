/**
 * Web Worker 入口：把 message 事件转交给 SimWorkerKernel。
 * 所有物理计算都在这里进行；与测试共用 workerKernel，
 * 因此“分块/不分块结果一致”在 Node 单测中即可证明。
 */

import type { WorkerRequest, WorkerResponse } from './protocol';
import { SimWorkerKernel } from './workerKernel';

const kernel = new SimWorkerKernel({
  post(msg: WorkerResponse) {
    (self as unknown as Worker).postMessage(msg);
  },
});

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  kernel.handle(e.data);
};
