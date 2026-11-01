import {spawnSync} from "node:child_process";
import {isAbsolute, join} from "node:path";

/** Fixed ACL query; initialization is restricted to a new empty owned directory. */
export const WINDOWS_NATIVE_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
  $line=[Console]::In.ReadLine()
  if($null -eq $line -or $line.Length -gt 16384){throw 'invalid path'}
  $request=$line|ConvertFrom-Json
  $path=[IO.Path]::GetFullPath([string]$request.path)
  if($path -notmatch '^[A-Za-z]:\\' -or $path.Substring(2).Contains(':')){throw 'invalid path'}
  $user=[Security.Principal.WindowsIdentity]::GetCurrent()
  $trusted=@($user.User.Value,$user.Owner.Value,'S-1-5-18','S-1-5-32-544')
  $ancestorOwners=$trusted+@('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  function Check-Acl($acl,[bool]$ancestor) {
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $owners=$trusted;if($ancestor){$owners=$ancestorOwners}
    if($owners -notcontains $owner){throw 'untrusted owner'}
    $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if($null -eq $raw.DiscretionaryAcl){throw 'null ACL'}
    foreach($ace in $raw.DiscretionaryAcl){
      if(([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0){continue}
      if($ace.AceType -eq [Security.AccessControl.AceType]::AccessDenied){continue}
      if($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed){throw 'unsupported ACE'}
      $mask=[long]0x500d0156;if($ancestor){$mask=[long]0x100d0040}
      $foreign=$owners -notcontains $ace.SecurityIdentifier.Value
      if($foreign -and (([long]$ace.AccessMask -band $mask) -ne 0 -or ([bool]$request.private -and !$ancestor -and ([long]$ace.AccessMask -band [long]0x90000001) -ne 0))){throw 'foreign access ACL'}
    }
    return $owner
  }
  $parent=[IO.Directory]::GetParent($path)
  while($null -ne $parent){
    if(([IO.File]::GetAttributes($parent.FullName) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'linked ancestor'}
    [void](Check-Acl (Get-Acl -LiteralPath $parent.FullName) $true)
    $parent=$parent.Parent
  }
  $attributes=[IO.File]::GetAttributes($path)
  if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'linked target'}
  $directory=($attributes -band [IO.FileAttributes]::Directory) -ne 0
  if($directory -ne [bool]$request.directory){throw 'wrong target type'}
  if([string]$request.operation -eq 'private-directory'){
    if(!$directory -or [IO.Directory]::GetFileSystemEntries($path).Length -ne 0){throw 'not an empty owned directory'}
    $current=Get-Acl -LiteralPath $path
    if($trusted -notcontains $current.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'untrusted directory owner'}
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user.User);$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in $trusted){
      $principal=New-Object Security.Principal.SecurityIdentifier($sid)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  if($directory){$owner=Check-Acl (Get-Acl -LiteralPath $path) $false}
  else {
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
      $owner=Check-Acl ($stream.GetAccessControl()) $false
      $expected=[string]$request.sha256
      if($expected){
        if($stream.Length -lt 1 -or $stream.Length -gt 33554432 -or $expected -notmatch '^[a-f0-9]{64}$'){throw 'invalid expected file'}
        $hash=[Security.Cryptography.SHA256]::Create()
        try{$actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
        if($actual -cne $expected){throw 'changed file bytes'}
      }
    }finally{$stream.Dispose()}
  }
  @{ok=$true;owner=$owner}|ConvertTo-Json -Compress
}catch{
  $code=[string]$_.Exception.Message
  if($code -notin @('invalid path','untrusted owner','null ACL','unsupported ACE','foreign access ACL','linked ancestor','linked target','wrong target type','not an empty owned directory','untrusted directory owner','invalid expected file','changed file bytes')){$code='native security query unavailable'}
  @{ok=$false;code=$code}|ConvertTo-Json -Compress;exit 1
}
`;

export function inspectWindowsNativeSecurity(path: string, directory: boolean, sha256?: string, privateFile = false, initializePrivateDirectory = false): string {
  if (process.platform !== "win32" || !isAbsolute(path)) throw new Error("Windows identity requires an absolute native path");
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_NATIVE_SECURITY_SCRIPT, "utf16le").toString("base64")], {
    input: JSON.stringify({path, directory, sha256, private: privateFile, ...(initializePrivateDirectory ? {operation: "private-directory"} : {})}) + "\n", encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096,
    env: {SystemRoot: process.env.SystemRoot ?? "C:\\Windows"},
  });
  if (result.error) throw new Error("Windows ownership or ACL could not be verified: " + (result.error as NodeJS.ErrnoException).code);
  const value = JSON.parse(result.stdout);
  if (result.status !== 0) throw new Error("Windows ownership or ACL could not be verified: " + value.code);
  if (value?.ok !== true || typeof value.owner !== "string" || !/^S-1-\d+(?:-\d+)+$/.test(value.owner)) throw new Error("Windows ownership is unconfirmed");
  return value.owner;
}
