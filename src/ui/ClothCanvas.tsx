import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { SimClient } from '../sim/SimClient';
import type { SimState } from '../sim/types';

interface Props {
  stateRef: RefObject<SimState | null>;
  clientRef: RefObject<SimClient | null>;
  busy: boolean;
  onInteract: () => void;
}

const NODE_HIT_RADIUS = 9;
const DRAG_THRESHOLD = 3;

interface DragState {
  node: number;
  startX: number;
  startY: number;
  moved: boolean;
  ghostX: number;
  ghostY: number;
}

/**
 * 布料画布：节点/边渲染 + 挂点交互（点击固定/释放，拖动移动挂点）。
 * 渲染数据每帧从 stateRef 读取同一个快照；交互直接写 SimClient。
 */
export function ClothCanvas({ stateRef, clientRef, busy, onInteract }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<number | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = stateRef.current;
      if (!s) return;
      const { nodes, edges, config } = s;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 地面
      ctx.fillStyle = '#e7e2d8';
      ctx.fillRect(0, config.groundY, canvas.width, canvas.height - config.groundY);
      ctx.strokeStyle = '#8a7f6d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, config.groundY + 0.5);
      ctx.lineTo(canvas.width, config.groundY + 0.5);
      ctx.stroke();

      // 边：完好用深蓝，撕裂用红虚线
      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (e.torn) {
          ctx.strokeStyle = 'rgba(200, 60, 60, 0.55)';
          ctx.setLineDash([4, 4]);
        } else {
          ctx.strokeStyle = '#33566f';
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 拖动中的挂点虚影
      const drag = dragRef.current;

      // 节点
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.pinned) {
          ctx.fillStyle = '#d97706';
          ctx.beginPath();
          ctx.arc(n.x, n.y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#92400e';
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (hoverRef.current === i) {
          ctx.fillStyle = 'rgba(51, 86, 111, 0.25)';
          ctx.beginPath();
          ctx.arc(n.x, n.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (drag) {
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#92400e';
        ctx.beginPath();
        ctx.arc(drag.ghostX, drag.ghostY, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = '#b45309';
        ctx.beginPath();
        ctx.moveTo(nodes[drag.node].pinX, nodes[drag.node].pinY);
        ctx.lineTo(drag.ghostX, drag.ghostY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [stateRef]);

  const pos = (ev: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const pickNode = (x: number, y: number): number | null => {
    const s = stateRef.current;
    if (!s) return null;
    let best: number | null = null;
    let bestD = NODE_HIT_RADIUS;
    for (let i = 0; i < s.nodes.length; i++) {
      const n = s.nodes[i];
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    if (busyRef.current) return;
    const { x, y } = pos(ev);
    const idx = pickNode(x, y);
    if (idx === null) return;
    canvasRef.current!.setPointerCapture(ev.pointerId);
    const n = stateRef.current!.nodes[idx];
    if (n.pinned) {
      // 按住挂点准备拖动
      dragRef.current = { node: idx, startX: x, startY: y, moved: false, ghostX: n.pinX, ghostY: n.pinY };
    }
    // 非挂点按下先记录，松手时若未拖动则切换固定状态
    dragRef.current = dragRef.current ?? {
      node: idx,
      startX: x,
      startY: y,
      moved: false,
      ghostX: x,
      ghostY: y,
    };
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const { x, y } = pos(ev);
    const drag = dragRef.current;
    if (drag) {
      const s = stateRef.current!;
      const n = s.nodes[drag.node];
      if (n.pinned) {
        if (Math.hypot(x - drag.startX, y - drag.startY) > DRAG_THRESHOLD) drag.moved = true;
        if (drag.moved) {
          drag.ghostX = x;
          drag.ghostY = y;
        }
      }
    } else {
      hoverRef.current = pickNode(x, y);
      canvasRef.current!.style.cursor = hoverRef.current !== null ? 'pointer' : 'default';
    }
  };

  const onPointerUp = (ev: React.PointerEvent) => {
    const drag = dragRef.current;
    const client = clientRef.current;
    dragRef.current = null;
    if (!drag || !client || busyRef.current) return;
    const { x, y } = pos(ev);
    const n = stateRef.current!.nodes[drag.node];

    if (n.pinned && drag.moved) {
      // 移动挂点：写入与回放一致的 movePin 日志
      client.applyInteractiveOp({
        type: 'movePin',
        node: drag.node,
        pinned: true,
        x,
        y,
      });
    } else if (!drag.moved) {
      // 点击：固定/释放切换。固定自由节点时锚定在节点当前位置（原位固定）。
      client.applyInteractiveOp({
        type: 'setPin',
        node: drag.node,
        pinned: !n.pinned,
        x: n.x,
        y: n.y,
      });
    }
    onInteract();
  };

  return (
    <canvas
      ref={canvasRef}
      width={900}
      height={640}
      style={{ background: '#faf8f3', border: '1px solid #c9c2b4', borderRadius: 6, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
