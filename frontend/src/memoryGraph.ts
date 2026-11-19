import type { Edge, Node } from '@xyflow/react';
import { valueChanged, type ClassInfo, type Frame, type Snapshot, type Variable } from './trace';

type Kind = 'frame' | 'local' | 'object' | 'class';
export type GraphField = { item: Variable; changed: boolean };
export type SnapGlowArea = { side: 'top' | 'right' | 'bottom' | 'left'; from: number; to: number };
export type ConnectionPort = { id: string; side: SnapGlowArea['side']; offset: number; type: 'source' | 'target' };
export type GraphData = {
  kind: Kind; title: string; value?: GraphField; fields?: GraphField[]; badge?: string; note?: string;
  declarations?: { text: string; group: 'field' | 'member'; abstract?: boolean }[];
  text?: string; active?: boolean; orphaned?: boolean; leaving?: boolean;
  scope?: Frame['scope']; moduleGlobals?: boolean;
  typeKind?: 'interface' | 'abstract';
  focused?: boolean; linked?: boolean; subdued?: boolean; choose?: (id: string) => void;
  referencePorts?: ReadonlySet<string>;
  connectionPorts?: ConnectionPort[];
  snapGlow?: SnapGlowArea & { version: number; active: boolean };
};
export type MemoryNode = Node<GraphData, 'memory'>;
export type EdgeLane = { axis: 'x' | 'y'; coordinate: number };
export type MemoryEdge = Edge<{ kind: 'branch' | 'call' | 'definition' | 'reference' | 'inheritance' | 'implementation'; fieldIndex?: number; lane?: EdgeLane; curved?: boolean }>;

export const objectNodeId = (id: string) => `object:${id}`;
const classKey = (clazz: ClassInfo) => clazz.id ?? clazz.name;
export const classNodeId = (clazz: ClassInfo) => `class:${classKey(clazz)}`;

export function hierarchyTypes(classes: ClassInfo[]) {
  const definitions = new Map(classes.map(type => [classKey(type), type]));
  for (const type of classes) for (const base of type.bases ?? []) {
    if (!definitions.has(base.id)) definitions.set(base.id, { ...base, fields: [], methods: [], external: true });
  }
  return [...definitions.values()];
}

const frameWidth = 148;
const localX = 232;
const localWidth = 144;
const heapStart = 482;
const heapGap = 258;
const heapWidth = 174;
const classWidth = 154;
const classGap = 46;
const rowGap = 64;

function typeRows(types: ClassInfo[], compact: boolean) {
  const byId = new Map(types.map(type => [classKey(type), type]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (visiting.has(id) || !byId.has(id)) return -1;
    const known = depths.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    const level = Math.max(0, ...(byId.get(id)?.bases ?? []).map(base => depth(base.id) + 1));
    visiting.delete(id);
    depths.set(id, level);
    return level;
  }
  const byDepth = new Map<number, ClassInfo[]>();
  for (const type of types) {
    const level = depth(classKey(type));
    const row = byDepth.get(level) ?? [];
    row.push(type);
    byDepth.set(level, row);
  }
  return [...byDepth.entries()].sort(([a], [b]) => a - b).flatMap(([, row]) =>
    compact ? Array.from({ length: Math.ceil(row.length / 2) }, (_, index) => row.slice(index * 2, index * 2 + 2)) : [row]);
}

function fieldsFor(fields: Variable[], prev?: Variable[]): GraphField[] {
  return fields.map(item => ({ item, changed: Boolean(prev && valueChanged(item, prev)) }));
}

function objectDepths({ frames, heap, classes }: Snapshot, globals?: Snapshot['heap'][number]) {
  const heapById = new Map(heap.map(object => [object.id, object]));
  const depths = new Map<string, number>();
  const references = (variables: Variable[]) => variables.flatMap(v => v.value.ref ? [v.value.ref] : []);
  const walk = (roots: string[]) => {
    const queue: string[] = [];
    const push = (id: string, depth: number) => {
      if (!depths.has(id) && heapById.has(id)) { depths.set(id, depth); queue.push(id); }
    };
    roots.forEach(id => push(id, 0));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      references(heapById.get(id)!.fields).forEach(ref => push(ref, depths.get(id)! + 1));
    }
  };
  if (globals) depths.set(globals.id, 0);
  walk([...frames.flatMap(f => globals && f.scope === 'module' ? [] : references(f.variables)),
    ...references(globals?.fields ?? []), ...classes.flatMap(c => references(c.fields))]);
  // Keep disconnected trees legible too, including formerly reachable objects at program exit.
  const targeted = new Set(heap.flatMap(o => references(o.fields)));
  walk(heap.filter(o => !targeted.has(o.id)).map(o => o.id));
  heap.forEach(o => walk([o.id]));
  return depths;
}

export function buildMemoryGraph(snapshot?: Snapshot, previous?: Snapshot, compact = false): { nodes: MemoryNode[]; edges: MemoryEdge[]; signature: string } {
  if (!snapshot) return { nodes: [], edges: [], signature: '' };
  const nodes: MemoryNode[] = [];
  const edges: MemoryEdge[] = [];
  const byId = new Map<string, MemoryNode>();
  const addNode = (id: string, x: number, y: number, width: number, data: GraphData) => {
    const node: MemoryNode = { id, type: 'memory', position: { x, y }, style: { width }, data, ariaLabel: data.title };
    byId.set(id, node); nodes.push(node);
    return node;
  };
  const addEdge = (source: string, target: string, sourceHandle: string, targetHandle: string, kind: NonNullable<MemoryEdge['data']>['kind'], fieldIndex?: number) => {
    const from = byId.get(source)?.data.title;
    const to = byId.get(target)?.data;
    const labels = { branch: to?.value?.item.role === 'receiver' ? '호출 대상' : to?.scope === 'module' ? '전역 이름' : to?.scope === 'class' ? '클래스 이름' : '지역 변수',
      call: to?.scope === 'class' ? '클래스 실행' : '호출', definition: to?.kind === 'object' ? '인스턴스' : '메서드 정의', reference: '참조',
      inheritance: '상속', implementation: '구현' };
    const label = labels[kind];
    const id = kind === 'reference' ? [source, fieldIndex ?? 'value', target, kind] : [source, sourceHandle, target, targetHandle, kind];
    edges.push({ id: JSON.stringify(id), source, target, sourceHandle, targetHandle,
      type: 'routed', label, ariaLabel: `${label}: ${from ?? source} → ${to?.title ?? target}`, data: { kind, fieldIndex } });
  };

  // Class definitions sit above the runtime graph; keep static-field rows there too.
  const types = hierarchyTypes(snapshot.classes);
  const structureOnly = snapshot.structureOnly;
  const definitionWidth = structureOnly ? 300 : classWidth;
  const gap = types.some(type => type.bases?.length) ? 44 : 22;
  let typeBottom = 0;
  const classRows = typeRows(types, compact).map(members => {
    const y = typeBottom;
    typeBottom += Math.max(...members.map(type => 57 + 26 * (type.fields.length
      + (structureOnly ? (type.declaredFields?.length ?? 0) + type.methods.length : 0)))) + gap;
    return { y, members };
  });
  const top = typeBottom ? typeBottom + (compact ? 23 : 50) : 22;
  const variableX = compact ? 212 : localX;
  const methodsByClass = new Map<string, MemoryNode>();
  const objectsByClass = new Map<string, MemoryNode[]>();
  const topObjectByLane = new Map<number, string>();
  const prevFrames = new Map(previous?.frames.map(f => [f.id, f]));
  const prevHeap = new Map(previous?.heap.map(o => [o.id, o]));
  const globals = snapshot.heap.find(o => o.id === snapshot.globalsRef);
  let nextY = top;
  let calleeId: string | undefined;
  snapshot.frames.forEach((frame, i) => {
    const module = globals && frame.scope === 'module';
    if (module && !calleeId) return;
    const variables = module ? [] : frame.variables;
    const id = `frame:${frame.id}`;
    const groupHeight = Math.max(1, variables.length) * rowGap;
    const before = prevFrames.get(frame.id);
    const frameNode = addNode(id, 0, nextY + (groupHeight - rowGap) / 2, frameWidth, {
      kind: 'frame', title: module ? '모듈 실행' : frame.name, note: frame.className, scope: module ? undefined : frame.scope, active: i === 0,
    });
    const key = frame.classId ?? frame.className;
    if (key && !methodsByClass.has(key)) methodsByClass.set(key, frameNode);
    if (calleeId) addEdge(id, calleeId, 'out-top', 'in-bottom', 'call');
    calleeId = id;
    variables.forEach((item, index) => {
      const variable = addNode(`local:${frame.id}:${item.name}`, variableX, nextY + index * rowGap, localWidth, {
        kind: 'local', title: item.name, note: item.type, scope: frame.scope, value: { item, changed: Boolean(before && valueChanged(item, before.variables)) },
      });
      addEdge(id, variable.id, 'out-right', 'in-left', 'branch');
    });
    nextY += groupHeight + (compact ? 32 : 64);
  });

  const globalsOnly = globals && !calleeId;
  if (globals) {
    const note = globals.truncated ? '일부 전역 이름만 표시' : !globals.fields.length ? '표시할 전역 이름 없음' : undefined;
    addNode(objectNodeId(globals.id), 0, nextY, heapWidth + 22, {
      kind: 'object', title: globals.type, moduleGlobals: true, badge: `@${globals.id}`,
      fields: fieldsFor(globals.fields, prevHeap.get(globals.id)?.fields), note,
    });
    if (compact) nextY += 41 + 26 * (globals.fields.length + Number(Boolean(note))) + 38;
  }
  const depths = objectDepths(snapshot, globals);
  const lanes = compact ? [nextY, nextY + 30] : [top + 28, top + 44, top + 44];
  for (const object of snapshot.heap) {
    if (object === globals) continue;
    const lane = Math.min(lanes.length - 1, depths.get(object.id) ?? 0);
    const before = prevHeap.get(object.id);
    const text = object.text == null ? undefined : object.kind === 'string' ? JSON.stringify(object.text) : object.text;
    const note = object.truncated ? `전체 ${object.length}개 · 일부 표시` : !object.reachable ? '표시된 참조 없음' : object.kind === 'array' && !object.fields.length ? '빈 컬렉션' : undefined;
    const node = addNode(objectNodeId(object.id), compact ? lane * variableX : (globalsOnly ? heapGap : heapStart) + lane * heapGap, lanes[lane], heapWidth, {
      kind: 'object', title: object.type, badge: `@${object.id}`, fields: fieldsFor(object.fields, before?.fields), orphaned: !object.reachable,
      note, text,
    });
    lanes[lane] += 41 + 26 * (object.fields.length + Number(Boolean(text)) + Number(Boolean(note))) + 46;
    const key = object.classId ?? object.type;
    const instances = objectsByClass.get(key) ?? [];
    instances.push(node);
    objectsByClass.set(key, instances);
    if (!topObjectByLane.has(node.position.x)) topObjectByLane.set(node.position.x, node.id);
  }

  const prevClasses = new Map(previous?.classes.map(c => [classKey(c), c]));
  const hasRuntimeNode = (key: string) => methodsByClass.has(key) || objectsByClass.has(key);
  for (const { y, members } of classRows) {
    const occupiedClassX: number[] = [];
    const classOrder = compact ? members : [...members].sort((a, b) => Number(!hasRuntimeNode(classKey(a))) - Number(!hasRuntimeNode(classKey(b))));
    for (const [index, clazz] of classOrder.entries()) {
      const key = classKey(clazz);
      const method = methodsByClass.get(key);
      const instances = objectsByClass.get(key) ?? [];
      const representative = method ?? instances[0];
      let x = compact ? (index % 2) * (structureOnly ? definitionWidth + classGap : variableX) : representative?.position.x ?? 0;
      if (!compact) while (occupiedClassX.some(used => Math.abs(used - x) < definitionWidth + classGap)) x += definitionWidth + classGap;
      occupiedClassX.push(x);
      const prior = prevClasses.get(key);
      const node = addNode(classNodeId(clazz), x, y, definitionWidth, {
        kind: 'class', typeKind: clazz.kind === 'interface' ? 'interface' : clazz.abstract ? 'abstract' : undefined,
        title: clazz.name, note: clazz.external ? '라이브러리 타입' : structureOnly ? '타입 선언' : `메서드 ${clazz.methods.length}개`, fields: fieldsFor(clazz.fields, prior?.fields),
        declarations: structureOnly && !clazz.external ? [
          ...(clazz.declaredFields ?? []).map(text => ({ text, group: 'field' as const })),
          ...clazz.methods.map(text => ({ text, group: 'member' as const, abstract: clazz.abstractMethods?.includes(text) })),
        ] : undefined,
      });
      if (method) addEdge(node.id, method.id, 'out-bottom', 'in-top', 'definition');
      for (const instance of instances) {
        const sameLane = instance.position.x === x;
        const openFromAbove = sameLane && (!compact || snapshot.frames.length === 0) && topObjectByLane.get(x) === instance.id;
        addEdge(node.id, instance.id, 'out-bottom', openFromAbove ? 'in-top' : x >= instance.position.x ? 'in-right' : 'in-left', 'definition');
      }
    }
  }

  const typeById = new Map(types.map(type => [classKey(type), type]));
  for (const type of types) {
    for (const base of type.bases ?? []) {
      const parent = typeById.get(base.id);
      if (!parent) continue;
      const kind = type.kind !== 'interface' && base.kind === 'interface' ? 'implementation' : 'inheritance';
      addEdge(classNodeId(type), classNodeId(parent), 'out-top', 'in-bottom', kind);
    }
  }

  for (const node of nodes) {
    const addReference = ({ item }: GraphField, index?: number) => {
      if (!item.value.ref) return;
      const target = byId.get(objectNodeId(item.value.ref));
      if (!target) return;
      addEdge(node.id, target.id, index === undefined ? 'out-right' : `field-${index}-right`, 'in-left', 'reference', index);
    };
    if (node.data.value) addReference(node.data.value);
    if (!node.data.orphaned) node.data.fields?.forEach(addReference);
  }

  const signature = JSON.stringify(nodes.map(n => [n.id, n.position.x, n.position.y, n.data.fields?.length, n.data.declarations?.length, Boolean(n.data.text), Boolean(n.data.note)]));
  return { nodes, edges, signature };
}
