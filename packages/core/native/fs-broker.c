#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#include <sddl.h>
#include <io.h>
#include <fcntl.h>
typedef HANDLE handle;
#define BAD_HANDLE INVALID_HANDLE_VALUE
#define PLATFORM "win32"
#else
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <dirent.h>
#ifdef __linux__
#include <sys/syscall.h>
#define PLATFORM "linux"
#else
#define PLATFORM "darwin"
#endif
typedef int handle;
#define BAD_HANDLE (-1)
#endif

#define MAX_BYTES (20u * 1024u * 1024u)
#define MAX_DEPTH 256
#define MAX_TREE_ENTRIES 4096
#define MAX_HELD (MAX_DEPTH * 2 + MAX_TREE_ENTRIES + 8)
enum { PROBE = 0, READ = 1, WRITE = 2, MKDIR = 3, PUBLISH_NEW = 4, STAT = 5, ROOT = 6, TREE_PUBLISH = 7, TREE_VERIFY = 8, MKDIR_NEW = 9 };
enum { OVERWRITE = 1, PARENTS = 2, EXPECT_ROOT = 4 };
typedef struct { char kind[12], id[80]; uint64_t size, links, changed, modified; unsigned mode; } info;
typedef struct { handle h; int parent; char *name; info original; } held;
static held handles[MAX_HELD];
static int held_limit = MAX_DEPTH;
static bool tree_mode;
static int count;
static bool mutated;
static const char *failure;

static bool deny(const char *code) { if (!failure) failure = code; return false; }
static bool exact(void *data, size_t size) { return fread(data, 1, size, stdin) == size || deny("invalid_request"); }
static bool number(uint32_t *n) {
  unsigned char b[4]; if (!exact(b, 4)) return false;
  *n = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
  return true;
}
static char *field(uint32_t maximum) {
  uint32_t n; if (!number(&n) || n > maximum) { deny("invalid_request"); return NULL; }
  char *value = malloc((size_t)n + 1); if (!value) { deny("io_error"); return NULL; }
  if (!exact(value, n) || memchr(value, 0, n)) { free(value); deny("invalid_request"); return NULL; }
  value[n] = 0; return value;
}
static bool component(const char *name) {
  size_t size = strlen(name);
  if (!size || size > 255 || !strcmp(name, ".") || !strcmp(name, "..") || name[size - 1] == '.' || name[size - 1] == ' ') return deny("path_denied");
  for (const unsigned char *p = (const unsigned char *)name; *p; p++)
    if (*p < 32 || *p == 127 || strchr("/\\:<>\"|?*", *p)) return deny("path_denied");
  char base[256]; size_t n = strcspn(name, "."); memcpy(base, name, n); base[n] = 0;
  while (n && base[n - 1] == ' ') base[--n] = 0;
  for (size_t i = 0; i < n; i++) if (base[i] >= 'a' && base[i] <= 'z') base[i] -= 'a' - 'A';
  if (!strcmp(base, "CON") || !strcmp(base, "PRN") || !strcmp(base, "AUX") || !strcmp(base, "NUL") || !strcmp(base, "CONIN$") || !strcmp(base, "CONOUT$") || !strcmp(base, "CLOCK$")) return deny("path_denied");
  if (n == 4 && (!memcmp(base, "COM", 3) || !memcmp(base, "LPT", 3)) && base[3] >= '1' && base[3] <= '9') return deny("path_denied");
  if (n == 5 && (!memcmp(base, "COM", 3) || !memcmp(base, "LPT", 3)) && (unsigned char)base[3] == 0xc2 && ((unsigned char)base[4] == 0xb9 || (unsigned char)base[4] == 0xb2 || (unsigned char)base[4] == 0xb3)) return deny("path_denied");
  return true;
}
static bool relative_path(const char *path) {
  if (!*path) return deny("path_denied");
  const char *part = path; unsigned depth = 0;
  while (*part) {
    if (++depth > MAX_DEPTH) return deny("path_denied");
    const char *slash = strchr(part, '/'); size_t size = slash ? (size_t)(slash - part) : strlen(part);
    if (!size || size > 255) return deny("path_denied");
    char value[256]; memcpy(value, part, size); value[size] = 0;
    if (!component(value)) return false;
    if (!slash) return true; part = slash + 1; if (!*part) return deny("path_denied");
  }
  return true;
}

#ifdef _WIN32
typedef NTSTATUS (NTAPI *create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *set_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef ULONG (WINAPI *dos_fn)(NTSTATUS);
static create_fn create_file;
static set_fn set_file;
static dos_fn dos_error;
static PSECURITY_DESCRIPTOR private_sd;
static bool os_error(DWORD e) {
  if (e == ERROR_FILE_EXISTS || e == ERROR_ALREADY_EXISTS) return deny("exists");
  if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND) return deny("not_found");
  if (e == ERROR_SHARING_VIOLATION || e == ERROR_LOCK_VIOLATION) return deny("busy");
  if (e == ERROR_ACCESS_DENIED || e == ERROR_CANT_ACCESS_FILE || e == ERROR_DIRECTORY || e == ERROR_REPARSE_TAG_INVALID) return deny("path_denied");
  if (e == ERROR_NOT_SUPPORTED || e == ERROR_INVALID_FUNCTION) return deny("unsupported");
  return deny("io_error");
}
static bool initialize(void) {
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  create_file = (create_fn)GetProcAddress(module, "NtCreateFile");
  set_file = (set_fn)GetProcAddress(module, "NtSetInformationFile");
  dos_error = (dos_fn)GetProcAddress(module, "RtlNtStatusToDosError");
  if (!create_file || !set_file || !dos_error) return deny("unsupported");
  HANDLE token; DWORD size = 0; LPWSTR sid = NULL; void *data = NULL; bool ok = false;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return os_error(GetLastError());
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (!size || !(data = malloc(size))) { CloseHandle(token); return deny("io_error"); }
  if (GetTokenInformation(token, TokenUser, data, size, &size) && ConvertSidToStringSidW(((TOKEN_USER *)data)->User.Sid, &sid)) {
    wchar_t sddl[384];
    if (swprintf(sddl, 384, L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;%ls)", sid) > 0)
      ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &private_sd, NULL) != 0;
  }
  if (sid) LocalFree(sid); free(data); CloseHandle(token);
  return ok || deny("io_error");
}
static wchar_t *wide(const char *name) {
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, NULL, 0);
  if (!size || size > 32760) { deny("path_denied"); return NULL; }
  wchar_t *result = malloc((size_t)size * sizeof(wchar_t));
  if (!result) { deny("io_error"); return NULL; }
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, result, size)) { free(result); deny("path_denied"); return NULL; }
  return result;
}
static void close_handle(handle h) { if (h != BAD_HANDLE) CloseHandle(h); }
static bool describe(handle h, info *out) {
  FILE_ATTRIBUTE_TAG_INFO attributes; FILE_STANDARD_INFO standard; FILE_ID_INFO id; FILE_BASIC_INFO basic;
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &attributes, sizeof(attributes)) || !GetFileInformationByHandleEx(h, FileStandardInfo, &standard, sizeof(standard)) || !GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id)) || !GetFileInformationByHandleEx(h, FileBasicInfo, &basic, sizeof(basic))) return os_error(GetLastError());
  if (GetFileType(h) != FILE_TYPE_DISK) return deny("path_denied");
  strcpy(out->kind, attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT ? "symlink" : standard.Directory ? "directory" : "file");
  out->size = standard.Directory ? 0 : (uint64_t)standard.EndOfFile.QuadPart; out->links = standard.NumberOfLinks;
  out->changed = (uint64_t)basic.ChangeTime.QuadPart; out->modified = (uint64_t)basic.LastWriteTime.QuadPart;
  out->mode = basic.FileAttributes & FILE_ATTRIBUTE_READONLY ? 0400u : 0600u;
  int offset = snprintf(out->id, sizeof(out->id), "w:%" PRIx64 ":", (uint64_t)id.VolumeSerialNumber);
  for (int n = 0; n < 16; n++) offset += snprintf(out->id + offset, sizeof(out->id) - (size_t)offset, "%02x", id.FileId.Identifier[n]);
  return true;
}
static handle child(handle parent, const char *name, bool directory, bool writing, bool create, bool exclusive, bool deleting, bool allow_link) {
  wchar_t *value = wide(name); if (!value) return BAD_HANDLE;
  UNICODE_STRING string = { (USHORT)(wcslen(value) * sizeof(wchar_t)), (USHORT)((wcslen(value) + 1) * sizeof(wchar_t)), value };
  OBJECT_ATTRIBUTES object; memset(&object, 0, sizeof(object));
  object.Length = sizeof(object); object.RootDirectory = parent; object.ObjectName = &string;
  object.Attributes = 0x40 | (allow_link ? 0 : 0x1000); object.SecurityDescriptor = create ? private_sd : NULL;
  IO_STATUS_BLOCK status; handle h = BAD_HANDLE;
  ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  access |= directory ? FILE_LIST_DIRECTORY | FILE_TRAVERSE : writing ? FILE_WRITE_DATA : FILE_READ_DATA;
  if (tree_mode && writing) access |= FILE_WRITE_ATTRIBUTES;
  if (deleting) access |= DELETE;
  ULONG flags = 0x20 | 0x00200000 | (directory ? 1 : allow_link ? 0 : 0x40);
  if (writing) flags |= 2;
  NTSTATUS result = create_file(&h, access, &object, &status, NULL, directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | (directory ? FILE_SHARE_WRITE : 0), exclusive ? 2 : create ? 3 : 1, flags, NULL, 0);
  free(value);
  if (result < 0) { os_error(dos_error(result)); return BAD_HANDLE; }
  if (create && status.Information == 2) mutated = true;
  info actual; if (!describe(h, &actual) || (!allow_link && !strcmp(actual.kind, "symlink"))) { close_handle(h); deny("path_denied"); return BAD_HANDLE; }
  return h;
}
static handle base_root(char *root, char **rest) {
  if (strlen(root) < 3 || root[1] != ':' || (root[2] != '/' && root[2] != '\\') || !((root[0] >= 'a' && root[0] <= 'z') || (root[0] >= 'A' && root[0] <= 'Z'))) { deny("unsupported"); return BAD_HANDLE; }
  for (char *p = root + 2; *p; p++) if (*p == '\\') *p = '/';
  wchar_t drive[] = L"\\\\?\\C:\\"; drive[4] = (wchar_t)root[0];
  handle h = CreateFileW(drive, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h == BAD_HANDLE) os_error(GetLastError()); *rest = root + 3; return h;
}
static bool read_bytes(handle h, unsigned char *bytes, uint32_t limit, uint32_t *size) {
  DWORD n; *size = 0;
  while (*size < limit) { if (!ReadFile(h, bytes + *size, limit - *size, &n, NULL)) return os_error(GetLastError()); if (!n) break; *size += n; }
  return true;
}
static bool write_bytes(handle h, const unsigned char *bytes, uint32_t size) {
  LARGE_INTEGER zero; zero.QuadPart = 0;
  if (!SetFilePointerEx(h, zero, NULL, FILE_BEGIN)) return os_error(GetLastError());
  mutated = true;
  if (!SetEndOfFile(h)) return os_error(GetLastError());
  uint32_t offset = 0; DWORD n;
  while (offset < size) { if (!WriteFile(h, bytes + offset, size - offset, &n, NULL) || !n) return os_error(GetLastError()); offset += n; }
  return FlushFileBuffers(h) != 0 || os_error(GetLastError());
}
static bool publish(handle parent, handle source, const char *from, const char *to) {
  (void)from; wchar_t *name = wide(to); if (!name) return false;
  typedef struct { BOOLEAN replace; HANDLE root; ULONG length; WCHAR name[1]; } rename_info;
  size_t bytes = wcslen(name) * sizeof(wchar_t), size = offsetof(rename_info, name) + bytes;
  rename_info *value = calloc(1, size); if (!value) { free(name); return deny("io_error"); }
  value->root = parent; value->length = (ULONG)bytes; memcpy(value->name, name, bytes);
  IO_STATUS_BLOCK status; NTSTATUS result = set_file(source, &status, value, (ULONG)size, (FILE_INFORMATION_CLASS)10);
  free(value); free(name);
  if (result < 0) return os_error(dos_error(result));
  mutated = true; return true;
}
#else
static bool os_error(int e) {
  if (e == EEXIST || e == ENOTEMPTY) return deny("exists");
  if (e == ENOENT) return deny("not_found");
  if (e == ELOOP || e == ENOTDIR || e == EACCES || e == EPERM) return deny("path_denied");
  if (e == EBUSY || e == EAGAIN) return deny("busy");
  if (e == ENOSYS || e == EOPNOTSUPP) return deny("unsupported");
  return deny("io_error");
}
static bool initialize(void) { return true; }
static void close_handle(handle h) { if (h != BAD_HANDLE) close(h); }
static bool describe(handle h, info *out) {
  struct stat value; if (fstat(h, &value)) return os_error(errno);
  strcpy(out->kind, S_ISDIR(value.st_mode) ? "directory" : S_ISREG(value.st_mode) ? "file" : S_ISLNK(value.st_mode) ? "symlink" : "other");
  out->size = S_ISDIR(value.st_mode) ? 0 : (uint64_t)value.st_size; out->links = value.st_nlink;
  out->mode = (unsigned)(value.st_mode & 0777);
#ifdef __linux__
  out->changed = (uint64_t)value.st_ctim.tv_sec * UINT64_C(1000000000) + (uint64_t)value.st_ctim.tv_nsec;
  out->modified = (uint64_t)value.st_mtim.tv_sec * UINT64_C(1000000000) + (uint64_t)value.st_mtim.tv_nsec;
#else
  out->changed = (uint64_t)value.st_ctimespec.tv_sec * UINT64_C(1000000000) + (uint64_t)value.st_ctimespec.tv_nsec;
  out->modified = (uint64_t)value.st_mtimespec.tv_sec * UINT64_C(1000000000) + (uint64_t)value.st_mtimespec.tv_nsec;
#endif
  snprintf(out->id, sizeof(out->id), "p:%" PRIx64 ":%" PRIx64, (uint64_t)value.st_dev, (uint64_t)value.st_ino); return true;
}
static handle child(handle parent, const char *name, bool directory, bool writing, bool create, bool exclusive, bool deleting, bool allow_link) {
  (void)deleting;
  if (directory && create) { if (!mkdirat(parent, name, 0700)) mutated = true; else if (errno != EEXIST || exclusive) { os_error(errno); return BAD_HANDLE; } }
  int flags = O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (directory ? O_RDONLY | O_DIRECTORY : writing ? O_WRONLY : O_RDONLY);
  if (allow_link) {
#ifdef __linux__
    flags = O_PATH | O_NOFOLLOW | O_CLOEXEC;
#else
    flags = O_RDONLY | O_SYMLINK | O_CLOEXEC | O_NONBLOCK;
#endif
  }
  handle h;
  if (!directory && create) {
    h = exclusive ? BAD_HANDLE : openat(parent, name, flags);
    if (h == BAD_HANDLE && (exclusive || errno == ENOENT)) {
      h = openat(parent, name, flags | O_CREAT | O_EXCL, 0600);
      if (h != BAD_HANDLE) mutated = true;
    }
  } else h = openat(parent, name, flags);
  if (h == BAD_HANDLE) os_error(errno);
  return h;
}
static handle base_root(char *root, char **rest) {
  if (root[0] != '/') { deny("path_denied"); return BAD_HANDLE; }
  handle h = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); if (h == BAD_HANDLE) os_error(errno);
  *rest = root + 1; return h;
}
static bool read_bytes(handle h, unsigned char *bytes, uint32_t limit, uint32_t *size) {
  *size = 0; while (*size < limit) { ssize_t n = read(h, bytes + *size, limit - *size); if (n < 0) { if (errno == EINTR) continue; return os_error(errno); } if (!n) break; *size += (uint32_t)n; } return true;
}
static bool write_bytes(handle h, const unsigned char *bytes, uint32_t size) {
  mutated = true; if (ftruncate(h, 0)) return os_error(errno);
  uint32_t offset = 0; while (offset < size) { ssize_t n = write(h, bytes + offset, size - offset); if (n < 0 && errno == EINTR) continue; if (n <= 0) return os_error(errno); offset += (uint32_t)n; }
  return fsync(h) == 0 || os_error(errno);
}
static bool publish(handle parent, handle source, const char *from, const char *to) {
  (void)source;
#ifdef __linux__
  int result = (int)syscall(SYS_renameat2, parent, from, parent, to, 1u);
#else
  int result = renameatx_np(parent, from, parent, to, RENAME_EXCL);
#endif
  if (result) return os_error(errno); mutated = true;
  return fsync(parent) == 0 || os_error(errno);
}
#endif

static int remember(handle h, int parent, char *name) {
  if (h == BAD_HANDLE) return -1;
  if (count == held_limit) { close_handle(h); deny("path_denied"); return -1; }
  int n = count++; handles[n].h = h; handles[n].parent = parent; handles[n].name = name;
  if (!describe(h, &handles[n].original)) return -1; return n;
}
static int walk(int parent, char *path, bool create) {
  char *part = path;
  if (!*part || !strcmp(part, ".")) return parent;
  for (;;) {
    char *slash = strchr(part, '/'); if (slash) *slash = 0;
    if (!component(part)) return -1;
    parent = remember(child(handles[parent].h, part, true, false, create, false, false, false), parent, part);
    if (parent < 0) return -1;
    if (!slash) return parent; part = slash + 1;
  }
}
static bool current(int end) {
  for (int n = 0; n <= end; n++) {
    held *value = &handles[n]; info actual;
    if (!describe(value->h, &actual) || strcmp(actual.id, value->original.id)) return deny("path_changed");
#ifndef _WIN32
    if (value->parent >= 0) {
      handle check = child(handles[value->parent].h, value->name, !strcmp(value->original.kind, "directory"), false, false, false, false, !strcmp(value->original.kind, "symlink") || !strcmp(value->original.kind, "other"));
      if (check == BAD_HANDLE) { failure = "path_changed"; return false; }
      bool same = describe(check, &actual) && !strcmp(actual.id, value->original.id); close_handle(check);
      if (!same) { failure = "path_changed"; return false; }
    }
#endif
  }
  return true;
}
static bool barrier(void) {
#ifdef PHONON_FS_BROKER_TEST_HOOKS
  if (getenv("PHONON_FS_BROKER_TEST_BARRIER")) {
    fputs("PHONON_FS_PARENT_READY\n", stderr); fflush(stderr);
    if (fgetc(stdin) != 0xa5) return deny("invalid_request");
  }
#endif
  return fgetc(stdin) == EOF || deny("invalid_request");
}

#include "fs-tree.inc"

int main(void) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
  unsigned char header[8]; char *root = NULL, *relative = NULL, *expected = NULL, *destination = NULL; unsigned char *bytes = NULL;
  uint32_t argument = 0, data_size = 0; int root_index = -1, parent = -1, leaf_index = -1; info final;
  if (!exact(header, 8) || memcmp(header, "PFS2", 4) || header[4] > MKDIR_NEW || header[5] & ~(OVERWRITE | PARENTS | EXPECT_ROOT) || header[6] || header[7]) { deny("invalid_request"); goto done; }
  if (!(root = field(4096)) || !(relative = field(2048))) goto done;
  if (header[5] & EXPECT_ROOT) { expected = field(80); if (!expected || !*expected) { deny("invalid_request"); goto done; } }
  if (!number(&argument)) goto done;
  int operation = header[4], flags = header[5];
  tree_mode = operation == TREE_PUBLISH || operation == TREE_VERIFY;
  if (operation == PROBE) {
    if (*root || *relative || argument > 1 || flags || fgetc(stdin) != EOF || !initialize()) { deny("invalid_request"); goto done; }
    printf("{\"ok\":true,\"version\":2,\"platform\":\"%s\",\"operations\":[\"read\",\"write\",\"mkdir\",\"publish_new\",\"stat\",\"root\"],\"extensions\":[\"publish_tree_v1\",\"verify_tree_v1\"%s]}\n", PLATFORM, argument == 1 ? ",\"exclusive_mkdir_v1\"" : ""); goto done;
  }
  if (!*root || (operation != ROOT && (!*relative || !expected)) || (operation == ROOT && (*relative || flags || argument)) || (operation != WRITE && flags & OVERWRITE) || (operation != WRITE && operation != MKDIR && operation != TREE_PUBLISH && flags & PARENTS)) { deny("invalid_request"); goto done; }
  if (operation != ROOT && !relative_path(relative)) goto done;
  if (operation == READ || operation == WRITE) {
    if ((operation == READ && !argument) || argument > MAX_BYTES || !(bytes = malloc(argument ? argument : 1))) { deny("invalid_request"); goto done; }
    if (operation == WRITE && !exact(bytes, argument)) goto done;
  } else if (operation == PUBLISH_NEW) {
    if (!argument || argument > 255 || !(destination = malloc((size_t)argument + 1)) || !exact(destination, argument)) { deny("invalid_request"); goto done; }
    destination[argument] = 0;
    if (memchr(destination, 0, argument) || !component(destination)) goto done;
  } else if (tree_mode) {
    if (!tree_parse(argument, operation == TREE_PUBLISH)) goto done;
  } else if (argument) { deny("invalid_request"); goto done; }
#ifdef PHONON_FS_BROKER_TEST_HOOKS
  if (!getenv("PHONON_FS_BROKER_TEST_BARRIER") && !getenv("PHONON_FS_BROKER_TREE_BARRIER") && fgetc(stdin) != EOF) { deny("invalid_request"); goto done; }
#else
  if (fgetc(stdin) != EOF) { deny("invalid_request"); goto done; }
#endif
  if (!initialize()) goto done;
  char *rest; handle base = base_root(root, &rest); if (base == BAD_HANDLE) goto done;
  int base_index = remember(base, -1, NULL); if (base_index < 0 || (root_index = walk(base_index, rest, false)) < 0) goto done;
  if (strcmp(handles[root_index].original.kind, "directory")) { deny("path_denied"); goto done; }
  if (operation == ROOT) { if (!current(root_index)) goto done; final = handles[root_index].original; goto emit_receipt; }
  if (strcmp(expected, handles[root_index].original.id)) { deny("path_changed"); goto done; }
  if (tree_mode) {
    if (!tree_run(root_index, relative, flags, operation == TREE_PUBLISH, &final)) goto done;
    goto emit_receipt;
  }
  char *leaf = strrchr(relative, '/');
  if (leaf) { *leaf++ = 0; parent = walk(root_index, relative, flags & PARENTS); }
  else { parent = root_index; leaf = relative; }
  if (parent < 0 || !component(leaf) || !barrier() || !current(parent)) goto done;
  leaf_index = remember(child(handles[parent].h, leaf, operation == MKDIR || operation == MKDIR_NEW || operation == PUBLISH_NEW, operation == WRITE,
    operation == WRITE || operation == MKDIR || operation == MKDIR_NEW, (operation == WRITE && !(flags & OVERWRITE)) || operation == MKDIR_NEW, operation == PUBLISH_NEW, operation == STAT), parent, leaf);
  if (leaf_index < 0 || !describe(handles[leaf_index].h, &final)) goto done;
  if ((operation == READ || operation == WRITE) && (strcmp(final.kind, "file") || final.links != 1)) { deny("path_denied"); goto done; }
  if (operation == READ && !read_bytes(handles[leaf_index].h, bytes, argument, &data_size)) goto done;
  if (operation == WRITE && !write_bytes(handles[leaf_index].h, bytes, argument)) goto done;
  if (!current(leaf_index) || !describe(handles[leaf_index].h, &final)) goto done;
  if ((operation == READ || operation == WRITE) && final.links != 1) { deny("path_changed"); goto done; }
  if (operation == PUBLISH_NEW) {
    if (!publish(handles[parent].h, handles[leaf_index].h, leaf, destination)) goto done;
    handles[leaf_index].name = destination;
    if (!current(leaf_index)) goto done;
  }
emit_receipt:
  printf("{\"ok\":true,\"kind\":\"%s\",\"rootIdentity\":\"%s\",\"identity\":\"%s\",\"sizeBytes\":\"%" PRIu64 "\",\"dataBytes\":%" PRIu32 ",\"truncated\":%s,\"mutated\":%s}\n",
    final.kind, handles[root_index].original.id, final.id, final.size, data_size, operation == READ && final.size > data_size ? "true" : "false", mutated ? "true" : "false");
  if (data_size && fwrite(bytes, 1, data_size, stdout) != data_size) { failure = "io_error"; goto done; }
done:
  for (int n = count - 1; n >= 0; n--) close_handle(handles[n].h);
  free(bytes); free(destination); free(expected); free(relative); free(root);
  tree_free();
#ifdef _WIN32
  if (private_sd) LocalFree(private_sd);
#endif
  if (failure) fprintf(stdout, "{\"ok\":false,\"code\":\"%s\",\"mutated\":%s}\n", failure, mutated ? "true" : "false");
  if (fflush(stdout)) return 1;
  return failure ? 1 : 0;
}
