using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

const string AppName = "GranaFlow";
const string RepoUrl = "https://github.com/CaduVerlique/grana-flow.git";

var skipUpdate = args.Any((arg) => arg.Equals("--skip-update", StringComparison.OrdinalIgnoreCase));
var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
var installRoot = Path.Combine(localAppData, AppName);
var appRoot = ResolveAppRoot(installRoot);
var configRoot = Path.Combine(appData, AppName);
var launcherStatePath = Path.Combine(configRoot, "launcher.json");
var envPath = Path.Combine(appRoot, ".env.local");
var logsDir = Path.Combine(configRoot, "logs");
var launcherExePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName ?? string.Empty;

Directory.CreateDirectory(configRoot);
Directory.CreateDirectory(logsDir);

Console.OutputEncoding = Encoding.UTF8;
Console.Title = AppName;

try
{
    WriteHeader("Inicializando");
    EnsureTool("git", "Git e necessario para instalar/atualizar o GranaFlow.");
    EnsureTool("node", "Node.js e necessario para rodar o GranaFlow.");
    EnsureTool("npm", "npm e necessario para instalar dependencias do GranaFlow.");

    var state = LoadState(launcherStatePath);
    KillPreviousServer(state);

    EnsureRepository(appRoot);

    if (IsFirstRun(state, envPath))
    {
        state = PromptFirstRun(state, envPath, launcherExePath);
    }

    if (!skipUpdate && TryUpdate(appRoot))
    {
        WriteHeader("Atualizacao aplicada");
        EnsureNodeDependencies(appRoot);
        Run("npm", "run build", appRoot, "Gerando build atualizado");
        SaveState(launcherStatePath, state);
        Process.Start(new ProcessStartInfo
        {
            FileName = launcherExePath,
            UseShellExecute = true,
            Arguments = "--skip-update",
        });
        return;
    }

    EnsureNodeDependencies(appRoot);
    Run("npm", "run build", appRoot, "Gerando build de producao");

    var serverProcess = StartServer(appRoot, logsDir, state.Port);
    state.ServerProcessId = serverProcess.Id;
    SaveState(launcherStatePath, state);

    var url = $"http://127.0.0.1:{state.Port}/";
    WaitForServer(url);
    OpenBrowser(url);

    Console.WriteLine();
    Console.WriteLine($"GranaFlow aberto em {url}");
    Console.WriteLine("Voce pode fechar esta janela. O servidor continua rodando em segundo plano.");
}
catch (Exception error)
{
    Console.ForegroundColor = ConsoleColor.Red;
    Console.WriteLine();
    Console.WriteLine(error.Message);
    Console.ResetColor();
    Console.WriteLine();
    Console.WriteLine("Pressione Enter para fechar.");
    Console.ReadLine();
}

static string ResolveAppRoot(string installRoot)
{
    var baseDir = AppContext.BaseDirectory;

    if (File.Exists(Path.Combine(baseDir, "package.json")) && Directory.Exists(Path.Combine(baseDir, "server")))
    {
        return baseDir;
    }

    return Path.Combine(installRoot, "app");
}

static bool IsFirstRun(LauncherState state, string envPath)
{
    return state.FirstRun || !File.Exists(envPath);
}

static LauncherState PromptFirstRun(LauncherState state, string envPath, string launcherExePath)
{
    WriteHeader("Primeira configuracao");
    Console.WriteLine("Voce pode deixar as credenciais em branco e preencher depois pela UI.");
    Console.WriteLine();

    var port = PromptInt("Porta do app", state.Port > 0 ? state.Port : 8787);
    var clientId = Prompt("Pluggy Client ID (opcional)");
    var clientSecret = Prompt("Pluggy Client Secret (opcional)", secret: true);
    var itemId = Prompt("Pluggy Item ID (opcional)");
    var autoStart = PromptYesNo("Iniciar automaticamente com o Windows?", state.AutoStart);

    Directory.CreateDirectory(Path.GetDirectoryName(envPath)!);
    File.WriteAllText(envPath, string.Join(Environment.NewLine, new[]
    {
        $"PLUGGY_CLIENT_ID=\"{EscapeEnv(clientId)}\"",
        $"PLUGGY_CLIENT_SECRET=\"{EscapeEnv(clientSecret)}\"",
        $"PLUGGY_ITEM_ID=\"{EscapeEnv(itemId)}\"",
        $"API_PORT={port}",
        string.Empty,
    }), Encoding.UTF8);

    SetAutoStart(autoStart, launcherExePath);

    state.Port = port;
    state.AutoStart = autoStart;
    state.FirstRun = false;
    return state;
}

static void EnsureRepository(string appRoot)
{
    if (File.Exists(Path.Combine(appRoot, "package.json")))
    {
        return;
    }

    WriteHeader("Instalando app");
    Directory.CreateDirectory(Path.GetDirectoryName(appRoot)!);
    Run("git", $"clone {RepoUrl} \"{appRoot}\"", Path.GetDirectoryName(appRoot)!, "Clonando repositorio");
}

static bool TryUpdate(string appRoot)
{
    if (!Directory.Exists(Path.Combine(appRoot, ".git")))
    {
        Console.WriteLine("Repositorio Git nao encontrado; pulando update automatico.");
        return false;
    }

    WriteHeader("Checando updates");
    Run("git", "fetch --prune", appRoot, "Buscando updates");

    var current = Capture("git", "rev-parse HEAD", appRoot).Trim();
    var upstream = Capture("git", "rev-parse @{u}", appRoot, allowFailure: true).Trim();

    if (string.IsNullOrWhiteSpace(upstream))
    {
        upstream = Capture("git", "rev-parse origin/main", appRoot, allowFailure: true).Trim();
    }

    if (string.IsNullOrWhiteSpace(upstream) || current.Equals(upstream, StringComparison.OrdinalIgnoreCase))
    {
        Console.WriteLine("Nenhum update encontrado.");
        return false;
    }

    Run("git", "pull --ff-only", appRoot, "Baixando update");
    return true;
}

static void EnsureNodeDependencies(string appRoot)
{
    if (!Directory.Exists(Path.Combine(appRoot, "node_modules")))
    {
        Run("npm", "install", appRoot, "Instalando dependencias");
    }
}

static Process StartServer(string appRoot, string logsDir, int port)
{
    WriteHeader("Subindo servidor");
    Directory.CreateDirectory(logsDir);

    var stdoutPath = Path.Combine(logsDir, "server.out.log");
    var stderrPath = Path.Combine(logsDir, "server.err.log");
    var startInfo = new ProcessStartInfo
    {
        FileName = "node",
        Arguments = "server/index.mjs",
        WorkingDirectory = appRoot,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };

    startInfo.Environment["API_PORT"] = port.ToString();
    startInfo.Environment["NODE_ENV"] = "production";

    var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Nao foi possivel iniciar o servidor.");
    _ = PipeToFileAsync(process.StandardOutput, stdoutPath);
    _ = PipeToFileAsync(process.StandardError, stderrPath);
    return process;
}

static async Task PipeToFileAsync(StreamReader reader, string path)
{
    await using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
    await using var writer = new StreamWriter(stream, Encoding.UTF8);

    string? line;
    while ((line = await reader.ReadLineAsync()) is not null)
    {
        await writer.WriteLineAsync(line);
        await writer.FlushAsync();
    }
}

static void WaitForServer(string url)
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
    var healthUrl = $"{url.TrimEnd('/')}/api/health";

    for (var attempt = 0; attempt < 30; attempt++)
    {
        try
        {
            var response = client.GetAsync(healthUrl).GetAwaiter().GetResult();
            if (response.IsSuccessStatusCode)
            {
                return;
            }
        }
        catch
        {
            // Server is still booting.
        }

        Thread.Sleep(500);
    }

    throw new TimeoutException("Servidor nao respondeu a tempo. Veja os logs em %APPDATA%\\GranaFlow\\logs.");
}

static void OpenBrowser(string url)
{
    Process.Start(new ProcessStartInfo
    {
        FileName = url,
        UseShellExecute = true,
    });
}

static void KillPreviousServer(LauncherState state)
{
    if (state.ServerProcessId is null or <= 0)
    {
        return;
    }

    try
    {
        var process = Process.GetProcessById(state.ServerProcessId.Value);
        Console.WriteLine($"Encerrando instancia anterior ({state.ServerProcessId}).");
        process.Kill(entireProcessTree: true);
        process.WaitForExit(5000);
    }
    catch
    {
        // Process already exited.
    }

    state.ServerProcessId = null;
}

static void EnsureTool(string tool, string message)
{
    var output = Capture(tool, "--version", Directory.GetCurrentDirectory(), allowFailure: true);
    if (string.IsNullOrWhiteSpace(output))
    {
        throw new InvalidOperationException(message);
    }
}

static void Run(string fileName, string arguments, string workingDirectory, string label)
{
    Console.WriteLine(label);

    var startInfo = new ProcessStartInfo
    {
        FileName = fileName,
        Arguments = arguments,
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };

    using var process = Process.Start(startInfo) ?? throw new InvalidOperationException($"Falha ao executar {fileName}.");
    process.OutputDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) Console.WriteLine(eventArgs.Data); };
    process.ErrorDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) Console.Error.WriteLine(eventArgs.Data); };
    process.BeginOutputReadLine();
    process.BeginErrorReadLine();
    process.WaitForExit();

    if (process.ExitCode != 0)
    {
        throw new InvalidOperationException($"{label} falhou com codigo {process.ExitCode}.");
    }
}

static string Capture(string fileName, string arguments, string workingDirectory, bool allowFailure = false)
{
    var startInfo = new ProcessStartInfo
    {
        FileName = fileName,
        Arguments = arguments,
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };

    using var process = Process.Start(startInfo);
    if (process is null)
    {
        return string.Empty;
    }

    var output = process.StandardOutput.ReadToEnd();
    var error = process.StandardError.ReadToEnd();
    process.WaitForExit();

    if (process.ExitCode != 0 && !allowFailure)
    {
        throw new InvalidOperationException(error.Trim().Length > 0 ? error.Trim() : $"{fileName} falhou.");
    }

    return process.ExitCode == 0 ? output : string.Empty;
}

static LauncherState LoadState(string path)
{
    if (!File.Exists(path))
    {
        return new LauncherState();
    }

    try
    {
        return JsonSerializer.Deserialize<LauncherState>(File.ReadAllText(path)) ?? new LauncherState();
    }
    catch
    {
        return new LauncherState();
    }
}

static void SaveState(string path, LauncherState state)
{
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, JsonSerializer.Serialize(state, new JsonSerializerOptions { WriteIndented = true }));
}

static void SetAutoStart(bool enabled, string launcherExePath)
{
    try
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        if (key is null)
        {
            return;
        }

        if (enabled)
        {
            key.SetValue(AppName, $"\"{launcherExePath}\"");
        }
        else
        {
            key.DeleteValue(AppName, throwOnMissingValue: false);
        }
    }
    catch (Exception error)
    {
        Console.WriteLine($"Nao foi possivel configurar inicio automatico: {error.Message}");
    }
}

static string Prompt(string label, bool secret = false)
{
    Console.Write($"{label}: ");

    if (!secret)
    {
        return Console.ReadLine()?.Trim() ?? string.Empty;
    }

    var value = new StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter)
        {
            Console.WriteLine();
            return value.ToString().Trim();
        }

        if (key.Key == ConsoleKey.Backspace && value.Length > 0)
        {
            value.Length--;
            Console.Write("\b \b");
            continue;
        }

        if (!char.IsControl(key.KeyChar))
        {
            value.Append(key.KeyChar);
            Console.Write('*');
        }
    }
}

static int PromptInt(string label, int defaultValue)
{
    Console.Write($"{label} [{defaultValue}]: ");
    var raw = Console.ReadLine();
    return int.TryParse(raw, out var value) && value > 0 ? value : defaultValue;
}

static bool PromptYesNo(string label, bool defaultValue)
{
    Console.Write($"{label} [{(defaultValue ? "S/n" : "s/N")}]: ");
    var raw = Console.ReadLine()?.Trim().ToLowerInvariant();
    if (string.IsNullOrWhiteSpace(raw))
    {
        return defaultValue;
    }

    return raw is "s" or "sim" or "y" or "yes";
}

static string EscapeEnv(string value)
{
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"").ReplaceLineEndings(string.Empty);
}

static void WriteHeader(string title)
{
    Console.WriteLine();
    Console.ForegroundColor = ConsoleColor.Green;
    Console.WriteLine($"== {title} ==");
    Console.ResetColor();
}

internal sealed class LauncherState
{
    public bool AutoStart { get; set; }
    public bool FirstRun { get; set; } = true;
    public int Port { get; set; } = 8787;
    public int? ServerProcessId { get; set; }
}
