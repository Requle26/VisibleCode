import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

const minWidth = 320;
const canvasReserve = 308; // The 8px handle and at least 300px for the canvas.

export function EditorResizeHandle({ workspace, editor, setWidth, editorHidden }: {
  workspace: RefObject<HTMLElement | null>;
  editor: RefObject<HTMLElement | null>;
  setWidth: (width: number | null, save?: boolean) => void;
  editorHidden: boolean;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const [size, setSize] = useState({ width: minWidth, max: minWidth });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const panel = editor.current;
    const area = workspace.current;
    if (!panel || !area) return;
    const measure = () => {
      if (!panel.offsetWidth) return;
      const width = panel.offsetWidth;
      const max = Math.max(minWidth, area.clientWidth - canvasReserve);
      setSize(current => current.width === width && current.max === max ? current : { width, max });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(area);
    measure();
    return () => observer.disconnect();
  }, [editor, workspace]);

  const clampWidth = (width: number) => Math.max(minWidth, Math.min(Math.round(width), (workspace.current?.clientWidth ?? 0) - canvasReserve));

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.width !== current.startWidth) setWidth(current.width, true);
  };

  return <div className={`editor-divider${dragging ? ' dragging' : ''}`} tabIndex={0} role="separator" inert={editorHidden}
    aria-label="코드 입력창 너비 조절" aria-orientation="vertical" aria-controls="code-panel"
    aria-valuemin={minWidth} aria-valuemax={size.max} aria-valuenow={size.width} aria-valuetext={`${size.width}픽셀`}
    title="드래그로 너비 조절 · 더블 클릭으로 기본 너비"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || !editor.current || drag.current) return;
      event.preventDefault();
      const width = editor.current.offsetWidth;
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const width = clampWidth(current.startWidth + event.clientX - current.startX);
      if (width === current.width) return;
      current.width = width;
      setWidth(width);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => setWidth(null, true)}
    onKeyDown={event => {
      const amount = event.shiftKey ? 64 : 24;
      const width = editor.current?.offsetWidth ?? size.width;
      const target = event.key === 'ArrowLeft' ? width - amount : event.key === 'ArrowRight' ? width + amount
        : event.key === 'Home' ? minWidth : event.key === 'End' ? size.max : undefined;
      if (target === undefined) return;
      event.preventDefault();
      setWidth(clampWidth(target), true);
    }}>
    <span aria-hidden="true" />
  </div>;
}
