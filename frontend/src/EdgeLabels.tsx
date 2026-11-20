import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { EdgeLabelRenderer, useReactFlow } from '@xyflow/react';
import type { MemoryEdge, MemoryNode } from './memoryGraph';

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Wire = Rect & { edgeId?: string };
type Segment = { from: Point; to: Point; horizontal: boolean; length: number; curved?: boolean };
type Anchor = Point & { fraction: number };
type Label = Point & { id: string; text: string; className: string; width: number; anchor: Anchor; inline?: boolean; cutout?: SVGGElement | null; leader?: Rect };
const height = 16;
const labelBox = ({ x, y }: Point, width: number) => ({ x: x - width / 2, y: y - height / 2, width, height });

const collides = (a: Rect, b: Rect) => a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x &&
  a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y;

function segments(path: string): Segment[] {
  const result: Segment[] = [];
  let current: Point | undefined;
  const append = (from: Point, to: Point, curved = false) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length > 0) result.push({ from, to, horizontal: Math.abs(dx) >= Math.abs(dy), length, curved });
  };
  for (const [, command, args] of path.matchAll(/([MLC])\s*([^MLC]+)/g)) {
    const [x, y, controlX, controlY, endX, endY] = args.trim().split(/[\s,]+/).map(Number);
    const point = { x, y };
    if (command === 'M' || !current) { current = point; continue; }
    if (command === 'L') { append(current, point); current = point; continue; }
    const end = { x: endX, y: endY };
    let from = current;
    for (let i = 1; i <= 14; i++) {
      const t = i / 14, u = 1 - t;
      const to = { x: u ** 3 * current.x + 3 * u * u * t * point.x + 3 * u * t * t * controlX + t ** 3 * end.x,
        y: u ** 3 * current.y + 3 * u * u * t * point.y + 3 * u * t * t * controlY + t ** 3 * end.y };
      append(from, to, true);
      from = to;
    }
    current = end;
  }
  return result;
}

function anchors(path: Segment[], fraction: number) {
  const length = path.reduce((sum, segment) => sum + segment.length, 0);
  let walked = 0;
  return path.flatMap(({ from, to, horizontal, length: span, curved }) => {
    const start = walked;
    walked += span;
    return (curved || span < 6 ? [.5] : [.5, .25, .75, .12, .88]).map(part => {
      const distance = start + span * part;
      return { x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part,
        horizontal, fraction: distance / length, score: Math.abs(distance - length * fraction) + (horizontal ? 0 : 8) };
    });
  }).sort((a, b) => a.score - b.score);
}

function placeLabel(path: Segment[], width: number, occupied: Rect[], wires: Wire[], edgeId: string) {
  const points = anchors(path, .5);
  const inline = points.find(point => {
    const box = labelBox(point, width);
    return !occupied.some(rect => collides(box, rect)) && !wires.some(wire => wire.edgeId !== edgeId && collides(box, wire));
  });
  if (inline) return { x: inline.x, y: inline.y, anchor: inline, inline: true, leader: undefined };

  const obstacles = [...occupied, ...wires];
  let best: (Point & { score: number; anchor: Anchor; inline?: boolean; leader?: Rect }) | undefined;
  for (const anchor of points) {
    const axis = anchor.horizontal ? 'y' : 'x';
    const size = axis === 'y' ? 'height' : 'width';
    const half = (axis === 'y' ? height : width) / 2;
    for (const direction of [-1, 1]) {
      let gap = 5;
      // When the space beside the line is crowded, look farther out and add a leader.
      while (!best || anchor.score + gap < best.score) {
        const position = { x: anchor.x, y: anchor.y, [axis]: anchor[axis] + direction * (half + gap) };
        const rect = labelBox(position, width);
        const blocked = obstacles.filter(other => collides(rect, other));
        if (!blocked.length) {
          const leader = gap >= 12 ? {
            x: axis === 'x' ? Math.min(anchor.x + 2, position.x + half + 1) : anchor.x,
            y: axis === 'y' ? Math.min(anchor.y + 2, position.y + half + 1) : anchor.y,
            width: axis === 'x' ? gap - 3 : 1,
            height: axis === 'y' ? gap - 3 : 1,
          } : undefined;
          best = { ...position, anchor, score: anchor.score + gap, leader };
          break;
        }
        gap = Math.max(gap + 1, ...blocked.map(other =>
          (other[axis] + (direction > 0 ? other[size] : 0) - anchor[axis]) * direction + 4));
      }
    }
  }
  return best;
}

function pointOnPath(path: Segment[], fraction: number) {
  let distance = path.reduce((sum, segment) => sum + segment.length, 0) * fraction;
  for (const { from, to, length } of path) {
    if (distance <= length) {
      const t = distance / length;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    distance -= length;
  }
  return path.at(-1)?.to;
}

export function EdgeLabels({ canvas, edges, dragging }: { canvas: RefObject<HTMLDivElement | null>; edges: MemoryEdge[]; dragging: boolean }) {
  const [labels, setLabels] = useState<Label[]>([]);
  const settled = useRef(new Map<string, Label>());
  const { getNodes, getInternalNode } = useReactFlow<MemoryNode, MemoryEdge>();

  useEffect(() => {
    const layer = canvas.current?.querySelector('.react-flow__edges');
    if (!layer) return;
    const labeled = edges.filter(edge => typeof edge.label === 'string').sort((a, b) => rank(b) - rank(a));
    let request = 0;
    const place = () => {
      const routes = new Map([...layer.querySelectorAll<SVGGElement>('.react-flow__edge[data-id]')].map(edge => [edge.dataset.id, {
        path: segments(edge.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? ''),
        cutout: edge.querySelector<SVGGElement>('[data-label-gap]'),
      }]));
      // Keep the same point along each wire while dragging. Picking a new
      // collision-free slot for every pointer move makes adjacent slots flicker.
      if (dragging) {
        setLabels(labeled.flatMap(edge => {
          const rest = settled.current.get(edge.id);
          const route = routes.get(edge.id);
          const point = pointOnPath(route?.path ?? [], rest?.anchor.fraction ?? .5);
          const className = edge.className?.replace(/^graph-edge\s*/, '') ?? '';
          if (rest) {
            if (!point) return [{ ...rest, className, cutout: route?.cutout }];
            return [{ ...rest, className, cutout: route?.cutout, x: point.x + (rest.x - rest.anchor.x), y: point.y + (rest.y - rest.anchor.y) }];
          }
          const text = edge.label;
          return point && typeof text === 'string'
            ? [{ ...point, y: point.y - height, id: edge.id, text, className, width: labelWidth(text), anchor: { ...point, fraction: .5 } }] : [];
        }));
        return;
      }
      const wires: Wire[] = [...routes].flatMap(([edgeId, { path }]) => path.map(({ from, to }) => ({
        edgeId,
        x: Math.min(from.x, to.x) - 1, y: Math.min(from.y, to.y) - 1,
        width: Math.abs(to.x - from.x) + 2, height: Math.abs(to.y - from.y) + 2,
      })));
      const occupied: Rect[] = getNodes().flatMap(({ id, data }) => {
        if (data.leaving) return [];
        const node = getInternalNode(id);
        if (!node?.measured?.width || !node.measured.height) return [];
        return [{ ...node.internals.positionAbsolute, width: node.measured.width, height: node.measured.height }];
      });
      const next: Label[] = [];
      for (const edge of labeled) {
        const text = edge.label;
        if (typeof text !== 'string') continue;
        const width = labelWidth(text);
        const route = routes.get(edge.id);
        const position = placeLabel(route?.path ?? [], width, occupied, wires, edge.id);
        if (!position) continue;
        const { x, y, anchor, inline, leader } = position;
        occupied.push(labelBox(position, width));
        next.push({ id: edge.id, text, x, y, width, anchor, inline, cutout: route?.cutout,
          leader: leader && { ...leader, x: leader.x - x, y: leader.y - y },
          className: edge.className?.replace(/^graph-edge\s*/, '') ?? '' });
      }
      settled.current = new Map(next.map(label => [label.id, label]));
      setLabels(next);
    };
    const schedule = () => { cancelAnimationFrame(request); request = requestAnimationFrame(place); };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ['d'] });
    return () => { observer.disconnect(); cancelAnimationFrame(request); };
  }, [canvas, edges, dragging, getNodes, getInternalNode]);

  return <EdgeLabelRenderer>{labels.map(label => <EdgeLabel key={label.id} {...label} />)}</EdgeLabelRenderer>;
}

function EdgeLabel({ id, text, className, x, y, width, inline, cutout, leader }: Label) {
  const group = useRef<HTMLDivElement>(null);
  const gap = useRef<SVGRectElement>(null);
  const position = useRef({ x, y });
  useLayoutEffect(() => {
    const draw = (x: number, y: number) => {
      position.current = { x, y };
      const transform = `translate(${x}px, ${y}px)`;
      if (group.current) group.current.style.transform = transform;
      if (gap.current) gap.current.style.transform = transform;
    };
    const start = position.current;
    if (Math.hypot(x - start.x, y - start.y) < .25 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(x, y);
      return;
    }
    // The HTML text and the SVG hole must use the same animation frame.
    draw(start.x, start.y);
    const began = performance.now();
    let request = requestAnimationFrame(function move(now) {
      const time = Math.max(0, Math.min(1, (now - began) / 90));
      const t = 1 - (1 - time) ** 3;
      draw(start.x + (x - start.x) * t, start.y + (y - start.y) * t);
      if (time < 1) request = requestAnimationFrame(move);
    });
    return () => cancelAnimationFrame(request);
  }, [x, y, inline, cutout]);

  return <div ref={group} data-edge-id={id} className={`map-edge-label-group ${className}`} aria-hidden="true">
    {inline && cutout && createPortal(<rect ref={gap} className="map-edge-label-cutout" x={-width / 2} y={-height / 2}
      width={width} height={height} rx={3} fill="black" />, cutout)}
    {leader && <span className="map-edge-label-leader" style={{ left: leader.x, top: leader.y, width: leader.width, height: leader.height }} />}
    <span className="map-edge-label" style={{ width }}>{text}</span>
  </div>;
}

function labelWidth(text: string) {
  return 10 + [...text].reduce((sum, char) => sum + (/[가-힣]/.test(char) ? 11 : 6), 0);
}

function rank(edge: MemoryEdge) {
  return (edge.className?.includes('highlight') ? 4 : 0) + (edge.label === '호출 대상' ? 3 : edge.data?.kind === 'reference' ? 2 : edge.data?.kind === 'call' ? 1 : 0);
}
