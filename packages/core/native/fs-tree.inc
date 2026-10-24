#define MAX_TREE_BYTES (64u * 1024u * 1024u)
#define MAX_TREE_WIRE (MAX_TREE_BYTES + 2u * 1024u * 1024u)
extern void phonon_sha256(const unsigned char *, size_t, unsigned char *);
extern bool phonon_utf8_valid(const unsigned char *, size_t);
typedef struct {
  uint32_t parent, size, depth; unsigned char kind, executable, digest[32]; char *name;
  const unsigned char *data; int handle_index;
} tree_entry;
static tree_entry *tree_entries;
static uint32_t tree_count, *tree_order;
static unsigned char *tree_wire;
static const unsigned char *tree_cursor, *tree_end;
static char *tree_expected, *tree_destination, tree_stage[272];

static void tree_free(void) {
  if (tree_entries) for (uint32_t n = 0; n < tree_count; n++) free(tree_entries[n].name);
  free(tree_entries); free(tree_order); free(tree_wire); free(tree_expected); free(tree_destination);
}
static bool tree_take(void *out, size_t size) {
  if (size > (size_t)(tree_end - tree_cursor)) return deny("invalid_request");
  if (out) memcpy(out, tree_cursor, size); tree_cursor += size; return true;
}
static bool tree_number(uint32_t *out) {
  unsigned char bytes[4]; if (!tree_take(bytes, 4)) return false;
  *out = (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24; return true;
}
static char *tree_field(uint32_t maximum) {
  uint32_t size; if (!tree_number(&size) || size > maximum || size > (size_t)(tree_end - tree_cursor)) { deny("invalid_request"); return NULL; }
  char *out = malloc((size_t)size + 1); if (!out) { deny("io_error"); return NULL; }
  if (!tree_take(out, size) || memchr(out, 0, size) || !phonon_utf8_valid((const unsigned char *)out, size)) { free(out); deny("invalid_request"); return NULL; }
  out[size] = 0; return out;
}
static int tree_compare(const void *left, const void *right) {
  const tree_entry *a = &tree_entries[*(const uint32_t *)left], *b = &tree_entries[*(const uint32_t *)right];
  if (a->parent != b->parent) return a->parent < b->parent ? -1 : 1;
  return strcmp(a->name, b->name);
}
static bool tree_limits(void) {
#ifndef _WIN32
  struct rlimit value; if (getrlimit(RLIMIT_NOFILE, &value)) return os_error(errno);
  rlim_t needed = (rlim_t)tree_count + MAX_DEPTH * 2u + 32u;
  if (value.rlim_cur < needed) {
    if (value.rlim_max < needed) return deny("unsupported");
    value.rlim_cur = needed; if (setrlimit(RLIMIT_NOFILE, &value)) return os_error(errno);
  }
#endif
  held_limit = MAX_HELD; return true;
}
static bool tree_parse(uint32_t size, bool publishing) {
  if (size < 12 || size > MAX_TREE_WIRE || !(tree_wire = malloc(size))) return deny("invalid_request");
  if (!exact(tree_wire, size)) return false;
  tree_cursor = tree_wire; tree_end = tree_wire + size;
  tree_expected = tree_field(80); tree_destination = tree_field(255);
  if (!tree_expected || !tree_destination || !tree_number(&tree_count) || !tree_count || tree_count > MAX_TREE_ENTRIES) return deny("invalid_request");
  if (publishing ? *tree_expected || !component(tree_destination) : !*tree_expected || *tree_destination) return deny("invalid_request");
  if (publishing && (snprintf(tree_stage, sizeof(tree_stage), ".stage-%s", tree_destination) >= (int)sizeof(tree_stage) || !component(tree_stage))) return deny("invalid_request");
  if (!(tree_entries = calloc(tree_count, sizeof(*tree_entries))) || !(tree_order = calloc(tree_count, sizeof(*tree_order)))) return deny("io_error");
  uint64_t total = 0;
  for (uint32_t n = 0; n < tree_count; n++) {
    tree_entry *entry = &tree_entries[n]; tree_order[n] = n;
    if (!tree_number(&entry->parent) || !tree_take(&entry->kind, 1) || entry->kind > 1 || !tree_take(&entry->executable, 1) || entry->executable > 1 || (!entry->kind && entry->executable) || !(entry->name = tree_field(255))
      || !component(entry->name) || !tree_number(&entry->size) || !tree_take(entry->digest, 32)) return deny("invalid_request");
    if (entry->parent != UINT32_MAX && (entry->parent >= n || tree_entries[entry->parent].kind)) return deny("invalid_request");
    entry->depth = entry->parent == UINT32_MAX ? 1 : tree_entries[entry->parent].depth + 1;
    if (entry->depth > 64 || entry->size > MAX_BYTES || (!entry->kind && entry->size) || (total += entry->size) > MAX_TREE_BYTES) return deny("invalid_request");
    if (!entry->kind) for (unsigned i = 0; i < 32; i++) if (entry->digest[i]) return deny("invalid_request");
    if (publishing && entry->kind) { entry->data = tree_cursor; if (!tree_take(NULL, entry->size)) return false; }
  }
  if (tree_cursor != tree_end) return deny("invalid_request");
  qsort(tree_order, tree_count, sizeof(*tree_order), tree_compare);
  for (uint32_t n = 1; n < tree_count; n++) if (!tree_compare(&tree_order[n - 1], &tree_order[n])) return deny("invalid_request");
  return tree_limits();
}
static int tree_find(uint32_t parent, const char *name) {
  size_t low = 0, high = tree_count;
  while (low < high) {
    size_t middle = low + (high - low) / 2; const tree_entry *entry = &tree_entries[tree_order[middle]];
    int order = parent != entry->parent ? parent < entry->parent ? -1 : 1 : strcmp(name, entry->name);
    if (!order) return (int)tree_order[middle]; if (order < 0) high = middle; else low = middle + 1;
  }
  return -1;
}
static bool tree_ancestry(int index) {
  for (int n = index; n >= 0; n = handles[n].parent) {
    info actual; held *value = &handles[n]; if (!describe(value->h, &actual) || strcmp(actual.id, value->original.id)) return deny("path_changed");
#ifndef _WIN32
    if (value->parent >= 0) {
      handle other = child(handles[value->parent].h, value->name, !strcmp(value->original.kind, "directory"), false, false, false, false, false);
      if (other == BAD_HANDLE) { failure = "path_changed"; return false; }
      bool same = describe(other, &actual) && !strcmp(actual.id, value->original.id); close_handle(other);
      if (!same) return deny("path_changed");
    }
#endif
  }
  return true;
}
static bool tree_read(int index, const tree_entry *entry) {
  info actual; if (!describe(handles[index].h, &actual) || strcmp(actual.kind, "file") || actual.links != 1 || actual.size != entry->size) return deny("path_changed");
  unsigned char *data = malloc(entry->size ? entry->size : 1), digest[32]; uint32_t got;
  if (!data) return deny("io_error");
  bool ok = read_bytes(handles[index].h, data, entry->size, &got);
  if (ok) { phonon_sha256(data, got, digest); ok = got == entry->size && !memcmp(digest, entry->digest, 32); }
  free(data); if (!ok) return deny("path_changed");
  info final; if (!describe(handles[index].h, &final) || strcmp(actual.id, final.id) || actual.changed != final.changed || actual.modified != final.modified || final.links != 1 || final.size != actual.size) return deny("path_changed");
  handles[index].original = final; return true;
}
static bool tree_seal(int index, bool directory, bool executable) {
#ifdef _WIN32
  (void)executable;
  if (!directory) {
    FILE_BASIC_INFO value;
    if (!GetFileInformationByHandleEx(handles[index].h, FileBasicInfo, &value, sizeof(value))) return os_error(GetLastError());
    value.FileAttributes |= FILE_ATTRIBUTE_READONLY;
    if (!SetFileInformationByHandle(handles[index].h, FileBasicInfo, &value, sizeof(value))) return os_error(GetLastError());
  }
#else
  if (fchmod(handles[index].h, directory || executable ? 0500 : 0400)) return os_error(errno);
  if (fsync(handles[index].h)) return os_error(errno);
#endif
  return true;
}
static bool tree_seen(uint32_t parent, const char *name) {
  int found = tree_find(parent, name); if (found < 0) return deny("path_changed");
  const tree_entry *entry = &tree_entries[found]; held *value = &handles[entry->handle_index]; info actual;
  handle other = child(handles[value->parent].h, name, !entry->kind, false, false, false, false, false);
  if (other == BAD_HANDLE) { failure = "path_changed"; return false; }
  bool same = describe(other, &actual) && !strcmp(actual.id, value->original.id) && (!entry->kind || actual.links == 1); close_handle(other);
  return same || deny("path_changed");
}
static bool tree_census(int index, uint32_t parent) {
  uint32_t seen = 0, expected = 0;
  for (uint32_t n = 0; n < tree_count; n++) if (tree_entries[n].parent == parent) expected++;
#ifdef _WIN32
  unsigned char buffer[65536]; bool first = true;
  for (;;) {
    if (!GetFileInformationByHandleEx(handles[index].h, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buffer, sizeof(buffer))) {
      DWORD error = GetLastError(); if (error == ERROR_NO_MORE_FILES) break; return os_error(error);
    }
    first = false; DWORD offset = 0;
    for (;;) {
      FILE_ID_BOTH_DIR_INFO *item = (FILE_ID_BOTH_DIR_INFO *)(void *)(buffer + offset);
      if (offset > sizeof(buffer) - offsetof(FILE_ID_BOTH_DIR_INFO, FileName) || item->FileNameLength % 2 || item->FileNameLength > 510
        || item->FileNameLength > sizeof(buffer) - offset - offsetof(FILE_ID_BOTH_DIR_INFO, FileName)) return deny("path_changed");
      wchar_t wide_name[256]; memcpy(wide_name, item->FileName, item->FileNameLength); wide_name[item->FileNameLength / 2] = 0;
      if (wcscmp(wide_name, L".") && wcscmp(wide_name, L"..")) {
        char name[1025]; if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_name, -1, name, sizeof(name), NULL, NULL) || !tree_seen(parent, name)) return false;
        seen++;
      }
      if (!item->NextEntryOffset) break;
      if (item->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) || item->NextEntryOffset >= sizeof(buffer) - offset) return deny("io_error");
      offset += item->NextEntryOffset;
    }
  }
#else
  int copy = dup(handles[index].h); if (copy < 0) return os_error(errno);
  DIR *directory = fdopendir(copy); if (!directory) { close(copy); return os_error(errno); }
  rewinddir(directory); bool ok = true; struct dirent *item;
  for (;;) {
    errno = 0; item = readdir(directory); if (!item) { if (errno) ok = os_error(errno); break; }
    if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
    if (!tree_seen(parent, item->d_name)) { ok = false; break; } seen++;
  }
  closedir(directory); if (!ok) return false;
#endif
  return seen == expected || deny("path_changed");
}
static bool tree_test_barrier(void) {
#ifdef PHONON_FS_BROKER_TEST_HOOKS
  if (getenv("PHONON_FS_BROKER_TREE_BARRIER")) {
    fputs("PHONON_FS_TREE_READY\n", stderr); fflush(stderr);
    if (fgetc(stdin) != 0xa6) return deny("invalid_request");
    return fgetc(stdin) == EOF || deny("invalid_request");
  }
#endif
  return true;
}
static bool tree_run(int root, char *relative, int flags, bool publishing, info *out) {
  int parent = walk(root, relative, publishing && (flags & PARENTS)); if (parent < 0 || !current(parent)) return false;
#ifdef PHONON_FS_BROKER_TEST_HOOKS
  if (getenv("PHONON_FS_BROKER_TEST_BARRIER") && !barrier()) return false;
#endif
  int tree = parent;
  if (publishing) {
    tree = remember(child(handles[parent].h, tree_stage, true, false, true, true, true, false), parent, tree_stage);
    if (tree < 0) return false;
  } else if (strcmp(handles[tree].original.id, tree_expected)) return deny("path_changed");
  for (uint32_t n = 0; n < tree_count; n++) {
    tree_entry *entry = &tree_entries[n]; int ancestor = entry->parent == UINT32_MAX ? tree : tree_entries[entry->parent].handle_index;
    if (!tree_ancestry(ancestor)) return false;
    int leaf = remember(child(handles[ancestor].h, entry->name, !entry->kind, publishing && entry->kind, publishing, publishing, false, false), ancestor, entry->name);
    if (leaf < 0) return false; entry->handle_index = leaf;
    if (strcmp(handles[leaf].original.kind, entry->kind ? "file" : "directory") || (entry->kind && handles[leaf].original.links != 1)) return deny("path_denied");
    if (entry->kind) {
      if (publishing) {
        if (!write_bytes(handles[leaf].h, entry->data, entry->size) || !tree_seal(leaf, false, entry->executable != 0)) return false;
        info written; if (!describe(handles[leaf].h, &written)) return false; close_handle(handles[leaf].h);
        handles[leaf].h = child(handles[ancestor].h, entry->name, false, false, false, false, false, false);
        info reopened; if (handles[leaf].h == BAD_HANDLE || !describe(handles[leaf].h, &reopened) || strcmp(written.id, reopened.id)) return deny("path_changed");
      }
      if (!tree_read(leaf, entry)) return false;
#ifndef _WIN32
      if (handles[leaf].original.mode != (entry->executable ? 0500u : 0400u)) return deny("path_changed");
#else
      if (handles[leaf].original.mode != 0400u) return deny("path_changed");
#endif
    }
  }
  if (publishing) {
    for (int n = count - 1; n >= tree; n--) if (!strcmp(handles[n].original.kind, "directory")) {
      if (!tree_seal(n, true, false) || !describe(handles[n].h, &handles[n].original)) return false;
    }
#ifndef _WIN32
    for (int n = root; n < tree; n++) if (fsync(handles[n].h)) return os_error(errno);
#endif
  }
  if (!tree_test_barrier() || !tree_ancestry(tree)) return false;
  for (uint32_t n = 0; n <= tree_count; n++) {
    int index = n == tree_count ? tree : tree_entries[n].handle_index;
    if (!tree_ancestry(index)) return false;
    info actual, before = handles[index].original; if (!describe(handles[index].h, &actual)) return false;
    if (before.changed != actual.changed || before.modified != actual.modified || before.size != actual.size || before.mode != actual.mode || (strcmp(actual.kind, "directory") && actual.links != 1)) return deny("path_changed");
#ifndef _WIN32
    if (!strcmp(actual.kind, "directory") && actual.mode != 0500u) return deny("path_changed");
#endif
    if (!strcmp(actual.kind, "directory") && !tree_census(index, n == tree_count ? UINT32_MAX : n)) return false;
  }
  if (publishing) {
    if (!publish(handles[parent].h, handles[tree].h, tree_stage, tree_destination)) return false;
    handles[tree].name = tree_destination;
    if (!tree_ancestry(tree)) return false;
  }
  return describe(handles[tree].h, out);
}
