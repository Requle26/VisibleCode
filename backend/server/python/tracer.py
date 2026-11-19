import contextlib
import io
import inspect
import itertools
import json
import sys
import time
import types
import weakref
from pathlib import Path


class LimitReached(BaseException):
    pass


class Output(io.StringIO):
    def write(self, text):
        super().write(text[:max(0, 20000 - self.tell())])
        return len(text)


def trace(file):
    try:
        code = compile(Path(file).read_text(encoding='utf-8'), file, 'exec')
    except SyntaxError as exc:
        return {'error': 'Python 문법 오류가 있어요.', 'diagnostics': [{'line': exc.lineno or 0, 'message': exc.msg}]}

    module = types.ModuleType('__main__')
    namespace = vars(module)
    namespace['__file__'] = file
    snapshots, identities, known, frame_ids = [], {}, {}, {}
    class_ids = {}
    class_sequence = itertools.count(1)
    output = Output()
    sequence = itertools.count(1)
    started = time.monotonic()
    error, warning = None, None
    error_line = 0
    previous_line = 0

    def is_hidden(name, value):
        return name.startswith('__') or type(value) in (types.FunctionType, types.ModuleType) or isinstance(value, type)

    def type_name(value):
        return type.__getattribute__(type(value), '__qualname__')

    def class_id(clazz):
        key = id(clazz)
        entry = class_ids.get(key)
        if entry is None or entry[0]() is not clazz:
            entry = (weakref.ref(clazz), f'py:{next(class_sequence)}')
            class_ids[key] = entry
        return entry[1]

    def frame_owner(frame, items):
        names = frame.f_code.co_varnames
        if not names or names[0] not in items:
            return None
        receiver = items[names[0]]
        clazz = receiver if isinstance(receiver, type) else type(receiver)
        for owner in type.__getattribute__(clazz, '__mro__'):
            member = type.__getattribute__(owner, '__dict__').get(frame.f_code.co_name)
            if type(member) is classmethod:
                member = member.__func__
            if type(member) is property and any(type(fn) is types.FunctionType and fn.__code__ is frame.f_code for fn in (member.fget, member.fset, member.fdel)):
                return owner
            if type(member) is types.FunctionType and member.__code__ is frame.f_code:
                return owner
        return None

    def short_scalar(value):
        if type(value) is str:
            return value if len(value) <= 240 else value[:239] + '…'
        if type(value) is bytes:
            return repr(value[:120]) + ('…' if len(value) > 120 else '')
        if type(value) is int and value.bit_length() > 400:
            return f'int ({value.bit_length()} bits)'
        return repr(value)

    def object_fields(obj):
        for owner in type.__getattribute__(type(obj), '__mro__'):
            members = type.__getattribute__(owner, '__dict__')
            descriptor = members.get('__dict__')
            if type(descriptor) is types.GetSetDescriptorType:
                attrs = descriptor.__get__(obj, owner)
                if type(attrs) is dict:
                    yield from attrs.items()
                break
        for owner in type.__getattribute__(type(obj), '__mro__'):
            for name, descriptor in type.__getattribute__(owner, '__dict__').items():
                if type(descriptor) is types.MemberDescriptorType and not name.startswith('__'):
                    try:
                        yield name, descriptor.__get__(obj, owner)
                    except AttributeError:
                        pass

    def capture(frame, line, finished=False, executed_line=None):
        queue = {}

        def var(name, item):
            if item is None:
                return {'name': name, 'type': 'NoneType', 'value': {'kind': 'null', 'display': 'None'}}
            key = id(item)
            if key not in identities:
                if len(identities) >= 180 or len(queue) >= 65:
                    return {'name': name, 'type': type_name(item), 'value': {'kind': 'primitive', 'display': '…'}}
                identities[key] = (str(len(identities) + 1), item)
            ref = identities[key][0]
            if ref not in queue and len(queue) < 65:
                queue[ref] = item
            return {'name': name, 'type': type_name(item), 'value': {'kind': 'reference', 'ref': ref, 'display': '@' + ref}}

        globals_ref = var('', namespace)['value']['ref']
        visible_globals = ((k, v) for k, v in namespace.items() if type(k) is str and not is_hidden(k, v))
        global_variables = [var(k, v) for k, v in itertools.islice(visible_globals, 60)]
        globals_truncated = next(visible_globals, None) is not None

        frames, classes = [], []
        while frame:
            if frame.f_code.co_filename == file:
                items = frame.f_locals
                name = frame.f_code.co_name
                is_module = name == '<module>'
                is_class = not is_module and items is not frame.f_globals and not frame.f_code.co_flags & inspect.CO_NEWLOCALS
                scope = 'module' if is_module else 'class' if is_class else None
                owner = frame_owner(frame, items) if scope is None else None
                receiver = frame.f_code.co_varnames[0] if owner is not None else None
                variables = global_variables if is_module and items is namespace else [
                    var(k, v) for k, v in itertools.islice(((k, v) for k, v in items.items()
                    if type(k) is str and not is_hidden(k, v) and not (is_class and type(v) in (property, staticmethod, classmethod))), 60)]
                for variable in variables:
                    if variable['name'] == receiver:
                        variable['role'] = 'receiver'
                if id(frame) not in frame_ids:
                    frame_ids[id(frame)] = str(next(sequence))
                frames.append({'id': frame_ids[id(frame)],
                               'name': '전역 변수' if is_module else name if is_class else name + '()',
                               'className': type.__getattribute__(owner, '__qualname__') if owner is not None else '',
                               'classId': class_id(owner) if owner is not None else None,
                               'line': frame.f_lineno, 'scope': scope,
                               'variables': variables})
            frame = frame.f_back

        seen_classes = set()

        def definition_kind(clazz):
            return 'interface' if type.__getattribute__(clazz, '__dict__').get('_is_protocol') is True else 'class'

        def add_class(clazz):
            if id(clazz) in seen_classes or len(classes) >= 30:
                return
            attrs = type.__getattribute__(clazz, '__dict__')
            if attrs.get('__module__') != '__main__':
                return
            seen_classes.add(id(clazz))
            methods, abstract_methods, fields, nested = [], [], [], []
            for name, value in attrs.items():
                value_type = type(value)
                if value_type in (types.FunctionType, staticmethod, classmethod):
                    signature = name + '()'
                    methods.append(signature)
                    function = value.__func__ if value_type in (staticmethod, classmethod) else value
                    if type(function) is types.FunctionType and function.__dict__.get('__isabstractmethod__') is True:
                        abstract_methods.append(signature)
                elif value_type is property:
                    signature = name + ' (프로퍼티)'
                    methods.append(signature)
                    if name in attrs.get('__abstractmethods__', ()):
                        abstract_methods.append(signature)
                elif isinstance(value, type):
                    nested.append(value)
                elif not is_hidden(name, value) and value_type not in (property, types.MemberDescriptorType, types.GetSetDescriptorType):
                    if len(fields) < 30:
                        fields.append(var(name, value))
            parents = [base for base in type.__getattribute__(clazz, '__bases__') if base is not object]
            bases = [{'id': class_id(base), 'name': type.__getattribute__(base, '__qualname__'), 'kind': definition_kind(base)} for base in parents]
            kind = definition_kind(clazz)
            classes.append({'id': class_id(clazz), 'name': type.__getattribute__(clazz, '__qualname__'), 'kind': kind,
                            'abstract': kind == 'class' and bool(attrs.get('__abstractmethods__')), 'bases': bases,
                            'fields': fields, 'methods': methods, 'abstractMethods': abstract_methods})
            for value in nested + parents:
                add_class(value)

        for value in namespace.values():
            if isinstance(value, type):
                add_class(value)

        seen = set()
        while len(seen) < len(queue):
            for ref, obj in list(queue.items()):
                if ref in seen:
                    continue
                seen.add(ref)
                fields, text, length, kind = [], None, -1, 'object'
                exact = type(obj)
                add_class(exact)
                if obj is namespace:
                    kind, length, fields = 'array', len(namespace), global_variables
                elif exact in (str, int, bool, float, complex, bytes):
                    text = short_scalar(obj)
                    kind = 'string' if exact is str else 'scalar'
                elif exact in (list, tuple, set, frozenset):
                    kind, length = 'array', len(obj)
                    fields = [var(f'[{i}]', item) for i, item in enumerate(itertools.islice(obj, 30))]
                elif exact is dict:
                    kind, length = 'array', len(obj)
                    for i, (key, item) in enumerate(itertools.islice(obj.items(), 30)):
                        inline = type(key) in (str, int, bool, float) or key is None
                        if not inline or id(key) in identities:
                            fields.append(var(f'[{i}].key', key))
                        label = repr(key[:48]) if type(key) is str else short_scalar(key) if inline else f'[{i}].value'
                        fields.append(var(label, item))
                else:
                    fields = [var(name, value) for name, value in itertools.islice(object_fields(obj), 30)]
                known[ref] = {'id': ref, 'type': type_name(obj), 'classId': class_id(exact), 'kind': kind, 'fields': fields,
                               'text': text, 'length': length, 'truncated': globals_truncated if obj is namespace else length > 30}

        return {'line': line, 'executedLine': previous_line if executed_line is None else executed_line, 'frames': frames, 'classes': classes,
                'globalsRef': globals_ref,
                'heap': [{**obj, 'reachable': ref in queue} for ref, obj in known.items()],
                'output': output.getvalue(), 'finished': finished}

    def step(frame, event, arg):
        nonlocal previous_line
        if frame.f_code.co_filename != file:
            return None
        if event in ('line', 'return'):
            if len(snapshots) >= 350 or time.monotonic() - started > 8.5:
                raise LimitReached()
            if event == 'return':
                # At return the last statement has already run; keep its values visible
                # for this snapshot without marking the same statement as upcoming.
                snapshots.append(capture(frame, 0, executed_line=frame.f_lineno))
            else:
                snapshots.append(capture(frame, frame.f_lineno))
            previous_line = frame.f_lineno
        if event == 'return':
            frame_ids.pop(id(frame), None)
        return step

    def failure_line(exc):
        line, trace = 0, exc.__traceback__
        while trace:
            if trace.tb_frame.f_code.co_filename == file:
                line = trace.tb_lineno
            trace = trace.tb_next
        return line

    old_main, old_argv = sys.modules['__main__'], sys.argv
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        sys.modules['__main__'] = module
        sys.argv = [file]
        sys.settrace(step)
        try:
            exec(code, namespace)
        except LimitReached:
            warning = '학습을 위해 최대 350단계 / 8.5초까지 표시합니다.'
        except SystemExit as exc:
            if exc.code not in (None, 0):
                error = f'SystemExit: {exc.code}'
                error_line = failure_line(exc)
        except BaseException as exc:
            error = f'{type(exc).__name__}: {exc}'
            error_line = failure_line(exc)
        finally:
            sys.settrace(None)
            sys.modules['__main__'] = old_main
            sys.argv = old_argv

    if error is None and warning is None:
        snapshots.append(capture(None, 0, True))
    return {'snapshots': snapshots, 'output': output.getvalue(), 'runtimeError': error, 'runtimeErrorLine': error_line, 'warning': warning}


if __name__ == '__main__':
    print(json.dumps(trace(sys.argv[1]), ensure_ascii=True))
