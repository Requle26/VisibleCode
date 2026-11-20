import type { XYPosition } from '@xyflow/react';
import type { ConnectionPort, EdgeLane, MemoryEdge, MemoryNode } from './memoryGraph';
import { nodeBounds } from './nodePlacement';

type Point = XYPosition;
type Side = ConnectionPort['side'];
type Box = { x: number; y: number; width: number; height: number; header: number; object: boolean };
type EdgeRoute = { sourceHandle: string; targetHandle: string; lane?: EdgeLane; curved?: boolean };
type RoutedLink = { edge: MemoryEdge; source: Box; target: Box; fan: boolean; draft: PlannedRoute };
type FixedPorts = { start: Side; end: Side; departure?: ConnectionPort; arrival?: ConnectionPort };

const stub = 16;
const laneGap = 8;
const portGap = 12;
const cornerInset = 10;
const minimumSharedSpan = 10;
const sides = ['right', 'left', 'top', 'bottom'] as const;
const fieldSides = ['right', 'left'] as const;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const axisOf = (side: Side) => side === 'left' || side === 'right' ? 'x' : 'y';
const signOf = (side: Side) => side === 'left' || side === 'top' ? -1 : 1;
const move = (p: Point, side: Side, d: number): Point => ({
  x: p.x + (side === 'left' ? -d : side === 'right' ? d : 0),
  y: p.y + (side === 'top' ? -d : side === 'bottom' ? d : 0),
});

function port(box: Box, side: Side, row?: number, incoming = false): Point {
  const middle = row != null ? box.header + row * 26 + 13 : incoming && box.object ? 20 : box.height / 2;
  return {
    x: box.x + (side === 'left' ? 0 : side === 'right' ? box.width : box.width / 2),
    y: box.y + (side === 'top' ? 0 : side === 'bottom' ? box.height : middle),
  };
}

function acrossOf(side: Side) { return axisOf(side) === 'x' ? 'y' : 'x'; }

function splitPorts(links: RoutedLink[]) {
  const groups = new Map<string, { nodeId: string; box: Box; side: Side; slots: Map<string, { type: ConnectionPort['type']; kind: string; links: RoutedLink[] }> }>();
  const add = (type: ConnectionPort['type'], nodeId: string, box: Box, side: Side, slotKey: string, link: RoutedLink) => {
    const key = JSON.stringify([nodeId, side]);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { nodeId, box, side, slots: new Map() });
    const slot = JSON.stringify([type, slotKey]);
    const entry = group.slots.get(slot);
    if (entry) entry.links.push(link);
    else group.slots.set(slot, { type, kind: slotKey, links: [link] });
  };
  for (const link of links) {
    const { edge, source, target, draft } = link;
    // References tied to a field already have a dedicated exit on that row.
    if (edge.data?.fieldIndex == null) add('source', edge.source, source, draft.start, edge.id, link);
    // Arrivals of the same kind can converge, even when other kinds need their own port.
    add('target', edge.target, target, draft.end, edge.data?.kind ?? '', link);
  }
  const departures = new Map<string, ConnectionPort>();
  const arrivals = new Map<string, ConnectionPort>();
  const connectionPorts = new Map<string, ConnectionPort[]>();
  for (const { nodeId, box, side, slots } of groups.values()) {
    if (slots.size < 2) continue;
    const across = acrossOf(side), size = across === 'x' ? 'width' : 'height';
    const span = box[size], inset = Math.min(cornerInset, span / 4);
    const gap = Math.min(portGap, (span - 2 * inset) / (slots.size - 1));
    const half = (slots.size - 1) * gap / 2;
    const base = port(box, side, undefined, [...slots.values()].some(slot => slot.type === 'target'))[across] - box[across];
    const first = Math.min(span - inset - 2 * half, Math.max(inset, base - half));
    const ordered = [...slots].map(([key, slot]) => ({ ...slot, key, center: slot.links.reduce((sum, link) => {
      const other = slot.type === 'target' ? link.source : link.target;
      return sum + other[across] + other[size] / 2;
    }, 0) / slot.links.length })).sort((a, b) => a.center - b.center || a.key.localeCompare(b.key));
    // Keep the visible reference dot at the standard port; fit other kinds around it.
    const reference = ordered.findIndex(({ type, kind }) => type === 'target' && kind === 'reference');
    const beforeGap = reference > 0 ? Math.min(portGap, (base - inset) / reference) : portGap;
    const after = ordered.length - reference - 1;
    const afterGap = after > 0 ? Math.min(portGap, (span - inset - base) / after) : portGap;
    const handles = connectionPorts.get(nodeId) ?? [];
    ordered.forEach(({ type, kind, links }, i) => {
      if (i === reference) return;
      const incoming = type === 'target';
      const natural = port(box, side, undefined, incoming)[across] - box[across];
      const coordinate = reference < 0 ? first + i * gap : base + (i - reference) * (i < reference ? beforeGap : afterGap);
      const slot = { id: incoming ? `in-${side}-kind-${kind}` : `out-${side}-slot-${i}`, side, type, offset: coordinate - natural };
      handles.push(slot);
      for (const { edge } of links) (incoming ? arrivals : departures).set(edge.id, slot);
    });
    connectionPorts.set(nodeId, handles);
  }
  return { departures, arrivals, connectionPorts };
}

function compactPoints(points: Point[]) {
  const result: Point[] = [];
  const between = (value: number, a: number, b: number) => value >= Math.min(a, b) && value <= Math.max(a, b);
  for (const point of points) {
    const last = result.at(-1), previous = result.at(-2);
    if (last && distance(last, point) === 0) continue;
    if (last && previous && ((previous.x === last.x && last.x === point.x && between(last.y, previous.y, point.y))
        || (previous.y === last.y && last.y === point.y && between(last.x, previous.x, point.x)))) result.pop();
    result.push(point);
  }
  return result;
}

function lanePoints(a: Point, start: Side, b: Point, end: Side, { axis, coordinate }: EdgeLane) {
  const from = axisOf(start) === axis ? a : move(a, start, stub);
  const to = axisOf(end) === axis ? b : move(b, end, stub);
  return compactPoints([a, from, { ...from, [axis]: coordinate }, { ...to, [axis]: coordinate }, to, b]);
}

function exitsOnSide(port: Point, side: Side, next: Point) {
  return axisOf(side) === 'x' ? next.y === port.y && (next.x - port.x) * signOf(side) > 0
    : next.x === port.x && (next.y - port.y) * signOf(side) > 0;
}

function hasProperEnds(points: Point[], start: Side, end: Side) {
  if (points.length < 2 || !exitsOnSide(points[0], start, points[1]) || !exitsOnSide(points.at(-1)!, end, points.at(-2)!)) return false;
  // Collinear reversals would draw back over a segment of the same line.
  return !points.some((point, i) => i > 1 && ((point.x === points[i - 1].x && point.x === points[i - 2].x)
    || (point.y === points[i - 1].y && point.y === points[i - 2].y)));
}

function directPoints(a: Point, start: Side, b: Point, end: Side) {
  const axis = axisOf(start);
  if (axis !== axisOf(end)) {
    return compactPoints([a, axis === 'x' ? { x: b.x, y: a.y } : { x: a.x, y: b.y }, b]);
  }
  const coordinate = start === end
    ? signOf(start) < 0 ? Math.min(a[axis], b[axis]) - stub : Math.max(a[axis], b[axis]) + stub
    : (a[axis] + b[axis]) / 2;
  return lanePoints(a, start, b, end, { axis, coordinate });
}

function curveControls(a: Point, start: Side, b: Point, end: Side) {
  const first = axisOf(start), last = axisOf(end);
  const depart = (b[first] - a[first]) * signOf(start);
  const approach = (a[last] - b[last]) * signOf(end);
  if (depart < 6 || approach < 6 || a.x === b.x || a.y === b.y) return;
  return [move(a, start, Math.min(100, depart * .49)), move(b, end, Math.min(100, approach * .49))] as const;
}

function sampleCurve(a: Point, c: Point, d: Point, b: Point) {
  return Array.from({ length: 15 }, (_, i) => {
    const t = i / 14, u = 1 - t;
    return { x: u ** 3 * a.x + 3 * u * u * t * c.x + 3 * u * t * t * d.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * c.y + 3 * u * t * t * d.y + t ** 3 * b.y };
  });
}

function segmentHits(a: Point, b: Point, box: Box, padding: number) {
  const left = box.x - padding, right = box.x + box.width + padding;
  const top = box.y - padding, bottom = box.y + box.height + padding;
  if (Math.max(a.x, b.x) < left || Math.min(a.x, b.x) > right || Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) return false;
  // Clip the segment against the four sides of the card.
  const dx = b.x - a.x, dy = b.y - a.y;
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, a.x - left], [dx, right - a.x], [-dy, a.y - top], [dy, bottom - a.y]]) {
    if (!p) { if (q < 0) return false; continue; }
    if (p < 0) lo = Math.max(lo, q / p);
    else hi = Math.min(hi, q / p);
    if (lo > hi) return false;
  }
  return true;
}

function bounds(points: Point[]) {
  return {
    left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
    top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)),
  };
}

function segment(a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return { ...bounds([a, b]), a, b, length, ux: dx / length, uy: dy / length };
}

function trace(points: Point[]) {
  const legs = points.slice(1).map((point, index) => segment(points[index], point));
  const length = legs.reduce((sum, leg) => sum + leg.length, 0);
  let walked = 0;
  // Edges may briefly converge at the same port. Only reserve the interior.
  const segments = legs.flatMap(leg => {
    const start = Math.max(0, stub - walked), end = Math.min(leg.length, length - stub - walked);
    walked += leg.length;
    if (end <= start) return [];
    const at = (d: number) => ({ x: leg.a.x + leg.ux * d, y: leg.a.y + leg.uy * d });
    return [segment(at(start), at(end))];
  });
  return { ...bounds(points), segments };
}

type Trace = ReturnType<typeof trace>;
type Segment = Trace['segments'][number];
type PlannedRoute = { route: EdgeRoute; trace: Trace; start: Side; end: Side };

function nearby(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) {
  return a.left < b.right + laneGap && a.right > b.left - laneGap
    && a.top < b.bottom + laneGap && a.bottom > b.top - laneGap;
}

function parallelSpan(a: Segment, b: Segment) {
  if (Math.abs(a.ux * b.uy - a.uy * b.ux) > .15 || !nearby(a, b)) return 0;
  const along = (p: Point) => (p.x - a.a.x) * a.ux + (p.y - a.a.y) * a.uy;
  const across = (p: Point) => -(p.x - a.a.x) * a.uy + (p.y - a.a.y) * a.ux;
  const start = along(b.a), finish = along(b.b);
  let lo = Math.max(0, Math.min(start, finish)), hi = Math.min(a.length, Math.max(start, finish));
  if (hi <= lo) return 0;
  const gap = across(b.a), slope = (across(b.b) - gap) / (finish - start);
  if (Math.abs(slope) < 1e-6) return Math.abs(gap) < laneGap ? hi - lo : 0;
  const enter = start + (-laneGap - gap) / slope, exit = start + (laneGap - gap) / slope;
  lo = Math.max(lo, Math.min(enter, exit));
  hi = Math.min(hi, Math.max(enter, exit));
  return Math.max(0, hi - lo);
}

function sharedDistance(candidate: Trace, reserved: Trace[]) {
  let total = 0;
  for (const prior of reserved) {
    if (!nearby(candidate, prior)) continue;
    let shared = 0;
    for (const a of candidate.segments) for (const b of prior.segments) shared += parallelSpan(a, b);
    if (shared >= minimumSharedSpan) total += shared;
  }
  return total;
}

export function routeEdges(edges: MemoryEdge[], nodes: MemoryNode[]) {
  const boxes = new Map(nodes.map(node => [node.id, { ...nodeBounds(node), object: node.data.kind === 'object' }]));
  const routes = new Map<string, EdgeRoute>();
  const ports = new Map<string, Set<string>>();
  const obstacles = [...boxes.values()];
  const reserved: Trace[] = [];
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  const links: RoutedLink[] = [];
  for (const { source, target } of edges) {
    if (!boxes.has(source) || !boxes.has(target)) continue;
    outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const mark = (node: string, id: string) => {
    const visible = ports.get(node) ?? new Set<string>();
    visible.add(id);
    ports.set(node, visible);
  };
  for (const edge of edges) {
    const source = boxes.get(edge.source), target = boxes.get(edge.target);
    if (!source || !target) continue;
    const fan = (outgoing.get(edge.source) ?? 0) > 1 || (incoming.get(edge.target) ?? 0) > 1;
    const draft = routeEdge(edge, source, target, obstacles, reserved, fan);
    reserved.push(draft.trace);
    links.push({ edge, source, target, fan, draft });
  }

  const { departures, arrivals, connectionPorts } = splitPorts(links);
  reserved.length = 0;
  let replan = false;
  for (const { edge, source, target, fan, draft } of links) {
    const departure = departures.get(edge.id), arrival = arrivals.get(edge.id);
    replan ||= Boolean(departure || arrival);
    // Keep each planned side so no rerouted edge can join a port after slots have been assigned.
    const { route, trace } = replan ? routeEdge(edge, source, target, obstacles, reserved, fan,
      { start: draft.start, end: draft.end, departure, arrival }) : draft;
    routes.set(edge.id, route);
    reserved.push(trace);
    if (edge.data?.kind === 'reference') {
      mark(edge.source, route.sourceHandle);
      mark(edge.target, route.targetHandle);
    }
  }
  return { routes, ports, connectionPorts };
}

function routeEdge(edge: MemoryEdge, source: Box, target: Box, obstacles: Box[], reserved: Trace[], fan: boolean,
  fixed?: FixedPorts): PlannedRoute {
  const row = edge.data?.fieldIndex;
  const reference = edge.data?.kind === 'reference';
  const candidates = (fixed ? [fixed.start] : reference ? fieldSides : sides).flatMap(start => (fixed ? [fixed.end] : sides).map(end => {
    const a = port(source, start, row), b = port(target, end, undefined, true);
    if (fixed?.departure) a[acrossOf(start)] += fixed.departure.offset;
    if (fixed?.arrival) b[acrossOf(end)] += fixed.arrival.offset;
    const points = directPoints(a, start, b, end);
    const sourceHandle = row == null ? `out-${start}` : `field-${row}-${start}`;
    const targetHandle = `in-${end}`;
    const route = { sourceHandle: fixed?.departure?.id ?? sourceHandle, targetHandle: fixed?.arrival?.id ?? targetHandle };
    const portPreference = reference ? 0 : Number(sourceHandle !== edge.sourceHandle) * 8 + Number(targetHandle !== edge.targetHandle) * 8;
    const score = pathCost(points) + portPreference;
    return { start, end, a, b, points, score, portPreference, route };
  })).sort((a, b) => a.score - b.score);

  const clearance = (box: Box) => box === source || box === target ? -2 : 5;
  const isClear = (points: Point[]) => {
    const { left, right, top, bottom } = bounds(points);
    return !obstacles.some(box => {
      const padding = clearance(box);
      return box.x - padding <= right && box.x + box.width + padding >= left
        && box.y - padding <= bottom && box.y + box.height + padding >= top
        && points.some((point, i) => i > 0 && segmentHits(points[i - 1], point, box, padding));
    });
  };
  const findCurve = () => {
    let bestCurve: (PlannedRoute & { score: number }) | undefined;
    for (const { a, b, start, end, portPreference, route } of candidates) {
      const controls = curveControls(a, start, b, end);
      if (!controls) continue;
      const points = sampleCurve(a, ...controls, b);
      if (!isClear(points)) continue;
      const shape = trace(points);
      const shared = sharedDistance(shape, reserved);
      if (shared > 26) continue;
      const length = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
      const score = length + portPreference + shared * 6 + (axisOf(start) === axisOf(end) ? 0 : 24);
      if (!bestCurve || score < bestCurve.score) bestCurve = { score, route: { ...route, curved: true }, trace: shape, start, end };
    }
    return bestCurve;
  };
  if (fan) {
    const { points, route, start, end } = candidates[0];
    if (points.length === 2 && hasProperEnds(points, start, end) && isClear(points)) {
      const shape = trace(points);
      if (!sharedDistance(shape, reserved)) return { route, trace: shape, start, end };
    }
    const curve = findCurve();
    if (curve) return curve;
  }
  const minDistance = Math.min(...candidates.map(({ a, b, portPreference }) => distance(a, b) + portPreference));
  let best: (PlannedRoute & { score: number }) | undefined;
  for (const { points, start, end, score, route } of candidates) {
    if (best && score >= best.score) break;
    if (!hasProperEnds(points, start, end) || !isClear(points)) continue;
    const shape = trace(points);
    const shared = sharedDistance(shape, reserved);
    if (!best && !shared && score <= minDistance + 32) return { route, trace: shape, start, end };
    const total = score + shared * 6;
    if (!best || total < best.score) best = { score: total, route, trace: shape, start, end };
  }

  // Try nearby horizontal and vertical aisles when a simple path is blocked.
  const spread = (lanes: number[]) => [...new Set(reserved.length
    ? lanes.flatMap(lane => [lane, lane + laneGap + 1, lane - laneGap - 1]) : lanes)];
  const aisles = {
    x: obstacles.flatMap(box => [box.x - 20, box.x + box.width + 20]),
    y: obstacles.flatMap(box => [box.y - 20, box.y + box.height + 20]),
  };
  let fallback: (PlannedRoute & { score: number }) | undefined;
  for (const { a, b, start, end, portPreference, route } of candidates) {
    if (best && distance(a, b) + portPreference >= best.score) continue;
    const s = move(a, start, stub), t = move(b, end, stub);
    const options = (['x', 'y'] as const).flatMap(axis => {
      const midpoint = (s[axis] + t[axis]) / 2;
      const near = [...new Set(aisles[axis])].sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint)).slice(0, 8);
      return spread([midpoint, s[axis], t[axis], ...near]).map(coordinate => ({ axis, coordinate }));
    });
    for (const lane of options) {
      const points = lanePoints(a, start, b, end, lane);
      if (!hasProperEnds(points, start, end)) continue;
      const score = pathCost(points) + portPreference + 4;
      if (best && score >= best.score) continue;
      if (!isClear(points)) {
        if (!fallback || score < fallback.score) fallback = { score, route: { ...route, lane }, trace: trace(points), start, end };
        continue;
      }
      const shape = trace(points);
      const total = score + sharedDistance(shape, reserved) * 6;
      if (!best || total < best.score) best = { score: total, route: { ...route, lane }, trace: shape, start, end };
    }
  }
  // A solitary edge can curve too if it avoids a substantial detour or overlap.
  const curve = fan ? undefined : findCurve();
  if (curve && (!best || curve.score + portGap < best.score)) return curve;
  if (best || fallback) return best ?? fallback!;
  const { points, route, start, end } = candidates[0];
  return { route, trace: trace(points), start, end };
}

function pathCost(points: Point[]) {
  return points.slice(1).reduce((length, point, i) => length + distance(points[i], point), Math.max(0, points.length - 2) * 10);
}

export function routedPath(a: Point, start: Side, b: Point, end: Side, lane?: EdgeLane, curved?: boolean) {
  const coords = (p: Point) => `${p.x},${p.y}`;
  const controls = curved && curveControls(a, start, b, end);
  if (controls) return `M ${coords(a)} C ${coords(controls[0])} ${coords(controls[1])} ${coords(b)}`;
  const points = lane ? lanePoints(a, start, b, end, lane) : directPoints(a, start, b, end);
  return points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${coords(point)}`).join(' ');
}
