"""Capture Rust source-level snapshots inside LLDB's Python interpreter."""

import json
import os
import re
import time

import lldb


MAX_STEPS = 140
MAX_OUTPUT = 8000
MAX_OUTPUT_FILE = 1024 * 1024
STDOUT = 'stdout.txt'
STDERR = 'stderr.txt'
CRATE = 'codevis_rust'
MAX_TEXT = 180
MAX_ELEMENTS = 8


def text_prefix(path, limit=MAX_OUTPUT):
    try:
        with open(path, 'rb') as stream:
            data = stream.read(limit + 1)
    except FileNotFoundError:
        return ''
    trimmed = len(data) > limit
    return data[:limit].decode('utf-8', errors='ignore' if trimmed else 'replace') + ('\n…' if trimmed else '')


def entry_line(entry, source):
    file = entry.GetFileSpec()
    if file.GetFilename() == 'main.rs' and os.path.realpath(os.path.join(file.GetDirectory() or '', 'main.rs')) == source:
        return entry.GetLine()
    return 0


def source_line(frame, source):
    return entry_line(frame.GetLineEntry(), source) if frame.IsValid() else 0


def short_type(value):
    return (value.GetTypeName() or '?').replace(CRATE + '::', '').replace('alloc::boxed::', '')


def scalar(value):
    return value.GetValue() if value.IsValid() and value.GetError().Success() else None


def member(value, *names):
    for name in names:
        value = value.GetChildMemberWithName(name, lldb.eNoDynamicValues)
    return value


def number(value):
    error = lldb.SBError()
    result = value.GetValueAsUnsigned(error, 0)
    return result if error.Success() and value.IsValid() else None


def vec_parts(value):
    buf = member(value, 'buf')
    inner = member(buf, 'inner')
    raw = inner if inner.IsValid() else buf
    pointer = member(raw, 'ptr')
    for _ in range(3):
        if pointer.GetType().IsPointerType():
            break
        pointer = member(pointer, 'pointer')
    cap = member(raw, 'cap')
    if cap.GetNumChildren(2) == 1:
        cap = cap.GetChildAtIndex(0)
    return pointer, number(member(value, 'len')), number(cap)


def collection(value):
    """Decode a few known Rust layouts without evaluating code in the program."""
    name = value.GetTypeName() or ''
    if name == 'alloc::string::String':
        pointer, length, capacity = vec_parts(member(value, 'vec'))
        if capacity is not None and length is not None and length > capacity:
            return None
        return 'string', pointer, length, None
    if re.fullmatch(r'&(mut )?str', name):
        return 'string', member(value, 'data_ptr'), number(member(value, 'length')), None
    if name.startswith('alloc::vec::Vec<'):
        pointer, length, capacity = vec_parts(value)
        element = value.GetType().GetTemplateArgumentType(0)
        if not element.IsValid():
            element = pointer.GetType().GetPointeeType()
            # RawVecInner may store an erased byte pointer rather than T.
            if not element.IsValid() or not name.startswith('alloc::vec::Vec<' + (element.GetName() or '') + (',' if ',' in name else '>')):
                return None
        if capacity is not None and length is not None and element.GetByteSize() and length > capacity:
            return None
        return 'array', pointer, length, element
    if re.fullmatch(r'&(mut )?\[.+\]', name):
        pointer = member(value, 'data_ptr')
        return 'array', pointer, number(member(value, 'length')), pointer.GetType().GetPointeeType()
    return None


def collection_items(value):
    info = collection(value)
    if info is None:
        return None
    kind, pointer, length, element = info
    if length is None or (kind == 'array' and not element.IsValid()):
        return None
    address = number(pointer) if length else 0
    if length and not address:
        return None
    if kind == 'string':
        if not length:
            return kind, length, ''
        error = lldb.SBError()
        data = pointer.GetProcess().ReadMemory(address, min(length, MAX_TEXT), error)
        if error.Fail() or not data:
            return None
        trim = len(data) < length
        return kind, length, data.decode('utf-8', errors='ignore' if trim else 'replace') + ('…' if trim else '')
    size = element.GetByteSize()
    items = [pointer.CreateValueFromAddress(f'[{i}]', address + size * i, element)
             for i in range(min(length, MAX_ELEMENTS))]
    return kind, length, items


def enum_variant(value):
    variants = member(value, '$variants$')
    if not variants.IsValid():
        return False, None
    count = variants.GetNumChildren(65)
    if count > 64:
        return True, None
    for i in range(count):
        variant = variants.GetChildAtIndex(i)
        tag = member(variant, '$discr$')
        payload = member(variant, 'value')
        if payload.IsValid() and (count == 1 or (tag.IsValid() and variant.GetName() == '$variant$' + str(number(tag)))):
            # Some LLDBs synthesize a fake bitfield for a variant payload.
            # Its bytes can be from a different member; don't display them.
            if any(field.GetName() == 'value' and field.IsBitfield() for field in variant.GetType().fields):
                return True, None
            return True, payload
    # An unrecognized tag is not evidence for the niche/default variant:
    # some LLDB versions expose ordinals instead of the actual discriminants.
    return True, None


def variant_name(value):
    depth = 0
    name = []
    for char in short_type(value):
        if char == '<':
            depth += 1
        elif char == '>' and depth:
            depth -= 1
        elif not depth:
            name.append(char)
    return ''.join(name).rsplit('::', 1)[-1]


def preview(value, depth=0):
    if not value.IsValid() or not value.GetError().Success():
        return '확인할 수 없음'
    info = collection_items(value) if depth < 2 else None
    if info is not None:
        kind, length, contents = info
        if kind == 'string':
            return json.dumps(contents, ensure_ascii=False)
        parts = [preview(child, depth + 1) for child in contents[:4]]
        return '[' + ', '.join(parts + (['…'] if length > 4 else [])) + ']'
    if (value.GetTypeName() or '').startswith('alloc::collections::btree::map::BTreeMap<'):
        length = number(member(value, 'length'))
        return f'BTreeMap(항목 {length}개)' if length is not None else 'BTreeMap'
    is_enum, payload = enum_variant(value)
    if is_enum:
        if payload is None:
            return '열거형 미리보기 없음'
        name = variant_name(payload)
        count = payload.GetNumChildren(5)
        if not count or depth >= 2:
            return name
        return name + preview(payload, depth)
    summary = value.GetSummary() or scalar(value)
    if summary is not None:
        if value.GetType().IsPointerType():
            return '널 포인터' if value.GetValueAsUnsigned(0) == 0 else '포인터'
        return summary if len(summary) <= MAX_TEXT else summary[:MAX_TEXT - 1] + '…'
    count = value.GetNumChildren(5)
    if not count:
        return '()' if value.GetTypeName() in ('()', 'void') else '{}'
    if depth >= 2:
        return '…'
    children = [value.GetChildAtIndex(i) for i in range(min(count, 4))]
    parts = [preview(child, depth + 1) for child in children]
    if value.GetType().IsArrayType():
        return '[' + ', '.join(parts + (['…'] if count > 4 else [])) + ']'
    parts = [f'{child.GetName()}: {part}' for child, part in zip(children, parts)]
    return '{' + ', '.join(parts + (['…'] if count > 4 else [])) + '}'


def pointer_target(value):
    name = value.GetTypeName() or ''
    if name.startswith('alloc::boxed::Box<'):
        # Box's debug representation is either a pointer or a chain of single-field wrappers.
        for _ in range(5):
            if value.GetType().IsPointerType():
                return value, 'heap'
            if value.GetNumChildren(2) != 1:
                break
            value = value.GetChildAtIndex(0)
    if value.GetType().IsPointerType():
        # Some Rust/LLDB versions expose both Box<T> and &T as T*.
        return value, 'referent'
    return None, None


class Memory:
    def __init__(self):
        self.addresses = {}
        self.frames = {}
        self.next_object = 1
        self.next_frame = 1
        self.objects = {}

    def variable(self, value, depth=0):
        name = value.GetName() or '?'
        item = {'name': name, 'type': short_type(value)}
        pointer, region = pointer_target(value)
        address = pointer.GetValueAsUnsigned(0) if pointer is not None else 0
        if address and depth < 3 and len(self.objects) < 28:
            target = pointer.Dereference()
            if target.IsValid() and target.GetError().Success():
                key = (address, target.GetTypeName())
                if key not in self.addresses:
                    self.addresses[key] = str(self.next_object)
                    self.next_object += 1
                identifier = self.addresses[key]
                if identifier not in self.objects:
                    node = {'id': identifier, 'type': short_type(target), 'region': region, 'reachable': True}
                    self.objects[identifier] = node
                    self.describe_target(target, node, depth)
                elif region == 'heap':
                    self.objects[identifier]['region'] = 'heap'
                item['value'] = {'kind': 'reference', 'display': '@' + identifier, 'ref': identifier}
                return item
        display = '참조 미리보기 없음' if pointer is not None else preview(value)
        if len(display) > MAX_TEXT:
            display = display[:MAX_TEXT - 1] + '…'
        item['value'] = {'kind': 'primitive', 'display': display}
        return item

    def describe_target(self, target, node, depth):
        info = collection_items(target)
        if info is not None:
            kind, length, contents = info
            node.update(kind=kind, length=length, fields=[], text=None, truncated=False)
            if kind == 'string':
                node['text'] = contents
            else:
                node['fields'] = [self.variable(child, depth + 1) for child in contents]
                node['truncated'] = length > len(contents)
            return
        is_enum, payload = enum_variant(target)
        if is_enum and payload is not None:
            node['type'] += ' · ' + variant_name(payload)
        visible = payload if is_enum else target
        length = visible.GetNumChildren() if visible is not None else 0
        kind = 'array' if target.GetType().IsArrayType() else 'object' if length else 'scalar'
        node.update(kind=kind, length=length, truncated=length > MAX_ELEMENTS,
                    text=preview(target) if not length else None,
                    fields=[self.variable(visible.GetChildAtIndex(i), depth + 1) for i in range(min(length, MAX_ELEMENTS))])

    def snapshot(self, thread, source, line, executed):
        frames = []
        live_frames = {}
        self.objects = {}
        # Address identity is only meaningful while it is continuously visible.
        for index in range(min(thread.GetNumFrames(), 24)):
            frame = thread.GetFrameAtIndex(index)
            frame_line = source_line(frame, source)
            if not frame_line:
                continue
            raw_name = frame.GetFunctionName() or '?'
            name = raw_name[len(CRATE) + 2:] if raw_name.startswith(CRATE + '::') else raw_name
            name = re.sub(r'::h[0-9a-f]{16}$', '', name)
            key = (thread.GetThreadID(), frame.GetCFA(), name)
            identifier = self.frames.get(key)
            if identifier is None:
                identifier = str(self.next_frame)
                self.next_frame += 1
            live_frames[key] = identifier
            locals_by_name = {}
            values = frame.GetVariables(True, True, False, True, lldb.eNoDynamicValues)
            for i in range(min(values.GetSize(), 32)):
                value = values.GetValueAtIndex(i).GetNonSyntheticValue()
                declaration = value.GetDeclaration()
                # Formatting macros may introduce a DWARF local `args` on the caller's line.
                if value.GetName() == 'args' and 'core::fmt::rt::Argument' in (value.GetTypeName() or ''):
                    continue
                if value.GetName() and value.GetError().Success() and entry_line(declaration, source):
                    locals_by_name[value.GetName()] = {**self.variable(value), 'sourceLine': declaration.GetLine()}
            frames.append({'id': identifier, 'name': name + '()', 'className': '', 'line': frame_line,
                           'variables': list(locals_by_name.values())})
        self.frames = live_frames
        self.addresses = {key: identifier for key, identifier in self.addresses.items() if identifier in self.objects}
        return {'line': line, 'executedLine': executed, 'frames': frames, 'heap': list(self.objects.values()),
                'classes': [], 'output': text_prefix(STDOUT), 'stderr': text_prefix(STDERR), 'finished': False}


def wait_for_stop(listener, deadline):
    while time.monotonic() < deadline:
        if any(os.path.exists(path) and os.path.getsize(path) > MAX_OUTPUT_FILE for path in (STDOUT, STDERR)):
            return None, 'Rust 프로그램의 출력 크기 제한을 초과했어요.'
        event = lldb.SBEvent()
        if not listener.WaitForEvent(1, event) or not lldb.SBProcess.EventIsProcessEvent(event):
            continue
        state = lldb.SBProcess.GetStateFromEvent(event)
        if state == lldb.eStateStopped and lldb.SBProcess.GetRestartedFromEvent(event):
            continue
        if state in (lldb.eStateStopped, lldb.eStateCrashed, lldb.eStateExited, lldb.eStateDetached):
            return state, None
    return None, 'Rust 프로그램의 실행 시간이 초과되었어요.'


def trace(debugger):
    source = os.path.realpath('main.rs')
    target = debugger.GetSelectedTarget()
    # Source breakpoints survive calls into std and returns from inlined library
    # code, where debugger step plans can otherwise skip the rest of main.
    module = target.FindModule(target.GetExecutable())
    lines = set()
    for index in range(module.GetNumCompileUnits()):
        unit = module.GetCompileUnitAtIndex(index)
        for i in range(unit.GetNumLineEntries()):
            line = entry_line(unit.GetLineEntryAtIndex(i), source)
            if line:
                lines.add(line)
    if not lines:
        return {'error': 'Rust 소스의 디버그 정보를 찾을 수 없어요.'}
    source_file = lldb.SBFileSpec(source)
    modules = lldb.SBFileSpecList()
    modules.Append(target.GetExecutable())
    locations = sum(target.BreakpointCreateByLocation(source_file, line, 0, 0, modules, False).GetNumLocations() for line in sorted(lines))
    if not locations:
        return {'error': 'Rust 소스의 실행 위치를 찾을 수 없어요.'}
    debugger.HandleCommand('settings set target.disable-aslr false')
    debugger.SetAsync(True)
    listener = lldb.SBListener('codevis-rust')
    launch = lldb.SBLaunchInfo([])
    launch.SetLaunchFlags(launch.GetLaunchFlags() & ~lldb.eLaunchFlagDisableASLR)
    launch.SetListener(listener)
    launch.SetWorkingDirectory(os.getcwd())
    launch.AddOpenFileAction(0, os.devnull, True, False)
    launch.AddOpenFileAction(1, os.path.abspath(STDOUT), False, True)
    launch.AddOpenFileAction(2, os.path.abspath(STDERR), False, True)
    error = lldb.SBError()
    process = target.Launch(launch, error)
    if error.Fail():
        return {'error': 'LLDB가 Rust 프로그램을 실행하지 못했어요.',
                'diagnostics': [{'line': 0, 'message': str(error)}]}

    deadline = time.monotonic() + 6
    memory = Memory()
    snapshots = []
    runtime_error, warning = None, None
    state = None
    last_line = 0
    exit_line = 0
    try:
        for _ in range(MAX_STEPS * 3):
            state, runtime_error = wait_for_stop(listener, deadline)
            if state == lldb.eStateExited:
                if process.GetExitStatus() != 0:
                    runtime_error = f'Rust 프로그램이 종료 코드 {process.GetExitStatus()}(으)로 끝났어요.'
                break
            if state == lldb.eStateDetached:
                runtime_error = 'Rust 프로그램의 실행 추적이 중단되었어요.'
                break
            if state not in (lldb.eStateStopped, lldb.eStateCrashed):
                break
            thread = process.GetSelectedThread()
            # Select the thread responsible for the stop, rather than a waiting caller.
            for candidate in process:
                if candidate.GetStopReason() not in (lldb.eStopReasonNone, lldb.eStopReasonInvalid):
                    thread = candidate
                    break
            frame = thread.GetFrameAtIndex(0)
            line = source_line(frame, source)
            if line:
                snapshot = memory.snapshot(thread, source, line, last_line)
                if not snapshots or any(snapshot[key] != snapshots[-1][key] for key in ('line', 'frames', 'heap', 'output', 'stderr')):
                    if snapshots and snapshot['frames']:
                        resumed = snapshot['frames'][0]['id']
                        caller = next((f for f in snapshots[-1]['frames'][1:] if f['id'] == resumed), None)
                        if caller:
                            snapshot['executedLine'] = caller['line']
                    snapshots.append(snapshot)
                    last_line = line
            reason = thread.GetStopReason()
            if state == lldb.eStateCrashed or reason in (lldb.eStopReasonSignal, lldb.eStopReasonException):
                runtime_error = thread.GetStopDescription(240) or 'Rust 프로그램 실행 중 오류가 발생했어요.'
                exit_line = next((source_line(f, source) for f in thread if source_line(f, source)), last_line)
                break
            if len(snapshots) >= MAX_STEPS:
                warning = f'처음 {MAX_STEPS}단계까지만 기록했어요.'
                break
            process.Continue()
        else:
            warning = 'Rust 실행 추적 한도에 도달했어요.'
    finally:
        if state != lldb.eStateExited:
            process.Kill()

    output, stderr = text_prefix(STDOUT), text_prefix(STDERR)
    if state == lldb.eStateExited and process.GetExitStatus() == 101:
        panics = re.findall(r"(?m)^thread '[^\n]*?'(?: \(\d+\))? panicked at (?:[^\n]*[/\\])?main\.rs:(\d+):\d+:", stderr)
        if panics:
            exit_line = int(panics[-1])
    if state == lldb.eStateExited:
        snapshots.append({'line': exit_line, 'executedLine': last_line, 'frames': [], 'heap': [], 'classes': [],
                          'output': output, 'stderr': stderr, 'finished': True})
    return {'snapshots': snapshots, 'output': output, 'stderr': stderr, 'warning': warning,
            'runtimeError': runtime_error, 'runtimeErrorLine': (exit_line or last_line) if runtime_error else 0}


def run(driver, _command, _context, _result, _internal):
    # A separate debugger avoids the CLI rendering source at every breakpoint.
    debugger = lldb.SBDebugger.Create(False)
    try:
        executable = driver.GetSelectedTarget().GetExecutable().fullpath
        debugger.CreateTarget(executable)
        result = trace(debugger)
    finally:
        lldb.SBDebugger.Destroy(debugger)
    with open('trace.json', 'w', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False)


def __lldb_init_module(debugger, _internal):
    debugger.HandleCommand('command script add -f ' + __name__ + '.run codevis-rust-trace')
