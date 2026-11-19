using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

var source = File.ReadAllText(args[0]);
var syntax = CSharpSyntaxTree.ParseText(source, path: "Program.cs");
var globals = CSharpSyntaxTree.ParseText("global using System; global using System.Collections.Generic; global using System.Linq; global using System.Threading.Tasks;");
var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
    .Select(path => MetadataReference.CreateFromFile(path));
var original = CSharpCompilation.Create("MemoryStudioUser", [syntax, globals], references,
    new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable));
var originalErrors = original.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToArray();
if (originalErrors.Length > 0)
{
    Write(new { error = "C# 컴파일 오류가 있어요.", diagnostics = originalErrors.Take(15).Select(d => new {
        line = d.Location.IsInSource ? d.Location.GetLineSpan().StartLinePosition.Line + 1 : 0, message = d.GetMessage() }) });
    return;
}

var model = original.GetSemanticModel(syntax);
var instrumentation = new Instrumentation(model);
var typeBases = Instrumentation.CollectTypeBases(model);
using var image = new MemoryStream();
bool compiled;
try
{
    var tree = syntax.WithRootAndOptions(instrumentation.Visit(syntax.GetRoot())!, syntax.Options);
    compiled = original.ReplaceSyntaxTree(syntax, tree).Emit(image).Success;
}
catch (ArgumentException) { compiled = false; }
string? warning = null;
if (!compiled)
{
    image.SetLength(0);
    original.Emit(image);
    warning = "이 C# 문법은 단계별 추적을 지원하지 않아 실행 결과만 표시해요.";
}

var assembly = Assembly.Load(image.ToArray());
var writer = Console.Out;
var errorWriter = Console.Error;
var output = new BoundedWriter();
TraceProbe.Setup(assembly, output, typeBases);
string? runtimeError = null;
Console.SetOut(output);
Console.SetError(output);
try
{
    var entry = assembly.EntryPoint!;
    var result = entry.Invoke(null, entry.GetParameters().Length == 0 ? null : [Array.Empty<string>()]);
    if (result is Task task) await task;
}
catch (Exception error)
{
    var cause = error is TargetInvocationException invocation ? invocation.InnerException ?? error : error;
    if (cause is TraceLimitException) warning = "학습을 위해 최대 350단계 / 8.5초까지 표시합니다.";
    else runtimeError = $"{cause.GetType().Name}: {cause.Message}";
}
finally
{
    Console.SetOut(writer);
    Console.SetError(errorWriter);
}
if (runtimeError == null && warning == null) TraceProbe.Finish();
Write(new { snapshots = TraceProbe.Snapshots, output = output.ToString(), runtimeError, warning });

static void Write(object result) => Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

sealed class Instrumentation(SemanticModel model) : CSharpSyntaxRewriter
{
    private const string Probe = "global::TraceProbe";
    private static readonly SymbolDisplayFormat DisplayType = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers |
            SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);
    private readonly string suffix = Guid.NewGuid().ToString("N");
    private int scopeNumber;

    public override SyntaxNode VisitBlock(BlockSyntax node)
    {
        var statements = new List<StatementSyntax>();
        if (node.Parent is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax)
        {
            if (model.GetDeclaredSymbol(node.Parent) is IMethodSymbol method)
                statements.Add(Enter(method.ContainingType, MethodName(method), Line(node.OpenBraceToken.SpanStart)));
        }
        foreach (var statement in node.Statements)
        {
            statements.Add(Capture(statement, false, statement.SpanStart));
            statements.Add((StatementSyntax)Visit(statement)!);
        }
        if (node.Statements.LastOrDefault() is { } last && model.AnalyzeControlFlow(last)?.EndPointIsReachable == true)
            statements.Add(Capture(last, true, last.Span.End - 1, Line(node.CloseBraceToken.SpanStart)));
        return node.WithStatements(List(statements));
    }

    public override SyntaxNode VisitCompilationUnit(CompilationUnitSyntax unit)
    {
        var members = new List<MemberDeclarationSyntax>();
        var globals = unit.Members.OfType<GlobalStatementSyntax>().ToArray();
        foreach (var member in unit.Members)
        {
            if (member is GlobalStatementSyntax global)
            {
                if (global == globals[0]) members.Add(GlobalStatement(Enter("Program", "Program", "Main()", Line(global.SpanStart))));
                members.Add(GlobalStatement(Capture(global.Statement, false, global.SpanStart)));
                members.Add((GlobalStatementSyntax)base.VisitGlobalStatement(global)!);
                if (global == globals[^1] && model.AnalyzeControlFlow(global.Statement)?.EndPointIsReachable == true)
                    members.Add(GlobalStatement(Capture(global.Statement, true, global.Statement.Span.End - 1)));
            }
            else members.Add((MemberDeclarationSyntax)Visit(member)!);
        }
        return unit.WithMembers(List(members));
    }

    public override SyntaxNode VisitSwitchSection(SwitchSectionSyntax node) => node.WithStatements(List(node.Statements.SelectMany(s =>
        new[] { Capture(s, false, s.SpanStart), (StatementSyntax)Visit(s)! })));

    public override SyntaxNode VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        if (node.ExpressionBody is { } expression && model.GetDeclaredSymbol(node) is IMethodSymbol method)
            return node.WithExpressionBody(null).WithSemicolonToken(default).WithBody(ExpressionBody(expression, method));
        return base.VisitMethodDeclaration(node)!;
    }

    public override SyntaxNode VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
    {
        if (node.ExpressionBody is { } expression && model.GetDeclaredSymbol(node) is IMethodSymbol method)
            return node.WithExpressionBody(null).WithSemicolonToken(default).WithBody(ExpressionBody(expression, method));
        return base.VisitLocalFunctionStatement(node)!;
    }

    public override SyntaxNode VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        if (node.ExpressionBody is { } expression && model.GetDeclaredSymbol(node) is IMethodSymbol method)
            return node.WithExpressionBody(null).WithSemicolonToken(default).WithBody(ExpressionBody(expression, method));
        return base.VisitConstructorDeclaration(node)!;
    }

    public override SyntaxNode VisitAccessorDeclaration(AccessorDeclarationSyntax node)
    {
        if (node.ExpressionBody is { } expression && model.GetDeclaredSymbol(node) is IMethodSymbol method)
            return node.WithExpressionBody(null).WithSemicolonToken(default).WithBody(ExpressionBody(expression, method));
        return base.VisitAccessorDeclaration(node)!;
    }

    public override SyntaxNode VisitPropertyDeclaration(PropertyDeclarationSyntax node)
    {
        if (node.ExpressionBody is { } expression && model.GetDeclaredSymbol(node) is IPropertySymbol { GetMethod: { } getter })
            return node.WithExpressionBody(null).WithSemicolonToken(default).WithAccessorList(ExpressionGetter(expression, getter));
        return base.VisitPropertyDeclaration(node)!;
    }

    public override SyntaxNode VisitIndexerDeclaration(IndexerDeclarationSyntax node)
    {
        if (node.ExpressionBody is { } expression && model.GetDeclaredSymbol(node) is IPropertySymbol { GetMethod: { } getter })
            return node.WithExpressionBody(null).WithSemicolonToken(default).WithAccessorList(ExpressionGetter(expression, getter));
        return base.VisitIndexerDeclaration(node)!;
    }

    private AccessorListSyntax ExpressionGetter(ArrowExpressionClauseSyntax expression, IMethodSymbol getter) =>
        AccessorList(SingletonList(AccessorDeclaration(SyntaxKind.GetAccessorDeclaration).WithBody(ExpressionBody(expression, getter))));

    private BlockSyntax ExpressionBody(ArrowExpressionClauseSyntax arrow, IMethodSymbol method)
    {
        var line = Line(arrow.Expression.SpanStart);
        var statement = arrow.Expression switch {
            ThrowExpressionSyntax thrown => (StatementSyntax)ThrowStatement(thrown.Expression),
            _ when method.ReturnsVoid || method.IsAsync && method.ReturnType is INamedTypeSymbol { Arity: 0 } => ExpressionStatement(arrow.Expression),
            _ => ReturnStatement(arrow.Expression),
        };
        return Block(Enter(method.ContainingType, MethodName(method), line), Capture(arrow.Expression, false, arrow.Expression.SpanStart, ownerMethod: method), statement);
    }

    public override SyntaxNode? Visit(SyntaxNode? node)
    {
        var visited = base.Visit(node);
        if (node is StatementSyntax s && s is not BlockSyntax && s.Parent is IfStatementSyntax or ElseClauseSyntax or
            ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax or LockStatementSyntax && visited is StatementSyntax statement)
            return Block(Capture(s, false, s.SpanStart), statement);
        // Keep a label pointing at the probe so goto still records the following statement.
        if (node is LabeledStatementSyntax label && visited is LabeledStatementSyntax rewritten)
            return rewritten.WithStatement(Block(Capture(label.Statement, false, label.Statement.SpanStart), rewritten.Statement));
        return visited;
    }

    public override SyntaxNode VisitClassDeclaration(ClassDeclarationSyntax node) => MarkClass(node, (ClassDeclarationSyntax)base.VisitClassDeclaration(node)!);
    public override SyntaxNode VisitStructDeclaration(StructDeclarationSyntax node) => MarkClass(node, (StructDeclarationSyntax)base.VisitStructDeclaration(node)!);
    public override SyntaxNode VisitRecordDeclaration(RecordDeclarationSyntax node) => MarkClass(node, (RecordDeclarationSyntax)base.VisitRecordDeclaration(node)!);

    private TypeDeclarationSyntax MarkClass(TypeDeclarationSyntax original, TypeDeclarationSyntax rewritten)
    {
        if (!original.Members.Any(m => m is FieldDeclarationSyntax field && field.Modifiers.Any(SyntaxKind.StaticKeyword)
            || m is PropertyDeclarationSyntax property && property.Modifiers.Any(SyntaxKind.StaticKeyword)
            || m is ConstructorDeclarationSyntax constructor && constructor.Modifiers.Any(SyntaxKind.StaticKeyword))) return rewritten;
        var typeName = original.Identifier.Text + (original.TypeParameterList is { } typeParameters
            ? "<" + string.Join(",", typeParameters.Parameters.Select(p => p.Identifier.Text)) + ">" : "");
        return rewritten.AddMembers(ParseMemberDeclaration($"private static readonly bool __memory_{suffix} = {Probe}.Mark(typeof({typeName}));")!);
    }

    private StatementSyntax Enter(INamedTypeSymbol owner, string name, int line) => Enter(owner.ToDisplayString(DisplayType), TypeId(owner), name, line);
    private StatementSyntax Enter(string owner, string ownerId, string name, int line) =>
        ParseStatement($"using var __frame_{suffix}_{scopeNumber++} = {Probe}.Enter({Quoted(owner)}, {Quoted(ownerId)}, {Quoted(name)}, {line});");

    private static string TypeId(INamedTypeSymbol type) => type.ContainingType is { } outer ? TypeId(outer) + "+" + type.MetadataName
        : (type.ContainingNamespace.IsGlobalNamespace ? "" : type.ContainingNamespace.ToDisplayString() + ".") + type.MetadataName;

    internal static Dictionary<string, TraceTypeBase[]> CollectTypeBases(SemanticModel model)
    {
        var result = new Dictionary<string, TraceTypeBase[]>();
        foreach (var declaration in model.SyntaxTree.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            if (model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol type) continue;
            var parents = new List<INamedTypeSymbol>();
            if (type.BaseType is { } parent && parent.SpecialType is not (SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum or SpecialType.System_MulticastDelegate))
                parents.Add(parent);
            // Roslyn preserves direct declarations, unlike reflection's transitive GetInterfaces().
            parents.AddRange(type.Interfaces);
            result[TypeId(type)] = parents.Select(baseType => new TraceTypeBase(TypeId(baseType.OriginalDefinition),
                baseType.ToDisplayString(DisplayType), baseType.TypeKind == TypeKind.Interface ? "interface" : "class")).ToArray();
        }
        return result;
    }

    private StatementSyntax Capture(SyntaxNode target, bool after, int position, int? displayLine = null, IMethodSymbol? ownerMethod = null)
    {
        var flow = target switch { ExpressionSyntax expression => model.AnalyzeDataFlow(expression),
            StatementSyntax statement when statement is not (LocalFunctionStatementSyntax or LabeledStatementSyntax) => model.AnalyzeDataFlow(statement), _ => null };
        var assigned = flow?.Succeeded == true ? after ? flow.DefinitelyAssignedOnExit : flow.DefinitelyAssignedOnEntry : [];
        var values = new List<string>();
        var member = target.Ancestors().FirstOrDefault(n => n is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax);
        var owner = ownerMethod ?? (member == null ? null : model.GetDeclaredSymbol(member) as IMethodSymbol);
        if (owner is { IsStatic: false, ContainingType.IsReferenceType: true } instance)
            values.Add(Datum("this", instance.ContainingType.ToDisplayString(DisplayType), "this", true, receiver: true));
        foreach (var symbol in model.LookupSymbols(position))
        {
            var type = symbol switch { ILocalSymbol local => local.Type, IParameterSymbol parameter => parameter.Type, _ => null };
            if (type == null || type.IsRefLikeType || type.TypeKind is TypeKind.Pointer or TypeKind.FunctionPointer || !assigned.Contains(symbol, SymbolEqualityComparer.Default)) continue;
            if (!SyntaxFacts.IsValidIdentifier(symbol.Name) && SyntaxFacts.GetKeywordKind(symbol.Name) == SyntaxKind.None) continue;
            values.Add(Datum(symbol.Name, type.ToDisplayString(DisplayType), "@" + symbol.Name, !type.IsValueType));
        }
        return ParseStatement($"{Probe}.Step({displayLine ?? Line(position)}{(values.Count > 0 ? "," + string.Join(",", values) : "")});");
    }

    private int Line(int position) => model.SyntaxTree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(position, 0)).StartLinePosition.Line + 1;
    private static string Quoted(string text) => SymbolDisplay.FormatLiteral(text, true);
    private static string Datum(string name, string type, string expression, bool byReference, bool receiver = false) =>
        $"new global::TraceDatum({Quoted(name)}, {Quoted(type)}, (object?){expression}, {(byReference ? "true" : "false")}, {(receiver ? "true" : "false")})";
    private static string MethodName(IMethodSymbol method) => (method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor
        ? method.ContainingType.Name : method.Name) + "()";
}

public sealed record TraceDatum(string Name, string Type, object? Value, bool Reference, bool Receiver);
internal sealed record TraceTypeBase(string Id, string Name, string Kind);
public sealed class TraceLimitException : Exception;

sealed class BoundedWriter : StringWriter
{
    public override Encoding Encoding => Encoding.UTF8;
    public override void Write(char value) { if (GetStringBuilder().Length < 20000) base.Write(value); }
    public override void Write(string? value)
    {
        if (value != null) base.Write(value[..Math.Min(value.Length, Math.Max(0, 20000 - GetStringBuilder().Length))]);
    }
    public override void Write(char[] buffer, int index, int count) => Write(new string(buffer, index, count));
    public override void WriteLine(string? value) { Write(value); Write(NewLine); }
}

public static class TraceProbe
{
    private sealed class Frame(string id, string owner, string ownerId, string name, int line)
    {
        public readonly string Id = id, Owner = owner, OwnerId = ownerId, Name = name;
        public int Line = line;
        public TraceDatum[] Values = [];
    }
    private sealed class Scope(Frame frame, Frame? previous) : IDisposable
    {
        public void Dispose() { if (ReferenceEquals(active.Value, frame)) active.Value = previous; }
    }
    private record HeapInfo(string Id, string Type, string ClassId, string Kind, List<object> Fields, string? Text, int Length, bool Truncated, bool Reachable);
    private static readonly AsyncLocal<Frame?> active = new();
    private static readonly AsyncLocal<Frame[]?> parents = new();
    private static readonly HashSet<Type> initialized = [];
    private static readonly Dictionary<object, string> ids = new(ReferenceEqualityComparer.Instance);
    private static readonly Dictionary<string, HeapInfo> heap = [];
    private static readonly Stopwatch timer = new();
    private static Type[] declared = [];
    private static Dictionary<string, TraceTypeBase[]> typeBases = [];
    private static StringWriter output = new();
    private static Assembly? userAssembly;
    private static int frameNumber, previousLine;
    public static List<object> Snapshots { get; } = [];

    internal static void Setup(Assembly assembly, StringWriter writer, Dictionary<string, TraceTypeBase[]> relations)
    {
        userAssembly = assembly;
        declared = assembly.GetTypes().Where(t => !t.IsDefined(typeof(CompilerGeneratedAttribute), false)).Take(30).ToArray();
        typeBases = relations;
        output = writer;
        timer.Start();
    }

    public static bool Mark(Type type) { initialized.Add(type); return true; }

    public static IDisposable Enter(string owner, string ownerId, string name, int line)
    {
        var previous = active.Value;
        var frame = new Frame((++frameNumber).ToString(CultureInfo.InvariantCulture), owner, ownerId, name, line);
        var outer = parents.Value ?? [];
        parents.Value = previous == null ? [] : [previous, .. outer];
        active.Value = frame;
        return new RestoreScope(new Scope(frame, previous), outer);
    }

    private sealed class RestoreScope(IDisposable scope, Frame[] outer) : IDisposable
    {
        public void Dispose() { scope.Dispose(); parents.Value = outer; }
    }

    public static void Step(int line, params TraceDatum[] values)
    {
        if (active.Value is not { } frame) return;
        if (Snapshots.Count >= 350 || timer.Elapsed.TotalSeconds > 8.5) throw new TraceLimitException();
        frame.Line = line;
        frame.Values = values;
        Capture(line, [frame, .. parents.Value ?? []], false);
    }

    internal static void Finish() => Capture(0, [], true);

    private static void Capture(int line, Frame[] frames, bool finished)
    {
        var objects = new Dictionary<string, object>();
        var pending = new Queue<(string, object)>();
        object Value(object? item, bool byReference)
        {
            if (item == null) return new { kind = "null", display = "null" };
            if (!byReference && item.GetType().IsValueType) return new { kind = "primitive", display = Scalar(item) };
            if (!ids.TryGetValue(item, out var id))
            {
                if (ids.Count >= 180 || objects.Count >= 65) return new { kind = "primitive", display = "…" };
                ids[item] = id = (ids.Count + 1).ToString(CultureInfo.InvariantCulture);
            }
            if (objects.Count < 65 && objects.TryAdd(id, item)) pending.Enqueue((id, item));
            return new { kind = "reference", @ref = id, display = "@" + id };
        }
        object Field(string name, Type type, object? item) => new { name, type = TypeName(type), value = Value(item, !type.IsValueType) };
        var frameData = frames.Select(frame => new { id = frame.Id, name = frame.Name, className = frame.Owner, classId = frame.OwnerId, line = frame.Line,
            variables = frame.Values.Where(item => !(item.Name == "args" && item.Value is string[] { Length: 0 })).Take(60)
                .Select(item => new { name = item.Name, type = item.Type, value = Value(item.Value, item.Reference), role = item.Receiver ? "receiver" : null }).ToArray() }).ToArray();
        const BindingFlags flags = BindingFlags.DeclaredOnly | BindingFlags.Public | BindingFlags.NonPublic;
        var classes = declared.Select(type => {
            var entries = type.GetConstructors(flags | BindingFlags.Instance).Cast<MethodBase>()
                .Concat(type.GetMethods(flags | BindingFlags.Instance | BindingFlags.Static).Where(m => !m.IsSpecialName && !m.Name.StartsWith('<')))
                .Select(m => (Name: (m.IsConstructor ? TypeName(type) : m.Name) + "(" + string.Join(", ", m.GetParameters().Select(p => TypeName(p.ParameterType))) + ")", Abstract: m.IsAbstract))
                .Concat(type.GetProperties(flags | BindingFlags.Instance | BindingFlags.Static)
                    .Select(p => (Name: p.Name + " { " + (p.GetMethod != null ? "get; " : "") + (p.SetMethod != null ? "set; " : "") + "}",
                        Abstract: p.GetAccessors(true).Any(m => m.IsAbstract))))
                .Take(35).ToArray();
            return new {
                id = TypeId(type),
                name = TypeName(type),
                kind = type.IsInterface ? "interface" : "class",
                @abstract = type.IsAbstract && !type.IsInterface && !type.IsSealed,
                bases = typeBases.GetValueOrDefault(TypeId(type)) ?? [],
                fields = !type.ContainsGenericParameters ? type.GetFields(flags | BindingFlags.Static)
                    .Where(f => !f.Name.StartsWith("__memory_") && (f.IsLiteral || type.TypeInitializer == null || initialized.Contains(type))).Take(30)
                    .Select(f => Field(FieldName(f), f.FieldType, f.IsLiteral ? f.GetRawConstantValue() : f.GetValue(null))).ToArray() : [],
                methods = entries.Select(entry => entry.Name).ToArray(),
                abstractMethods = entries.Where(entry => entry.Abstract).Select(entry => entry.Name).ToArray(),
            };
        }).ToArray();

        while (pending.TryDequeue(out var next))
        {
            var (id, item) = next;
            var type = item.GetType();
            var fields = new List<object>();
            string kind = "object";
            string? text = null;
            int length = -1;
            if (item is string str) { kind = "string"; text = str.Length > 240 ? str[..239] + "…" : str; }
            else if (item is Array array)
            {
                kind = "array"; length = array.Length; int i = 0;
                foreach (var element in array) { if (i >= 30) break; fields.Add(Field($"[{i++}]", type.GetElementType()!, element)); }
            }
            else if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>) && item is IList list)
            {
                kind = "array"; length = list.Count;
                for (int i = 0; i < Math.Min(length, 30); i++) fields.Add(Field($"[{i}]", type.GenericTypeArguments[0], list[i]));
            }
            else if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Dictionary<,>) && item is IDictionary dictionary)
            {
                kind = "array"; length = dictionary.Count;
                var arguments = type.GenericTypeArguments;
                int i = 0;
                foreach (DictionaryEntry entry in dictionary) {
                    if (i >= 30) break;
                    fields.Add(Field($"[{i}].key", arguments[0], entry.Key));
                    fields.Add(Field($"[{i++}].value", arguments[1], entry.Value));
                }
            }
            else if (type.Assembly == userAssembly)
            {
                var members = new List<FieldInfo>();
                for (var owner = type; owner != null && owner.Assembly == userAssembly && members.Count < 30; owner = owner.BaseType)
                    members.AddRange(owner.GetFields(flags | BindingFlags.Instance).Take(30 - members.Count));
                var counts = members.GroupBy(FieldName).ToDictionary(group => group.Key, group => group.Count());
                foreach (var f in members) {
                    var name = FieldName(f);
                    fields.Add(Field(counts[name] > 1 ? TypeName(f.DeclaringType!) + "." + name : name, f.FieldType, f.GetValue(item)));
                }
            }
            else if (type.IsValueType) { kind = "scalar"; text = Scalar(item); }
            else text = ".NET 객체 · 내부 필드 생략";
            heap[id] = new(id, TypeName(type), TypeId(type), kind, fields, text, length, length > 30, true);
        }
        Snapshots.Add(new { line, executedLine = previousLine, frames = frameData, classes,
            heap = heap.Values.Select(o => o with { Reachable = objects.ContainsKey(o.Id) }).ToArray(), output = output.ToString(), finished });
        previousLine = line;
    }

    private static string FieldName(FieldInfo field) => field.Name.EndsWith(">k__BackingField") ? field.Name[1..field.Name.IndexOf('>')] : field.Name;
    private static string TypeId(Type type)
    {
        if (type.IsGenericType) type = type.GetGenericTypeDefinition();
        return type.FullName ?? type.Name;
    }

    private static string TypeName(Type type)
    {
        if (type.IsArray) return TypeName(type.GetElementType()!) + "[" + new string(',', type.GetArrayRank() - 1) + "]";
        var code = Type.GetTypeCode(type);
        if (!type.IsEnum && code is not TypeCode.Object)
            return code switch {
                TypeCode.Boolean => "bool", TypeCode.Int32 => "int", TypeCode.Int64 => "long", TypeCode.Single => "float",
                TypeCode.Double => "double", TypeCode.Char => "char", TypeCode.String => "string", TypeCode.Decimal => "decimal", _ => type.Name,
            };
        var parts = new List<string>();
        var arguments = type.IsGenericType ? type.GetGenericArguments() : [];
        for (var owner = type; owner != null; owner = owner.DeclaringType)
        {
            var split = owner.Name.Split('`');
            var arity = split.Length == 2 && int.TryParse(split[1], out var parsed) ? parsed : 0;
            var offset = (owner.DeclaringType?.GetGenericArguments().Length).GetValueOrDefault();
            parts.Add(arity > 0 ? split[0] + "<" + string.Join(",", arguments.Skip(offset).Take(arity).Select(TypeName)) + ">" : split[0]);
        }
        parts.Reverse();
        return string.Join('.', parts);
    }

    private static string Scalar(object value, int depth = 0) => value switch {
        bool boolean => boolean ? "true" : "false", char character => $"'{character}'", Enum enumeration => enumeration.ToString(),
        byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal => Convert.ToString(value, CultureInfo.InvariantCulture)!,
        _ when depth < 2 && value.GetType().IsValueType && value.GetType().Assembly == userAssembly => StructValue(value, depth),
        _ => $"{TypeName(value.GetType())} 값",
    };

    private static string StructValue(object value, int depth)
    {
        var fields = value.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        var preview = fields.Take(5).Select(field => {
            var item = field.GetValue(value);
            var display = item switch {
                null => "null", string text => JsonSerializer.Serialize(text.Length > 40 ? text[..39] + "…" : text),
                _ when field.FieldType.IsValueType => Scalar(item, depth + 1), _ => TypeName(item.GetType()) + " 참조",
            };
            return $"{FieldName(field)}: {display}";
        });
        return "{" + string.Join(", ", preview) + (fields.Length > 5 ? ", …}" : "}");
    }
}
