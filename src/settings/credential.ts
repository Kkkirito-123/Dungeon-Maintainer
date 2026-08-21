/**
 * 模型 API Key 的 Windows 凭据管理器边界。
 *
 * 密钥通过子进程环境传给 PowerShell，再由 C# P/Invoke 调用 CredWrite/CredRead；密钥
 * 不进入命令行、JSON、日志或 Shell。开发模式仍可使用 MAINTAINER_API_KEY 及按档案
 * 命名的环境变量。非 Windows 平台不模拟明文文件存储。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { profileKeyEnvironmentName } from "./profiles.js";

const exec = promisify(execFile);
const TARGET_PREFIX = "DungeonMaintainer/";

const CREDENTIAL_SOURCE = [
  "using System;",
  "using System.ComponentModel;",
  "using System.Runtime.InteropServices;",
  "using System.Runtime.InteropServices.ComTypes;",
  "using System.Text;",
  "public static class DungeonCredentialStore {",
  "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "  private struct CREDENTIAL {",
  "    public UInt32 Flags;",
  "    public UInt32 Type;",
  "    public string TargetName;",
  "    public string Comment;",
  "    public FILETIME LastWritten;",
  "    public UInt32 CredentialBlobSize;",
  "    public IntPtr CredentialBlob;",
  "    public UInt32 Persist;",
  "    public UInt32 AttributeCount;",
  "    public IntPtr Attributes;",
  "    public string TargetAlias;",
  "    public string UserName;",
  "  }",
  "  [DllImport(\"Advapi32.dll\", EntryPoint = \"CredWriteW\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);",
  "  [DllImport(\"Advapi32.dll\", EntryPoint = \"CredReadW\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);",
  "  [DllImport(\"Advapi32.dll\", EntryPoint = \"CredFree\", SetLastError = true)]",
  "  private static extern void CredFree(IntPtr credential);",
  "  public static void Write(string target, string secret) {",
  "    byte[] bytes = Encoding.Unicode.GetBytes(secret);",
  "    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);",
  "    try {",
  "      Marshal.Copy(bytes, 0, blob, bytes.Length);",
  "      CREDENTIAL credential = new CREDENTIAL();",
  "      credential.Type = 1;",
  "      credential.TargetName = target;",
  "      credential.CredentialBlobSize = (UInt32)bytes.Length;",
  "      credential.CredentialBlob = blob;",
  "      credential.Persist = 2;",
  "      credential.UserName = \"Dungeon Maintainer\";",
  "      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());",
  "    } finally {",
  "      for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);",
  "      Marshal.FreeHGlobal(blob);",
  "      Array.Clear(bytes, 0, bytes.Length);",
  "    }",
  "  }",
  "  public static string Read(string target) {",
  "    IntPtr pointer;",
  "    if (!CredRead(target, 1, 0, out pointer)) {",
  "      int code = Marshal.GetLastWin32Error();",
  "      if (code == 1168) return null;",
  "      throw new Win32Exception(code);",
  "    }",
  "    try {",
  "      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));",
  "      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return \"\";",
  "      return Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);",
  "    } finally { CredFree(pointer); }",
  "  }",
  "}",
].join("\n");

function script(action: "read" | "write"): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    CREDENTIAL_SOURCE,
    "'@",
    action === "write"
      ? "[DungeonCredentialStore]::Write($env:DUNGEON_CREDENTIAL_TARGET, $env:DUNGEON_CREDENTIAL_SECRET)"
      : "$value = [DungeonCredentialStore]::Read($env:DUNGEON_CREDENTIAL_TARGET); if ($null -ne $value) { [Console]::Out.Write($value) }",
  ].join("\n");
}

function developmentKey(profileId: string, environment: NodeJS.ProcessEnv): string | null {
  const profileValue = environment[profileKeyEnvironmentName(profileId)]?.trim();
  if (profileValue) return profileValue;
  if (profileId === "default") return environment.MAINTAINER_API_KEY?.trim() || null;
  return null;
}

/** 读取档案密钥；开发环境变量优先，Windows 凭据管理器其次。 */
export async function readProfileCredential(
  profileId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnvironment = developmentKey(profileId, environment);
  if (fromEnvironment) return fromEnvironment;
  if (process.platform !== "win32") return null;
  const result = await exec("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script("read"),
  ], {
    windowsHide: true,
    env: {
      ...process.env,
      DUNGEON_CREDENTIAL_TARGET: TARGET_PREFIX + profileId,
    },
    maxBuffer: 16 * 1024,
  });
  return result.stdout || null;
}

/** 将档案密钥写入 Windows 凭据管理器；不会回显密钥。 */
export async function writeProfileCredential(
  profileId: string,
  secret: string,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("当前平台只支持通过环境变量提供模型 API Key");
  }
  const normalized = secret.trim();
  if (!normalized || normalized.length > 8_192) throw new Error("API Key 为空或过长");
  await exec("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script("write"),
  ], {
    windowsHide: true,
    env: {
      ...process.env,
      DUNGEON_CREDENTIAL_TARGET: TARGET_PREFIX + profileId,
      DUNGEON_CREDENTIAL_SECRET: normalized,
    },
    maxBuffer: 16 * 1024,
  });
}
