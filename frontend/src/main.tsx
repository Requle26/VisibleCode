import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle, ChevronLeft, ChevronRight, Pause, Play, SkipBack, SkipForward, Terminal,
} from 'lucide-react';
import { CodeEditor } from './CodeEditor';
import { EditorResizeHandle } from './EditorResizeHandle';
import { languages, type Language } from './languages';
import { MemoryView } from './MemoryView';
import { classNodeId, hierarchyTypes } from './memoryGraph';
import { indexSource, nodeSource, type SourceJump } from './nodeSource';
import { describe, sourceLineMarks, typeDefinitionLabel, type Trace } from './trace';
import { useTheme } from './theme';
import './styles.css';

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const language = (Object.keys(languages) as Language[]).find(id => languages[id].path === path) ?? 'java';
const currentLanguage = languages[language];
const draftKey = `memory-studio:draft:${language}`;
const editorWidthKey = 'memory-studio:editor-width';
document.title = `${currentLanguage.name} Memory Studio`;

function readDraft() {
  try { return localStorage.getItem(draftKey) ?? currentLanguage.example; }
  catch { return currentLanguage.example; }
}

function readEditorWidth() {
  try {
    const width = Number(localStorage.getItem(editorWidthKey));
    return Number.isFinite(width) && width >= 320 ? width : null;
  } catch {
    return null;
  }
}

function App() {
  const { theme, toggleTheme } = useTheme();
  const [editorHidden, setEditorHidden] = useState(false);
  const [editorWidth, setEditorWidth] = useState(readEditorWidth);
  const workspace = useRef<HTMLElement>(null);
  const editorPanel = useRef<HTMLElement>(null);
  const resizeEditor = useCallback((width: number | null, save = false) => {
    setEditorWidth(width);
    if (!save) return;
    try {
      if (width === null) localStorage.removeItem(editorWidthKey);
      else localStorage.setItem(editorWidthKey, String(width));
    } catch { /* Resizing still works when local storage is unavailable. */ }
  }, []);
  const toggleEditor = useCallback(() => setEditorHidden(hidden => !hidden), []);
  const [code, setCode] = useState(readDraft);
  const initialCode = useRef(code);
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<Trace>();
  const [traceCode, setTraceCode] = useState<string>();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [smoothProgress, setSmoothProgress] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [sourceJump, setSourceJump] = useState<SourceJump>();
  const sourceIndex = useMemo(() => traceCode === code ? indexSource(code, language) : undefined, [code, traceCode]);
  const request = useRef<AbortController | null>(null);
  const autoTimer = useRef<number | undefined>(undefined);
  const isDirty = traceCode !== code;
  const steps = trace?.snapshots ?? [];
  const current = steps[step];
  const ready = !!current && !busy && !isDirty;
  const structureOnly = ready && current.structureOnly;
  const isLast = step === steps.length - 1;
  const diagnostic = !isDirty ? trace?.diagnostics?.[0] : undefined;
  const insight = describe(current, steps[step - 1], language);
  const error = !isDirty ? trace?.error : undefined;
  const runtimeError = !isDirty && (isLast || !steps.length) ? trace?.runtimeError : undefined;
  const focusedClass = ready && selected ? hierarchyTypes(current.classes).find(clazz => classNodeId(clazz) === selected) : undefined;
  const errorLine = diagnostic?.line ?? (runtimeError ? trace?.runtimeErrorLine || current?.line || current?.executedLine || 0 : 0);
  const previous = steps[step - 1];
  const lineMarks = useMemo(() => sourceLineMarks(ready ? current : undefined, ready ? previous : undefined),
    [ready, current, previous]);
  const jumpToNode = (id: string) => {
    if (!ready || !sourceIndex) return;
    const jump = nodeSource(sourceIndex, steps, step, id);
    if (!jump) return;
    setSourceJump(jump);
    setEditorHidden(false);
  };

  const run = useCallback(async (source: string, preview = false) => {
    window.clearTimeout(autoTimer.current);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPlaying(false);
    setSmoothProgress(false);
    setSelected(null);
    setSourceJump(undefined);
    if (!source.trim()) {
      setTrace({ error: `먼저 실행할 ${currentLanguage.name} 코드를 입력해 주세요.` });
      setTraceCode(source);
      setStep(0);
      setBusy(false);
      return;
    }
    setBusy(true);
    let result: Trace;
    try {
      const response = await fetch('/api/trace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: source, language }), signal: controller.signal,
      });
      result = await response.json();
    } catch {
      if (controller.signal.aborted) return;
      result = { error: `${currentLanguage.name} 실행 서버에 연결할 수 없어요. 서버를 확인한 뒤 다시 실행해 주세요.` };
    }
    if (controller.signal.aborted) return;
    const shared = preview ? result.snapshots?.findIndex(s => {
      const values = s.frames[0]?.variables;
      if (language === 'rust') return Boolean(values?.find(v => v.name === 'borrowed')?.value.ref);
      const alice = values?.find(v => v.name === 'alice')?.value.ref;
      const friend = values?.find(v => v.name === 'friend')?.value.ref;
      return Boolean(alice && alice === friend);
    }) : undefined;
    setTrace(result);
    setTraceCode(source);
    setStep(Math.max(0, shared ?? 0));
    setBusy(false);
  }, []);

  useEffect(() => {
    void run(initialCode.current, initialCode.current === currentLanguage.example);
    return () => { request.current?.abort(); window.clearTimeout(autoTimer.current); };
  }, [run]);

  useEffect(() => {
    if (!playing || !ready || isLast) return;
    const id = window.setTimeout(() => {
      setSmoothProgress(true);
      setSourceJump(undefined);
      setStep(step + 1);
      if (step + 1 >= steps.length - 1) setPlaying(false);
    }, 740);
    return () => window.clearTimeout(id);
  }, [playing, ready, isLast, step, steps.length]);

  const updateCode = (value: string) => {
    setCode(value);
    setSourceJump(undefined);
    try { localStorage.setItem(draftKey, value); } catch { /* The editor still works without storage. */ }
    setPlaying(false);
    request.current?.abort();
    setBusy(false);
    window.clearTimeout(autoTimer.current);
    autoTimer.current = window.setTimeout(() => void run(value), 620);
  };

  const go = (next: number) => { setPlaying(false); setSmoothProgress(false); setSourceJump(undefined); setStep(Math.min(Math.max(0, next), steps.length - 1)); };
  const togglePlaying = () => {
    if (!ready || steps.length <= 1) return;
    if (isLast) {
      setSmoothProgress(false);
      setSourceJump(undefined);
      setStep(0);
    }
    setPlaying(!playing);
  };
  const showFinalOutput = isLast || steps.length === 0;
  const output = !busy && !isDirty ? (showFinalOutput ? trace?.output ?? current?.output : current?.output) : '';
  const stderr = !busy && !isDirty ? (showFinalOutput ? trace?.stderr ?? current?.stderr : current?.stderr) : '';

  const editorControls = <>
    <nav className="language-switch" aria-label="언어 선택">
      {Object.entries(languages).map(([id, item]) => <a key={id} href={item.path} aria-current={id === language ? 'page' : undefined}>{item.name}</a>)}
    </nav>
    {ready && !structureOnly && <div className="transport" role="group" aria-label="실행 타임라인">
      <div className="player-buttons">
        <button className="icon-button" type="button" title="첫 단계" aria-label="첫 단계" onClick={() => go(0)} disabled={step === 0}><SkipBack size={13} /></button>
        <button className="icon-button" type="button" title="이전 단계" aria-label="이전 단계" onClick={() => go(step - 1)} disabled={step === 0}><ChevronLeft size={17} /></button>
        <button className="icon-button play-button" type="button" title={playing ? '일시정지' : '자동 재생'} aria-label={playing ? '일시정지' : '자동 재생'} onClick={togglePlaying} disabled={steps.length <= 1}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
        <button className="icon-button" type="button" title="다음 단계" aria-label="다음 단계" onClick={() => go(step + 1)} disabled={isLast}><ChevronRight size={17} /></button>
        <button className="icon-button" type="button" title="마지막 단계" aria-label="마지막 단계" onClick={() => go(steps.length - 1)} disabled={isLast}><SkipForward size={13} /></button>
      </div>
      <input className={`timeline${smoothProgress ? ' smooth-progress' : ''}`} aria-label="실행 단계" aria-valuetext={`${step + 1} / ${steps.length} 단계 · ${insight.title}`} type="range" min={0} max={Math.max(1, steps.length - 1)} value={step} onChange={event => go(Number(event.target.value))} disabled={steps.length < 2} style={{ '--progress': `${steps.length > 1 ? step / (steps.length - 1) * 100 : 0}%` } as React.CSSProperties} />
      <span className="step-counter" title={insight.body}>{step + 1}/{steps.length}</span>
    </div>}
  </>;

  return (
    <main ref={workspace} className={`workspace${editorHidden ? ' editor-hidden' : ''}`} aria-label={`${currentLanguage.name} Memory Studio`}
      style={editorWidth === null ? undefined : { '--editor-width': `${editorWidth}px` } as React.CSSProperties}>
      <section ref={editorPanel} id="code-panel" className="code-panel" aria-label={`${currentLanguage.name} 코드`} inert={editorHidden}>
        <div className="editor-surface">
          <CodeEditor language={language} code={code} theme={theme} {...lineMarks} errorLine={errorLine} sourceJump={sourceJump}
            onChange={updateCode} onRun={() => void run(code)} />
          {!editorHidden && <div className="editor-controls">{editorControls}</div>}
        </div>
        {(output || stderr || error || runtimeError) && (
          <div className={`console${error || runtimeError ? ' console-error' : ''}`} role="status" aria-label="출력 콘솔">
            {error ? <div className="error-title"><AlertCircle size={14} /> {error}</div> : output && <div className="console-heading"><Terminal size={14} /> 출력</div>}
            {error && !!trace?.diagnostics?.length && <ul>{trace.diagnostics.map((d, index) => <li key={index}><b>{d.line > 0 ? `줄 ${d.line}` : '컴파일'}</b> {d.message}</li>)}</ul>}
            {output && <pre>{output}</pre>}
            {stderr && <><div className="console-heading"><Terminal size={14} /> 표준 오류</div><pre aria-label="표준 오류">{stderr}</pre></>}
            {runtimeError && <div className="error-title"><AlertCircle size={14} /> {runtimeError}</div>}
          </div>
        )}
      </section>

      <EditorResizeHandle workspace={workspace} editor={editorPanel} setWidth={resizeEditor} editorHidden={editorHidden} />

      <section className="canvas" aria-label="메모리 맵" aria-busy={busy}>
        <MemoryView key={traceCode} language={language} theme={theme} toggleTheme={toggleTheme} editorHidden={editorHidden} toggleEditor={toggleEditor} snapshot={ready ? current : undefined} previous={ready ? steps[step - 1] : undefined} focus={selected} setFocus={setSelected} onNodeNavigate={jumpToNode} placeholder={busy ? '실행 단계를 기록하는 중…' : '코드를 실행하면 메모리 맵이 표시돼요.'} />
        {editorHidden && <div className="editor-controls canvas-editor-controls">{editorControls}</div>}
        {structureOnly ? <div className="trace-notice structure-notice" role="status">클래스 구조도 · 실행 진입점 없음</div>
          : trace?.warning && !isDirty && <div className="trace-notice" role="status"><AlertCircle size={15} /> {trace.warning}</div>}
        {focusedClass && <div className="canvas-controls">
          <div className="class-details" role="status">
            <strong>{focusedClass.name} · {typeDefinitionLabel(focusedClass)}</strong>
            {structureOnly && !!focusedClass.declaredFields?.length && <div className="method-list">
              {focusedClass.declaredFields.map((field, index) => <code key={index}>{field}</code>)}
            </div>}
            <div className="method-list">{focusedClass.methods.length ? focusedClass.methods.map((method, index) => <code key={index}>
              {focusedClass.abstractMethods?.includes(method) && <span className="abstract-method-tag">추상</span>}{method}
            </code>) : <span>{focusedClass.external ? '라이브러리 타입' : '메서드 없음'}</span>}</div>
          </div>
        </div>}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
