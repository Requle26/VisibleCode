import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.ElementFilter;
import javax.tools.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Real JVM snapshots, serialized without a runtime dependency. */
public class MemoryTracer {
    private static final Set<String> PRIMITIVE_WRAPPERS = Set.of(
        "java.lang.Boolean", "java.lang.Byte", "java.lang.Character", "java.lang.Short",
        "java.lang.Integer", "java.lang.Long", "java.lang.Float", "java.lang.Double");

    private VirtualMachine vm;
    private Process process;
    private final Set<String> userClasses = new LinkedHashSet<>();
    private final Map<String, Map<String, Object>> typeDefinitions = new LinkedHashMap<>();
    private final Map<Long, String> ids = new LinkedHashMap<>();
    private record Invocation(Method method, String id) { }
    private final Map<Long, NavigableMap<Integer, Invocation>> invocations = new HashMap<>();
    private int invocationSequence;
    private final Map<String, Map<String, Object>> knownHeap = new LinkedHashMap<>();
    private final List<Object> snapshots = new ArrayList<>();
    private final StringBuffer stdout = new StringBuffer();
    private final StringBuffer stderr = new StringBuffer();
    private final List<Thread> readers = new ArrayList<>();
    private final Map<String, Object> result = new LinkedHashMap<>();
    private int previousLine = 0;
    private int previousDepth;
    private List<Location> previousLocations = List.of();
    private Map<String, Object> exitState;
    private long started;
    private boolean limited;
    private String runtimeError;
    private int runtimeErrorLine;

    public static void main(String[] args) {
        MemoryTracer tracer = new MemoryTracer();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> tracer.cleanup()));
        try { tracer.run(Path.of(args[0])); }
        catch (Throwable ex) { tracer.result.put("error", "JVM 실행 오류: " + ex.getMessage()); }
        finally { tracer.cleanup(); }
        System.out.println(json(tracer.result));
    }

    private void run(Path dir) throws Exception {
        String source = Files.readString(dir.resolve("source.txt"));
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        JavaFileObject input = new SimpleJavaFileObject(URI.create("string:///Source.java"), JavaFileObject.Kind.SOURCE) {
            @Override public CharSequence getCharContent(boolean ignore) { return source; }
        };
        JavacTask parser = (JavacTask) compiler.getTask(new StringWriter(), null, diagnostics, List.of("-proc:none"), null, List.of(input));
        CompilationUnitTree unit = parser.parse().iterator().next();
        String packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString() + ".";
        String fileClass = null;
        Set<String> entryClasses = new LinkedHashSet<>();
        for (Tree tree : unit.getTypeDecls()) {
            if (tree instanceof ClassTree clazz) {
                if (fileClass == null || clazz.getModifiers().getFlags().contains(Modifier.PUBLIC)) fileClass = clazz.getSimpleName().toString();
                for (Tree member : clazz.getMembers()) {
                    if (member instanceof MethodTree method && isEntryPoint(method)) {
                        entryClasses.add(clazz.getSimpleName().toString());
                    }
                }
            }
        }
        if (fileClass == null) { result.put("error", "클래스를 작성해 주세요. 예: public class Main { ... }"); return; }
        Path javaFile = dir.resolve(fileClass + ".java");
        Files.writeString(javaFile, source);
        diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager manager = compiler.getStandardFileManager(diagnostics, Locale.KOREAN, StandardCharsets.UTF_8)) {
            JavacTask compilation = (JavacTask) compiler.getTask(new StringWriter(), manager, diagnostics,
                List.of("-g", "-encoding", "UTF-8", "-proc:none", "-d", dir.toString()), null,
                manager.getJavaFileObjects(javaFile.toFile()));
            var units = compilation.parse();
            compilation.analyze();
            if (diagnostics.getDiagnostics().stream().noneMatch(d -> d.getKind() == Diagnostic.Kind.ERROR)) {
                collectTypeDefinitions(compilation, units);
                compilation.generate();
            }
            if (diagnostics.getDiagnostics().stream().anyMatch(d -> d.getKind() == Diagnostic.Kind.ERROR)) {
                result.put("error", "컴파일 오류가 있어요. 아래 내용을 확인해 주세요.");
                result.put("diagnostics", diagnostics.getDiagnostics().stream()
                    .filter(d -> d.getKind() == Diagnostic.Kind.ERROR)
                    .map(d -> map("line", d.getLineNumber(), "message", d.getMessage(Locale.KOREAN))).toList());
                return;
            }
        }
        if (entryClasses.isEmpty()) { result.put("error", "실행을 시작할 public static void main(String[] args) 메서드가 필요합니다."); return; }
        String mainClass = packageName + (entryClasses.contains(fileClass) ? fileClass : entryClasses.iterator().next());
        try (var files = Files.walk(dir)) {
            files.filter(p -> p.toString().endsWith(".class")).forEach(p -> {
                String name = dir.relativize(p).toString().replace(File.separatorChar, '.');
                userClasses.add(name.substring(0, name.length() - 6));
            });
        }
        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("main").setValue(mainClass);
        arguments.get("options").setValue("-Xmx96m -XX:+UseSerialGC -cp \"" + dir + "\"");
        vm = connector.launch(arguments);
        process = vm.process();
        readStream(process.getInputStream(), stdout);
        readStream(process.getErrorStream(), stderr);
        EventRequestManager requests = vm.eventRequestManager();
        for (String className : userClasses) {
            MethodEntryRequest entry = requests.createMethodEntryRequest();
            entry.addClassFilter(className);
            entry.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            entry.enable();
        }
        ClassPrepareRequest prepare = requests.createClassPrepareRequest();
        prepare.addClassFilter(mainClass);
        prepare.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        prepare.enable();
        ExceptionRequest exceptions = requests.createExceptionRequest(null, false, true);
        exceptions.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        exceptions.enable();
        started = System.currentTimeMillis();
        boolean done = false;
        while (!done) {
            if (snapshots.size() >= 350 || System.currentTimeMillis() - started > 8500) { limited = true; break; }
            EventSet events;
            try { events = vm.eventQueue().remove(500); }
            catch (VMDisconnectedException ex) { break; }
            if (events == null) continue;
            // Entry and stepping can arrive at the same location. Assign the new
            // invocation before capturing its first line, even at a reused depth.
            for (Event event : events) {
                if (event instanceof MethodEntryEvent entry) {
                    int depth = entry.thread().frameCount();
                    var active = invocations.computeIfAbsent(entry.thread().uniqueID(), ignored -> new TreeMap<>());
                    active.tailMap(depth, true).clear();
                    active.put(depth, new Invocation(entry.method(), Integer.toString(++invocationSequence)));
                }
            }
            for (Event event : events) {
                if (event instanceof ClassPrepareEvent prepared) {
                    List<Method> mains = prepared.referenceType().methodsByName("main", "([Ljava/lang/String;)V");
                    if (mains.isEmpty()) { runtimeError = "main 메서드의 매개변수는 String[] args여야 합니다."; done = true; break; }
                    BreakpointRequest breakpoint = requests.createBreakpointRequest(mains.get(0).location());
                    breakpoint.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                    breakpoint.enable();
                    MethodExitRequest exit = requests.createMethodExitRequest();
                    exit.addClassFilter(mainClass);
                    exit.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                    exit.enable();
                } else if (event instanceof BreakpointEvent breakpoint) {
                    capture(breakpoint.thread(), breakpoint.location().lineNumber(), false);
                    requests.deleteEventRequest(breakpoint.request());
                    step(breakpoint.thread());
                } else if (event instanceof StepEvent step) {
                    requests.deleteEventRequest(step.request());
                    if (userClasses.contains(step.location().declaringType().name())) {
                        // A caller paused mid-expression may still have an object on its JVM
                        // operand stack. Wait for the next source line instead of showing
                        // that unobservable intermediate state as a lost reference.
                        Location caller = previousLocations.size() > 1 ? previousLocations.get(1) : null;
                        boolean midExpression = caller != null && step.thread().frameCount() < previousDepth
                            && caller.method().equals(step.location().method()) && caller.lineNumber() == step.location().lineNumber();
                        if (!midExpression) capture(step.thread(), step.location().lineNumber(), false);
                        step(step.thread());
                    }
                } else if (event instanceof MethodExitEvent exit) {
                    if (exit.method().name().equals("main") && exit.method().signature().equals("([Ljava/lang/String;)V")
                            && exit.thread().frameCount() == 1) capture(exit.thread(), 0, true);
                } else if (event instanceof ExceptionEvent exception) {
                    runtimeError = exception.exception().referenceType().name();
                    try {
                        Field message = exception.exception().referenceType().fieldByName("detailMessage");
                        if (message != null && exception.exception().getValue(message) instanceof StringReference text) runtimeError += ": " + text.value();
                    } catch (Exception ignored) { }
                    runtimeErrorLine = exception.thread().frames().stream().map(StackFrame::location)
                        .filter(loc -> userClasses.contains(loc.declaringType().name()) && loc.lineNumber() > 0)
                        .mapToInt(Location::lineNumber).findFirst().orElse(previousLine);
                    capture(exception.thread(), runtimeErrorLine, false);
                } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                    done = true;
                }
            }
            try { events.resume(); } catch (VMDisconnectedException ignored) { done = true; }
        }
        if (limited) result.put("warning", "학습에 적합하도록 최대 350단계 / 8.5초까지 표시합니다. 반복 횟수를 줄여 주세요.");
        if (!limited && process.waitFor(500, TimeUnit.MILLISECONDS) && process.exitValue() != 0 && runtimeError == null && !snapshots.isEmpty()) {
            runtimeError = "프로그램이 종료 코드 " + process.exitValue() + "(으)로 끝났어요.";
            runtimeErrorLine = previousLine;
        }
        cleanup();
        for (Thread reader : readers) reader.join(500);
        if (snapshots.isEmpty() && runtimeError == null && !limited) {
            result.put("error", "main 메서드를 실행하지 못했습니다. public static void main(String[] args)로 선언했는지 확인해 주세요.");
            return;
        }
        if (!limited && runtimeError == null && !snapshots.isEmpty()) {
            @SuppressWarnings("unchecked") Map<String, Object> last = exitState != null ? exitState : (Map<String, Object>) snapshots.get(snapshots.size() - 1);
            Set<String> roots = new HashSet<>();
            @SuppressWarnings("unchecked") List<Map<String, Object>> classes = (List<Map<String, Object>>) last.get("classes");
            for (Map<String, Object> clazz : classes) {
                @SuppressWarnings("unchecked") List<Map<String, Object>> fields = (List<Map<String, Object>>) clazz.get("fields");
                for (Map<String, Object> field : fields) collectRef(field.get("value"), roots);
            }
            boolean changed;
            do {
                int before = roots.size();
                for (String id : new ArrayList<>(roots)) {
                    Map<String, Object> object = knownHeap.get(id);
                    if (object != null) {
                        @SuppressWarnings("unchecked") List<Map<String, Object>> fields = (List<Map<String, Object>>) object.get("fields");
                        for (Map<String, Object> field : fields) collectRef(field.get("value"), roots);
                    }
                }
                changed = before != roots.size();
            } while (changed);
            List<Object> heap = new ArrayList<>();
            knownHeap.forEach((id, value) -> { var copy = new LinkedHashMap<>(value); copy.put("reachable", roots.contains(id)); heap.add(copy); });
            snapshots.add(map("line", 0, "executedLine", previousLine, "frames", List.of(), "heap", heap,
                "classes", classes, "output", stdout.toString(), "stderr", stderr.toString(), "finished", true));
        }
        result.put("snapshots", snapshots);
        result.put("output", stdout.toString());
        result.put("stderr", stderr.toString());
        result.put("runtimeError", runtimeError);
        result.put("runtimeErrorLine", runtimeErrorLine);
        result.put("mainClass", mainClass);
        result.put("engine", "JVM / JDI");
    }

    private static boolean isEntryPoint(MethodTree method) {
        if (!method.getName().contentEquals("main") || method.getReturnType() == null
            || !method.getReturnType().toString().equals("void") || method.getParameters().size() != 1
            || !method.getModifiers().getFlags().containsAll(Set.of(Modifier.PUBLIC, Modifier.STATIC))) return false;
        Tree type = method.getParameters().get(0).getType();
        while (type instanceof AnnotatedTypeTree annotated) type = annotated.getUnderlyingType();
        if (!(type instanceof ArrayTypeTree array)) return false;
        type = array.getType();
        while (type instanceof AnnotatedTypeTree annotated) type = annotated.getUnderlyingType();
        return type.toString().equals("String") || type.toString().equals("java.lang.String");
    }

    private void collectTypeDefinitions(JavacTask task, Iterable<? extends CompilationUnitTree> units) {
        var trees = Trees.instance(task);
        var elements = task.getElements();
        var types = task.getTypes();
        new TreePathScanner<Void, Void>() {
            @Override public Void visitClass(ClassTree tree, Void context) {
                if (trees.getElement(getCurrentPath()) instanceof TypeElement type) {
                    String id = elements.getBinaryName(type).toString();
                    if (!id.isEmpty()) {
                        List<Object> bases = new ArrayList<>();
                        List<TypeMirror> parents = new ArrayList<>();
                        parents.add(type.getSuperclass());
                        parents.addAll(type.getInterfaces());
                        for (TypeMirror parent : parents) {
                            if (!(parent instanceof DeclaredType declared) || !(declared.asElement() instanceof TypeElement owner)) continue;
                            String parentId = elements.getBinaryName(owner).toString();
                            if (Set.of("java.lang.Object", "java.lang.Enum", "java.lang.Record").contains(parentId)) continue;
                            bases.add(map("id", parentId, "name", simple(parentId), "kind", owner.getKind().isInterface() ? "interface" : "class"));
                        }
                        List<String> methods = new ArrayList<>(), abstractMethods = new ArrayList<>();
                        var members = new ArrayList<>(ElementFilter.constructorsIn(type.getEnclosedElements()));
                        members.addAll(ElementFilter.methodsIn(type.getEnclosedElements()));
                        for (var method : members) {
                            String name = method.getSimpleName().contentEquals("<init>") ? simple(id) : method.getSimpleName().toString();
                            String signature = name + "(" + String.join(", ", method.getParameters().stream()
                                .map(param -> simple(types.erasure(param.asType()).toString())).toList()) + ")";
                            methods.add(signature);
                            if (method.getModifiers().contains(Modifier.ABSTRACT)) abstractMethods.add(signature);
                        }
                        typeDefinitions.put(id, map("id", id, "name", simple(id), "kind", type.getKind().isInterface() ? "interface" : "class",
                            "abstract", !type.getKind().isInterface() && type.getModifiers().contains(Modifier.ABSTRACT),
                            "bases", bases, "fields", List.of(), "methods", methods, "abstractMethods", abstractMethods));
                    }
                }
                return super.visitClass(tree, context);
            }
        }.scan(units, null);
    }

    private void step(ThreadReference thread) {
        StepRequest request = vm.eventRequestManager().createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
        for (String prefix : List.of("java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "com.oracle.*")) request.addClassExclusionFilter(prefix);
        request.addCountFilter(1);
        request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        request.enable();
    }

    private void capture(ThreadReference thread, int line, boolean finished) throws Exception {
        Map<String, ObjectReference> reachable = new LinkedHashMap<>();
        List<Object> frames = new ArrayList<>();
        List<StackFrame> stack = thread.frames();
        List<Location> locations = new ArrayList<>();
        var active = invocations.computeIfAbsent(thread.uniqueID(), ignored -> new TreeMap<>());
        active.tailMap(stack.size(), false).clear();
        for (int i = 0; i < stack.size(); i++) {
            StackFrame frame = stack.get(i);
            if (!userClasses.contains(frame.location().declaringType().name())) continue;
            locations.add(frame.location());
            List<Object> variables = new ArrayList<>();
            if (frame.thisObject() != null) variables.add(map("name", "this", "type", simple(frame.thisObject().referenceType().name()), "value", value(frame.thisObject(), reachable), "role", "receiver"));
            try {
                for (LocalVariable variable : frame.visibleVariables()) {
                    // The synthetic, empty launcher args array adds noise for first-time learners.
                    if (frame.location().method().name().equals("main") && variable.name().equals("args") && frame.getValue(variable) instanceof ArrayReference a && a.length() == 0) continue;
                    variables.add(map("name", variable.name(), "type", simple(variable.typeName()), "value", value(frame.getValue(variable), reachable)));
                }
            } catch (AbsentInformationException ignored) { }
            Method method = frame.location().method();
            int depth = stack.size() - i;
            Invocation invocation = active.get(depth);
            if (invocation == null || !invocation.method().equals(method)) {
                invocation = new Invocation(method, Integer.toString(++invocationSequence));
                active.put(depth, invocation);
            }
            frames.add(map("id", invocation.id(),
                "name", method.name().equals("<init>") ? simple(method.declaringType().name()) + "()" : method.name() + "()",
                "className", simple(method.declaringType().name()), "classId", method.declaringType().name(), "line", frame.location().lineNumber(), "variables", variables));
        }
        var classes = new LinkedHashMap<>(typeDefinitions);
        for (ReferenceType type : vm.allClasses()) {
            if (!userClasses.contains(type.name()) || !type.isPrepared()) continue;
            List<Object> fields = new ArrayList<>();
            for (Field field : type.fields()) {
                if (field.isStatic() && !field.isSynthetic()) {
                    try { fields.add(map("name", field.name(), "type", field.typeName(), "value", value(type.getValue(field), reachable))); }
                    catch (Exception ignored) { }
                }
            }
            List<String> methods = new ArrayList<>(), abstractMethods = new ArrayList<>();
            for (Method method : type.methods()) {
                if (method.isSynthetic()) continue;
                String name = method.name().equals("<init>") ? simple(type.name()) : method.name();
                String signature = name + "(" + String.join(", ", method.argumentTypeNames().stream().map(MemoryTracer::simple).toList()) + ")";
                methods.add(signature);
                if (method.isAbstract()) abstractMethods.add(signature);
            }
            var definition = new LinkedHashMap<>(classes.getOrDefault(type.name(),
                map("id", type.name(), "name", simple(type.name()), "kind", type instanceof InterfaceType ? "interface" : "class",
                    "abstract", type instanceof ClassType clazz && clazz.isAbstract())));
            definition.put("fields", fields);
            definition.put("methods", methods);
            definition.put("abstractMethods", abstractMethods);
            classes.put(type.name(), definition);
        }
        Set<String> processed = new HashSet<>();
        while (processed.size() < reachable.size() && processed.size() < 60) {
            var entries = new ArrayList<>(reachable.entrySet());
            for (var entry : entries) {
                if (!processed.add(entry.getKey())) continue;
                ObjectReference object = entry.getValue();
                List<Object> fields = new ArrayList<>();
                String kind = "object";
                String text = null;
                int length = -1;
                boolean truncated = false;
                try {
                    if (object instanceof StringReference string) { kind = "string"; text = string.value(); }
                    else if (object instanceof ArrayReference array) {
                        kind = "array"; length = array.length(); truncated = length > 30;
                        List<Value> values = array.getValues(0, Math.min(length, 30));
                        for (int i = 0; i < values.size(); i++) fields.add(map("name", "[" + i + "]", "type", object.referenceType().name().replaceFirst("\\[\\]$", ""), "value", value(values.get(i), reachable)));
                    } else if (object.referenceType().name().equals("java.util.ArrayList")
                            && member(object, "size") instanceof IntegerValue size && member(object, "elementData") instanceof ArrayReference data) {
                        kind = "array"; length = size.value(); truncated = length > 30;
                        int count = Math.min(Math.min(length, 30), data.length());
                        List<Value> entriesInList = data.getValues(0, count);
                        for (int i = 0; i < count; i++) fields.add(contains("[" + i + "]", entriesInList.get(i), reachable));
                    } else if (object.referenceType().name().equals("java.util.HashMap") && member(object, "size") instanceof IntegerValue size) {
                        kind = "array"; length = size.value(); truncated = length > 30;
                        if (member(object, "table") instanceof ArrayReference table) {
                            int index = 0;
                            // Read the debugger's fields; do not invoke user code or collection methods.
                            int buckets = Math.min(table.length(), 32768);
                            for (int start = 0; start < buckets && index < Math.min(length, 30); start += 256) {
                                for (Value head : table.getValues(start, Math.min(256, buckets - start))) {
                                    for (Value next = head; next instanceof ObjectReference entryNode && index < Math.min(length, 30); next = member(entryNode, "next")) {
                                        fields.add(contains("[" + index + "].key", member(entryNode, "key"), reachable));
                                        fields.add(contains("[" + index++ + "].value", member(entryNode, "value"), reachable));
                                    }
                                    if (index >= Math.min(length, 30)) break;
                                }
                            }
                            truncated = index < length;
                        }
                    } else if (userClasses.contains(object.referenceType().name())) {
                        var members = object.referenceType().allFields().stream().filter(field -> !field.isStatic()
                            && (!field.isSynthetic() || field.name().matches("this\\$[0-9]+"))).toList();
                        var seen = new HashSet<String>();
                        var shadowed = new HashSet<String>();
                        for (Field field : members) if (!seen.add(field.name())) shadowed.add(field.name());
                        for (Field field : members) {
                            String type = simple(field.typeName()), owner = simple(field.declaringType().name());
                            String name = field.isSynthetic() ? type + ".this" : shadowed.contains(field.name()) ? owner + "." + field.name() : field.name();
                            fields.add(map("name", name, "type", type, "value", value(object.getValue(field), reachable)));
                        }
                    } else {
                        ReferenceType type = object.referenceType();
                        Field wrapped = PRIMITIVE_WRAPPERS.contains(type.name()) ? type.fieldByName("value") : null;
                        if (wrapped != null && !wrapped.isStatic() && object.getValue(wrapped) instanceof PrimitiveValue primitive) {
                            fields.add(map("name", "value", "type", wrapped.typeName(), "value", value(primitive, reachable)));
                        } else { text = "JDK 객체 · 내부 필드 생략"; }
                    }
                    knownHeap.put(entry.getKey(), map("id", entry.getKey(), "type", simple(object.referenceType().name()), "classId", object.referenceType().name(), "kind", kind,
                        "fields", fields, "text", text, "length", length, "truncated", truncated));
                } catch (ObjectCollectedException ignored) { }
            }
        }
        List<Object> heap = new ArrayList<>();
        knownHeap.forEach((id, object) -> { var copy = new LinkedHashMap<>(object); copy.put("reachable", reachable.containsKey(id)); heap.add(copy); });
        Map<String, Object> snapshot = map("line", line, "executedLine", previousLine, "frames", frames, "classes", new ArrayList<>(classes.values()),
            "heap", heap, "output", stdout.toString(), "stderr", stderr.toString(), "finished", finished);
        if (finished) exitState = snapshot;
        else {
            snapshots.add(snapshot);
            previousLine = line;
            previousDepth = stack.size();
            previousLocations = locations;
        }
    }

    private Object value(Value value, Map<String, ObjectReference> reachable) {
        if (value == null) return map("kind", "null", "display", "null");
        if (value instanceof ObjectReference object) {
            String id = ids.computeIfAbsent(object.uniqueID(), ignored -> "" + (ids.size() + 1));
            if (reachable.size() < 60 || reachable.containsKey(id)) reachable.put(id, object);
            return map("kind", "reference", "ref", id, "display", "@" + id);
        }
        return map("kind", "primitive", "display", value instanceof CharValue ? "'" + value + "'" : value.toString());
    }

    private static Value member(ObjectReference object, String name) {
        Field field = object.referenceType().fieldByName(name);
        return field == null ? null : object.getValue(field);
    }

    private Object contains(String name, Value item, Map<String, ObjectReference> reachable) {
        return map("name", name, "type", item == null ? "Object" : simple(item.type().name()), "value", value(item, reachable));
    }

    @SuppressWarnings("unchecked") private static void collectRef(Object item, Set<String> refs) {
        if (item instanceof Map<?, ?> value && "reference".equals(value.get("kind"))) refs.add((String) value.get("ref"));
    }
    private void readStream(InputStream stream, StringBuffer target) {
        Thread reader = new Thread(() -> {
            try (Reader input = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
                char[] chars = new char[1024]; int count;
                while ((count = input.read(chars)) != -1) { if (target.length() < 20000) target.append(chars, 0, Math.min(count, 20000 - target.length())); }
            } catch (IOException ignored) { }
        });
        reader.setDaemon(true); reader.start(); readers.add(reader);
    }
    private void cleanup() {
        if (vm != null) { try { vm.exit(0); } catch (Exception ignored) { } vm = null; }
        if (process != null && process.isAlive()) process.destroyForcibly();
    }
    private static String simple(String type) { return type.substring(type.lastIndexOf('.') + 1).replace('$', '.'); }
    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }
    private static String json(Object object) {
        if (object == null) return "null";
        if (object instanceof String text) {
            StringBuilder out = new StringBuilder("\"");
            for (char c : text.toCharArray()) {
                switch (c) {
                    case '"' -> out.append("\\\""); case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n"); case '\r' -> out.append("\\r"); case '\t' -> out.append("\\t");
                    default -> { if (c < 32) out.append(String.format("\\u%04x", (int) c)); else out.append(c); }
                }
            }
            return out.append('"').toString();
        }
        if (object instanceof Number || object instanceof Boolean) return object.toString();
        if (object instanceof Map<?, ?> map) return "{" + String.join(",", map.entrySet().stream().map(e -> json(e.getKey().toString()) + ":" + json(e.getValue())).toList()) + "}";
        if (object instanceof Collection<?> list) return "[" + String.join(",", list.stream().map(MemoryTracer::json).toList()) + "]";
        return json(object.toString());
    }
}
