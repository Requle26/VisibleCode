import { useEffect, useState, type RefObject } from 'react';
import { EdgeLabelRenderer, useReactFlow } from '@xyflow/react';
import type { MemoryEdge, MemoryNode } from './memoryGraph';

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Wire = Rect & { edgeId: string | undefined };
type Segment = { from: Point; to: Point; horizontal: boolean; length: number; curved?: boolean };
type Label = { id: string; text: string; className: string; x: number; y: number; width: number; inline?: boolean; leader?: Rect };
const height = 16;

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
    return (curved || span < 6 ? [.5] : [.5, .25, .75, .12, .88]).map(part => ({ x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part,
      horizontal, score: Math.abs(start + span * part - length * fraction) + (horizontal ? 0 : 8) }));
  }).sort((a, b) => a.score - b.score);
}

function placeLabel(path: Segment[], width: number, occupied: Rect[], wires: Wire[], edgeId: string) {
  const points = anchors(path, .5);
  const inline = points.find(({ x, y }) => {
    const rect = { x: x - width / 2, y: y - height / 2, width, height };
    return !occupied.some(other => collides(rect, other)) && !wires.some(wire => wire.edgeId !== edgeId && collides(rect, wire));
  });
  if (inline) return { x: inline.x, y: inline.y, inline: true, leader: undefined };

  const obstacles = [...occupied, ...wires];
  let best: (Point & { score: number; inline: false; leader?: Rect }) | undefined;
  for (const anchor of points) {
    const axis = anchor.horizontal ? 'y' : 'x';
    const size = axis === 'y' ? 'height' : 'width';
    const half = (axis === 'y' ? height : width) / 2;
    for (const direction of [-1, 1]) {
      let gap = 5;
      // When the space beside the line is crowded, look farther out and add a leader.
      while (!best || anchor.score + gap < best.score) {
        const position = { x: anchor.x, y: anchor.y, [axis]: anchor[axis] + direction * (half + gap) };
        const rect = { x: position.x - width / 2, y: position.y - height / 2, width, height };
        const blocked = obstacles.filter(other => collides(rect, other));
        if (!blocked.length) {
          const leader = gap >= 12 ? {
            x: axis === 'x' ? Math.min(anchor.x + 2, position.x + half + 1) : anchor.x,
            y: axis === 'y' ? Math.min(anchor.y + 2, position.y + half + 1) : anchor.y,
            width: axis === 'x' ? gap - 3 : 1,
            height: axis === 'y' ? gap - 3 : 1,
          } : undefined;
          best = { ...position, score: anchor.score + gap, inline: false, leader };
          break;
        }
        gap = Math.max(gap + 1, ...blocked.map(other =>
          (other[axis] + (direction > 0 ? other[size] : 0) - anchor[axis]) * direction + 4));
      }
    }
  }
  return best;
}

export function EdgeLabels({ canvas, edges }: { canvas: RefObject<HTMLDivElement | null>; edges: MemoryEdge[] }) {
  const [labels, setLabels] = useState<Label[]>([]);
  const { getNodes, getInternalNode } = useReactFlow<MemoryNode, MemoryEdge>();

  useEffect(() => {
    const layer = canvas.current?.querySelector('.react-flow__edges');
    if (!layer) return;
    const labeled = edges.filter(edge => typeof edge.label === 'string').sort((a, b) => rank(b) - rank(a));
    let request = 0;
    const place = () => {
      const paths = new Map([...layer.querySelectorAll<SVGGElement>('.react-flow__edge[data-id]')].map(edge =>
        [edge.dataset.id, segments(edge.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? '')]));
      const wires = [...paths].flatMap(([edgeId, path]) => path.map(({ from, to }) => ({
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
        const width = 10 + [...text].reduce((sum, char) => sum + (/[가-힣]/.test(char) ? 11 : 6), 0);
        const position = placeLabel(paths.get(edge.id) ?? [], width, occupied, wires, edge.id);
        if (!position) continue;
        const { x, y, inline, leader } = position;
        occupied.push({ x: x - width / 2, y: y - height / 2, width, height });
        next.push({ id: edge.id, text, x, y, width, inline, leader, className: edge.className?.replace(/^graph-edge\s*/, '') ?? '' });
      }
      setLabels(next);
    };
    const schedule = () => { cancelAnimationFrame(request); request = requestAnimationFrame(place); };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ['d'] });
    return () => { observer.disconnect(); cancelAnimationFrame(request); };
  }, [canvas, edges, getNodes, getInternalNode]);

  return <EdgeLabelRenderer>{labels.map(({ id, text, className, x, y, width, inline, leader }) => <div key={id} className={`map-edge-label-group ${className}`} aria-hidden="true">
    {leader && <span className="map-edge-label-leader" style={{ left: leader.x, top: leader.y, width: leader.width, height: leader.height }} />}
    <span className={`map-edge-label${inline ? ' inline' : ''}`} style={{ left: x, top: y, width }}>{text}</span>
  </div>)}</EdgeLabelRenderer>;
}

function rank(edge: MemoryEdge) {
  return (edge.className?.includes('highlight') ? 4 : 0) + (edge.label === '호출 대상' ? 3 : edge.data?.kind === 'reference' ? 2 : edge.data?.kind === 'call' ? 1 : 0);
}
