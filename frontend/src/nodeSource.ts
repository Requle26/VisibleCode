import { javaLanguage } from '@codemirror/lang-java';
import { pythonLanguage } from '@codemirror/lang-python';
import { csharpLanguage } from '@replit/codemirror-lang-csharp';
import type { Language } from './languages';
import { classNodeId, objectNodeId } from './memoryGraph';
import { sourceLineMarks, type Frame, type Snapshot } from './trace';

type SyntaxNode = ReturnType<typeof javaLanguage.parser.parse>['topNode'];
type Definition = { name: string; line: number; from: number; to: number; parameter?: boolean };
export type SourceJump = { line: number; label: string };

const parsers = { java: javaLanguage.parser, csharp: csharpLanguage.parser, python: pythonLanguage.parser };
const javaTypes = new Set(['ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'RecordDeclaration', 'AnnotationTypeDeclaration']);
const csharpTypes = new Set(['class', 'struct', 'interface', 'enum', 'record']);

function ancestor(node: SyntaxNode, names: string[]): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) if (names.includes(parent.name)) return parent;
  return null;
}

export function indexSource(code: string, language: Language) {
  const root = parsers[language].parse(code).topNode;
  const types: { name: string; line: number }[] = [];
  const variables: Definition[] = [];
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const lineAt = (position: number) => {
    let low = 0, high = starts.length;
    while (high - low > 1) {
      const mid = (high + low) >>> 1;
      if (starts[mid] <= position) low = mid;
      else high = mid;
    }
    return low + 1;
  };
  const text = (node: SyntaxNode) => code.slice(node.from, node.to).trim();
  const binding = (name: SyntaxNode | null, scope: SyntaxNode | null, parameter = false) => {
    if (name) variables.push({ name: text(name), line: lineAt(name.from), from: lineAt(scope?.from ?? 0),
      to: lineAt(scope?.to ?? root.to), parameter });
  };

  function visit(node: SyntaxNode, qualifiers: string[]) {
    let childQualifiers = qualifiers;
    if (javaTypes.has(node.name) || node.name === 'ClassDefinition') {
      const name = node.getChild(language === 'python' ? 'VariableName' : 'Definition');
      if (name) {
        childQualifiers = [...qualifiers, text(name)];
        types.push({ name: childQualifiers.join('.'), line: lineAt(name.from) });
      }
    } else if (node.name === 'FunctionDefinition') {
      const name = node.getChild('VariableName');
      if (name) childQualifiers = [...qualifiers, text(name), '<locals>'];
    }

    if (language === 'java') {
      if (node.name === 'FormalParameter' || node.name === 'SpreadParameter') {
        binding(node.getChild('Definition') ?? node.getChild('VariableDeclarator')?.getChild('Definition') ?? null,
          ancestor(node, ['MethodDeclaration', 'ConstructorDeclaration', 'LambdaExpression', 'CatchClause']), true);
      }
      if (node.name === 'VariableDeclarator' && node.parent?.name === 'LocalVariableDeclaration') {
        binding(node.getChild('Definition'), ancestor(node, ['Block', 'ForStatement', 'SwitchBlock']));
      }
    } else if (language === 'csharp') {
      if (node.name === 'VarName' && node.parent?.name === 'LocalVarDecl') binding(node, ancestor(node, ['Delim']));
      if (node.name === 'ParamName') {
        const body = node.parent?.nextSibling;
        binding(node, body?.name === 'Delim' ? body : node.parent, true);
      }
    } else {
      const scope = ancestor(node, ['FunctionDefinition', 'ClassDefinition']);
      if (node.name === 'ParamList') {
        let first = true;
        for (let part = node.firstChild; part; part = part.nextSibling) {
          if (part.name === ',') first = true;
          else if (part.name === 'VariableName' && first) { binding(part, scope, true); first = false; }
        }
      }
      if (node.name === 'AssignStatement') {
        for (let part = node.firstChild; part && part.name !== 'AssignOp'; part = part.nextSibling) {
          if (part.name === 'VariableName') binding(part, scope);
        }
      }
    }

    let pendingType: string[] | undefined;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (language === 'csharp' && child.name === 'Keyword') {
        const keyword = text(child);
        const name = child.nextSibling;
        if (name?.name === 'TypeIdentifier' && (csharpTypes.has(keyword) || keyword === 'namespace')) {
          pendingType = [...childQualifiers, text(name)];
          if (keyword === 'namespace' && name.nextSibling?.name === ';') {
            childQualifiers = pendingType;
            pendingType = undefined;
          } else if (keyword !== 'namespace') {
            types.push({ name: pendingType.join('.'), line: lineAt(name.from) });
          }
        }
      }
      if (pendingType && child.name === 'Delim' && child.firstChild?.name === '{') {
        visit(child, pendingType);
        pendingType = undefined;
      } else {
        visit(child, childQualifiers);
        if (child.name === ';') pendingType = undefined;
      }
    }
  }
  visit(root, []);
  return { types, variables };
}

function valid(line?: number) { return line != null && line > 0 ? line : undefined; }

export function nodeSource(index: ReturnType<typeof indexSource>, snapshots: Snapshot[], step: number, nodeId: string): SourceJump | undefined {
  const snapshot = snapshots[step];
  if (!snapshot) return;
  const result = (line: number | undefined, label: string) => valid(line) ? { line: line!, label } : undefined;
  if (nodeId.startsWith('class:')) {
    const clazz = snapshot.classes.find(candidate => classNodeId(candidate) === nodeId);
    if (!clazz) return;
    const normalize = (name: string) => name.replace(/<[^<>]*>|`\d+/g, '').replace(/[$+]/g, '.');
    const id = normalize(clazz.id ?? clazz.name);
    const name = normalize(clazz.name);
    for (const key of [id, name]) {
      const candidates = index.types.filter(type => type.name === key || key.endsWith(`.${type.name}`));
      const longest = Math.max(0, ...candidates.map(type => type.name.length));
      const matches = candidates.filter(type => type.name.length === longest);
      if (matches.length === 1) return result(matches[0].line, '타입 선언');
    }
    return;
  }
  if (nodeId.startsWith('frame:')) {
    return result(snapshot.frames.find(frame => `frame:${frame.id}` === nodeId)?.line, '실행 위치');
  }
  if (nodeId.startsWith('local:')) {
    for (const frame of snapshot.frames) {
      const variable = frame.variables.find(item => `local:${frame.id}:${item.name}` === nodeId);
      if (!variable) continue;
      const present = (state: Snapshot) => state.frames.find(item => item.id === frame.id && item.variables.some(v => v.name === variable.name));
      let introduced = step;
      while (introduced > 0 && present(snapshots[introduced - 1])) introduced--;
      const earlier = snapshots[introduced - 1];
      const entered = !earlier?.frames.some(item => item.id === frame.id);
      const first = present(snapshots[introduced]) as Frame;
      const executed = sourceLineMarks(snapshots[introduced], earlier).executedLine;
      const observed = entered ? first.line : executed || first.line;
      const bindings = index.variables.filter(item => item.name === variable.name && item.from <= frame.line
        && item.to >= frame.line && (item.parameter ? entered : item.line <= frame.line && !entered));
      bindings.sort((a, b) => (a.to - a.from) - (b.to - b.from) || Math.abs(a.line - observed) - Math.abs(b.line - observed));
      if (bindings.length) return result(bindings[0].line, bindings[0].parameter ? '매개변수 선언' : '변수 선언');
      return result(observed, entered ? '프레임 진입' : '변수가 나타난 줄');
    }
  }
  if (nodeId.startsWith('object:')) {
    if (snapshot.globalsRef && nodeId === objectNodeId(snapshot.globalsRef)) {
      return result(snapshot.frames.find(frame => frame.scope === 'module')?.line || snapshot.executedLine, '모듈 실행 위치');
    }
    const start = snapshots.slice(0, step + 1).findIndex(state => state.heap.some(item => objectNodeId(item.id) === nodeId));
    if (start < 0) return;
    const first = snapshots[start];
    // Allocation inside a constructor is first visible through its receiver.
    let outside = 0;
    while (first.frames[outside]?.variables.some(v => v.role === 'receiver' && v.value.ref && objectNodeId(v.value.ref) === nodeId)
        && first.frames[outside].name !== '전역 변수') outside++;
    return result((outside > 0 ? first.frames[outside]?.line : 0) || sourceLineMarks(first, snapshots[start - 1]).executedLine || first.line,
      '객체가 처음 보인 줄');
  }
}
