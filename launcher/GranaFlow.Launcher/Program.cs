using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;

const string AppName = "GranaFlow";
const string RepoFullName = "CaduVerlique/grana-flow";
const string LatestReleaseApiUrl = "https://api.github.com/repos/" + RepoFullName + "/releases/latest";
const string ReleaseAssetName = "GranaFlow.exe";
const string AppBundleResourceName = "GranaFlow.AppBundle.zip";
const string NodeBundleResourceName = "GranaFlow.Node.zip";
const int DefaultAppPort = 5173;
const int LegacyDefaultAppPort = 8787;

var skipUpdate = args.Any((arg) => arg.Equals("--skip-update", StringComparison.OrdinalIgnoreCase));
var smokeTest = args.Any((arg) => arg.Equals("--smoke-test", StringComparison.OrdinalIgnoreCase));
var localAppData = GetFolderPath("GRANAFLOW_LOCALAPPDATA", Environment.SpecialFolder.LocalApplicationData);
var appData = GetFolderPath("GRANAFLOW_APPDATA", Environment.SpecialFolder.ApplicationData);
var installRoot = Path.Combine(localAppData, AppName);
var appRoot = Path.Combine(installRoot, "app");
var runtimeRoot = Path.Combine(installRoot, "runtime");
var configRoot = Path.Combine(appData, AppName);
var launcherStatePath = Path.Combine(configRoot, "launcher.json");
var envPath = Path.Combine(appRoot, ".env.local");
var userEnvPath = Path.Combine(configRoot, ".env.local");
var logsDir = Path.Combine(configRoot, "logs");
var launcherExePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName ?? string.Empty;
var currentReleaseTag = GetCurrentReleaseTag();

Directory.CreateDirectory(configRoot);
Directory.CreateDirectory(logsDir);

Console.OutputEncoding = Encoding.UTF8;
Console.Title = AppName;

try
{
    WriteHeader($"Inicializando {currentReleaseTag}");
    var state = LoadState(launcherStatePath);
    KillPreviousServer(state);

    if (!skipUpdate && TryUpdateLauncher(launcherExePath, currentReleaseTag))
    {
        SaveState(launcherStatePath, state);
        return;
    }

    var nodeExePath = InstallBundledRuntime(appRoot, runtimeRoot, currentReleaseTag, state);
    SyncEnvFiles(envPath, userEnvPath);

    if (smokeTest)
    {
        if (!IsFirstRun(envPath, userEnvPath))
        {
            SyncPortFromEnv(state, envPath, userEnvPath);
            state.FirstRun = false;
            SaveState(launcherStatePath, state);
        }

        RunSmokeTest(nodeExePath, appRoot, logsDir, userEnvPath, launcherExePath, installRoot, configRoot);
        return;
    }

    if (IsFirstRun(envPath, userEnvPath))
    {
        state = PromptFirstRun(state, envPath, userEnvPath, launcherExePath);
    }
    else
    {
        SyncPortFromEnv(state, envPath, userEnvPath);
        state.FirstRun = false;
    }

    state.AppReleaseTag = currentReleaseTag;
    state.RuntimeReleaseTag = currentReleaseTag;

    var serverProcess = StartServer(nodeExePath, appRoot, logsDir, state.Port, userEnvPath, launcherExePath, installRoot, configRoot);
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

static bool IsFirstRun(string envPath, string userEnvPath)
{
    return !File.Exists(envPath) && !File.Exists(userEnvPath);
}

static string GetFolderPath(string overrideVariableName, Environment.SpecialFolder specialFolder)
{
    var overridePath = Environment.GetEnvironmentVariable(overrideVariableName);
    return string.IsNullOrWhiteSpace(overridePath) ? Environment.GetFolderPath(specialFolder) : overridePath;
}

static LauncherState PromptFirstRun(LauncherState state, string envPath, string userEnvPath, string launcherExePath)
{
    WriteHeader("Primeira configuracao");
    Console.WriteLine("Voce pode deixar as credenciais em branco e preencher depois pela UI.");
    Console.WriteLine();

    var port = PromptInt("Porta do app", state.Port > 0 ? state.Port : DefaultAppPort);
    var clientId = Prompt("Pluggy Client ID (opcional)");
    var clientSecret = Prompt("Pluggy Client Secret (opcional)", secret: true);
    var itemId = Prompt("Pluggy Item ID (opcional)");
    var autoStart = PromptYesNo("Iniciar automaticamente com o Windows?", state.AutoStart);

    var envContent = string.Join(Environment.NewLine, new[]
    {
        $"PLUGGY_CLIENT_ID=\"{EscapeEnv(clientId)}\"",
        $"PLUGGY_CLIENT_SECRET=\"{EscapeEnv(clientSecret)}\"",
        $"PLUGGY_ITEM_ID=\"{EscapeEnv(itemId)}\"",
        $"API_PORT={port}",
        string.Empty,
    });

    WriteEnvContent(envPath, envContent);
    WriteEnvContent(userEnvPath, envContent);

    SetAutoStart(autoStart, launcherExePath);

    state.Port = port;
    state.AutoStart = autoStart;
    state.FirstRun = false;
    return state;
}

static void WriteEnvContent(string envPath, string envContent)
{
    Directory.CreateDirectory(Path.GetDirectoryName(envPath)!);
    File.WriteAllText(envPath, envContent, Encoding.UTF8);
}

static void SyncEnvFiles(string envPath, string userEnvPath)
{
    if (File.Exists(envPath) && File.Exists(userEnvPath))
    {
        if (File.GetLastWriteTimeUtc(envPath) > File.GetLastWriteTimeUtc(userEnvPath))
        {
            MirrorEnvFile(envPath, userEnvPath);
            return;
        }

        MirrorEnvFile(userEnvPath, envPath);
        return;
    }

    if (File.Exists(userEnvPath))
    {
        MirrorEnvFile(userEnvPath, envPath);
        return;
    }

    if (File.Exists(envPath))
    {
        MirrorEnvFile(envPath, userEnvPath);
    }
}

static void MirrorEnvFile(string sourcePath, string targetPath)
{
    if (!File.Exists(sourcePath))
    {
        return;
    }

    Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
    File.Copy(sourcePath, targetPath, overwrite: true);
}

static void SyncPortFromEnv(LauncherState state, string envPath, string userEnvPath)
{
    var envPort = ReadApiPort(envPath);
    if (envPort is null)
    {
        return;
    }

    if (state.Port == LegacyDefaultAppPort && envPort == LegacyDefaultAppPort)
    {
        state.Port = DefaultAppPort;
        WriteApiPort(envPath, DefaultAppPort);
        MirrorEnvFile(envPath, userEnvPath);
        Console.WriteLine($"Porta padrao migrada de {LegacyDefaultAppPort} para {DefaultAppPort}.");
        return;
    }

    if (envPort > 0 && envPort != state.Port)
    {
        state.Port = envPort.Value;
        Console.WriteLine($"Porta carregada da configuracao local: {state.Port}.");
    }
}

static int? ReadApiPort(string envPath)
{
    if (!File.Exists(envPath))
    {
        return null;
    }

    foreach (var line in File.ReadAllLines(envPath))
    {
        var trimmed = line.Trim();
        if (!trimmed.StartsWith("API_PORT=", StringComparison.Ordinal))
        {
            continue;
        }

        var rawValue = trimmed["API_PORT=".Length..].Trim().Trim('"');
        return int.TryParse(rawValue, out var port) && port > 0 ? port : null;
    }

    return null;
}

static void WriteApiPort(string envPath, int port)
{
    if (!File.Exists(envPath))
    {
        return;
    }

    var lines = File.ReadAllLines(envPath).ToList();
    var updated = false;
    for (var index = 0; index < lines.Count; index++)
    {
        if (!lines[index].TrimStart().StartsWith("API_PORT=", StringComparison.Ordinal))
        {
            continue;
        }

        lines[index] = $"API_PORT={port}";
        updated = true;
        break;
    }

    if (!updated)
    {
        lines.Add($"API_PORT={port}");
    }

    File.WriteAllLines(envPath, lines, Encoding.UTF8);
}

static string InstallBundledRuntime(string appRoot, string runtimeRoot, string releaseTag, LauncherState state)
{
    WriteHeader("Preparando app");
    Directory.CreateDirectory(appRoot);
    Directory.CreateDirectory(runtimeRoot);

    var nodeExePath = Path.Combine(runtimeRoot, "node.exe");
    var shouldRefreshRuntime = !File.Exists(nodeExePath) || !releaseTag.Equals(state.RuntimeReleaseTag, StringComparison.OrdinalIgnoreCase);
    if (shouldRefreshRuntime)
    {
        var nodeBundlePath = Path.Combine(runtimeRoot, "node.zip");
        ExtractEmbeddedResource(NodeBundleResourceName, nodeBundlePath);
        ZipFile.ExtractToDirectory(nodeBundlePath, runtimeRoot, overwriteFiles: true);

        if (!File.Exists(nodeExePath))
        {
            throw new InvalidOperationException("Runtime Node portatil nao foi extraido corretamente.");
        }
    }

    var shouldRefreshApp =
        !releaseTag.Equals(state.AppReleaseTag, StringComparison.OrdinalIgnoreCase) ||
        !File.Exists(Path.Combine(appRoot, "server", "index.mjs")) ||
        !File.Exists(Path.Combine(appRoot, "dist", "index.html"));

    if (shouldRefreshApp)
    {
        DeleteDirectoryIfExists(Path.Combine(appRoot, "server"));
        DeleteDirectoryIfExists(Path.Combine(appRoot, "dist"));

        var appBundlePath = Path.Combine(runtimeRoot, "app.zip");
        ExtractEmbeddedResource(AppBundleResourceName, appBundlePath);
        ZipFile.ExtractToDirectory(appBundlePath, appRoot, overwriteFiles: true);
        Console.WriteLine($"App local atualizado para {releaseTag}.");
    }
    else
    {
        Console.WriteLine($"App ja esta na release {releaseTag}.");
    }

    return nodeExePath;
}

static void ExtractEmbeddedResource(string resourceName, string destinationPath)
{
    using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName);
    if (stream is null)
    {
        throw new InvalidOperationException($"Recurso embutido {resourceName} nao encontrado. Gere a release com npm run release:win.");
    }

    Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
    using var destination = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None);
    stream.CopyTo(destination);
}

static void DeleteDirectoryIfExists(string path)
{
    if (Directory.Exists(path))
    {
        Directory.Delete(path, recursive: true);
    }
}

static void RunSmokeTest(string nodeExePath, string appRoot, string logsDir, string userEnvPath, string launcherExePath, string installRoot, string configRoot)
{
    const int smokePort = 8798;
    WriteHeader("Smoke test");
    var serverProcess = StartServer(nodeExePath, appRoot, logsDir, smokePort, userEnvPath, launcherExePath, installRoot, configRoot);

    try
    {
        WaitForServer($"http://127.0.0.1:{smokePort}/");
        Console.WriteLine("Smoke test OK.");
    }
    finally
    {
        if (!serverProcess.HasExited)
        {
            serverProcess.Kill(entireProcessTree: true);
            serverProcess.WaitForExit(5000);
        }
    }
}

static bool TryUpdateLauncher(string launcherExePath, string currentReleaseTag)
{
    if (string.IsNullOrWhiteSpace(launcherExePath) || !File.Exists(launcherExePath))
    {
        Console.WriteLine("Nao foi possivel localizar o executavel atual; pulando update automatico.");
        return false;
    }

    WriteHeader("Checando releases");
    var latestRelease = FetchLatestRelease();

    if (latestRelease is null || string.IsNullOrWhiteSpace(latestRelease.TagName))
    {
        Console.WriteLine("Nao foi possivel consultar a ultima release agora.");
        return false;
    }

    if (!IsNewerRelease(latestRelease.TagName, currentReleaseTag))
    {
        Console.WriteLine($"Nenhuma release nova encontrada. Atual: {currentReleaseTag}.");
        return false;
    }

    var asset = latestRelease.Assets?.FirstOrDefault((item) => item.Name.Equals(ReleaseAssetName, StringComparison.OrdinalIgnoreCase));
    if (asset is null || string.IsNullOrWhiteSpace(asset.BrowserDownloadUrl))
    {
        Console.WriteLine($"Release {latestRelease.TagName} nao tem o asset {ReleaseAssetName}; usando versao atual.");
        return false;
    }

    Console.WriteLine($"Nova release encontrada: {latestRelease.TagName}. Baixando executavel...");
    var updateDir = Path.Combine(Path.GetTempPath(), AppName, "updates");
    Directory.CreateDirectory(updateDir);

    try
    {
        var downloadedExePath = Path.Combine(updateDir, $"{AppName}-{SanitizeFileName(latestRelease.TagName)}.exe");
        DownloadFile(asset.BrowserDownloadUrl, downloadedExePath);
        StartSelfUpdater(downloadedExePath, launcherExePath);
    }
    catch (Exception error)
    {
        Console.WriteLine($"Update nao aplicado agora: {error.Message}");
        return false;
    }

    Console.WriteLine("Update baixado. O GranaFlow vai reiniciar com a nova versao.");
    return true;
}

static ReleaseInfo? FetchLatestRelease()
{
    using var client = CreateGitHubClient();
    try
    {
        using var response = client.GetAsync(LatestReleaseApiUrl).GetAwaiter().GetResult();
        if (!response.IsSuccessStatusCode)
        {
            Console.WriteLine($"GitHub respondeu {(int)response.StatusCode} ao consultar releases.");
            return null;
        }

        var payload = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        return JsonSerializer.Deserialize(payload, LauncherJsonContext.Default.ReleaseInfo);
    }
    catch (Exception error)
    {
        Console.WriteLine($"Nao foi possivel consultar releases: {error.Message}");
        return null;
    }
}

static void DownloadFile(string url, string destinationPath)
{
    using var client = CreateGitHubClient();
    using var response = client.GetAsync(url).GetAwaiter().GetResult();
    response.EnsureSuccessStatusCode();

    using var destination = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None);
    response.Content.CopyToAsync(destination).GetAwaiter().GetResult();

    if (new FileInfo(destinationPath).Length < 1_000_000)
    {
        throw new InvalidOperationException("Download do executavel parece incompleto.");
    }
}

static HttpClient CreateGitHubClient()
{
    var client = new HttpClient();
    client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/vnd.github+json");
    client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", $"{AppName}-launcher");
    return client;
}

static bool IsNewerRelease(string latestTag, string currentTag)
{
    if (TryParseReleaseVersion(latestTag, out var latestVersion) && TryParseReleaseVersion(currentTag, out var currentVersion))
    {
        return latestVersion.CompareTo(currentVersion) > 0;
    }

    return !latestTag.Equals(currentTag, StringComparison.OrdinalIgnoreCase);
}

static bool TryParseReleaseVersion(string tag, out Version version)
{
    var normalized = tag.Trim().TrimStart('v', 'V');
    var suffixIndex = normalized.IndexOfAny(new[] { '-', '+' });
    if (suffixIndex >= 0)
    {
        normalized = normalized[..suffixIndex];
    }

    return Version.TryParse(normalized, out version!);
}

static void StartSelfUpdater(string downloadedExePath, string launcherExePath)
{
    var updateDir = Path.GetDirectoryName(downloadedExePath)!;
    var scriptPath = Path.Combine(updateDir, "apply-update.ps1");
    File.WriteAllText(scriptPath, """
param(
    [int]$ParentPid,
    [string]$Source,
    [string]$Target,
    [string]$Arguments
)

$ErrorActionPreference = 'Stop'
try {
    Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
} catch {}

Start-Sleep -Milliseconds 700
Copy-Item -LiteralPath $Source -Destination $Target -Force
Start-Process -FilePath $Target -ArgumentList $Arguments
""", Encoding.UTF8);

    var arguments = string.Join(" ", new[]
    {
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        QuoteCliArg(scriptPath),
        "-ParentPid",
        Environment.ProcessId.ToString(),
        "-Source",
        QuoteCliArg(downloadedExePath),
        "-Target",
        QuoteCliArg(launcherExePath),
        "-Arguments",
        QuoteCliArg("--skip-update"),
    });

    Process.Start(new ProcessStartInfo
    {
        FileName = "powershell.exe",
        Arguments = arguments,
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden,
    });
}

static string GetCurrentReleaseTag()
{
    var version = Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
        ?.InformationalVersion
        .Split('+')[0]
        .Trim();

    return string.IsNullOrWhiteSpace(version) ? "v0.0.0" : $"v{version.TrimStart('v', 'V')}";
}

static string SanitizeFileName(string value)
{
    var invalidChars = Path.GetInvalidFileNameChars();
    var builder = new StringBuilder(value.Length);
    foreach (var character in value)
    {
        builder.Append(invalidChars.Contains(character) ? '-' : character);
    }

    return builder.ToString();
}

static string QuoteCliArg(string value)
{
    return $"\"{value.Replace("\"", "\\\"")}\"";
}

static Process StartServer(string nodeExePath, string appRoot, string logsDir, int port, string userEnvPath, string launcherExePath, string installRoot, string configRoot)
{
    WriteHeader("Subindo servidor");
    Directory.CreateDirectory(logsDir);

    var stdoutPath = Path.Combine(logsDir, "server.out.log");
    var stderrPath = Path.Combine(logsDir, "server.err.log");
    var startInfo = new ProcessStartInfo
    {
        FileName = nodeExePath,
        Arguments = "server/index.mjs",
        WorkingDirectory = appRoot,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };

    startInfo.Environment["API_PORT"] = port.ToString();
    startInfo.Environment["GRANAFLOW_CONFIG_ENV_PATH"] = userEnvPath;
    startInfo.Environment["GRANAFLOW_CONFIG_ROOT"] = configRoot;
    startInfo.Environment["GRANAFLOW_INSTALL_ROOT"] = installRoot;
    startInfo.Environment["GRANAFLOW_LAUNCHER_EXE_PATH"] = launcherExePath;
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

static LauncherState LoadState(string path)
{
    if (!File.Exists(path))
    {
        return new LauncherState();
    }

    try
    {
        return JsonSerializer.Deserialize(File.ReadAllText(path), LauncherJsonContext.Default.LauncherState) ?? new LauncherState();
    }
    catch
    {
        return new LauncherState();
    }
}

static void SaveState(string path, LauncherState state)
{
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, JsonSerializer.Serialize(state, LauncherJsonContext.Default.LauncherState));
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
    public string? AppReleaseTag { get; set; }
    public string? RuntimeReleaseTag { get; set; }
    public bool AutoStart { get; set; }
    public bool FirstRun { get; set; } = true;
    public int Port { get; set; } = 5173;
    public int? ServerProcessId { get; set; }
}

internal sealed class ReleaseInfo
{
    [JsonPropertyName("tag_name")]
    public string TagName { get; set; } = string.Empty;

    [JsonPropertyName("assets")]
    public List<ReleaseAsset> Assets { get; set; } = [];
}

internal sealed class ReleaseAsset
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("browser_download_url")]
    public string BrowserDownloadUrl { get; set; } = string.Empty;
}

[JsonSourceGenerationOptions(WriteIndented = true)]
[JsonSerializable(typeof(LauncherState))]
[JsonSerializable(typeof(ReleaseInfo))]
internal sealed partial class LauncherJsonContext : JsonSerializerContext
{
}
