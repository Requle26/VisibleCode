import type { XYPosition } from '@xyflow/react';
import type { MemoryNode } from './memoryGraph';

type Rect = XYPosition & { width: number; height: number };
type Axis = 'x' | 'y';
export type AlignmentGuide = { axis: Axis; coordinate: number; from: number; to: number };
export type SnapContact = AlignmentGuide & { movingIndex: number; fixedIndex: number };
export type PortAlignment = { axis: Axis; movingIndex: number; fixedIndex: number; movingPort: number; fixedPort: number; direction: -1 | 1 };
type Alignment = { axis: Axis; correction: number; coordinate: number; movingIndex: number; other: Rect; gap: number };
const epsilon = 1e-6;
export const nodeSnapPixels = 5;
const alignmentReachPixels = 280;

export function nodeBounds(node: MemoryNode) {
  const header = node.data.kind === 'local' ? 47 : node.data.kind === 'object' ? 41 : 51;
  const rows = (node.data.fields?.length ?? 0) + Number(node.data.text != null) + Number(node.data.kind === 'object' && Boolean(node.data.note));
  return { ...node.position, header, width: node.measured?.width || Number(node.style?.width ?? 174),
    height: node.measured?.height || header + 26 * rows };
}

const end = (rect: Rect, axis: Axis) => rect[axis] + (axis === 'x' ? rect.width : rect.height);
const spanOverlaps = (a: Rect, b: Rect, axis: Axis) => a[axis] < end(b, axis) - epsilon && b[axis] < end(a, axis) - epsilon;
const overlaps = (a: Rect, b: Rect) => spanOverlaps(a, b, 'x') && spanOverlaps(a, b, 'y');
const shifted = (rect: Rect, offset: XYPosition) => ({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y });

// Settle the automatic layout before applying any user positions.
export function settleNodePositions(nodes: MemoryNode[]) {
  const placed: Rect[] = [];
  const adjusted = new Map<string, number>();
  for (const node of nodes) {
    const box = nodeBounds(node);
    let intersections = placed.filter(other => overlaps(box, other));
    while (intersections.length) {
      box.y = Math.max(...intersections.map(other => end(other, 'y'))) + 8;
      intersections = placed.filter(other => overlaps(box, other));
    }
    if (box.y !== node.position.y) adjusted.set(node.id, box.y);
    placed.push(box);
  }
  if (!adjusted.size) return nodes;
  return nodes.map(node => adjusted.has(node.id) ? { ...node, position: { ...node.position, y: adjusted.get(node.id)! } } : node);
}

export function snapNodeDrag(moving: Rect[], fixed: Rect[], wanted: XYPosition, snapDistance: number, ports: PortAlignment[] = []): { offset: XYPosition; contact?: SnapContact; guides?: AlignmentGuide[] } {
  const offset = { ...wanted };
  const moved = moving.map(rect => shifted(rect, offset));
  const reach = snapDistance / nodeSnapPixels * alignmentReachPixels;
  const portMatch = (axis: Axis, pair?: { movingIndex: number; fixedIndex: number }) => {
    const across = axis === 'x' ? 'y' : 'x';
    let nearest: Alignment | undefined;
    for (const port of ports) {
      if (port.axis !== axis || (pair && (port.movingIndex !== pair.movingIndex || port.fixedIndex !== pair.fixedIndex))) continue;
      const card = shifted(moving[port.movingIndex], offset), other = fixed[port.fixedIndex];
      const gap = port.direction > 0 ? other[across] - end(card, across) : card[across] - end(other, across);
      if (gap < -epsilon || gap > reach) continue;
      const coordinate = other[axis] + port.fixedPort;
      const correction = coordinate - (card[axis] + port.movingPort);
      if (Math.abs(correction) <= snapDistance && (!nearest || Math.abs(correction) < Math.abs(nearest.correction))) {
        nearest = { axis, coordinate, correction, movingIndex: port.movingIndex, other, gap };
      }
    }
    return nearest;
  };
  let best: { axis: Axis; correction: number; coordinate: number; movingIndex: number; fixedIndex: number } | undefined;

  for (const axis of ['x', 'y'] as const) {
    const across = axis === 'x' ? 'y' : 'x';
    for (const [movingIndex, card] of moved.entries()) for (const [fixedIndex, other] of fixed.entries()) {
      if (!spanOverlaps(card, other, across)) continue;
      for (const [correction, coordinate] of [[other[axis] - end(card, axis), other[axis]], [end(other, axis) - card[axis], end(other, axis)]]) {
        if (Math.abs(correction) > snapDistance) continue;
        if (best && Math.abs(best.correction) <= Math.abs(correction)) continue;
        best = { axis, correction, coordinate, movingIndex, fixedIndex };
      }
    }
  }
  if (best) {
    const { axis, correction, coordinate, movingIndex, fixedIndex } = best;
    const card = moved[movingIndex], other = fixed[fixedIndex];
    offset[axis] += correction;
    const across = axis === 'x' ? 'y' : 'x';
    // Prefer the actual endpoints of a connection when they are already close.
    const alignment = portMatch(across, best)?.correction ?? [other[across] - card[across], end(other, across) - end(card, across)]
      .sort((a, b) => Math.abs(a) - Math.abs(b))
      .find(delta => Math.abs(delta) <= snapDistance);
    if (alignment !== undefined) offset[across] += alignment;
    const aligned = shifted(moving[movingIndex], offset);
    const from = Math.max(aligned[across], other[across]);
    const to = Math.min(end(aligned, across), end(other, across));
    if (to > from) return { offset, contact: { axis, coordinate, from, to, movingIndex, fixedIndex } };
  }
  const matches: Alignment[] = [];
  for (const axis of ['x', 'y'] as const) {
    const connected = portMatch(axis);
    if (connected) { matches.push(connected); continue; }
    const across = axis === 'x' ? 'y' : 'x';
    let nearest: typeof matches[number] | undefined;
    for (const [movingIndex, card] of moved.entries()) for (const other of fixed) {
      const gap = Math.max(other[across] - end(card, across), card[across] - end(other, across));
      if (gap <= epsilon || gap > reach) continue;
      for (const anchor of [0, .5, 1]) {
        const coordinate = other[axis] + anchor * (end(other, axis) - other[axis]);
        const correction = coordinate - (card[axis] + anchor * (end(card, axis) - card[axis]));
        if (Math.abs(correction) > snapDistance) continue;
        if (!nearest || Math.abs(correction) < Math.abs(nearest.correction) - epsilon
          || (Math.abs(Math.abs(correction) - Math.abs(nearest.correction)) <= epsilon && gap < nearest.gap)) {
          nearest = { axis, correction, coordinate, movingIndex, other, gap };
        }
      }
    }
    if (nearest) matches.push(nearest);
  }
  for (const { axis, correction } of matches) offset[axis] += correction;
  const guides = matches.flatMap(({ axis, coordinate, movingIndex, other }) => {
    const across = axis === 'x' ? 'y' : 'x';
    const card = shifted(moving[movingIndex], offset);
    const from = Math.min(end(card, across), end(other, across));
    const to = Math.max(card[across], other[across]);
    return to > from ? [{ axis, coordinate, from, to }] : [];
  });
  return guides.length ? { offset, guides } : { offset };
}
