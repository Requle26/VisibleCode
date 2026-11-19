import { useEffect, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import { java, javaLanguage } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { csharp, csharpLanguage } from '@replit/codemirror-lang-csharp';
import { indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { acceptCompletion, CompletionContext, ifNotIn, snippetCompletion, type Completion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { tags } from '@lezer/highlight';
import { languages, type Language } from './languages';
import type { Theme } from './theme';
import type { SourceJump } from './nodeSource';

const mainTemplate = 'public static void main(String[] args) \\{\n\t${0}\n\\}';
const javaSnippets = [
  snippetCompletion(mainTemplate, { label: 'psvm', detail: 'main 메서드', type: 'method' }),
  snippetCompletion(mainTemplate, { label: 'psvma', detail: 'main 메서드', type: 'method' }),
  snippetCompletion('System.out.println(${1});${0}', { label: 'sout', detail: '표준 출력', type: 'method' }),
  snippetCompletion('System.err.println(${1});${0}', { label: 'serr', detail: '오류 출력', type: 'method' }),
  snippetCompletion('for (int ${1:i} = 0; ${1:i} < ${2:10}; ${1:i}++) \\{\n\t${0}\n\\}', { label: 'fori', detail: 'for 반복문', type: 'keyword' }),
];

const csharpSnippets = [
  snippetCompletion('static void Main(string[] args) \\{\n\t${0}\n\\}', { label: 'svm', detail: 'Main 메서드', type: 'method' }),
  snippetCompletion('Console.WriteLine(${1});${0}', { label: 'cw', detail: '표준 출력', type: 'method' }),
  snippetCompletion('for (int ${1:i} = 0; ${1:i} < ${2:10}; ${1:i}++) \\{\n\t${0}\n\\}', { label: 'fori', detail: 'for 반복문', type: 'keyword' }),
];

const completeSnippets = (options: Completion[]) => ifNotIn(['LineComment', 'BlockComment', 'StringLiteral', 'CharacterLiteral', 'TextBlock', 'Comment', 'String'], context => {
  const word = context.matchBefore(/[A-Za-z_$][\w$]*/);
  if (!word && !context.explicit) return null;
  const from = word?.from ?? context.pos;
  const prefix = context.state.sliceDoc(context.state.doc.lineAt(from).from, from);
  const nextChar = context.state.sliceDoc(context.pos, context.pos + 2);
  if (!/(?:^|[;{}])\s*$/.test(prefix) || /^[\p{ID_Continue}$]/u.test(nextChar)) return null;
  return { from, options, validFor: /^[\w$]*$/ };
});
const completeJava = completeSnippets(javaSnippets);
const completeCsharp = completeSnippets(csharpSnippets);
const languageExtensions = {
  java: [java(), javaLanguage.data.of({ autocomplete: completeJava })],
  csharp: [csharp(), csharpLanguage.data.of({ autocomplete: completeCsharp })],
  python: [python()],
};

function expandAbbreviation(view: EditorView, language: Language) {
  const { main, ranges } = view.state.selection;
  if (!main.empty || ranges.length !== 1 || view.composing || language === 'python') return false;
  const complete = language === 'java' ? completeJava : completeCsharp;
  const result = complete(new CompletionContext(view.state, main.head, false));
  if (!result || result instanceof Promise) return false;
  const abbreviation = view.state.sliceDoc(result.from, main.head);
  const completion = result.options.find(option => option.label === abbreviation);
  if (!completion || typeof completion.apply !== 'function') return false;
  completion.apply(view, completion, result.from, main.head);
  return true;
}

type LineMarks = { executedLine: number; nextLine: number; errorLine: number; callLines: number[] };
type MarkKind = 'executed' | 'next' | 'same' | 'calling' | 'recursive';

class LineBadge extends WidgetType {
  constructor(readonly kind: MarkKind) { super(); }
  eq(other: LineBadge) { return this.kind === other.kind; }
  toDOM() {
    const badge = document.createElement('span');
    badge.className = `cm-traceBadge ${this.kind}`;
    badge.textContent = { executed: '직전 실행', next: '다음 실행', same: '직전 · 다음 실행',
      calling: '호출 진행 중', recursive: '호출 진행 중 · 다음 실행' }[this.kind];
    return badge;
  }
}

const markLines = StateEffect.define<LineMarks>();
const decoration = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value;
    for (const effect of transaction.effects) {
      if (!effect.is(markLines)) continue;
      const { executedLine, nextLine, errorLine, callLines } = effect.value;
      const doc = transaction.state.doc;
      const marks = (line: number, lineClass: string, label?: MarkKind) => {
        if (line < 1 || line > doc.lines) return [];
        const { from, to } = doc.line(line);
        return [Decoration.line({ class: lineClass }).range(from),
          ...(label ? [Decoration.widget({ widget: new LineBadge(label), side: 1 }).range(to)] : [])];
      };
      next = Decoration.set(errorLine ? marks(errorLine, 'cm-errorLine') : [
        ...marks(executedLine, 'cm-executedLine', executedLine === nextLine ? 'same' : 'executed'),
        ...marks(executedLine !== nextLine && !callLines.includes(nextLine) ? nextLine : 0, 'cm-nextLine', 'next'),
        ...callLines.flatMap(line => marks(line, line === nextLine ? 'cm-nextLine cm-callingLine' : 'cm-callingLine', line === nextLine ? 'recursive' : 'calling')),
      ], true);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

const markSource = StateEffect.define<SourceJump | undefined>();
const sourceDecoration = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value;
    for (const effect of transaction.effects) if (effect.is(markSource)) {
      const jump = effect.value;
      next = jump && jump.line > 0 && jump.line <= transaction.state.doc.lines
        ? Decoration.set(Decoration.line({ class: 'cm-sourceJump', attributes: { title: jump.label } }).range(transaction.state.doc.line(jump.line).from))
        : Decoration.none;
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

const syntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.className, tags.typeName, tags.definition(tags.typeName)], color: 'var(--syntax-type)' },
  { tag: [tags.string, tags.character], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-literal)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
]);
const scheme = new Compartment();
const editorThemes = { light: EditorView.theme({}), dark: EditorView.theme({}, { dark: true }) };

export function CodeEditor({ language, code, theme, nextLine, executedLine, errorLine, callLines, sourceJump, onChange, onRun }: LineMarks & {
  language: Language; code: string; theme: Theme; sourceJump?: SourceJump; onChange: (value: string) => void; onRun: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applying = useRef(false);
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ extensions: [
        keymap.of([
          { key: 'Mod-Enter', run: () => { handlers.current.onRun(); return true; } },
          { key: 'Tab', run: view => acceptCompletion(view) || expandAbbreviation(view, language) },
          indentWithTab,
        ]),
        basicSetup, languageExtensions[language], syntaxHighlighting(syntax), scheme.of(editorThemes.light), decoration, sourceDecoration, EditorView.lineWrapping,
        EditorState.tabSize.of(4), indentUnit.of('    '),
        EditorView.contentAttributes.of({ 'aria-label': `${languages[language].name} 코드 편집기`, spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applying.current) handlers.current.onChange(update.state.doc.toString());
        }),
      ] }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: scheme.reconfigure(editorThemes[theme]) });
  }, [theme, language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === code) return;
    applying.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code } });
    applying.current = false;
  }, [code, language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const effects: StateEffect<unknown>[] = [markLines.of({ nextLine, executedLine, errorLine, callLines })];
    const primary = errorLine || nextLine || executedLine || callLines[0];
    if (primary > 0 && primary <= editor.state.doc.lines) {
      const doc = editor.state.doc;
      const nearby = (errorLine ? [] : [executedLine, ...callLines]).filter(line => line > 0 && line <= doc.lines && Math.abs(line - primary) <= 3);
      if (nearby.length) {
        const { from } = doc.line(Math.min(primary, ...nearby));
        const { to } = doc.line(Math.max(primary, ...nearby));
        effects.push(EditorView.scrollIntoView(EditorSelection.range(from, to), { y: 'nearest', yMargin: 28 }));
      } else {
        effects.push(EditorView.scrollIntoView(doc.line(primary).from, { y: 'nearest', yMargin: 28 }));
      }
    }
    editor.dispatch({ effects });
  }, [nextLine, executedLine, errorLine, callLines, language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: markSource.of(sourceJump) });
    if (!sourceJump || sourceJump.line < 1 || sourceJump.line > editor.state.doc.lines) return;
    const scroll = () => editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.doc.line(sourceJump.line).from, { y: 'center' }) });
    const id = requestAnimationFrame(scroll);
    const workspace = host.current?.closest('.workspace');
    const afterOpen = (event: Event) => {
      if (event.target === workspace && (event as TransitionEvent).propertyName === '--editor-open') scroll();
    };
    workspace?.addEventListener('transitionend', afterOpen);
    return () => { cancelAnimationFrame(id); workspace?.removeEventListener('transitionend', afterOpen); };
  }, [sourceJump, language]);

  return <div className="editor" ref={host} />;
}
