import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { join, resolve } from "node:path";

export class McpConfigurationError extends Error {
  constructor(readonly code: string) { super(code); }
}

// Fixed program only. Configuration paths/content travel over stdin, never a shell command line.
export const WINDOWS_MCP_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$result = $null
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [IO.Path]::GetFullPath([string]$request.path)
  if ($path -notmatch '^[a-zA-Z]:\\' -or $path.Substring(2).Contains(':')) { throw 'mcp_config_path_unsupported' }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  $systemOwners = $trusted + @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  function Check-Security($acl, [bool]$ancestor, [bool]$private) {
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $owners = $trusted
    if ($ancestor) { $owners = $systemOwners }
    if ($owners -notcontains $owner) { throw 'mcp_config_owner_untrusted' }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'mcp_config_acl_untrusted' }
    # Targets reject writes; ancestors may allow child creation but never replacement or ACL control.
    $mask = [long]0x500d0156
    if ($ancestor) { $mask = [long]0x100d0040 }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      $sid = $rule.IdentityReference.Value
      $allowed = $trusted
      if ($ancestor) { $allowed = $systemOwners }
      if ($allowed -contains $sid) { continue }
      $rights = [long][int]$rule.FileSystemRights
      if (($rights -band $mask) -ne 0 -or ($private -and ($rights -band [long]2147483649) -ne 0)) { throw 'mcp_config_acl_untrusted' }
    }
  }
  function Check-Item([string]$target, [bool]$directory, [bool]$ancestor, [bool]$private) {
    $attributes = [IO.File]::GetAttributes($target)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'mcp_config_symlink_refused' }
    if ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'mcp_config_file_untrusted' }
    Check-Security (Get-Acl -LiteralPath $target) $ancestor $private
  }
  function Check-Parents([string]$target) {
    $cursor = [IO.Directory]::GetParent($target)
    while ($null -ne $cursor) {
      Check-Item $cursor.FullName $true $true $false
      $cursor = $cursor.Parent
    }
  }
  function New-Security([bool]$directory) {
    if ($directory) { $security = New-Object Security.AccessControl.DirectorySecurity }
    else { $security = New-Object Security.AccessControl.FileSecurity }
    $security.SetOwner($user)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in $trusted) {
      $identity = New-Object Security.Principal.SecurityIdentifier($sid)
      if ($directory) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      } else {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
      }
      $security.AddAccessRule($rule)
    }
    return $security
  }
  function Ensure-Directory([string]$target, [bool]$ancestor = $false) {
    if ([IO.Directory]::Exists($target)) {
      Check-Parents $target
      Check-Item $target $true $ancestor $false
      return
    }
    $parent = [IO.Directory]::GetParent($target)
    if ($null -eq $parent) { throw 'mcp_config_directory_untrusted' }
    Ensure-Directory $parent.FullName $true
    [void][IO.Directory]::CreateDirectory($target, (New-Security $true))
    Check-Parents $target
    Check-Item $target $true $false $true
  }
  function Read-File([string]$target, [bool]$private, [int]$limit) {
    try { $attributes = [IO.File]::GetAttributes($target) }
    catch [IO.FileNotFoundException] { return @{missing=$true} }
    catch [IO.DirectoryNotFoundException] { return @{missing=$true} }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'mcp_config_symlink_refused' }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw 'mcp_config_file_untrusted' }
    Check-Parents $target
    # Pin the file and deny writers/deletion while checking its handle ACL and bytes.
    $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      Check-Security ($stream.GetAccessControl()) $false $private
      if ($stream.Length -gt $limit) { throw 'mcp_config_file_untrusted' }
      $bytes = [byte[]]::new([int]$stream.Length)
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($count -eq 0) { throw 'mcp_config_changed' }
        $offset += $count
      }
      if ($stream.Length -ne $bytes.Length) { throw 'mcp_config_changed' }
      return @{content=[Convert]::ToBase64String($bytes)}
    } finally { $stream.Dispose() }
  }
  function New-PrivateFile([string]$target, [string]$content) {
    Ensure-Directory ([IO.Path]::GetDirectoryName($target))
    if ([IO.File]::Exists($target) -or [IO.Directory]::Exists($target)) { throw 'mcp_config_file_exists' }
    $stream = New-Object IO.FileStream($target, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, (New-Security $false))
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes($content)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
    Check-Parents $target
    Check-Item $target $false $false $true
  }
  function Check-Source {
    $current = Read-File $path $false ([int]$request.limit)
    if ([bool]$current.missing -ne [bool]$request.sourceMissing) { throw 'mcp_config_changed' }
    if (-not $current.missing -and $current.content -cne [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$request.source))) { throw 'mcp_config_changed' }
  }
  switch ([string]$request.operation) {
    'directory' { Ensure-Directory $path }
    'inspect' {
      Check-Parents $path
      Check-Item $path ([bool]$request.directory) $false ([bool]$request.private)
    }
    'read' {
      $result = Read-File $path ([bool]$request.private) ([int]$request.limit)
      $result.ok = $true
    }
    'create' { New-PrivateFile $path ([string]$request.content) }
    'prepare' {
      $temporary = [IO.Path]::GetFullPath([string]$request.temporary)
      if ([IO.Path]::GetDirectoryName($temporary) -ine [IO.Path]::GetDirectoryName($path) -or [IO.Path]::GetFileName($temporary) -notmatch '^\.phonon-mcp-[a-f0-9-]{36}$') { throw 'mcp_config_path_unsupported' }
      Check-Source
      $created = $false
      try {
        New-PrivateFile $temporary ([string]$request.content)
        $created = $true
        Check-Source
      } catch {
        if ($created) {
          Check-Item $temporary $false $false $true
          [IO.File]::Delete($temporary)
        }
        throw
      }
    }
    default { throw 'mcp_config_security_unavailable' }
  }
  if ($null -eq $result) { $result = @{ok=$true} }
} catch {
  $code = $_.Exception.Message
  if ($code -notmatch '^mcp_config_[a-z_]+$') { $code = 'mcp_config_security_unavailable' }
  $result = @{ok=$false;code=$code}
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`;

type WindowsCommandRunner = (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => Pick<SpawnSyncReturns<string>, "stdout" | "status" | "error">;
type WindowsFileOptions = { directory?: boolean; private?: boolean; content?: string; limit?: number; source?: string; temporary?: string };
const MAX_FILE_BYTES = 1024 * 1024;
const securityErrors = new Set([
  "mcp_config_path_unsupported", "mcp_config_symlink_refused", "mcp_config_file_untrusted",
  "mcp_config_owner_untrusted", "mcp_config_acl_untrusted", "mcp_config_directory_untrusted",
  "mcp_config_file_exists", "mcp_config_changed", "mcp_config_security_unavailable",
]);

export function windowsMcpFileOperation(operation: "read", path: string, options: WindowsFileOptions, run?: WindowsCommandRunner): string | undefined;
export function windowsMcpFileOperation(operation: "directory" | "inspect" | "create" | "prepare", path: string, options?: WindowsFileOptions, run?: WindowsCommandRunner): void;
export function windowsMcpFileOperation(operation: "directory" | "inspect" | "create" | "prepare" | "read", path: string, options: WindowsFileOptions = {}, run: WindowsCommandRunner = spawnSync): string | undefined | void {
  const limit = options.limit ?? MAX_FILE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_FILE_BYTES) throw new McpConfigurationError("mcp_config_file_untrusted");
  if (options.content !== undefined && Buffer.byteLength(options.content, "utf8") > limit) throw new McpConfigurationError("mcp_config_file_untrusted");
  if (operation === "prepare" && !options.temporary) throw new McpConfigurationError("mcp_config_path_unsupported");
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let result: ReturnType<WindowsCommandRunner>, response: { ok?: unknown; code?: unknown; missing?: unknown; content?: unknown };
  try {
    result = run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_MCP_SECURITY_SCRIPT, "utf16le").toString("base64")], {
      input: JSON.stringify({ operation, path: resolve(path), ...options, limit, ...(operation === "prepare" ? { sourceMissing: options.source === undefined, temporary: resolve(options.temporary!) } : {}) }), encoding: "utf8", windowsHide: true, timeout: 15_000,
      maxBuffer: operation === "read" ? Math.ceil(limit / 3) * 4 + 32 * 1024 : 32 * 1024,
    });
    response = JSON.parse(result.stdout.trim()) as typeof response;
  } catch { throw new McpConfigurationError("mcp_config_security_unavailable"); }
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new McpConfigurationError("mcp_config_security_unavailable");
  if (result.error || result.status !== 0 || response.ok !== true) {
    throw new McpConfigurationError(typeof response.code === "string" && securityErrors.has(response.code) ? response.code : "mcp_config_security_unavailable");
  }
  if (operation === "read") {
    if (response.missing === true && response.content === undefined) return undefined;
    if (response.missing !== undefined || typeof response.content !== "string") throw new McpConfigurationError("mcp_config_security_unavailable");
    const bytes = Buffer.from(response.content, "base64");
    if (bytes.length > limit || bytes.toString("base64") !== response.content) throw new McpConfigurationError("mcp_config_security_unavailable");
    return bytes.toString("utf8");
  }
}
