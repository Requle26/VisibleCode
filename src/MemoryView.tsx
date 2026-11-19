import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Braces, Box, Focus, GitFork, Layers, Minus, Moon, Network, PanelLeftClose, PanelLeftOpen, Plus, Sun } from 'lucide-react';
import {
  Background, BackgroundVariant, BaseEdge, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, SelectionMode, ViewportPortal,
  useNodesInitialized, useReactFlow, useUpdateNodeInternals, type EdgeProps, type NodeChange, type NodeProps, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { buildMemoryGraph, objectNodeId, type GraphField, type MemoryEdge, type MemoryNode, type SnapGlowArea } from './memoryGraph';
import { EdgeLabels } from './EdgeLabels';
import { nodeBounds, nodeSnapPixels, settleNodePositions, snapNodeDrag, type AlignmentGuide, type PortAlignment } from './nodePlacement';
import { routeEdges, routedPath } from './edgeRouting';
import type { Language } from './languages';
import type { Snapshot } from './trace';
import type { Theme } from './theme';

const icons = { frame: Braces, local: Braces, class: Layers, object: Box };
const MemoryLanguage = createContext<Language>('java');
const objectIdHint = (id: string) => `객체 ID ${id} (실제 메모리 주소 아님)`;
const regions = {
  frame: { label: '스택', description: '메서드가 실행되는 동안 만들어지는 스택 프레임' },
  local: { label: '스택', description: '기본형은 값 자체를, 참조형은 객체를 가리키는 값을 담는 지역 변수' },
  class: { label: '클래스 영역', description: '클래스 정의와 static 필드를 모아 보여주는 학습용 영역' },
  abstract: { label: '추상 클래스', description: '직접 객체를 만들 수 없으며 자식 클래스가 이어받는 타입' },
  interface: { label: '인터페이스', description: '구현하는 타입이 따르는 계약' },
  object: { label: '힙', description: '객체와 배열이 저장되는 메모리 영역' },
  module: { label: '전역 딕셔너리', description: '모듈의 전역 딕셔너리에 이름과 객체 참조가 저장돼요.' },
  moduleFrame: { label: '모듈 전역 딕셔너리', description: '모듈의 전역 이름을 객체와 연결하는 딕셔너리예요.' },
  globals: { label: '힙 · 모듈 전역 딕셔너리', description: 'globals()가 반환하는 딕셔너리예요. 화면에는 사용자가 만든 전역 이름을 표시해요.' },
  pythonFrame: { label: '호출 스택', description: '함수가 실행되는 동안의 프레임이에요. 파이썬의 호출 관계를 보여줘요.' },
  pythonLocal: { label: '스택 프레임', description: '함수의 실행 프레임에 지역 이름의 객체 참조가 있어요. 물리적인 스택 주소를 나타내지는 않아요.' },
  pythonObject: { label: '힙 객체', description: '이름이 가리키는 파이썬 객체예요. 카드의 ID는 같은 객체인지 구별하는 표시예요.' },
  classBody: { label: '클래스 본문', description: 'Python 클래스가 정의되는 동안 사용하는 이름 공간' },
};
const layoutFit = { padding: 0.15, minZoom: 0.15, maxZoom: 1.12 };
const rightMouseButton = [2];
const oppositePort = { [Position.Left]: Position.Right, [Position.Right]: Position.Left, [Position.Top]: Position.Bottom, [Position.Bottom]: Position.Top };
const portPosition = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
const edgeColors = {
  light: { reference: '#8c72d4', active: '#6544cf', neutral: '#9ba9bd', hierarchy: '#168778' },
  dark: { reference: '#ad94e6', active: '#d8c5ff', neutral: '#7f90b0', hierarchy: '#71cbb8' },
};
type NodeOverride = Pick<MemoryNode, 'measured' | 'selected' | 'dragging'> & Partial<Pick<MemoryNode, 'position'>>;
type Placement = {
  overrides: Map<string, NodeOverride>;
  activeSnap: string | null;
  pulse?: { areas: Record<string, SnapGlowArea>; version: number };
  guides?: AlignmentGuide[];
};

function applyNodeOverrides(nodes: MemoryNode[], overrides: Map<string, NodeOverride>) {
  return nodes.map(node => {
    const override = overrides.get(node.id);
    return override ? { ...node, ...override, position: override.position ?? node.position } : node;
  });
}

function positionNodes(nodes: MemoryNode[], overrides: Map<string, NodeOverride>) {
  const measured = nodes.map(node => {
    const dimensions = overrides.get(node.id)?.measured;
    return dimensions ? { ...node, measured: dimensions } : node;
  });
  return applyNodeOverrides(settleNodePositions(measured), overrides);
}

function Value({ field, choose }: { field: GraphField; choose?: (id: string) => void }) {
  const python = useContext(MemoryLanguage) === 'python';
  const { item: { value, name }, changed } = field;
  const className = `node-value ${value.kind}${changed ? ' changed' : ''}`;
  return value.ref && choose
    ? <button className={`${className} nodrag`} type="button" aria-label={`${name}: 객체${python ? ' ID' : ''} @${value.ref} 참조`}
      title={python ? objectIdHint(`@${value.ref}`) : undefined}
      onClick={event => { event.stopPropagation(); choose(objectNodeId(value.ref!)); }}>{value.display}</button>
    : <span className={className} title={value.display}>{value.display}</span>;
}

function MemoryCard({ id, data }: NodeProps<MemoryNode>) {
  const python = useContext(MemoryLanguage) === 'python';
  const updateNodeInternals = useUpdateNodeInternals();
  const portLayout = JSON.stringify(data.connectionPorts);
  const previousLayout = useRef(portLayout);
  useLayoutEffect(() => {
    if (previousLayout.current !== portLayout) {
      previousLayout.current = portLayout;
      updateNodeInternals(id);
    }
  }, [id, portLayout, updateNodeInternals]);
  const Icon = data.typeKind === 'interface' ? Network : icons[data.kind];
  const kind = data.kind;
  const region = regions[data.moduleGlobals ? 'globals' : data.scope === 'module' ? (kind === 'frame' ? 'moduleFrame' : 'module')
    : data.scope === 'class' ? 'classBody' : python && kind === 'frame' ? 'pythonFrame'
      : python && kind === 'local' ? 'pythonLocal' : python && kind === 'object' ? 'pythonObject' : data.typeKind ?? kind];
  const port = (handle: string) => data.referencePorts?.has(handle) ? 'port' : '';
  return <div className={`graph-node ${data.kind}${data.moduleGlobals ? ' module-globals' : ''}${data.typeKind ? ` type-${data.typeKind}` : ''}${data.focused ? ' focused' : ''}${data.linked ? ' linked' : ''}${data.subdued ? ' subdued' : ''}${data.active ? ' active' : ''}${data.orphaned ? ' orphaned' : ''}${data.leaving ? ' leaving' : ''}`}
    inert={data.leaving} aria-hidden={data.leaving || undefined}>
    <Handle type="target" id="in-left" position={Position.Left} isConnectable={false} className={port('in-left')} />
    <Handle type="target" id="in-right" position={Position.Right} isConnectable={false} className={port('in-right')} />
    <Handle type="target" id="in-top" position={Position.Top} isConnectable={false} className={port('in-top')} />
    <Handle type="target" id="in-bottom" position={Position.Bottom} isConnectable={false} className={port('in-bottom')} />
    <Handle type="source" id="out-top" position={Position.Top} isConnectable={false} />
    <Handle type="source" id="out-bottom" position={Position.Bottom} isConnectable={false} />
    <Handle type="source" id="out-right" position={Position.Right} isConnectable={false} className={port('out-right')} />
    <Handle type="source" id="out-left" position={Position.Left} isConnectable={false} className={port('out-left')} />
    {data.connectionPorts?.map(({ id, side, type, offset }) => {
      const horizontal = side === 'left' || side === 'right';
      const center = horizontal && type === 'target' ? 'var(--arrival-y, 50%)' : '50%';
      return <Handle key={id} type={type} id={id} position={portPosition[side]} isConnectable={false} className={port(id)}
        style={{ [horizontal ? 'top' : 'left']: `calc(${center} + ${offset}px)` }} />;
    })}
    <div className="node-header">
      {data.kind !== 'local' && <Icon size={15} strokeWidth={1.8} className="node-icon" aria-hidden="true" />}
      <span className="node-heading">
        <span className="node-meta">
          <span className="node-region" title={region.description}>{region.label}</span>
          {data.kind !== 'object' && data.note && <small title={data.note}>{data.note}</small>}
        </span>
        <button type="button" className="node-title" title={data.title} aria-pressed={Boolean(data.focused)} onClick={event => { event.stopPropagation(); data.choose?.(id); }}>{data.title}</button>
      </span>
      {data.active && <span className="active-dot" title="현재 프레임" />}
      {data.badge && <span className="node-badge" title={python ? objectIdHint(data.badge) : undefined}>{python ? `ID ${data.badge}` : data.badge}</span>}
      {data.value && <Value field={data.value} />}
    </div>
    {data.fields?.map((field, index) => <div className="node-field" key={`${field.item.name}-${index}`}>
      <span title={field.item.name}>{data.moduleGlobals ? JSON.stringify(field.item.name) : field.item.name}</span><Value field={field} choose={data.choose} />
      <Handle type="source" id={`field-${index}-right`} position={Position.Right} isConnectable={false} className={port(`field-${index}-right`)} />
      <Handle type="source" id={`field-${index}-left`} position={Position.Left} isConnectable={false} className={port(`field-${index}-left`)} />
    </div>)}
    {data.text && <div className="node-text" title={data.text}>{data.text}</div>}
    {data.kind === 'object' && data.note && <div className="node-note">{data.note}</div>}
    {data.snapGlow && !data.leaving && <span key={data.snapGlow.version} className="node-snap-area" data-side={data.snapGlow.side} aria-hidden="true"
      style={{ '--snap-from': `${data.snapGlow.from + 2}px`, '--snap-to': `${data.snapGlow.to + 2}px` } as React.CSSProperties}>
      <span className={`node-snap-glow${data.snapGlow.active ? ' is-snapped' : ''}`} />
    </span>}
  </div>;
}

const nodeTypes = { memory: MemoryCard };
function RoutedEdge(props: EdgeProps<MemoryEdge>) {
  const path = routedPath({ x: props.sourceX, y: props.sourceY }, props.sourcePosition,
    { x: props.targetX, y: props.targetY }, props.targetPosition, props.data?.lane, props.data?.curved);
  if (props.data?.kind !== 'reference') {
    return <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} interactionWidth={props.interactionWidth} />;
  }
  return <>
    <BaseEdge id={props.id} path={path} pathLength={1} style={props.style} interactionWidth={props.interactionWidth} />
    <path className="reference-tip" d={path} fill="none" stroke="transparent" strokeWidth={props.style?.strokeWidth} markerEnd={props.markerEnd} pointerEvents="none" />
  </>;
}
const edgeTypes = { routed: RoutedEdge };

function useLeavingNodes(snapshot: Snapshot | undefined, nodes: MemoryNode[]) {
  const previous = useRef<{ snapshot?: Snapshot; nodes: MemoryNode[] }>({ nodes: [] });
  const [leaving, setLeaving] = useState<MemoryNode[]>([]);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { snapshot, nodes };
    if (last.snapshot === snapshot) return;
    if (!snapshot || !last.snapshot || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLeaving(current => current.length ? [] : current);
      return;
    }
    const keep = new Set(nodes.map(node => node.id));
    setLeaving(last.nodes.filter(node => !keep.has(node.id)).map(node => ({
      ...node, selectable: false, selected: false, dragging: false, draggable: false, focusable: false,
      style: { ...node.style, pointerEvents: 'none' },
      data: { ...node.data, leaving: true, choose: undefined, focused: false },
    })));
  }, [snapshot, nodes]);

  useEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), 165);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return useMemo(() => {
    if (!snapshot || !leaving.length) return nodes;
    const visible = new Set(nodes.map(node => node.id));
    return [...nodes, ...leaving.filter(node => !visible.has(node.id))];
  }, [nodes, leaving, snapshot]);
}

function Graph({ snapshot, previous, focus, setFocus, onNodeNavigate, placeholder, theme, toggleTheme, editorHidden, toggleEditor }: {
  snapshot?: Snapshot; previous?: Snapshot; focus: string | null; setFocus: (id: string | null) => void; placeholder: string;
  onNodeNavigate: (id: string) => void;
  theme: Theme; toggleTheme: () => void;
  editorHidden: boolean; toggleEditor: () => void;
}) {
  const [compact, setCompact] = useState(false);
  const graph = useMemo(() => buildMemoryGraph(snapshot, previous, compact), [snapshot, previous, compact]);
  const [{ overrides, activeSnap, pulse, guides }, setPlacement] = useState<Placement>(() => ({ overrides: new Map(), activeSnap: null }));
  const [panningFromNode, setPanningFromNode] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const panFromNode = useRef<{ pointerId: number; x: number; y: number; viewport: Viewport } | null>(null);
  const follow = useRef(true);
  const lastFit = useRef('');
  const previousEditorHidden = useRef(editorHidden);
  const { fitView, zoomIn, zoomOut, getNodes, getInternalNode, getNodesBounds, getViewport, setViewport } = useReactFlow<MemoryNode, MemoryEdge>();
  const initialized = useNodesInitialized();
  useLayoutEffect(() => {
    if (!canvas.current) return;
    const element = canvas.current;
    const sizeLayout = () => setCompact(element.clientWidth < 560);
    sizeLayout();
    const observer = new ResizeObserver(sizeLayout);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const choose = useCallback((id: string) => {
    setFocus(focus === id ? null : id);
    onNodeNavigate(id);
  }, [focus, setFocus, onNodeNavigate]);
  const activeFocus = graph.nodes.some(n => n.id === focus) ? focus : null;
  const referenceFocus = activeFocus && (graph.edges.find(e => e.source === activeFocus && e.data?.kind === 'reference' && activeFocus.startsWith('local:'))?.target ?? activeFocus);
  const { edges, linked } = useMemo(() => {
    const linked = new Set<string>();
    const colors = edgeColors[theme];
    const edges = graph.edges.map(edge => {
      const kind = edge.data!.kind;
      const highlight = Boolean(activeFocus && (edge.source === activeFocus || edge.target === activeFocus || (kind === 'reference' && edge.target === referenceFocus)));
      if (highlight) { linked.add(edge.source); linked.add(edge.target); }
      const hierarchy = kind === 'inheritance' || kind === 'implementation';
      const color = hierarchy ? colors.hierarchy : kind === 'reference' ? (highlight ? colors.active : colors.reference) : colors.neutral;
      return { ...edge, className: `graph-edge ${kind}${highlight ? ' highlight' : ''}${activeFocus && !highlight ? ' subdued' : ''}`,
        style: { stroke: color, strokeWidth: highlight ? 2.2 : kind === 'reference' || hierarchy ? 1.65 : 1.2 },
        markerEnd: hierarchy ? { type: MarkerType.Arrow, color, width: 17, height: 17 }
          : kind === 'reference' || kind === 'call' ? { type: MarkerType.ArrowClosed, color, width: 15, height: 15 } : undefined };
    });
    return { edges, linked };
  }, [graph.edges, activeFocus, referenceFocus, theme]);
  const geometry = useMemo(() => positionNodes(graph.nodes, overrides),
    [graph.nodes, overrides]);
  const routing = useMemo(() => routeEdges(graph.edges, geometry), [graph.edges, geometry]);
  const paths = useMemo(() => edges.map(edge => {
    const route = routing.routes.get(edge.id);
    return { ...edge, label: undefined, selectable: false, sourceHandle: route?.sourceHandle ?? edge.sourceHandle,
      targetHandle: route?.targetHandle ?? edge.targetHandle, data: edge.data && { ...edge.data, lane: route?.lane, curved: route?.curved } };
  }), [edges, routing]);
  const nodes = useMemo(() => geometry.map(node => {
    const focused = activeFocus === node.id;
    const connected = linked.has(node.id);
    const area = pulse?.areas[node.id];
    return { ...node, data: { ...node.data, choose, focused, linked: connected,
      subdued: activeFocus !== null && !focused && !connected, referencePorts: routing.ports.get(node.id), connectionPorts: routing.connectionPorts.get(node.id),
      snapGlow: area && pulse ? { ...area, version: pulse.version, active: Boolean(activeSnap) } : undefined } };
  }), [geometry, choose, activeFocus, linked, routing, pulse, activeSnap]);
  const displayedNodes = useLeavingNodes(snapshot, nodes);

  useEffect(() => {
    if (!pulse || activeSnap) return;
    const timer = window.setTimeout(() => {
      setPlacement(current => current.pulse === pulse && !current.activeSnap ? { ...current, pulse: undefined } : current);
    }, 380);
    return () => window.clearTimeout(timer);
  }, [pulse, activeSnap]);

  const onNodesChange = useCallback((changes: NodeChange<MemoryNode>[]) => {
    const moves = changes.flatMap(change => change.type === 'position' && change.position
      ? [{ id: change.id, position: change.position, dragging: change.dragging }] : []);
    const snapDistance = moves.length ? nodeSnapPixels / (getViewport().zoom || 1) : 0;
    const dragging = moves.some(move => move.dragging);
    const showSnapPulse = dragging && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const movingIds = new Set(moves.map(move => move.id));
    const connections: (Omit<PortAlignment, 'movingIndex' | 'fixedIndex'> & { moving: string; fixed: string })[] = [];
    if (moves.length) for (const edge of graph.edges) {
      const fromMoves = movingIds.has(edge.source);
      if (fromMoves === movingIds.has(edge.target)) continue;
      const route = routing.routes.get(edge.id);
      if (!route) continue;
      const from = getInternalNode(edge.source)?.internals.handleBounds?.source?.find(port => port.id === route.sourceHandle);
      const to = getInternalNode(edge.target)?.internals.handleBounds?.target?.find(port => port.id === route.targetHandle);
      if (!from || !to || oppositePort[from.position] !== to.position) continue;
      const moving = fromMoves ? from : to, fixed = fromMoves ? to : from;
      const vertical = moving.position === Position.Top || moving.position === Position.Bottom;
      connections.push({
        moving: fromMoves ? edge.source : edge.target, fixed: fromMoves ? edge.target : edge.source,
        axis: vertical ? 'x' : 'y', direction: moving.position === Position.Right || moving.position === Position.Bottom ? 1 : -1,
        movingPort: vertical ? moving.x + moving.width / 2 : moving.y + moving.height / 2,
        fixedPort: vertical ? fixed.x + fixed.width / 2 : fixed.y + fixed.height / 2,
      });
    }
    setPlacement(current => {
      const existing = current.overrides;
      let next = existing;
      const update = (id: string, patch: NodeOverride) => {
        if (next === existing) next = new Map(existing);
        next.set(id, { ...next.get(id), ...patch });
      };
      for (const change of changes) {
        if (change.type !== 'select' && change.type !== 'dimensions') continue;
        const before = next.get(change.id);
        if (change.type === 'select' && Boolean(before?.selected) !== change.selected) update(change.id, { selected: change.selected });
        if (change.type === 'dimensions' && change.dimensions && (before?.measured?.width !== change.dimensions.width || before?.measured?.height !== change.dimensions.height)) {
          update(change.id, { measured: change.dimensions });
        }
      }
      if (!moves.length) return next === existing ? current : { ...current, overrides: next };

      const scene = positionNodes(graph.nodes, next);
      const byId = new Map(scene.map(node => [node.id, node]));
      const valid = moves.flatMap(move => {
        const node = byId.get(move.id);
        return node ? [{ ...move, node }] : [];
      });
      if (!valid.length) return { ...current, overrides: next, activeSnap: null, guides: undefined };
      const moving = new Set(valid.map(move => move.id));
      const fixed = scene.filter(node => !moving.has(node.id));
      const movingIndices = new Map(valid.map(({ id }, i) => [id, i]));
      const fixedIndices = new Map(fixed.map(({ id }, i) => [id, i]));
      const portGuides = connections.flatMap(({ moving, fixed, ...alignment }) => {
        const movingIndex = movingIndices.get(moving), fixedIndex = fixedIndices.get(fixed);
        return movingIndex === undefined || fixedIndex === undefined ? [] : [{ ...alignment, movingIndex, fixedIndex }];
      });
      const anchor = valid[0];
      const { offset, contact, guides } = snapNodeDrag(valid.map(move => nodeBounds(move.node)), fixed.map(nodeBounds), {
        x: anchor.position.x - anchor.node.position.x,
        y: anchor.position.y - anchor.node.position.y,
      }, snapDistance, portGuides);

      for (const move of valid) update(move.id, { dragging: move.dragging,
        position: { x: move.node.position.x + offset.x, y: move.node.position.y + offset.y } });
      let activeSnap = null;
      let pulse = current.pulse;
      if (showSnapPulse && contact) {
        const moved = valid[contact.movingIndex].node;
        const stationary = fixed[contact.fixedIndex];
        const { axis, coordinate, from, to } = contact;
        const across = axis === 'x' ? 'y' : 'x';
        const area = (node: MemoryNode, dragged: boolean): SnapGlowArea => {
          const box = nodeBounds(node);
          const middle = box[axis] + (axis === 'x' ? box.width : box.height) / 2 + (dragged ? offset[axis] : 0);
          const origin = box[across] + (dragged ? offset[across] : 0);
          const side = axis === 'x' ? (coordinate < middle ? 'left' : 'right') : (coordinate < middle ? 'top' : 'bottom');
          return { side, from: from - origin, to: to - origin };
        };
        activeSnap = JSON.stringify([moved.id, stationary.id, axis, coordinate]);
        pulse = {
          areas: { [moved.id]: area(moved, true), [stationary.id]: area(stationary, false) },
          version: activeSnap === current.activeSnap && pulse ? pulse.version : (pulse?.version ?? 0) + 1,
        };
      }
      return { overrides: next, activeSnap, pulse, guides: dragging ? guides : undefined };
    });
  }, [graph.nodes, graph.edges, routing, getInternalNode, getViewport]);

  const fitIfNeeded = useCallback(() => {
    if (!canvas.current || !follow.current) return;
    const visible = getNodes().filter(node => !node.data.leaving);
    if (!visible.length) return;
    const { clientWidth, clientHeight } = canvas.current;
    if (!clientWidth || !clientHeight) return;
    const bounds = getNodesBounds(visible);
    const { x, y, zoom } = getViewport();
    const clipped = bounds.x * zoom + x < 20 || bounds.y * zoom + y < 20
      || (bounds.x + bounds.width) * zoom + x > clientWidth - 20 || (bounds.y + bounds.height) * zoom + y > clientHeight - 20;
    if (!lastFit.current || clipped) void fitView({ ...layoutFit, nodes: visible.map(({ id }) => ({ id })) });
    lastFit.current = graph.signature;
  }, [fitView, getNodes, getNodesBounds, getViewport, graph.signature]);

  useEffect(() => {
    if (!initialized || !graph.signature) return;
    const id = requestAnimationFrame(fitIfNeeded);
    const observer = new ResizeObserver(fitIfNeeded);
    if (canvas.current) observer.observe(canvas.current);
    return () => { cancelAnimationFrame(id); observer.disconnect(); };
  }, [initialized, graph.signature, fitIfNeeded]);

  useEffect(() => {
    if (previousEditorHidden.current === editorHidden) return;
    previousEditorHidden.current = editorHidden;
    lastFit.current = '';
    const id = requestAnimationFrame(fitIfNeeded);
    return () => cancelAnimationFrame(id);
  }, [editorHidden, fitIfNeeded]);

  const center = () => {
    setPlacement(({ overrides }) => ({ overrides: new Map([...overrides].map(([id, value]) => [id, { measured: value.measured }])), activeSnap: null }));
    setFocus(null);
    follow.current = true;
    requestAnimationFrame(() => { void fitView({ ...layoutFit, duration: 180, nodes: nodes.map(({ id }) => ({ id })) }); });
  };

  // React Flow pans the background on right-drag. Its draggable nodes stop that
  // gesture at the node boundary, so handle a right-drag that starts on a node here.
  const startPanFromNode = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 2 || !(event.target instanceof Element) || !event.target.closest('.react-flow__node')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panFromNode.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, viewport: getViewport() };
    setPanningFromNode(true);
  };
  const stopPanFromNode = (event: PointerEvent<HTMLDivElement>) => {
    if (panFromNode.current?.pointerId !== event.pointerId) return;
    panFromNode.current = null;
    setPanningFromNode(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const movePanFromNode = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panFromNode.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (!(event.buttons & 2)) return stopPanFromNode(event);
    const x = event.clientX - pan.x;
    const y = event.clientY - pan.y;
    if (x || y) follow.current = false;
    void setViewport({ x: pan.viewport.x + x, y: pan.viewport.y + y, zoom: pan.viewport.zoom });
  };
  const themeAction = theme === 'dark' ? '화이트 모드로 전환' : '다크 모드로 전환';
  const editorAction = editorHidden ? '코드 입력창 열기' : '코드 입력창 숨기기';

  return <div className={`map-canvas${panningFromNode ? ' panning' : ''}`} ref={canvas} aria-label="메모리 노드 캔버스"
    onContextMenu={event => event.preventDefault()} onPointerDownCapture={startPanFromNode} onPointerMove={movePanFromNode}
    onPointerUp={stopPanFromNode} onPointerCancel={stopPanFromNode} onLostPointerCapture={stopPanFromNode}>
    <ReactFlow<MemoryNode, MemoryEdge> colorMode={theme} nodes={displayedNodes} edges={paths} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
      onNodeClick={(_event, node) => choose(node.id)} onPaneClick={() => setFocus(null)}
      onSelectionStart={() => setFocus(null)} selectionOnDrag selectionMode={SelectionMode.Partial} selectionKeyCode={null}
      panOnDrag={rightMouseButton} panActivationKeyCode={null}
      onMoveStart={event => { if (event) follow.current = false; }}
      onNodeDragStart={() => { follow.current = false; }}
      nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} deleteKeyCode={null} zoomOnScroll={false} zoomActivationKeyCode={null}
      minZoom={0.15} maxZoom={2.5} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Lines} gap={24} lineWidth={1} color="var(--grid-line)" />
      <EdgeLabels canvas={canvas} edges={edges} />
      {nodes.length > 0 && guides?.length ? <ViewportPortal>
        <svg className="node-alignment-guides" width="1" height="1" aria-hidden="true">
          {guides.map(({ axis, coordinate, from, to }) => <line key={axis}
            x1={axis === 'x' ? coordinate : from} y1={axis === 'y' ? coordinate : from}
            x2={axis === 'x' ? coordinate : to} y2={axis === 'y' ? coordinate : to}
            vectorEffect="non-scaling-stroke" />)}
        </svg>
      </ViewportPortal> : null}
      <Panel position="bottom-right" className="map-tools">
        {!!nodes.length && <>
        <button className="icon-button" type="button" title="축소" aria-label="축소" onClick={() => { follow.current = false; void zoomOut({ duration: 130 }); }}><Minus size={16} /></button>
        <button className="icon-button" type="button" title="확대" aria-label="확대" onClick={() => { follow.current = false; void zoomIn({ duration: 130 }); }}><Plus size={16} /></button>
        <button className="icon-button" type="button" title="노드를 기본 배치로 되돌리고 전체 보기" aria-label="전체 보기" onClick={center}><Focus size={16} /></button>
        </>}
        <button className="icon-button theme-button" type="button" title={themeAction} aria-label={themeAction} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="icon-button" type="button" title={editorAction} aria-label={editorAction}
          aria-controls="code-panel" aria-expanded={!editorHidden} onClick={toggleEditor}>
          {editorHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </Panel>
    </ReactFlow>
    {!nodes.length && <div className="map-empty" role="status"><GitFork size={24} strokeWidth={1.6} /><p>{placeholder}</p></div>}
  </div>;
}

export function MemoryView({ language, ...props }: Parameters<typeof Graph>[0] & { language: Language }) {
  return <MemoryLanguage.Provider value={language}><ReactFlowProvider><Graph {...props} /></ReactFlowProvider></MemoryLanguage.Provider>;
}
