import { arch, hostname, platform, release, type } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { darwinFileBrokerAvailable } from "./darwin-file-broker.js";
import { collectDeviceSSHHints } from "./device-ssh-info.js";

const execFileAsync = promisify(execFile);

/**
 * 相对静态的设备信息，用于服务端做调度决策。
 * 例如：iOS/macOS 开发任务优先派给 darwin 设备，Windows 桌面开发派给 win32 设备。
 */
export async function collectDeviceInfo() {
  const [capabilities, ssh] = await Promise.all([inferCapabilities(), collectDeviceSSHHints()]);
  const base = {
    at: new Date().toISOString(),
    hostname: hostname(),
    os: {
      platform: platform(),
      type: type(),
      release: release(),
      arch: arch(),
    },
    runtime: {
      node: process.version,
    },
    capabilities,
    ssh,
  };
  return base;
}

async function inferCapabilities(): Promise<string[]> {
  const caps = new Set<string>(["project_namespace_v1","durable_workflow_dispatch_v1","manual_dev_recovery_v1","dev_dispatch_identity_v1","current_turn_input_v1","native_chat_workflow_v1","native_interaction_receipts_v1","employee_profiles_v1","native_conversation_board_v1","session_compression_receipts_v1","turn_reasoning_v1","best_effort_reasoning_v1","native_workflow_delegation_v1","native_conversation_messages_v1"]);
  caps.add("native_detached_workflow_v1");
  caps.add("workspace_directory_picker_v1");
  caps.add("native_proactive_output_v1");
  caps.add("session_recovery_v1");
  caps.add("native_stop_settlement_v1");
  caps.add("native_conversation_message_files_v1");
  caps.add("project_coordination_v1");
  caps.add("dev_native_interactions_v1");
  caps.add('dev_idempotent_resume_v1');
  caps.add('workflow_result_pages_v1');
  caps.add('workflow_input_receipts_v1');
  caps.add("schedule_dispatch_v1");
  caps.add("skill_namespace_identity_v1");
  caps.add("project_path_ownership_v1");
  caps.add("workspace_git_origin_v1");
  if(platform()==="linux")caps.add("secure_file_broker_linux_v1");
  if(await darwinFileBrokerAvailable())caps.add("secure_file_transfer_darwin_v1");
  if(platform()==="linux"||await darwinFileBrokerAvailable())caps.add("native_document_publish_v1");
  const p = platform();
  if (p === "darwin") {
    caps.add("macos");
    caps.add("ios-development");
  }
  if (p === "win32") {
    caps.add("windows");
    caps.add("windows-desktop-development");
  }
  if (p === "linux") caps.add("linux");
  if (await commandExists("git")) caps.add("git");
  if (await commandExists("node")) caps.add("node");
  if (await commandExists("python3")) caps.add("python");
  if (await commandExists("xcodebuild")) caps.add("xcode");
  if (await commandExists("swift")) caps.add("swift");
  if (await commandExists("powershell") || await commandExists("pwsh")) caps.add("powershell");
  if (await commandExists("nvidia-smi")) caps.add("nvidia-gpu");
  return [...caps].sort();
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const which = platform() === "win32" ? "where" : "which";
    await execFileAsync(which, [cmd], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}
