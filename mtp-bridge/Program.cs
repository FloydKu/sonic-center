// mtp-bridge: 基于 MediaDevices 2.0 的轻量级 MTP CLI 工具
//
// 用法 (所有输出均为 JSON，供 Electron 主进程 mtpService.ts 解析):
//   mtp-bridge.exe --action list-devices
//   mtp-bridge.exe --action scan --device "WALKMAN" --path "\Internal storage\Music" [--recursive]
//     recursive 模式：单次连接内递归枚举全部子目录，返回扁平文件列表；
//     期间每 25 个目录输出一行进度 {"__progress__":N,"__dir__":"..."} 到 stdout（TS 端过滤）
//   mtp-bridge.exe --action upload --device "WALKMAN" --local "D:/test.flac" --remote "\Internal storage\Music\test.flac"
//   mtp-bridge.exe --action upload-batch --device "WALKMAN" --list "C:/tmp/list.json"
//     单次连接内依次上传 list.json 中的 [{local, remote, replace}]，每个文件完成后输出一行
//     {"__upload__":序号,"result":{...}}，末尾输出汇总 JSON
//   mtp-bridge.exe --action write-m3u --device "WALKMAN" --remote "\Internal storage\Playlists\my_list.m3u" (--content "..." | --content-file "C:/tmp/list.m3u")
//   mtp-bridge.exe --action read --device "WALKMAN" --remote "\Internal storage\Playlists\my_list.m3u"
//   mtp-bridge.exe --action delete --device "WALKMAN" --remote "\Internal storage\Music\test.flac"
//
// 设计要点:
//   - 使用 MediaDevices 2.0 (preview) — 该版本以 generated COM + LibraryImport 重写，支持 Native AOT
//   - 所有 JSON 序列化使用 Source Generation (JsonSerializerContext)，无反射，AOT 安全
//   - 成功时 JSON 输出到 stdout (exit 0)；失败时错误消息输出到 stderr (exit 1)
//   - 上传支持增量同步：远程同名且同大小文件自动跳过

using System.Text.Json;
using System.Text.Json.Serialization;
using MediaDevices;

// ============================================================================
//  主程序入口 (top-level statements — 必须位于所有类型声明之前)
// ============================================================================

MediaDeviceManager? manager = null;
try
{
    // MediaDeviceManager 是 v2 的单例入口，负责 COM 初始化与设备枚举
    manager = MediaDeviceManager.Instance;

    var parsed = ParseArgs(args);
    var action = GetRequired(parsed, "action");

    switch (action.ToLowerInvariant())
    {
        case "list-devices":
            Console.WriteLine(JsonSerializer.Serialize(ListDevices(), MtpJsonContext.Default.DeviceInfoArray));
            break;
        case "test-json":
            Console.WriteLine(JsonSerializer.Serialize(TestJson(), MtpJsonContext.Default.DeviceInfoArray));
            break;
        case "scan":
            Console.WriteLine(JsonSerializer.Serialize(Scan(parsed), MtpJsonContext.Default.FileEntryArray));
            break;
        case "upload":
            Console.WriteLine(JsonSerializer.Serialize(Upload(parsed), MtpJsonContext.Default.UploadResult));
            break;
        case "upload-batch":
            Console.WriteLine(JsonSerializer.Serialize(UploadBatch(parsed), MtpJsonContext.Default.UploadBatchResult));
            break;
        case "write-m3u":
            Console.WriteLine(JsonSerializer.Serialize(WriteM3u(parsed), MtpJsonContext.Default.OperationResult));
            break;
        case "read":
            Console.WriteLine(JsonSerializer.Serialize(ReadFile(parsed), MtpJsonContext.Default.ReadResult));
            break;
        case "delete":
            Console.WriteLine(JsonSerializer.Serialize(Delete(parsed), MtpJsonContext.Default.OperationResult));
            break;
        default:
            throw new MtpException(
                $"未知操作: {action}。支持: list-devices | scan | upload | upload-batch | write-m3u | read | delete");
    }
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    Environment.ExitCode = 1;
}
finally
{
    // 释放 COM 资源与工作线程；单例 Dispose 后 Instance 变为 null
    manager?.Dispose();
}

// ============================================================================
//  Action 实现 (local functions)
// ============================================================================

/// <summary>
/// 枚举所有已连接的 MTP 设备，返回设备名称、ID、总空间与可用空间。
/// 需要对每个设备执行 Connect → GetDrives → Disconnect 以读取存储容量。
/// </summary>
static DeviceInfo[] ListDevices()
{
    var devices = MediaDeviceManager.Instance.GetDevices() ?? [];
    var result = new List<DeviceInfo>();

    foreach (var device in devices)
    {
        device.Connect();
        try
        {
            // MTP 设备可能有多个存储 (内部 + SD 卡)，汇总总容量与可用空间
            long totalSpace = 0;
            long freeSpace = 0;
            var storages = new List<StorageInfo>();
            foreach (var drive in device.GetDrives())
            {
                // MTP 驱动器的 VolumeLabel 常为空，Name 通常为路径如 \Internal storage
                var storageName = !string.IsNullOrEmpty(drive.VolumeLabel) ? drive.VolumeLabel
                    : !string.IsNullOrEmpty(drive.Name)
                        ? (drive.Name.Split('\\', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "Storage")
                    : "Storage";
                storages.Add(new StorageInfo
                {
                    Name = storageName,
                    TotalSpace = drive.TotalSize,
                    FreeSpace = drive.TotalFreeSpace,
                });
                totalSpace += drive.TotalSize;
                freeSpace += drive.TotalFreeSpace;
            }

            // FriendlyName 优先；为空时用 Description 作为显示名和业务标识
            var displayName = !string.IsNullOrEmpty(device.FriendlyName) ? device.FriendlyName
                : !string.IsNullOrEmpty(device.Description) ? device.Description
                : !string.IsNullOrEmpty(device.Manufacturer) ? device.Manufacturer
                : "Unknown";
            var deviceId = !string.IsNullOrEmpty(device.FriendlyName) ? device.FriendlyName
                : !string.IsNullOrEmpty(device.Description) ? device.Description
                : device.DeviceId;

            result.Add(new DeviceInfo
            {
                Id = deviceId,
                Name = displayName,
                Description = device.Description,
                Manufacturer = device.Manufacturer,
                TotalSpace = totalSpace,
                FreeSpace = freeSpace,
                Storages = storages,
            });
        }
        finally
        {
            device.Disconnect();
        }
    }

    return result.ToArray();
}

/// <summary>
/// 输出包含两个模拟存储设备的 JSON，用于验证 Storages 序列化是否正常。
/// 用法: mtp-bridge.exe --action test-json
/// </summary>
static DeviceInfo[] TestJson()
{
    return [
        new DeviceInfo
        {
            Id = "TEST",
            Name = "Test Device",
            TotalSpace = 64_000_000_000,
            FreeSpace = 32_000_000_000,
            Storages =
            [
                new StorageInfo { Name = "Internal storage", TotalSpace = 32_000_000_000, FreeSpace = 16_000_000_000 },
                new StorageInfo { Name = "SD card", TotalSpace = 32_000_000_000, FreeSpace = 16_000_000_000 },
            ],
        },
    ];
}

/// <summary>
/// 扫描设备指定目录，返回该目录下所有文件和文件夹的列表。
/// 使用 MediaDirectoryInfo.EnumerateFileSystemInfos() 一次性获取带属性的条目列表，
/// 无需逐个调用 GetFileInfo，性能更优。
/// recursive=true 时在同一连接内递归枚举全部子目录（消除逐目录进程启动开销，
/// 从 ~300ms/目录降至几十 ms/目录），并定期输出进度行供 TS 端实时展示。
/// </summary>
static FileEntry[] Scan(Dictionary<string, string> args)
{
    var deviceName = GetRequired(args, "device");
    var path = GetRequired(args, "path");
    var recursive = args.TryGetValue("recursive", out var r) && (r == "1" || r.Equals("true", StringComparison.OrdinalIgnoreCase));

    var device = OpenDevice(deviceName);
    try
    {
        var root = device.GetDirectoryInfo(path);
        if (recursive)
        {
            var all = new List<FileEntry>();
            var scanned = 0;
            EnumerateRecursive(root, all, ref scanned);
            return all.ToArray();
        }

        return EnumerateOneLevel(root).ToArray();
    }
    finally
    {
        device.Disconnect();
        device.Dispose();
    }
}

/// <summary>枚举单个目录的直接子项（非递归）</summary>
static List<FileEntry> EnumerateOneLevel(MediaDirectoryInfo dir)
{
    var entries = new List<FileEntry>();
    foreach (var item in dir.EnumerateFileSystemInfos())
    {
        entries.Add(ToFileEntry(item));
    }
    return entries;
}

/// <summary>文件系统条目 → FileEntry（优先用类型检查判断目录）</summary>
static FileEntry ToFileEntry(MediaFileSystemInfo item)
{
    // 优先用类型检查判断是否为目录（MTP 存储根目录的 Attributes 可能缺少 Directory 标志）
    var isFolder = item is MediaDirectoryInfo || (item.Attributes & MediaFileAttributes.Directory) != 0;
    return new FileEntry
    {
        Name = item.Name,
        Path = item.FullName,
        IsFolder = isFolder,
        Size = isFolder ? 0 : (long)item.Length,
        LastModified = item.LastWriteTime?.ToString("o"),
    };
}

/// <summary>
/// 递归枚举目录树：文件夹不入结果（仅文件），每扫完 25 个目录输出进度行。
/// 单个子目录枚举失败时静默跳过（与旧版逐目录 TS 扫描的容错策略一致）。
/// </summary>
static void EnumerateRecursive(MediaDirectoryInfo dir, List<FileEntry> all, ref int scanned)
{
    List<MediaFileSystemInfo> children;
    try
    {
        children = dir.EnumerateFileSystemInfos().ToList();
    }
    catch
    {
        return; // 单目录失败跳过
    }

    scanned++;
    if (scanned % 25 == 0)
    {
        // 进度行与结果 JSON 混在 stdout，TS 端按 __progress__ 前缀过滤
        Console.WriteLine("{\"__progress__\":" + scanned + ",\"__dir__\":" +
            JsonSerializer.Serialize(dir.FullName, MtpJsonContext.Default.String) + "}");
    }

    foreach (var item in children)
    {
        if (item is MediaDirectoryInfo sub)
        {
            EnumerateRecursive(sub, all, ref scanned);
        }
        else
        {
            all.Add(ToFileEntry(item));
        }
    }
}

/// <summary>
/// 上传/增量同步文件到设备。
/// 增量策略：远程已存在同名且文件大小一致的文件则跳过；否则写入设备。
/// 写入前会自动创建所需的远程目录层级。
/// </summary>
static UploadResult Upload(Dictionary<string, string> args)
{
    var deviceName = GetRequired(args, "device");
    var localPath = GetRequired(args, "local");
    var remotePath = GetRequired(args, "remote");

    if (!File.Exists(localPath))
        throw new MtpException($"本地文件不存在: {localPath}");

    var localSize = new FileInfo(localPath).Length;

    var device = OpenDevice(deviceName);
    try
    {
        // 增量检查：远程文件已存在且大小一致 → 跳过；不一致 → 删除后重新上传
        if (device.FileExists(remotePath))
        {
            var remoteInfo = device.GetFileInfo(remotePath);
            if ((long)remoteInfo.Length == localSize)
            {
                return new UploadResult { Ok = true, Skipped = true };
            }
            // MediaDevices 库的 UploadFile 对已存在文件抛 "already exists"，覆盖前先删除
            device.DeleteFile(remotePath);
        }

        // 确保远程目录存在 (MTP 不会自动创建父目录)
        EnsureRemoteDirectory(device, remotePath);

        // 上传文件 (使用文件路径重载，库内部处理流式传输)
        device.UploadFile(localPath, remotePath);

        return new UploadResult { Ok = true, Skipped = false };
    }
    finally
    {
        device.Disconnect();
        device.Dispose();
    }
}

/// <summary>
/// 批量上传：整批文件共用一次 MTP 连接（逐文件启动进程时每首歌都要重新连接、
/// 从存储根逐级查找路径，速度慢且频繁连接/断开易使设备 MTP 服务卡死）。
/// 已确认存在的目录在本批次内缓存；replace=true 表示设备上有同名不同大小的文件需先删除。
/// 连续多个文件失败说明设备已无响应，立即停止，避免继续向卡死的设备发送请求。
/// </summary>
static UploadBatchResult UploadBatch(Dictionary<string, string> args)
{
    var deviceName = GetRequired(args, "device");
    var listPath = GetRequired(args, "list");
    var items = JsonSerializer.Deserialize(File.ReadAllText(listPath, System.Text.Encoding.UTF8),
        MtpJsonContext.Default.ListUploadBatchItem) ?? [];

    const int maxConsecutiveFailures = 3;
    var knownDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var done = 0;
    var consecutiveFailures = 0;
    string? lastFailedDir = null;
    string? abortReason = null;

    var device = OpenDevice(deviceName);
    try
    {
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            var result = new UploadItemResult { Index = i };
            try
            {
                result.Skipped = UploadOne(device, item, knownDirs);
                result.Ok = true;
                consecutiveFailures = 0;
                lastFailedDir = null;
            }
            catch (Exception ex)
            {
                result.Ok = false;
                // 设备对新建对象返回空 ID：通常是目录/文件名被设备改写（如去掉结尾的点）后按原名找不到
                result.Error = ex.Message.Contains("reading properties", StringComparison.OrdinalIgnoreCase)
                    ? $"设备不接受该路径（名称可能含设备不支持的字符或结尾形式）：{item.Remote}"
                    : ex.Message;
                // 同一目录内的连续失败多半是该路径本身的问题（如名称不被设备接受），只计一次，
                // 不同目录也连续失败才说明设备本身出了问题
                var dir = Path.GetDirectoryName(item.Remote);
                if (!string.Equals(dir, lastFailedDir, StringComparison.OrdinalIgnoreCase)) consecutiveFailures++;
                lastFailedDir = dir;
            }
            done++;
            Console.WriteLine("{\"__upload__\":" + i + ",\"result\":" +
                JsonSerializer.Serialize(result, MtpJsonContext.Default.UploadItemResult) + "}");
            if (consecutiveFailures >= maxConsecutiveFailures)
            {
                abortReason = $"连续 {maxConsecutiveFailures} 个目录上传失败，设备可能已无响应，已停止上传：{result.Error}";
                break;
            }
        }
    }
    finally
    {
        device.Disconnect();
        device.Dispose();
    }

    return new UploadBatchResult { Ok = abortReason == null, Done = done, Aborted = abortReason != null, Error = abortReason };
}

/// <summary>上传批次中的单个文件；返回 true 表示设备上已有同名同大小文件而跳过</summary>
static bool UploadOne(MediaDevice device, UploadBatchItem item, HashSet<string> knownDirs)
{
    if (!File.Exists(item.Local))
        throw new MtpException($"本地文件不存在: {item.Local}");
    var localSize = new FileInfo(item.Local).Length;

    if (item.Replace && device.FileExists(item.Remote))
    {
        if ((long)device.GetFileInfo(item.Remote).Length == localSize) return true;
        device.DeleteFile(item.Remote);
    }

    EnsureRemoteDirectory(device, item.Remote, knownDirs);
    try
    {
        device.UploadFile(item.Local, item.Remote);
    }
    catch (Exception ex) when (ex.Message.Contains("exist", StringComparison.OrdinalIgnoreCase))
    {
        // 扫描结果可能漏掉了设备上已有的文件：同大小视为已存在，否则覆盖
        if ((long)device.GetFileInfo(item.Remote).Length == localSize) return true;
        device.DeleteFile(item.Remote);
        device.UploadFile(item.Local, item.Remote);
    }
    return false;
}

/// <summary>
/// 将 M3U 播放列表内容写入设备，内容以 UTF-8 编码写入远程文件。
/// 内容来自 --content-file（推荐，不受命令行 ~32K 字符限制）或 --content。
/// 已有同名文件时先写到临时文件再替换：MTP 不支持覆盖写入，若先删旧文件再上传，
/// 上传失败（设备卡死/拔出）时播放列表会直接丢失。
/// </summary>
static OperationResult WriteM3u(Dictionary<string, string> args)
{
    var deviceName = GetRequired(args, "device");
    var remotePath = GetRequired(args, "remote");
    var content = args.TryGetValue("content-file", out var contentFile) && !string.IsNullOrEmpty(contentFile)
        ? File.ReadAllText(contentFile, System.Text.Encoding.UTF8)
        : GetRequired(args, "content");
    var bytes = new System.Text.UTF8Encoding(false).GetBytes(content);

    var device = OpenDevice(deviceName);
    try
    {
        EnsureRemoteDirectory(device, remotePath);

        if (!device.FileExists(remotePath))
        {
            UploadBytes(device, bytes, remotePath);
            return new OperationResult { Ok = true };
        }

        var tempPath = remotePath + ".part";
        if (device.FileExists(tempPath)) device.DeleteFile(tempPath);
        UploadBytes(device, bytes, tempPath);
        device.DeleteFile(remotePath);
        var renamed = false;
        try
        {
            device.Rename(tempPath, Path.GetFileName(remotePath));
            renamed = device.FileExists(remotePath);
        }
        catch
        {
            renamed = false;
        }
        if (!renamed)
        {
            // 设备不支持重命名（或重命名未生效）：改为直接写入目标文件（旧文件已删除）
            if (device.FileExists(tempPath)) device.DeleteFile(tempPath);
            UploadBytes(device, bytes, remotePath);
        }

        return new OperationResult { Ok = true };
    }
    finally
    {
        device.Disconnect();
        device.Dispose();
    }
}

/// <summary>写入内存中的字节到设备文件</summary>
static void UploadBytes(MediaDevice device, byte[] bytes, string remotePath)
{
    using var stream = new MemoryStream(bytes);
    device.UploadFile(stream, remotePath);
}

/// <summary>
/// 从设备读取文本文件内容 (如 M3U 播放列表)，以 UTF-8 解码返回原始文本。
/// 只读一次并附上设备报告的文件大小，由调用方判断是否可信：
/// 同一连接内反复重读不会改善结果，反而加重设备负担（P1 实测设备报告的大小
/// 会滞后于真实内容，按大小重读只会一直失败）。
/// </summary>
static ReadResult ReadFile(Dictionary<string, string> args)
{
    var deviceName = GetRequired(args, "device");
    var remotePath = GetRequired(args, "remote");

    var device = OpenDevice(deviceName);
    try
    {
        var info = device.GetFileInfo(remotePath);
        var expected = (long)info.Length;
        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            using (var stream = info.OpenRead())
            {
                stream.CopyTo(ms);
            }
            bytes = ms.ToArray();
        }
        return new ReadResult
        {
            Content = System.Text.Encoding.UTF8.GetString(bytes),
            Size = bytes.LongLength,
            ExpectedSize = expected,
        };
    }
    finally
    {
        device.Disconnect();
        device.Dispose();
    }
}

/// <summary>从设备删除指定文件</summary>
static OperationResult Delete(Dictionary<string, string> args)
{
    var deviceName = GetRequired(args, "device");
    var remotePath = GetRequired(args, "remote");

    var device = OpenDevice(deviceName);
    try
    {
        device.DeleteFile(remotePath);
        return new OperationResult { Ok = true };
    }
    finally
    {
        device.Disconnect();
        device.Dispose();
    }
}

// ============================================================================
//  辅助方法 (local functions)
// ============================================================================

/// <summary>
/// 解析 --key value 格式的命令行参数。
/// 注意：--content 的值本身如果以 "--" 开头可能被误判为另一个参数，
/// 但 M3U 内容通常以 #EXTM3U 开头，实际不受影响。
/// </summary>
static Dictionary<string, string> ParseArgs(string[] args)
{
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i < args.Length; i++)
    {
        if (args[i].StartsWith("--") && i + 1 < args.Length)
        {
            // 去掉 "--" 前缀作为 key，下一个参数作为 value
            result[args[i][2..]] = args[i + 1];
            i++; // 跳过已消费的 value
        }
    }
    return result;
}

/// <summary>从已解析参数中获取必需值，缺失时抛出 MtpException</summary>
static string GetRequired(Dictionary<string, string> args, string key)
{
    if (args.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value))
        return value;
    throw new MtpException($"缺少必需参数: --{key}");
}

/// <summary>
/// 按设备名称 (FriendlyName) 或设备 ID 查找并连接 MTP 设备。
/// 匹配不区分大小写，先匹配 FriendlyName，再匹配 DeviceId。
/// </summary>
static MediaDevice OpenDevice(string deviceName)
{
    var devices = MediaDeviceManager.Instance.GetDevices() ?? [];
    var device = devices.FirstOrDefault(d =>
        string.Equals(d.FriendlyName, deviceName, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(d.DeviceId, deviceName, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(d.Description, deviceName, StringComparison.OrdinalIgnoreCase));

    if (device == null)
        throw new MtpException($"未找到 MTP 设备: {deviceName}");

    device.Connect();
    return device;
}

/// <summary>
/// 确保远程文件路径的父目录存在，不存在则逐级创建。
/// 例如 remotePath = "\Internal storage\Music\test.flac"
/// 会依次检查并创建 "\Internal storage" 和 "\Internal storage\Music"。
/// </summary>
static void EnsureRemoteDirectory(MediaDevice device, string remotePath, HashSet<string>? knownDirs = null)
{
    var dir = Path.GetDirectoryName(remotePath);
    if (string.IsNullOrEmpty(dir) || knownDirs?.Contains(dir) == true) return;

    // 按 \ 分割路径并逐级构建，确保每一级目录都存在（批量上传时跳过已确认的目录）
    var segments = dir.Split('\\', StringSplitOptions.RemoveEmptyEntries);
    var current = "";
    foreach (var segment in segments)
    {
        current = current + "\\" + segment;
        if (knownDirs?.Contains(current) == true) continue;
        if (!device.DirectoryExists(current))
        {
            device.CreateDirectory(current);
        }
        knownDirs?.Add(current);
    }
}

// ============================================================================
//  类型声明 (必须位于 top-level statements 之后)
// ============================================================================

/// <summary>MTP 设备信息 (list-devices 输出)</summary>
public sealed class DeviceInfo
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string? Manufacturer { get; set; }
    /// <summary>总容量 (字节)</summary>
    public long TotalSpace { get; set; }
    /// <summary>可用空间 (字节)</summary>
    public long FreeSpace { get; set; }
    /// <summary>各存储设备明细 (内部存储 / SD 卡等)</summary>
    public List<StorageInfo> Storages { get; set; } = [];
}

/// <summary>MTP 设备的单个存储设备信息</summary>
public sealed class StorageInfo
{
    /// <summary>存储名称 (如 "Internal storage", "SD card")</summary>
    public string Name { get; set; } = "";
    /// <summary>总容量 (字节)</summary>
    public long TotalSpace { get; set; }
    /// <summary>可用空间 (字节)</summary>
    public long FreeSpace { get; set; }
}

/// <summary>设备上的文件/文件夹条目 (scan 输出)</summary>
public sealed class FileEntry
{
    public string Name { get; set; } = "";
    /// <summary>设备上的完整路径，如 \Internal storage\Music\song.flac</summary>
    public string Path { get; set; } = "";
    public bool IsFolder { get; set; }
    /// <summary>文件大小 (字节)，文件夹为 0</summary>
    public long Size { get; set; }
    /// <summary>最后修改时间 (ISO 8601)，可能为 null</summary>
    public string? LastModified { get; set; }
}

/// <summary>上传结果</summary>
public sealed class UploadResult
{
    public bool Ok { get; set; } = true;
    /// <summary>是否因远程已存在同名同大小文件而跳过</summary>
    public bool Skipped { get; set; }
}

/// <summary>批量上传的单个条目 (upload-batch 的 --list 文件内容)</summary>
public sealed class UploadBatchItem
{
    public string Local { get; set; } = "";
    public string Remote { get; set; } = "";
    /// <summary>设备上已有同名但大小不同的文件，需先删除再上传</summary>
    public bool Replace { get; set; }
}

/// <summary>批量上传中单个文件的结果 (随进度行输出)</summary>
public sealed class UploadItemResult
{
    public int Index { get; set; }
    public bool Ok { get; set; }
    public bool Skipped { get; set; }
    public string? Error { get; set; }
}

/// <summary>批量上传汇总结果</summary>
public sealed class UploadBatchResult
{
    public bool Ok { get; set; }
    /// <summary>已处理（成功或失败）的文件数</summary>
    public int Done { get; set; }
    /// <summary>因设备无响应提前停止</summary>
    public bool Aborted { get; set; }
    public string? Error { get; set; }
}

/// <summary>通用操作结果 (write-m3u / delete)</summary>
public sealed class OperationResult
{
    public bool Ok { get; set; } = true;
}

/// <summary>文件读取结果 (read 输出)</summary>
public sealed class ReadResult
{
    public string Content { get; set; } = "";
    /// <summary>实际读到的字节数</summary>
    public long Size { get; set; }
    /// <summary>设备报告的文件大小（与 Size 不一致说明读取不可信）</summary>
    public long ExpectedSize { get; set; }
}

// ============================================================================
//  JsonSerializerContext — Native AOT 兼容的源生成 JSON 上下文
//  避免运行时反射，PublishAot 时无需额外 rd.xml 配置
// ============================================================================

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DeviceInfo))]
[JsonSerializable(typeof(DeviceInfo[]))]
[JsonSerializable(typeof(StorageInfo))]
[JsonSerializable(typeof(List<StorageInfo>))]
[JsonSerializable(typeof(FileEntry[]))]
[JsonSerializable(typeof(List<FileEntry>))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(UploadResult))]
[JsonSerializable(typeof(OperationResult))]
[JsonSerializable(typeof(ReadResult))]
[JsonSerializable(typeof(List<UploadBatchItem>))]
[JsonSerializable(typeof(UploadItemResult))]
[JsonSerializable(typeof(UploadBatchResult))]
internal sealed partial class MtpJsonContext : JsonSerializerContext { }

// ============================================================================
//  自定义异常 — 用于在 action 方法中中断流程并输出错误消息
// ============================================================================

internal sealed class MtpException : Exception
{
    public MtpException(string message) : base(message) { }
}
