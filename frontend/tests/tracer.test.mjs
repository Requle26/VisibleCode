import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';

let child;
let base;
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL('../../backend/server/index.mjs', import.meta.url))], { env: { ...process.env, PORT: '0' } });
  child.stderr.pipe(process.stderr);
  const [chunk] = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`서버 시작 실패: ${code}`); }),
  ]);
  base = String(chunk).match(/http:\/\/localhost:\d+/)?.[0].replace('localhost', '127.0.0.1');
  assert.ok(base, '테스트 서버의 포트를 확인할 수 있어야 합니다.');
});
after(() => child?.kill());

async function execute(code, language = 'java') {
  const response = await fetch(`${base}/api/trace`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, language }) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
}

test('같은 객체에 대한 두 참조와 필드 변경을 함께 기록한다', async () => {
  const result = await execute(`class Box { int value; }
public class Main {
    public static void main(String[] args) {
        Box first = new Box();
        Box second = first;
        second.value = 42;
        System.out.println(first.value);
    }
}`);
  const changed = result.snapshots.find(s => s.heap.some(o => o.fields[0]?.value.display === '42'));
  const first = changed.frames[0].variables.find(v => v.name === 'first');
  const second = changed.frames[0].variables.find(v => v.name === 'second');
  assert.ok(first.value.ref);
  assert.equal(first.value.ref, second.value.ref);
  assert.equal(result.output, '42\n');
  assert.ok(result.snapshots.at(-1).finished);
  assert.deepEqual(result.snapshots.at(-1).frames, []);
});

test('호출 프레임과 매개변수, 반환 후 지역 변수의 값을 기록한다', async () => {
  const result = await execute(`public class Main {
    static int twice(int i) { return i * 2; }
    public static void main(String[] args) {
        int result = twice(7);
        System.out.println(result);
    }
}`);
  const nested = result.snapshots.find(s => s.frames.length === 2);
  assert.deepEqual(nested.frames.map(f => f.name), ['twice()', 'main()']);
  assert.equal(nested.frames[0].variables.find(v => v.name === 'i').value.display, '7');
  assert.ok(result.snapshots.some(s => s.frames[0]?.variables.some(v => v.name === 'result' && v.value.display === '14')));
});

test('배열 요소, static 참조와 종료 시의 도달 가능성을 기록한다', async () => {
  const result = await execute(`public class Main {
    static int[] stored;
    public static void main(String[] args) {
        int[] array = {1, 2};
        int[] other = array;
        other[1] = 17;
        stored = array; array = null; other = null;
    }
}`);
  const finished = result.snapshots.at(-1);
  const reference = finished.classes.find(c => c.name === 'Main').fields.find(v => v.name === 'stored').value.ref;
  const object = finished.heap.find(o => o.id === reference);
  assert.equal(object.reachable, true);
  assert.equal(object.fields[1].value.display, '17');
});

test('한 줄로 작성한 main의 마지막 static 변경도 기록한다', async () => {
  const result = await execute('public class Main { static int value; public static void main(String[] args) { value = 9; } }');
  assert.equal(result.snapshots.at(-1).classes[0].fields[0].value.display, '9');
});

test('컴파일 오류의 줄 번호와 실행 중 발생한 예외를 전달한다', async () => {
  const invalid = await execute('public class Main {\n public static void main(String[] args) { int x = ; }\n}');
  assert.equal(invalid.diagnostics[0].line, 2);
  const exception = await execute('public class Main { public static void main(String[] args) { throw new IllegalArgumentException("test"); } }');
  assert.match(exception.runtimeError, /IllegalArgumentException: test/);
});

test('Java는 가변 인자 main을 실행하고 표준 오류 출력을 보존한다', async () => {
  const result = await execute(`public class Main {
    public static void main(String... args) {
        System.err.println("diagnostic");
        System.out.println("done");
    }
}
class Helper { public static void main(int value) { } }`);
  assert.equal(result.mainClass, 'Main');
  assert.equal(result.runtimeError, null);
  assert.equal(result.stderr, 'diagnostic\n');
  assert.equal(result.snapshots.at(-1).stderr, 'diagnostic\n');
  assert.equal(result.output, 'done\n');
});

test('Java 표준 라이브러리 예외는 호출한 사용자 코드의 줄을 가리킨다', async () => {
  const result = await execute(`class Main {
    public static void main(String[] args) {
        Integer.parseInt("not an int");
    }
}`);
  assert.match(result.runtimeError, /NumberFormatException/);
  assert.equal(result.runtimeErrorLine, 3);
  assert.equal(result.snapshots.at(-1).line, 3);
});

test('Java의 긴 문자열은 객체 미리보기만 줄이고 프로그램의 값은 바꾸지 않는다', async () => {
  const result = await execute(`public class Main {
    public static void main(String[] args) {
        String text = "a".repeat(238) + "😀".repeat(1000);
        System.out.println(text.length());
    }
}`);
  assert.equal(result.output, '2238\n');
  const preview = result.snapshots.flatMap(snapshot => snapshot.heap).find(object => object.type === 'String' && object.text?.startsWith('aaa'));
  assert.equal(preview?.text, 'a'.repeat(238) + '…');
});

test('Java에서 바깥 인스턴스를 사용하는 내부 클래스는 Outer.this 참조가 보인다', async () => {
  const result = await execute(`package sample;
class Outer {
    int score = 7;
    class Inner { int score() { return Outer.this.score; } }
}
class Main {
    public static void main(String[] args) {
        Outer outer = new Outer();
        Outer.Inner inner = outer.new Inner();
        outer = null;
        System.out.println(inner.score());
    }
}`);
  const frame = result.snapshots.find(s => s.frames[0]?.name === 'score()');
  assert.equal(frame.frames[0].classId, 'sample.Outer$Inner');
  const inner = frame.heap.find(o => o.classId === 'sample.Outer$Inner');
  const outer = frame.heap.find(o => o.classId === 'sample.Outer');
  assert.equal(inner.fields.find(field => field.name === 'Outer.this').value.ref, outer.id);
  assert.equal(outer.reachable, true);
  assert.equal(result.output, '7\n');
});

const pythonAvailable = spawnSync(process.env.PYTHON_BIN || 'python3', ['--version']).status === 0;
const localDotnet = path.resolve('../.runtime', 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const sdk = spawnSync(process.env.DOTNET_BIN || (existsSync(localDotnet) ? localDotnet : 'dotnet'), ['--list-sdks'], { encoding: 'utf8' });
const csharpAvailable = [...(sdk.stdout ?? '').matchAll(/^(\d+)\./gm)].some(([_, version]) => Number(version) >= 8);

test('C#의 값 복사, 동일 객체 참조, 표현식 본문 메서드와 static 값', { skip: !csharpAvailable }, async () => {
  const result = await execute(`class Box { public int Value; }
class Program {
    static int Total = 0;
    static int Twice(int n) => n * 2;
    static void Main() {
        int a = 10;
        int b = a;
        b = 7;
        Box first = new Box();
        Box second = first;
        second.Value = Twice(b);
        Total = first.Value;
        Console.WriteLine(a + ":" + Total);
    }
}`, 'csharp');
  assert.equal(result.warning, null);
  assert.equal(result.runtimeError, null);
  const call = result.snapshots.find(s => s.frames[0]?.name === 'Twice()');
  assert.deepEqual(call.frames.map(f => f.name), ['Twice()', 'Main()']);
  assert.equal(call.frames[0].variables.find(v => v.name === 'n').value.display, '7');
  const local = Object.fromEntries(call.frames[1].variables.map(v => [v.name, v.value]));
  assert.equal(local.a.display, '10');
  assert.equal(local.b.display, '7');
  assert.ok(local.first.ref);
  assert.equal(local.first.ref, local.second.ref);
  assert.ok(result.snapshots.some(s => s.heap.find(o => o.id === local.first.ref)?.fields.find(f => f.name === 'Value')?.value.display === '14'));
  assert.equal(result.snapshots.at(-1).classes.find(c => c.name === 'Program').fields.find(f => f.name === 'Total').value.display, '14');
  assert.equal(result.output, '10:14\n');
  const invalid = await execute('class Program {\n static void Main() { int n = ; }\n}', 'csharp');
  assert.equal(invalid.diagnostics[0].line, 2);
});

test('Python의 전역 이름과 지역 이름, 공유 리스트와 재대입을 추적한다', { skip: !pythonAvailable }, async () => {
  const result = await execute(`scores = [90]
def update():
    same = scores
    same.append(95)
    same = [0]
    print(scores)
update()`, 'python');
  assert.equal(result.runtimeError, null);
  const shared = result.snapshots.find(s => s.frames[0]?.variables.some(v => v.name === 'same'));
  assert.equal(shared.frames[0].name, 'update()');
  const root = shared.frames.find(f => f.scope === 'module').variables.find(v => v.name === 'scores').value.ref;
  assert.ok(root);
  assert.equal(shared.frames[0].variables.find(v => v.name === 'same').value.ref, root);
  const reassigned = result.snapshots.find(s => s.frames[0]?.variables.some(v => v.name === 'same' && v.value.ref !== root));
  const list = reassigned.heap.find(o => o.id === root);
  assert.equal(list.fields.length, 2);
  assert.equal(reassigned.heap.find(o => o.id === list.fields[1].value.ref).text, '95');
  assert.equal(result.output, '[90, 95]\n');
  assert.equal((await execute('print(1)\ndef :', 'python')).diagnostics[0].line, 2);
});

test('Python에서 __main__이 입력한 코드의 모듈을 가리키고 예외의 실제 줄을 기록한다', { skip: !pythonAvailable }, async () => {
  const result = await execute(`from __main__ import __file__
import sys
print(__file__.endswith('main.py') and sys.argv[0] == __file__)
def fail():
    return 1 / 0
fail()`, 'python');
  assert.match(result.runtimeError, /ZeroDivisionError/);
  assert.equal(result.runtimeErrorLine, 5);
  assert.equal(result.output, 'True\n');
});

test('Python의 전역 딕셔너리는 globals() 별칭 및 공유 참조와 같은 실제 힙 객체다', { skip: !pythonAvailable }, async () => {
  const result = await execute(`a = 10
b = a
c = {"key": "value"}
alias = globals()
def run():
    local = b
    return local
run()`, 'python');
  assert.equal(result.runtimeError, null);
  const active = result.snapshots.find(s => s.frames[0]?.variables.some(v => v.name === 'local'));
  const final = result.snapshots.at(-1);
  const globals = active.heap.find(o => o.id === active.globalsRef);
  const map = Object.fromEntries(globals.fields.map(v => [v.name, v.value.ref]));
  assert.equal(globals.type, 'dict');
  assert.deepEqual(Object.keys(map), ['a', 'b', 'c', 'alias']);
  assert.equal(map.a, map.b);
  assert.equal(map.a, active.frames[0].variables.find(v => v.name === 'local').value.ref);
  assert.equal(map.alias, active.globalsRef);
  assert.equal(active.heap.find(o => o.id === map.c).type, 'dict');
  assert.equal(final.globalsRef, active.globalsRef);
  assert.ok(final.heap.find(o => o.id === map.a).reachable);
  assert.deepEqual(final.frames, []);
});

test('C# 구조체 복사 후 각 변수의 다른 필드 값이 보인다', { skip: !csharpAvailable }, async () => {
  const result = await execute(`var first = new Point { X = 1 };
var second = first;
second.X = 2;
Console.WriteLine($"{first.X}:{second.X}");
struct Point { public int X; }`, 'csharp');
  const state = result.snapshots.find(s => s.line === 4 && s.frames[0]?.variables.some(v => v.name === 'second'));
  assert.equal(state.frames[0].variables.find(v => v.name === 'first').value.display, '{X: 1}');
  assert.equal(state.frames[0].variables.find(v => v.name === 'second').value.display, '{X: 2}');
  assert.equal(result.output, '1:2\n');
});

test('Python과 C#의 이름이 같은 중첩 클래스가 각각 올바른 객체와 연결된다', { skip: !pythonAvailable || !csharpAvailable }, async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { buildMemoryGraph } = await vite.ssrLoadModule('/src/memoryGraph.ts');
    const inputs = {
      python: `class Left:
    class Inner:
        pass
class Right:
    class Inner:
        pass
x = Left.Inner()
y = Right.Inner()
print(type(x).__qualname__, type(y).__qualname__)`,
      csharp: `var x = new Left.Inner();
var y = new Right.Inner();
Console.WriteLine(x.Name + y.Name);
class Left { public class Inner { public string Name = "L"; } }
class Right { public class Inner { public string Name = "R"; } }`,
    };
    for (const [language, code] of Object.entries(inputs)) {
      const result = await execute(code, language);
      const snapshot = result.snapshots.find(s => s.frames[0]?.variables.some(v => v.name === 'y'));
      for (const compact of [false, true]) {
        const graph = buildMemoryGraph(snapshot, undefined, compact);
        for (const name of ['Left.Inner', 'Right.Inner']) {
          const definition = graph.nodes.find(n => n.data.kind === 'class' && n.data.title === name);
          const instance = graph.nodes.find(n => n.data.kind === 'object' && n.data.title === name);
          assert.ok(definition && instance, `${language}: ${name}`);
          assert.deepEqual(graph.edges.filter(edge => edge.source === definition.id && edge.label === '인스턴스').map(edge => edge.target), [instance.id]);
        }
      }
    }
  } finally {
    await vite.close();
  }
});

const repeatedCalls = [
  { language: 'java', receiver: 'this', callerLine: 4, code: `class Main { public static void main(String[] args) {
Box a = new Box(3);
Box b = new Box(7);
int total = a.get() + b.get();
System.out.println(total);
} }
class Box { int n; Box(int n) { this.n = n; } int get() { return n; } }` },
  { language: 'python', receiver: 'receiver', callerLine: 8, skip: !pythonAvailable, code: `class Box:
    def __init__(self, n):
        self.n = n
    def get(receiver):
        return receiver.n
a = Box(3)
b = Box(7)
total = a.get() + b.get()
print(total)` },
  { language: 'csharp', receiver: 'this', callerLine: 3, skip: !csharpAvailable, code: `var a = new Box(3);
var b = new Box(7);
int total = a.Get() + b.Get();
Console.WriteLine(total);
class Box { int n; public Box(int n) { this.n = n; } public int Get() => n; }` },
];

test('한 줄에 호출이 두 번 있는 경우의 호출 대상과 편집기 표시', async t => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { buildMemoryGraph } = await vite.ssrLoadModule('/src/memoryGraph.ts');
    const { sourceLineMarks } = await vite.ssrLoadModule('/src/trace.ts');
    for (const { language, receiver, callerLine, code, skip } of repeatedCalls) {
      await t.test(language, { skip }, async () => {
        const result = await execute(code, language);
        assert.equal(result.runtimeError, null);
        assert.equal(result.output, '10\n');
        const calls = new Map();
        for (const [index, snapshot] of result.snapshots.entries()) {
          const [frame, caller] = snapshot.frames;
          if (frame?.name.toLowerCase() !== 'get()') continue;
          const self = frame.variables.find(v => v.name === receiver);
          assert.equal(self.role, 'receiver');
          assert.equal(caller.line, callerLine);
          assert.equal(caller.variables.some(v => v.name === 'total'), false);
          const marks = sourceLineMarks(snapshot, result.snapshots[index - 1]);
          assert.ok(marks.callLines.includes(callerLine));
          assert.notEqual(marks.executedLine, callerLine);
          const graph = buildMemoryGraph(snapshot);
          assert.ok(graph.edges.some(e => e.target === `local:${frame.id}:${receiver}` && e.label === '호출 대상'));
          assert.ok(graph.edges.some(e => e.source === `local:${frame.id}:${receiver}` && e.target === `object:${self.value.ref}`));
          calls.set(frame.id, self.value.ref);
        }
        const first = result.snapshots.find(s => s.frames[0]?.name.toLowerCase() === 'get()');
        assert.deepEqual([...calls.values()], ['a', 'b'].map(name => first.frames[1].variables.find(v => v.name === name).value.ref));
        const after = result.snapshots.findIndex(s => s.frames[0]?.variables.some(v => v.name === 'total'));
        const marks = sourceLineMarks(result.snapshots[after], result.snapshots[after - 1]);
        assert.equal(marks.executedLine, callerLine);
        assert.equal(marks.callLines.includes(callerLine), false);
      });
    }
  } finally {
    await vite.close();
  }
});

test('드래그는 노드를 통과하며 가까운 모서리와 수평·수직 기준선에 스냅한다', async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { snapNodeDrag, nodeSnapPixels, settleNodePositions } = await vite.ssrLoadModule('/src/nodePlacement.ts');
    const moving = [{ x: 0, y: 0, width: 20, height: 20 }];
    const fixed = [{ x: 40, y: 0, width: 20, height: 20 }];
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 12, y: 0 }, nodeSnapPixels),
      { offset: { x: 12, y: 0 }, guides: [{ axis: 'y', coordinate: 0, from: 32, to: 40 }] });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 17, y: 0 }, nodeSnapPixels).offset, { x: 20, y: 0 });
    const aligned = snapNodeDrag(moving, fixed, { x: 17, y: 3 }, nodeSnapPixels);
    assert.deepEqual(aligned, { offset: { x: 20, y: 0 }, contact: { axis: 'x', coordinate: 40, from: 0, to: 20, movingIndex: 0, fixedIndex: 0 } });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 17, y: 8 }, nodeSnapPixels).offset, { x: 20, y: 8 });
    const below = [{ x: 0, y: 40, width: 20, height: 20 }];
    assert.deepEqual(snapNodeDrag(moving, below, { x: 3, y: 17 }, nodeSnapPixels).offset, { x: 0, y: 20 });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 17, y: 0 }, nodeSnapPixels / 2).offset, { x: 17, y: 0 });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 35, y: 0 }, nodeSnapPixels), { offset: { x: 35, y: 0 } });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 90, y: 0 }, nodeSnapPixels).offset, { x: 90, y: 0 });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 47, y: 30 }, nodeSnapPixels).offset, { x: 47, y: 30 });
    const group = [...moving, { x: -15, y: 45, width: 20, height: 20 }];
    const blocker = [{ x: 30, y: 45, width: 20, height: 20 }];
    assert.deepEqual(snapNodeDrag(group, blocker, { x: 40, y: 0 }, nodeSnapPixels).offset, { x: 40, y: 0 });
    assert.deepEqual(snapNodeDrag(group, blocker, { x: 22, y: 0 }, nodeSnapPixels).offset, { x: 25, y: 0 });
    const across = [{ x: 80, y: 14, width: 20, height: 30 }];
    assert.deepEqual(snapNodeDrag(moving, across, { x: 0, y: 17 }, nodeSnapPixels),
      { offset: { x: 0, y: 19 }, guides: [{ axis: 'y', coordinate: 29, from: 20, to: 80 }] });
    assert.deepEqual(snapNodeDrag(moving, below, { x: 3, y: -25 }, nodeSnapPixels),
      { offset: { x: 0, y: -25 }, guides: [{ axis: 'x', coordinate: 0, from: -5, to: 40 }] });
    const ports = [{ axis: 'y', movingIndex: 0, fixedIndex: 0, movingPort: 10, fixedPort: 13, direction: 1 }];
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 12, y: 0 }, nodeSnapPixels, ports),
      { offset: { x: 12, y: 3 }, guides: [{ axis: 'y', coordinate: 13, from: 32, to: 40 }] });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: 17, y: 0 }, nodeSnapPixels, ports).offset, { x: 20, y: 3 });
    assert.deepEqual(snapNodeDrag(moving, fixed, { x: -400, y: 2 }, nodeSnapPixels), { offset: { x: -400, y: 2 } });
    const runtimeCards = ['first', 'second'].map(id => ({ id, position: { x: 15, y: 20 }, measured: { width: 100, height: 55 }, data: { kind: 'object' } }));
    const settled = settleNodePositions(runtimeCards);
    assert.deepEqual(settled[0].position, { x: 15, y: 20 });
    assert.ok(settled[1].position.y >= 75);
  } finally {
    await vite.close();
  }
});

test('직각 경로는 통로를 겹쳐 쓰지 않고 가로·세로 교차는 허용한다', async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { routeEdges, routedPath } = await vite.ssrLoadModule('/src/edgeRouting.ts');
    const card = (id, x, y, width = 140, height = 50) => ({ id, position: { x, y }, measured: { width, height }, data: { kind: 'object' } });
    const link = (id, source, target, fieldIndex) => ({ id, source, target, data: { kind: 'reference', fieldIndex } });
    const cards = [card('list', 0, 0, 174, 150), card('obstacle', 245, 60, 180, 185), card('one', 380, 290), card('two', 380, 375)];
    const first = link('first', 'list', 'one', 1);
    const second = link('second', 'list', 'two', 2);
    const firstAlone = routeEdges([first], cards).routes.get('first');
    const secondAlone = routeEdges([second], cards).routes.get('second');
    assert.deepEqual(firstAlone.lane, secondAlone.lane);
    const { routes } = routeEdges([first, second], cards);
    const a = routes.get('first').lane, b = routes.get('second').lane;
    assert.equal(a.axis, 'x');
    assert.equal(b.axis, 'x');
    assert.ok(Math.abs(a.coordinate - b.coordinate) >= 8);
    // Fractional measured handles can move relative to the precomputed lane.
    assert.equal(routedPath({ x: 174.5, y: 106.25 }, 'right', { x: 379.5, y: 395.5 }, 'left', b),
      `M 174.5,106.25 L ${b.coordinate},106.25 L ${b.coordinate},395.5 L 379.5,395.5`);

    const crossingCards = [card('left', 0, 130), card('right', 450, 130), card('top', 225, 0), card('bottom', 225, 280)];
    const crossing = routeEdges([link('horizontal', 'left', 'right'), { ...link('vertical', 'top', 'bottom'), data: { kind: 'definition' } }], crossingCards).routes;
    assert.deepEqual(crossing.get('horizontal'), { sourceHandle: 'out-right', targetHandle: 'in-left' });
    assert.deepEqual(crossing.get('vertical'), { sourceHandle: 'out-bottom', targetHandle: 'in-top' });
    assert.equal(routedPath({ x: 295, y: 50 }, 'bottom', { x: 295, y: 280 }, 'top'), 'M 295,50 L 295,280');
  } finally {
    await vite.close();
  }
});

test('호출·정의·상속·구현도 같은 카드에서 갈라질 때 곡선으로 그릴 수 있다', async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { routeEdges } = await vite.ssrLoadModule('/src/edgeRouting.ts');
    const card = (id, x, y) => ({ id, position: { x, y }, measured: { width: 148, height: 51 }, data: { kind: 'class' } });
    const nodes = [card('from', 0, 120), card('above', 350, 48), card('below', 350, 210)];
    const link = (target, kind) => ({ id: target, source: 'from', target, sourceHandle: 'out-right', targetHandle: 'in-left', data: { kind } });
    for (const kind of ['call', 'definition', 'inheritance', 'implementation']) {
      const edge = link('below', kind);
      assert.equal(routeEdges([edge], nodes).routes.get('below').curved, undefined, kind);
      assert.equal(routeEdges([edge, link('above', 'branch')], nodes).routes.get('below').curved, true, kind);
    }
  } finally {
    await vite.close();
  }
});

test('한 카드에서 나가는 호출과 지역 변수 선은 도착 카드 순서대로 갈라진다', async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { routeEdges } = await vite.ssrLoadModule('/src/edgeRouting.ts');
    const card = (id, x, y) => ({ id, position: { x, y }, measured: { width: 148, height: 51 }, data: { kind: 'frame' } });
    const cards = [card('main', 0, 120), card('sound', 175, 24), card('dog', 270, 100), card('cat', 270, 176)];
    const link = (target, kind) => ({ id: target, source: 'main', target, sourceHandle: 'out-right', targetHandle: 'in-left', data: { kind } });
    const edges = [link('cat', 'branch'), link('sound', 'call'), link('dog', 'branch')];
    const one = routeEdges([edges[1]], cards);
    assert.equal(one.routes.get('sound').sourceHandle, 'out-right');
    assert.equal(one.connectionPorts.has('main'), false);

    const order = (scene, ids) => {
      const { routes, connectionPorts } = routeEdges(edges, scene);
      const offsets = ids.map(id => {
        const port = connectionPorts.get('main')?.find(port => port.id === routes.get(id).sourceHandle);
        assert.equal(port?.side, 'right');
        return port.offset;
      });
      assert.ok(offsets[0] < offsets[1] && offsets[1] < offsets[2]);
    };
    order(cards, ['sound', 'dog', 'cat']);
    order([cards[0], cards[1], card('dog', 270, 176), card('cat', 270, 100)], ['sound', 'cat', 'dog']);
  } finally {
    await vite.close();
  }
});

test('같은 힙 객체에 들어오는 참조와 인스턴스 선은 같은 면에서도 다른 점에 닿는다', async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { routeEdges } = await vite.ssrLoadModule('/src/edgeRouting.ts');
    const card = (id, kind, x, y) => ({ id, position: { x, y }, measured: { width: 148, height: 45 }, data: { kind } });
    const cards = [card('class', 'class', 0, 25), card('dog', 'local', 0, 75), card('cat', 'local', 0, 125), card('object', 'object', 380, 100)];
    const link = (source, kind) => ({ id: source, source, target: 'object', sourceHandle: 'out-right', targetHandle: 'in-left', data: { kind } });
    const references = [link('dog', 'reference'), link('cat', 'reference')];
    const sameKind = routeEdges(references, cards);
    assert.equal(sameKind.routes.get('dog').targetHandle, 'in-left');
    assert.equal(sameKind.routes.get('cat').targetHandle, 'in-left');
    const { routes, connectionPorts, ports } = routeEdges([link('class', 'definition'), ...references], cards);
    const instance = routes.get('class').targetHandle, reference = routes.get('dog').targetHandle;
    assert.equal(routes.get('cat').targetHandle, reference);
    assert.equal(reference, sameKind.routes.get('dog').targetHandle);
    assert.notEqual(instance, reference);
    const arrivals = connectionPorts.get('object').filter(port => port.type === 'target');
    assert.deepEqual(arrivals.map(({ id, side }) => [id, side]), [[instance, 'left']]);
    assert.ok(arrivals[0].offset <= -8);
    assert.deepEqual([...ports.get('object')], [reference]);
  } finally {
    await vite.close();
  }
});

test('Main 없는 C# 제네릭 추상 클래스는 필드와 멤버를 실행 없이 표시한다', { skip: !csharpAvailable }, async () => {
  const code = `public abstract class BaseState<Contorller> {
    protected Contorller contorller;
    protected BaseState(Contorller contorller) { this.contorller = contorller; }
    public virtual void EnterState() { }
    public virtual void UpdateState() { }
    public virtual void FixedUpdateState() { }
    public virtual void ExitState() { }
}
public class PlayState : BaseState<int> {
    static PlayState() { throw new System.Exception("do not execute"); }
    public PlayState(int value) : base(value) { }
}`;
  const result = await execute(code, 'csharp');
  assert.equal(result.error, undefined);
  assert.equal(result.runtimeError, undefined);
  assert.equal(result.snapshots.length, 1);
  const [state] = result.snapshots;
  assert.equal(state.structureOnly, true);
  assert.deepEqual(state.frames, []);
  assert.deepEqual(state.heap, []);
  const base = state.classes.find(type => type.name === 'BaseState<Contorller>');
  assert.ok(base?.abstract);
  assert.deepEqual(base.declaredFields, ['protected Contorller contorller']);
  assert.ok(base.methods.includes('protected BaseState(Contorller contorller)'));
  for (const method of ['EnterState', 'UpdateState', 'FixedUpdateState', 'ExitState']) {
    assert.ok(base.methods.includes(`public virtual void ${method}()`));
  }
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { buildMemoryGraph } = await vite.ssrLoadModule('/src/memoryGraph.ts');
    const graph = buildMemoryGraph(state);
    assert.ok(graph.nodes.every(node => node.data.kind === 'class'));
    assert.deepEqual(graph.nodes.find(n => n.data.title === base.name).data.declarations.map(d => d.text), [...base.declaredFields, ...base.methods]);
    assert.deepEqual(graph.edges.map(e => e.label), ['상속']);
  } finally { await vite.close(); }
});

test('main 없는 Java 타입은 선언과 구현 관계를 보여주고 문법 오류는 보고한다', async () => {
  const result = await execute(`interface State { void enter(); }
public abstract class BaseState<T> implements State {
    protected T controller;
    protected BaseState(T controller) { this.controller = controller; }
}`);
  const [state] = result.snapshots ?? [];
  assert.equal(state?.structureOnly, true, result.error);
  assert.deepEqual(state.frames, []);
  const base = state.classes.find(type => type.name === 'BaseState<T>');
  assert.deepEqual(base?.declaredFields, ['protected T controller']);
  assert.ok(base.methods.includes('BaseState(T)'));
  assert.equal(base.bases[0].id, 'State');
  const invalid = await execute('public class Broken { int field = ; }');
  assert.ok(invalid.diagnostics?.length);
  assert.equal(invalid.snapshots, undefined);
});

test('같은 인터페이스를 구현해도 각 클래스가 자기 연결선을 가진다', async () => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { buildMemoryGraph } = await vite.ssrLoadModule('/src/memoryGraph.ts');
    const result = await execute(`interface Named { String name(); }
class Person implements Named { public String name() { return "Kim"; } }
class Course implements Named { public String name() { return "Java"; } }
class Main { public static void main(String[] args) { System.out.println(new Person().name()); } }`);
    const graph = buildMemoryGraph(result.snapshots[0]);
    assert.deepEqual(graph.edges.filter(edge => edge.label === '구현').map(edge => [edge.source, edge.target]),
      [['class:Person', 'class:Named'], ['class:Course', 'class:Named']]);
  } finally {
    await vite.close();
  }
});

test('노드가 선언, 호출 프레임, 처음 관찰한 객체의 줄을 찾는다', async t => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { indexSource, nodeSource } = await vite.ssrLoadModule('/src/nodeSource.ts');
    const cases = [
      { language: 'java', lines: [2, 5, 10, 9], code: `class Outside {
    static class Box {}
}
class Main {
    static int add(int value) {
        return value + 1;
    }
    public static void main(String[] args) {
        Outside.Box box = new Outside.Box();
        int total = add(2);
        System.out.println(total);
    }
}` },
      { language: 'csharp', skip: !csharpAvailable, lines: [2, 6, 11, 10], code: `namespace Demo {
class Outside { public class Box {} }
class MainType {
    static int Add(
        int padding,
        int value) {
        return value + padding;
    }
    static void Main() {
        var box = new Outside.Box();
        var total = Add(1, 2);
        Console.WriteLine(total);
    }
}
}` },
      { language: 'python', skip: !pythonAvailable, lines: [2, 6, 9, 8], code: `class Outside:
    class Box:
        pass

def add(
    value):
    return value + 1
box = Outside.Box()
total = add(2)
print(total)` },
    ];
    for (const { language, code, lines, skip } of cases) await t.test(language, { skip }, async () => {
      const result = await execute(code, language);
      const snapshots = result.snapshots;
      const index = indexSource(code, language);
      const active = snapshots.findIndex(s => s.frames[0]?.name.toLowerCase() === 'add()');
      const frame = snapshots[active].frames[0];
      assert.equal(nodeSource(index, snapshots, active, `frame:${frame.id}`).line, frame.line);
      assert.equal(nodeSource(index, snapshots, active, `local:${frame.id}:value`).line, lines[1]);
      const done = snapshots.findIndex(s => s.frames[0]?.variables.some(item => item.name === 'total'));
      const root = snapshots[done].frames[0];
      const box = root.variables.find(item => item.name === 'box');
      const type = snapshots[done].classes.find(item => item.name === 'Outside.Box');
      assert.equal(nodeSource(index, snapshots, done, `class:${type.id}`).line, lines[0]);
      assert.equal(nodeSource(index, snapshots, done, `local:${root.id}:total`).line, lines[2]);
      assert.equal(nodeSource(index, snapshots, done, `object:${box.value.ref}`).line, lines[3]);
    });
  } finally {
    await vite.close();
  }
});

test('상속·인터페이스 구현·추상 멤버를 타입 정의와 캔버스에 표시한다', async t => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { buildMemoryGraph, classNodeId } = await vite.ssrLoadModule('/src/memoryGraph.ts');
    const examples = [
      { language: 'java', member: 'age()', contract: 'name()', code: `package demo;
interface Named { String name(); default int version() { return 1; } }
interface Worker extends Named { void work(); }
abstract class Person implements Worker { abstract int age(); }
class Teacher extends Person {
    public String name() { return "Kim"; }
    public void work() {}
    int age() { return 30; }
}
public class Main { public static void main(String[] args) { System.out.println(new Teacher().name()); } }` },
      { language: 'csharp', skip: !csharpAvailable, member: 'Age { get; }', contract: 'Name()', code: `Console.WriteLine(new Teacher().Name());
interface Named { string Name(); int Version() => 1; }
interface Worker : Named { void Work(); }
abstract class Person : Worker {
    public abstract int Age { get; }
    public abstract string Name();
    public abstract void Work();
}
class Teacher : Person {
    public override int Age => 30;
    public override string Name() => "Kim";
    public override void Work() {}
}` },
      { language: 'python', skip: !pythonAvailable, member: 'age (프로퍼티)', contract: 'name()', code: `from abc import ABC, abstractmethod
from typing import Protocol
class Named(Protocol):
    @abstractmethod
    def name(self): ...
    def version(self): return 1
class Worker(Named, Protocol):
    def work(self): ...
class Person(ABC, Worker):
    @property
    @abstractmethod
    def age(self): ...
class Teacher(Person):
    @property
    def age(self): return 30
    def name(self): return 'Kim'
    def work(self): pass
print(Teacher().name())` },
    ];
    for (const { language, skip, member, contract, code } of examples) {
      await t.test(language, { skip }, async () => {
        const result = await execute(code, language);
        assert.equal(result.output, 'Kim\n');
        const current = result.snapshots.at(-1);
        const byName = new Map(current.classes.map(type => [type.name, type]));
        assert.equal(byName.get('Named')?.kind, 'interface');
        assert.equal(byName.get('Worker')?.kind, 'interface');
        assert.ok(byName.get('Named').abstractMethods.includes(contract));
        assert.ok(!byName.get('Named').abstractMethods.some(method => method.toLowerCase() === 'version()'));
        assert.equal(byName.get('Person')?.abstract, true);
        assert.ok(byName.get('Person').abstractMethods.includes(member));
        assert.equal(byName.get('Teacher')?.abstract, false);
        assert.deepEqual(byName.get('Teacher').abstractMethods, []);
        for (const compact of [false, true]) {
          const graph = buildMemoryGraph(current, undefined, compact);
          for (const [child, parent, label] of [['Teacher', 'Person', '상속'], ['Person', 'Worker', '구현'], ['Worker', 'Named', '상속']]) {
            const source = classNodeId(byName.get(child)), target = classNodeId(byName.get(parent));
            assert.ok(graph.edges.some(edge => edge.source === source && edge.target === target && edge.label === label));
            assert.ok(graph.nodes.find(node => node.id === source).position.y > graph.nodes.find(node => node.id === target).position.y);
          }
          assert.ok(!graph.edges.some(edge => edge.source === classNodeId(byName.get('Teacher')) && edge.target === classNodeId(byName.get('Worker'))));
          assert.equal(graph.nodes.find(node => node.id === classNodeId(byName.get('Person'))).data.typeKind, 'abstract');
        }
        if (language === 'java') assert.ok(result.snapshots[0].classes.some(type => type.name === 'Teacher'), '클래스를 아직 로드하지 않았어도 타입 정의를 표시한다');
      });
    }
  } finally {
    await vite.close();
  }
});

test('합성·다형성·순환 참조가 함께 있는 객체 설계에서 상태와 연결을 보존한다', async t => {
  const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { buildMemoryGraph, objectNodeId } = await vite.ssrLoadModule('/src/memoryGraph.ts');
    const cases = [
      { language: 'java', member: 'score()', code: `import java.util.ArrayList;
import java.util.HashMap;
class Base { int n = 3; int score() { return n; } }
class Child extends Base { int n = 5; @Override int score() { return super.score() + n; } }
class Team { ArrayList<Base> members = new ArrayList<>(); Team next; }
class Main {
    public static void main(String[] args) {
        Team team = new Team();
        Team alias = team;
        team.next = alias;
        Base selected = new Child();
        alias.members.add(selected);
        HashMap<String, Base> directory = new HashMap<>();
        String key = "lead";
        directory.put(key, selected);
        System.out.println(directory.get(key).score());
    }
}` },
      { language: 'csharp', member: 'get_Score()', skip: !csharpAvailable, code: `var team = new Team();
var alias = team;
team.next = alias;
Base selected = new Child();
alias.members.Add(selected);
var directory = new Dictionary<string, Base>();
string key = "lead";
directory[key] = selected;
Console.WriteLine(directory[key].Score);
class Base { protected int n = 3; public virtual int Score => n; }
class Child : Base { protected new int n = 5; public override int Score { get => base.Score + n; } }
class Team { public List<Base> members = new(); public Team? next; }` },
      { language: 'python', member: 'score()', skip: !pythonAvailable, code: `class Base:
    def __init__(self): self.n = 3
    @property
    def score(self): return self.n
class Child(Base):
    @property
    def score(self): return super().score + 5
class Team:
    __slots__ = ('members', 'next')
    def __init__(self): self.members = []
team = Team()
alias = team
team.next = alias
selected = Child()
alias.members.append(selected)
directory = {}
key = object()
directory[key] = selected
print(directory[key].score)` },
    ];

    for (const { language, member, skip, code } of cases) await t.test(language, { skip }, async () => {
      const result = await execute(code, language);
      assert.equal(result.output, '8\n');
      assert.equal(result.runtimeError, null);
      assert.ok(!result.warning, result.warning);
      const state = result.snapshots.find(s => s.frames[0]?.name === member && s.frames[0].className === 'Child');
      assert.ok(state, '자식 타입의 구현으로 진입해야 한다');
      const locals = new Map(state.frames.at(-1).variables.map(v => [v.name, v.value.ref]));
      const heap = new Map(state.heap.map(o => [o.id, o]));
      const team = heap.get(locals.get('team'));
      const selected = heap.get(locals.get('selected'));
      assert.equal(team.id, locals.get('alias'));
      assert.equal(team.fields.find(f => f.name === 'next').value.ref, team.id);
      assert.equal(selected.type, 'Child');
      const list = heap.get(team.fields.find(f => f.name === 'members').value.ref);
      assert.equal(list.length, 1);
      assert.equal(list.fields[0].value.ref, selected.id);
      const dictionary = heap.get(locals.get('directory'));
      assert.equal(dictionary.length, 1);
      assert.equal(dictionary.fields.find(f => f.name === '[0].key').value.ref, locals.get('key'));
      assert.equal(dictionary.fields.find(f => f.name === '[0].value').value.ref, selected.id);
      for (const owner of ['Child', 'Base']) {
        const access = result.snapshots.find(s => s.frames[0]?.className === owner && s.frames[0].name === member);
        assert.equal(access?.frames[0].variables.find(v => v.role === 'receiver')?.value.ref, selected.id);
      }
      if (language !== 'python') {
        assert.equal(selected.fields.find(f => f.name === 'Base.n')?.value.display, '3');
        assert.equal(selected.fields.find(f => f.name === 'Child.n')?.value.display, '5');
      }
      for (const compact of [false, true]) {
        const graph = buildMemoryGraph(state, undefined, compact);
        const refs = graph.edges.filter(edge => edge.label === '참조');
        for (const [source, target] of [[team.id, team.id], [team.id, list.id], [list.id, selected.id], [dictionary.id, selected.id], [dictionary.id, locals.get('key')]]) {
          assert.ok(refs.some(edge => edge.source === objectNodeId(source) && edge.target === objectNodeId(target)));
        }
      }
    });
  } finally {
    await vite.close();
  }
});
