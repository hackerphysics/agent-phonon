#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

static HANDLE job;
static HANDLE control;
static HANDLE evidence;
static CRITICAL_SECTION evidence_lock;

static void report(const char *phase, DWORD pid, DWORD active, DWORD code) {
  char text[256];
  int size = snprintf(text, sizeof(text), "{\"version\":1,\"phase\":\"%s\",\"pid\":%lu,\"active\":%lu,\"code\":%lu}\n",
                      phase, (unsigned long)pid, (unsigned long)active, (unsigned long)code);
  DWORD written;
  EnterCriticalSection(&evidence_lock);
  if (size > 0 && (size_t)size < sizeof(text)) WriteFile(evidence, text, (DWORD)size, &written, NULL);
  LeaveCriticalSection(&evidence_lock);
}

static DWORD WINAPI receive_control(void *unused) {
  (void)unused;
  char byte;
  DWORD count;
  while (ReadFile(control, &byte, 1, &count, NULL) && count == 1) {
    if (byte == 'F') TerminateJobObject(job, 130);
    /* Graceful shutdown remains the CLI's responsibility; force is explicit. */
  }
  /* The owning controller disappeared. Never leave an orphaned execution. */
  TerminateJobObject(job, 130);
  return 0;
}

static wchar_t *command_line(int argc, wchar_t **argv) {
  size_t size = 1;
  for (int i = 1; i < argc; i++) size += wcslen(argv[i]) * 2 + 4;
  if (size > 32767) return NULL;
  wchar_t *line = calloc(size, sizeof(wchar_t));
  if (!line) return NULL;
  size_t at = 0;
  const wchar_t *base = wcsrchr(argv[1], L'\\');
  bool shell = argc == 6 && !_wcsicmp(base ? base + 1 : argv[1], L"cmd.exe") &&
      !_wcsicmp(argv[2], L"/d") && !_wcsicmp(argv[3], L"/s") && !_wcsicmp(argv[4], L"/c");
  if (shell) {
    _snwprintf(line, size, L"\"%ls\" /d /s /c \"%ls\"", argv[1], argv[5]);
    return line;
  }
  for (int i = 1; i < argc; i++) {
    if (i != 1) line[at++] = L' ';
    line[at++] = L'"';
    size_t slashes = 0;
    for (const wchar_t *p = argv[i]; ; p++) {
      if (*p == L'\\') { slashes++; continue; }
      if (*p == L'"' || !*p) {
        for (size_t n = 0; n < slashes * 2; n++) line[at++] = L'\\';
        if (*p == L'"') line[at++] = L'\\';
      } else for (size_t n = 0; n < slashes; n++) line[at++] = L'\\';
      slashes = 0;
      if (!*p) break;
      line[at++] = *p;
    }
    line[at++] = L'"';
  }
  return line;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 2 || wcslen(argv[1]) < 5 || _wcsicmp(argv[1] + wcslen(argv[1]) - 4, L".exe")) return 125;
  evidence = (HANDLE)_get_osfhandle(3);
  control = (HANDLE)_get_osfhandle(4);
  if (evidence == INVALID_HANDLE_VALUE || control == INVALID_HANDLE_VALUE) return 125;
  InitializeCriticalSection(&evidence_lock);
  SetHandleInformation(evidence, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0);
  job = CreateJobObjectW(NULL, NULL);
  HANDLE completion = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT port = {(void *)1, completion};
  if (!job || !completion || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &port, sizeof(port))) return 125;
  wchar_t *line = command_line(argc, argv);
  if (!line) return 125;
  STARTUPINFOEXW startup = {0};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE inherited[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
  startup.lpAttributeList = malloc(bytes);
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &bytes)) return 125;
  for (int i = 0; i < 3; i++) if (!SetHandleInformation(inherited[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return 125;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)) return 125;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) return 125;
  PROCESS_INFORMATION process = {0};
  BOOL started = CreateProcessW(argv[1], line, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT,
      NULL, NULL, &startup.StartupInfo, &process);
  free(line);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (!started) { report("refused", 0, 0, GetLastError()); return 125; }
  HANDLE listener = CreateThread(NULL, 0, receive_control, NULL, 0, NULL);
  if (!listener || ResumeThread(process.hThread) == (DWORD)-1) {
    TerminateJobObject(job, 125); WaitForSingleObject(process.hProcess, INFINITE);
    report("refused", process.dwProcessId, 0, GetLastError());
    return 125;
  }
  CloseHandle(process.hThread);
  report("started", process.dwProcessId, 1, 0);
  for (;;) {
    DWORD message; ULONG_PTR key; LPOVERLAPPED value;
    BOOL notified = GetQueuedCompletionStatus(completion, &message, &key, &value, 1000);
    if (notified && (key != 1 || message != JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO)) continue;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) || accounting.ActiveProcesses) continue;
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code;
    if (!GetExitCodeProcess(process.hProcess, &code)) return 125;
    report("empty", process.dwProcessId, 0, code);
    CloseHandle(process.hProcess); CloseHandle(listener); CloseHandle(job); CloseHandle(completion);
    return (int)code;
  }
}
