export type MemoryValue = { kind: 'primitive' | 'reference' | 'null'; display: string; ref?: string };
export type Variable = { name: string; type: string; value: MemoryValue; role?: 'receiver' | null };
export type Frame = { id: string; name: string; className: string; classId?: string | null; line: number; scope?: 'module' | 'class' | null; variables: Variable[] };
export type HeapObject = { id: string; type: string; classId?: string; kind: 'object' | 'string' | 'array' | 'scalar'; fields: Variable[]; text: string | null; length: number; truncated: boolean; reachable: boolean };
export type TypeBase = { id: string; name: string; kind: 'class' | 'interface' };
export type ClassInfo = { id?: string; name: string; fields: Variable[]; methods: string[];
  kind?: TypeBase['kind']; abstract?: boolean; abstractMethods?: string[]; bases?: TypeBase[]; external?: boolean };
export function typeDefinitionLabel(type: ClassInfo) {
  return type.kind === 'interface' ? '인터페이스' : type.abstract ? '추상 클래스' : '클래스 영역';
}
export type Snapshot = { line: number; executedLine: number; frames: Frame[]; heap: HeapObject[]; globalsRef?: string; classes: ClassInfo[]; output: string; stderr?: string; finished: boolean };
export type Trace = { snapshots?: Snapshot[]; output?: string; stderr?: string; error?: string; runtimeError?: string | null; runtimeErrorLine?: number; warning?: string; diagnostics?: { line: number; message: string }[]; mainClass?: string };
export const valueChanged = (value: Variable, before?: Variable[]) => value.value.display !== before?.find(v => v.name === value.name)?.value.display;

export function sourceLineMarks(snapshot?: Snapshot, previous?: Snapshot) {
  if (!snapshot) return { nextLine: 0, executedLine: 0, callLines: [] };
  const nextLine = snapshot.line;
  const callLines = [...new Set(snapshot.frames.slice(1).flatMap((caller, i) =>
    caller.line > 0 && snapshot.frames[i].scope !== 'class' ? [caller.line] : []))];
  // The previous probe can be in a different method. Once a caller advances,
  // its call expression is the source line that produced this caller's state.
  const active = snapshot.frames[0];
  const resumed = active && previous?.frames.findIndex(frame => frame.id === active.id);
  const callerLine = resumed && resumed > 0 ? previous!.frames[resumed].line : 0;
  const executed = callerLine && callerLine !== nextLine ? callerLine : snapshot.executedLine;
  return { nextLine, callLines, executedLine: callLines.includes(executed) ? 0 : executed };
}

export function describe(snapshot?: Snapshot, previous?: Snapshot) {
  if (!snapshot) return { title: '실행할 준비가 됐어요', body: '왼쪽에서 코드를 작성하고 실행하면, 각 줄이 메모리를 어떻게 바꾸는지 볼 수 있어요.' };
  if (snapshot.finished) return { title: '프로그램 실행이 끝났어요', body: snapshot.globalsRef
    ? '실행 프레임이 사라졌어요. 전역 딕셔너리는 모듈의 마지막 상태를 보여줘요.'
    : '메서드 호출이 모두 끝나 스택 프레임이 사라졌어요. 흐리게 표시된 객체는 화면에 표시된 참조로 더 이상 도달할 수 없어요.' };
  const frame = snapshot.frames[0];
  if (!previous && snapshot.globalsRef) return { title: '모듈 코드에서 시작', body: '전역 이름은 모듈의 딕셔너리에 항목으로 들어가고, 각 항목은 힙 객체를 참조해요.' };
  if (!previous) return { title: `${frame?.name ?? 'main()'}에서 시작`, body: '메서드가 시작되면 그 메서드의 지역 변수를 담을 스택 프레임이 만들어져요. 보라색으로 표시된 코드는 다음에 실행할 줄이에요.' };
  if (snapshot.frames.length > previous.frames.length && frame) return { title: `${frame.name} 프레임이 쌓였어요`, body: snapshot.globalsRef
    ? '호출된 함수의 실행 프레임에 매개변수와 지역 이름의 참조를 담아요. 전역 이름은 모듈의 딕셔너리에서 찾아요.'
    : '메서드가 호출되면 매개변수와 지역 변수를 위한 새 공간이 스택 위에 생겨요. 인스턴스 메서드나 생성자의 this는 현재 객체를 가리켜요.' };
  if (snapshot.frames.length < previous.frames.length) return { title: `${previous.frames[0].name}에서 돌아왔어요`, body: '메서드 실행이 끝나면 그 프레임과 지역 변수가 사라져요. 호출한 메서드는 남아 있던 프레임에서 계속 실행돼요.' };
  const released = snapshot.heap.find(o => !o.reachable && previous.heap.some(p => p.id === o.id && p.reachable));
  if (released) return { title: `@${released.id}에 닿는 참조가 사라졌어요`, body: '표시된 지역 변수와 static 필드에서 이 객체에 도달할 수 없어요. 회색은 실제로 삭제됐다는 뜻이 아니에요.' };
  const allocated = snapshot.heap.find(o => !previous.heap.some(p => p.id === o.id));
  if (allocated) return { title: `힙에 ${allocated.type} 객체가 보이기 시작했어요`, body: `@${allocated.id}는 이 객체를 구분하기 위한 표시예요. 객체를 참조하는 변수를 누르면 연결을 강조해서 볼 수 있어요.` };
  if (frame) {
    const before = previous.frames.find(p => p.id === frame.id)?.variables;
    const changed = frame.variables.find(v => valueChanged(v, before));
    if (changed) {
      if (changed.value.kind === 'reference') {
        const other = frame.variables.find(v => v !== changed && v.value.ref === changed.value.ref);
        if (other) return { title: '두 변수가 같은 객체를 보고 있어요', body: `${changed.name}에 복사된 건 객체가 아니라 참조예요. ${other.name}와 ${changed.name}에서 뻗은 화살표가 모두 ${changed.value.display}를 가리켜요.` };
        return { title: `${changed.name} → ${changed.value.display}`, body: '참조 변수는 객체를 찾아가는 값을 담아요. 실제 객체와 그 필드는 힙에서 확인할 수 있어요.' };
      }
      return changed.value.kind === 'null'
        ? { title: `${changed.name}에 null이 들어갔어요`, body: '이 변수는 이제 아무 객체도 가리키지 않아요. 다른 변수가 같은 객체를 가리킨다면 그 연결은 그대로 남아요.' }
        : { title: `${changed.name}에 ${changed.value.display} 값이 들어갔어요`, body: 'int, boolean 같은 기본형 지역 변수는 스택 프레임에 값 자체를 보관해요.' };
    }
  }
  for (const object of snapshot.heap) {
    const before = previous.heap.find(o => o.id === object.id)?.fields;
    const field = object.fields.find(v => before && valueChanged(v, before));
    if (field) return { title: `@${object.id}의 ${field.name} 값이 바뀌었어요`, body: `힙에 있는 객체의 ${field.name} 값은 이제 ${field.value.display}예요. 같은 객체를 가리키는 변수로 읽으면 모두 같은 값이 보여요.` };
  }
  for (const clazz of snapshot.classes) {
    const before = previous.classes.find(c => c.name === clazz.name)?.fields;
    const field = clazz.fields.find(v => before && valueChanged(v, before));
    if (field) return { title: `${clazz.name}.${field.name}의 값이 바뀌었어요`, body: `static 필드는 인스턴스별로 생기지 않고 해당 클래스가 공유해요. 현재 값은 ${field.value.display}예요.` };
  }
  if (snapshot.output !== previous.output || snapshot.stderr !== previous.stderr) return { title: '콘솔에 결과가 출력됐어요', body: '출력된 내용을 왼쪽 아래 콘솔에서 확인하세요.' };
  return { title: `${snapshot.line > 0 ? `${snapshot.line}번째 줄 · ` : ''}다음 코드로 이동했어요`, body: '보라색 줄은 다음에 실행할 코드예요. 다음 단계 버튼을 누르면 실행 후의 메모리를 확인할 수 있어요.' };
}
