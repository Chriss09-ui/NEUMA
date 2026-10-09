#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <userenv.h>
#include <winternl.h>
#include <algorithm>
#include <climits>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr DWORD MAX_JOURNAL = 2 * 1024 * 1024;
constexpr size_t MAX_OBJECTS = 20000;
constexpr wchar_t PROFILE_PREFIX[] = L"neuma-isolation-";
struct Failure { int line = 0; DWORD error = 0; bool reported = false; };
void report_failure(int line, DWORD error) noexcept {
  char message[96];
  int size = std::snprintf(message, sizeof(message), "NEUMA_ISOLATION_FAIL line=%d win32=%lu\n", line, static_cast<unsigned long>(error));
  if (size <= 0 || static_cast<size_t>(size) >= sizeof(message)) return;
  DWORD written = 0;
  if (!WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, static_cast<DWORD>(size), &written, nullptr)) return;
}
Failure failure_at(int line) { return { line, GetLastError(), false }; }
void require_impl(bool ok, int line) {
  if (ok) return;
  DWORD error = GetLastError(); report_failure(line, error); throw Failure{ line, error, true };
}
#define require(value) require_impl(static_cast<bool>(value), __LINE__)
void report_current_exception(int fallback_line) noexcept {
  try { throw; }
  catch (const Failure& failure) { if (!failure.reported) report_failure(failure.line, failure.error); }
  catch (...) { report_failure(fallback_line, GetLastError()); }
}
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = nullptr; }
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { reset(); value = other.value; other.value = nullptr; } return *this; }
  void reset(HANDLE handle = nullptr) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = handle; }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct LocalMemory { void *value = nullptr; ~LocalMemory() { if (value) LocalFree(value); } };
struct ProfileSid { PSID value = nullptr; ~ProfileSid() { if (value) FreeSid(value); } };
struct Record { std::wstring path; std::vector<BYTE> label; FILE_ID_INFO identity{}; };
struct Journal {
  DWORD helperPid = 0;
  DWORD childPid = 0;
  ULONGLONG childCreation = 0;
  bool workspaceGranted = false;
  std::wstring profile, workspace;
  std::vector<Record> records;
};

bool is_path(const std::wstring& path) {
  if (path.empty() || path.size() > 32760 || path.find(L'\0') != std::wstring::npos) return false;
  return (path.size() > 2 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) || path.rfind(L"\\\\", 0) == 0;
}
bool same_path(const std::wstring& left, const std::wstring& right) { return _wcsicmp(left.c_str(), right.c_str()) == 0; }
bool beneath(const std::wstring& root, const std::wstring& path) {
  return same_path(root, path) || (path.size() > root.size() && _wcsnicmp(root.c_str(), path.c_str(), root.size()) == 0 && path[root.size()] == L'\\');
}
std::wstring parent_path(const std::wstring& path) {
  size_t last = path.find_last_of(L"\\/");
  if (last == std::wstring::npos) return L"";
  if (last == 2 && path[1] == L':') return path.substr(0, 3);
  return path.substr(0, last);
}
DWORD attributes(const std::wstring& path) { DWORD value = GetFileAttributesW(path.c_str()); require(value != INVALID_FILE_ATTRIBUTES); return value; }

template<typename Function> Function nt_function(const char *name) {
  HMODULE module = GetModuleHandleW(L"ntdll.dll"); require(module != nullptr);
  FARPROC address = GetProcAddress(module, name); require(address != nullptr);
  Function result = nullptr; static_assert(sizeof(result) == sizeof(address)); memcpy(&result, &address, sizeof(result)); return result;
}

// A final-component check is insufficient: an earlier directory may have been
// replaced with a junction while a run was interrupted. Resolve one component
// at a time relative to an already checked directory HANDLE. Never let a named
// ACL/label operation resolve the path a second time after this check.
Handle checked_object(const std::wstring& original, DWORD access = MAXIMUM_ALLOWED, bool final_reparse = false) {
  std::wstring path = original; std::replace(path.begin(), path.end(), L'/', L'\\');
  size_t start = 3;
  if (path.rfind(L"\\\\?\\", 0) == 0) start = 7;
  require(path.size() >= start && path[start - 2] == L':' && path[start - 1] == L'\\');
  std::wstring root = path.substr(0, start);
  Handle current(CreateFileW(root.c_str(), path.size() == start ? access : FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!current.valid()) throw failure_at(__LINE__);
  BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(current.value, &info)
    && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY));
  static auto open_relative = nt_function<decltype(&NtCreateFile)>("NtCreateFile");
  using StatusError = ULONG (WINAPI*)(NTSTATUS);
  static auto error_code = nt_function<StatusError>("RtlNtStatusToDosError");
  for (size_t position = start; position < path.size(); ) {
    size_t next = path.find(L'\\', position); bool last = next == std::wstring::npos;
    std::wstring component = path.substr(position, last ? std::wstring::npos : next - position);
    require(!component.empty() && component != L"." && component != L".." && component.find(L':') == std::wstring::npos
      && component.size() * sizeof(wchar_t) <= USHRT_MAX);
    UNICODE_STRING name{}; name.Buffer = component.data(); name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t)); name.MaximumLength = name.Length;
    OBJECT_ATTRIBUTES object{}; object.Length = sizeof(object); object.RootDirectory = current.value; object.ObjectName = &name; object.Attributes = OBJ_CASE_INSENSITIVE;
    IO_STATUS_BLOCK io{}; HANDLE opened = nullptr;
    NTSTATUS status = open_relative(&opened, (last ? access : FILE_READ_ATTRIBUTES) | SYNCHRONIZE, &object, &io, nullptr, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT | (last ? 0 : FILE_DIRECTORY_FILE), nullptr, 0);
    if (status < 0) { SetLastError(error_code(status)); throw failure_at(__LINE__); }
    Handle child(opened); require(child.valid() && GetFileInformationByHandle(child.value, &info));
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && !(last && final_reparse)) { SetLastError(ERROR_REPARSE_TAG_INVALID); throw failure_at(__LINE__); }
    if (!last) require(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
    current = std::move(child); if (last) break; position = next + 1;
  }
  return current;
}

FILE_ID_INFO object_identity(HANDLE handle) {
  FILE_ID_INFO identity{}; require(GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity))); return identity;
}
bool same_identity(const FILE_ID_INFO& left, const FILE_ID_INFO& right) {
  return left.VolumeSerialNumber == right.VolumeSerialNumber && !memcmp(left.FileId.Identifier, right.FileId.Identifier, sizeof(left.FileId.Identifier));
}
bool regular_handle(HANDLE handle, bool allow_links = false) {
  BY_HANDLE_FILE_INFORMATION info{};
  return GetFileInformationByHandle(handle, &info) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    && ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || allow_links || info.nNumberOfLinks == 1);
}
bool plain_object(const std::wstring& path, bool allow_links = false) {
  try { Handle handle = checked_object(path, FILE_READ_ATTRIBUTES); return regular_handle(handle.value, allow_links); } catch (...) { return false; }
}
void walk(const std::wstring& path, std::vector<std::wstring>& result) {
  require(result.size() < MAX_OBJECTS);
  result.push_back(path);
  Handle object = checked_object(path, FILE_READ_ATTRIBUTES, true); BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(object.value, &info)); DWORD flags = info.dwFileAttributes;
  if (!(flags & FILE_ATTRIBUTE_DIRECTORY) || flags & FILE_ATTRIBUTE_REPARSE_POINT) return;
  WIN32_FIND_DATAW found{};
  HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &found);
  if (search == INVALID_HANDLE_VALUE) { require(GetLastError() == ERROR_FILE_NOT_FOUND); return; }
  do {
    if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue;
    try { walk(path + L"\\" + found.cFileName, result); }
    catch (...) { FindClose(search); throw; }
  } while (FindNextFileW(search, &found));
  DWORD error = GetLastError(); FindClose(search); require(error == ERROR_NO_MORE_FILES);
}

std::vector<BYTE> user_sid() {
  Handle token; HANDLE raw = nullptr; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)); token.reset(raw);
  DWORD needed = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &needed); require(needed > 0 && needed < 65536);
  std::vector<BYTE> info(needed); require(GetTokenInformation(token.value, TokenUser, info.data(), needed, &needed));
  PSID sid = reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid;
  std::vector<BYTE> result(GetLengthSid(sid)); require(CopySid(static_cast<DWORD>(result.size()), result.data(), sid)); return result;
}
std::wstring owner_sddl() {
  auto sid = user_sid(); LPWSTR text = nullptr; require(ConvertSidToStringSidW(sid.data(), &text));
  LocalMemory memory; memory.value = text;
  return L"O:" + std::wstring(text) + L"D:P(A;;FA;;;" + std::wstring(text) + L")(A;;FA;;;SY)";
}
Handle private_file(const std::wstring& path, DWORD disposition) {
  LocalMemory descriptor;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(owner_sddl().c_str(), SDDL_REVISION_1, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value), nullptr));
  SECURITY_ATTRIBUTES security{ sizeof(security), descriptor.value, FALSE };
  Handle result(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, &security, disposition, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(result.valid()); return result;
}
void write_bytes(HANDLE file, const void *data, DWORD size) {
  const BYTE *cursor = static_cast<const BYTE*>(data);
  while (size) { DWORD written = 0; require(WriteFile(file, cursor, size, &written, nullptr) && written); cursor += written; size -= written; }
}
void append_number(std::vector<BYTE>& output, DWORD number) {
  const BYTE *bytes = reinterpret_cast<const BYTE*>(&number); output.insert(output.end(), bytes, bytes + sizeof(number));
}
void append_text(std::vector<BYTE>& output, const std::wstring& text) {
  require(text.size() <= 32760); append_number(output, static_cast<DWORD>(text.size()));
  const BYTE *bytes = reinterpret_cast<const BYTE*>(text.data()); output.insert(output.end(), bytes, bytes + text.size() * sizeof(wchar_t));
}
void delete_opened_object(HANDLE handle);
void save_journal(const std::wstring& path, const Journal& journal) {
  std::vector<BYTE> bytes{ 'N', 'E', 'U', 'M', 'A', 'W', '2', 0 };
  append_number(bytes, journal.helperPid); append_number(bytes, journal.childPid);
  append_number(bytes, static_cast<DWORD>(journal.childCreation)); append_number(bytes, static_cast<DWORD>(journal.childCreation >> 32));
  append_number(bytes, journal.workspaceGranted ? 1 : 0); append_text(bytes, journal.profile); append_text(bytes, journal.workspace);
  append_number(bytes, static_cast<DWORD>(journal.records.size()));
  for (const auto& record : journal.records) {
    append_text(bytes, record.path);
    append_number(bytes, static_cast<DWORD>(record.identity.VolumeSerialNumber)); append_number(bytes, static_cast<DWORD>(record.identity.VolumeSerialNumber >> 32));
    bytes.insert(bytes.end(), record.identity.FileId.Identifier, record.identity.FileId.Identifier + sizeof(record.identity.FileId.Identifier));
    append_number(bytes, static_cast<DWORD>(record.label.size()));
    bytes.insert(bytes.end(), record.label.begin(), record.label.end());
  }
  require(bytes.size() <= MAX_JOURNAL);
  // The journal is flushed before each ACL change; after an abrupt termination
  // the next trusted helper can revoke only this run's SID and restore labels.
  std::wstring pending = path + L".pending";
  if (GetFileAttributesW(pending.c_str()) != INVALID_FILE_ATTRIBUTES) {
    Handle pending_file = checked_object(pending); require(regular_handle(pending_file.value)); delete_opened_object(pending_file.value); pending_file.reset();
  }
  Handle file = private_file(pending, CREATE_NEW);
  write_bytes(file.value, bytes.data(), static_cast<DWORD>(bytes.size())); require(FlushFileBuffers(file.value)); file.reset();
  require(MoveFileExW(pending.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH));
}
DWORD take_number(const std::vector<BYTE>& input, size_t& offset) {
  require(offset + sizeof(DWORD) <= input.size()); DWORD result; memcpy(&result, input.data() + offset, sizeof(result)); offset += sizeof(result); return result;
}
std::wstring take_text(const std::vector<BYTE>& input, size_t& offset) {
  DWORD count = take_number(input, offset); require(count <= 32760 && offset + static_cast<size_t>(count) * sizeof(wchar_t) <= input.size());
  std::wstring result(count, L'\0'); memcpy(result.data(), input.data() + offset, static_cast<size_t>(count) * sizeof(wchar_t)); offset += static_cast<size_t>(count) * sizeof(wchar_t);
  require(result.find(L'\0') == std::wstring::npos); return result;
}
Journal load_journal(const std::wstring& path) {
  Handle file = checked_object(path, GENERIC_READ | READ_CONTROL); require(regular_handle(file.value));
  PSID owner = nullptr; LocalMemory descriptor;
  require(GetSecurityInfo(file.value, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) == ERROR_SUCCESS);
  auto current = user_sid(); require(owner && EqualSid(owner, current.data()));
  LARGE_INTEGER size{}; require(GetFileSizeEx(file.value, &size) && size.QuadPart >= 8 && size.QuadPart <= MAX_JOURNAL);
  std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart)); DWORD read = 0;
  require(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size());
  require(!memcmp(bytes.data(), "NEUMAW2", 8)); size_t offset = 8;
  Journal result; result.helperPid = take_number(bytes, offset); result.childPid = take_number(bytes, offset);
  result.childCreation = take_number(bytes, offset); result.childCreation |= static_cast<ULONGLONG>(take_number(bytes, offset)) << 32;
  DWORD granted = take_number(bytes, offset); require(granted <= 1); result.workspaceGranted = granted != 0;
  result.profile = take_text(bytes, offset); result.workspace = take_text(bytes, offset);
  require(result.profile.rfind(PROFILE_PREFIX, 0) == 0 && result.profile.size() == 48 && is_path(result.workspace));
  DWORD count = take_number(bytes, offset); require(count <= MAX_OBJECTS);
  for (DWORD index = 0; index < count; index++) {
    Record record; record.path = take_text(bytes, offset); require(is_path(record.path));
    record.identity.VolumeSerialNumber = take_number(bytes, offset); record.identity.VolumeSerialNumber |= static_cast<ULONGLONG>(take_number(bytes, offset)) << 32;
    require(offset + sizeof(record.identity.FileId.Identifier) <= bytes.size());
    memcpy(record.identity.FileId.Identifier, bytes.data() + offset, sizeof(record.identity.FileId.Identifier)); offset += sizeof(record.identity.FileId.Identifier);
    DWORD label_size = take_number(bytes, offset); require(label_size <= 65536 && offset + label_size <= bytes.size());
    record.label.assign(bytes.begin() + static_cast<ptrdiff_t>(offset), bytes.begin() + static_cast<ptrdiff_t>(offset + label_size)); offset += label_size;
    if (label_size) require(IsValidSecurityDescriptor(record.label.data()));
    result.records.push_back(std::move(record));
  }
  require(offset == bytes.size()); return result;
}

std::vector<BYTE> current_label(HANDLE handle) {
  LocalMemory descriptor;
  require(GetSecurityInfo(handle, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr,
    reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) == ERROR_SUCCESS);
  DWORD size = GetSecurityDescriptorLength(descriptor.value); require(size && size < 65536);
  const BYTE *bytes = static_cast<const BYTE*>(descriptor.value); return std::vector<BYTE>(bytes, bytes + size);
}
void set_label(HANDLE handle, PSECURITY_DESCRIPTOR descriptor) {
  PACL label = nullptr; BOOL present = FALSE, defaulted = FALSE;
  require(GetSecurityDescriptorSacl(descriptor, &present, &label, &defaulted));
  require(SetSecurityInfo(handle, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, present ? label : nullptr) == ERROR_SUCCESS);
}
void integrity_label(const std::wstring& path, bool low, const FILE_ID_INFO *expected = nullptr) {
  Handle handle = checked_object(path); require(regular_handle(handle.value));
  if (expected) require(same_identity(*expected, object_identity(handle.value)));
  LocalMemory descriptor;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(low ? L"S:(ML;OICI;NW;;;LW)" : L"S:(ML;OICI;NW;;;ME)", SDDL_REVISION_1,
    reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value), nullptr)); set_label(handle.value, descriptor.value);
}
void set_dacl(HANDLE handle, PACL acl) {
  // checked_object opens this exact object with MAXIMUM_ALLOWED. Microsoft
  // documents that SetSecurityInfo then does not propagate ACEs to children;
  // unrelated home/system directories are not recursively rewritten.
  require(SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr) == ERROR_SUCCESS);
}
void grant(const std::wstring& path, PSID sid, DWORD access, DWORD inheritance = NO_INHERITANCE, const FILE_ID_INFO *expected = nullptr) {
  Handle handle = checked_object(path); require(regular_handle(handle.value));
  if (expected) require(same_identity(*expected, object_identity(handle.value)));
  PACL old_acl = nullptr; LocalMemory descriptor;
  require(GetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_acl, nullptr,
    reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) == ERROR_SUCCESS);
  require(old_acl != nullptr);
  DWORD length = old_acl->AclSize + static_cast<DWORD>(sizeof(ACCESS_ALLOWED_ACE)) - static_cast<DWORD>(sizeof(DWORD)) + GetLengthSid(sid);
  require(length <= MAXWORD); std::vector<BYTE> bytes(length); PACL merged = reinterpret_cast<PACL>(bytes.data());
  require(InitializeAcl(merged, length, ACL_REVISION_DS)); bool inserted = false;
  for (DWORD index = 0; index < old_acl->AceCount; index++) {
    void *raw = nullptr; require(GetAce(old_acl, index, &raw)); ACE_HEADER *header = static_cast<ACE_HEADER*>(raw);
    if (!inserted && (header->AceFlags & INHERITED_ACE)) { require(AddAccessAllowedAceEx(merged, ACL_REVISION_DS, inheritance, access, sid)); inserted = true; }
    require(AddAce(merged, ACL_REVISION_DS, MAXDWORD, raw, header->AceSize));
  }
  // Keep different inheritance scopes in distinct ACEs. In particular CI-only
  // directory traversal must never merge into an OI file-execution permission.
  if (!inserted) require(AddAccessAllowedAceEx(merged, ACL_REVISION_DS, inheritance, access, sid));
  set_dacl(handle.value, merged);
}
void revoke_handle(HANDLE handle, PSID sid) {
  require(regular_handle(handle));
  PACL old_acl = nullptr; LocalMemory descriptor;
  require(GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_acl, nullptr,
    reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) == ERROR_SUCCESS);
  if (!old_acl) return;
  std::vector<BYTE> bytes(old_acl->AclSize); PACL result = reinterpret_cast<PACL>(bytes.data());
  require(InitializeAcl(result, old_acl->AclSize, ACL_REVISION_DS));
  bool changed = false;
  for (DWORD index = 0; index < old_acl->AceCount; index++) {
    void *raw = nullptr; require(GetAce(old_acl, index, &raw)); ACE_HEADER *header = static_cast<ACE_HEADER*>(raw);
    PSID entry_sid = nullptr;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) entry_sid = &static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) entry_sid = &static_cast<ACCESS_DENIED_ACE*>(raw)->SidStart;
    if (entry_sid && EqualSid(entry_sid, sid)) { changed = true; continue; }
    require(AddAce(result, ACL_REVISION_DS, MAXDWORD, raw, header->AceSize));
  }
  if (changed) set_dacl(handle, result);
}
void revoke(const std::wstring& path, PSID sid, const FILE_ID_INFO *expected = nullptr, bool workspace_replacement = false) {
  Handle handle;
  try { handle = checked_object(path); }
  catch (...) { require(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND); return; }
  require(regular_handle(handle.value));
  if (expected && !same_identity(*expected, object_identity(handle.value))) {
    // Atomic writes legitimately replace workspace files. The workspace walk
    // already removed this run's SID from the new object; do not replay an old
    // object's permissions or label onto its replacement.
    require(workspace_replacement); return;
  }
  revoke_handle(handle.value, sid);
}
size_t remember(Journal& journal, const std::wstring& journal_path, const std::wstring& path, bool label) {
  for (size_t index = 0; index < journal.records.size(); index++) if (same_path(journal.records[index].path, path)) {
    Handle handle = checked_object(path); require(regular_handle(handle.value) && same_identity(journal.records[index].identity, object_identity(handle.value)));
    if (label && journal.records[index].label.empty()) { journal.records[index].label = current_label(handle.value); save_journal(journal_path, journal); }
    return index;
  }
  require(journal.records.size() < MAX_OBJECTS && plain_object(path));
  Handle handle = checked_object(path); require(regular_handle(handle.value));
  journal.records.push_back({ path, label ? current_label(handle.value) : std::vector<BYTE>{}, object_identity(handle.value) }); save_journal(journal_path, journal); return journal.records.size() - 1;
}
void ancestors(Journal& journal, const std::wstring& journal_path, const std::wstring& root, PSID sid) {
  for (std::wstring path = parent_path(root); !path.empty(); ) {
    Handle writable_acl;
    try { writable_acl = checked_object(path, WRITE_DAC); } catch (...) { require(GetLastError() == ERROR_ACCESS_DENIED); }
    if (writable_acl.valid()) {
      size_t index = remember(journal, journal_path, path, false);
      grant(path, sid, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, NO_INHERITANCE, &journal.records[index].identity);
    }
    // System-owned ancestors retain their standard traversal rules. A normal
    // user never needs elevation or a change to the whole volume's permissions.
    std::wstring parent = parent_path(path); if (same_path(path, parent)) break; path = parent;
  }
}
void grant_tree(Journal& journal, const std::wstring& journal_path, const std::wstring& root, PSID sid, bool writable, bool executable = false) {
  ancestors(journal, journal_path, root, sid);
  std::vector<std::wstring> paths; walk(root, paths);
  // Capture every old label before changing an inheritable directory label.
  for (const auto& path : paths) remember(journal, journal_path, path, writable);
  if (writable) { journal.workspaceGranted = true; save_journal(journal_path, journal); }
  for (const auto& path : paths) {
    size_t index = remember(journal, journal_path, path, writable); const FILE_ID_INFO identity = journal.records[index].identity;
    DWORD flags = attributes(path);
    DWORD rights = FILE_GENERIC_READ;
    if (executable && !(flags & FILE_ATTRIBUTE_DIRECTORY)) rights |= FILE_GENERIC_EXECUTE;
    if (writable) { rights |= FILE_GENERIC_WRITE; if (!same_path(path, root)) rights |= DELETE; if (flags & FILE_ATTRIBUTE_DIRECTORY) rights |= FILE_DELETE_CHILD; }
    grant(path, sid, rights, flags & FILE_ATTRIBUTE_DIRECTORY ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE, &identity);
    // FILE_TRAVERSE and FILE_EXECUTE share a bit. A container-only ACE grants
    // traversal to new directories without granting execution to new files.
    if (flags & FILE_ATTRIBUTE_DIRECTORY) grant(path, sid, FILE_TRAVERSE, CONTAINER_INHERIT_ACE, &identity);
    if (writable) integrity_label(path, true, &identity);
  }
}

void delete_opened_object(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
  require(SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition)));
}
bool cleanup(Journal& journal, const std::wstring& journal_path) {
  try {
    if (journal.profile.empty()) return true;
    if (journal.childPid) {
      Handle child(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, journal.childPid));
      if (child.valid()) {
        FILETIME created{}, ended{}, kernel{}, user{};
        require(GetProcessTimes(child.value, &created, &ended, &kernel, &user));
        ULONGLONG identity = static_cast<ULONGLONG>(created.dwLowDateTime) | (static_cast<ULONGLONG>(created.dwHighDateTime) << 32);
        // A reused PID belongs to another process and is never terminated.
        if (identity == journal.childCreation) require(WaitForSingleObject(child.value, 3000) == WAIT_OBJECT_0);
      } else require(GetLastError() == ERROR_INVALID_PARAMETER);
    }
    ProfileSid sid; require(SUCCEEDED(DeriveAppContainerSidFromAppContainerName(journal.profile.c_str(), &sid.value)));
    if (journal.workspaceGranted && GetFileAttributesW(journal.workspace.c_str()) != INVALID_FILE_ATTRIBUTES) {
      Handle workspace = checked_object(journal.workspace); require(regular_handle(workspace.value));
      auto root_record = std::find_if(journal.records.begin(), journal.records.end(), [&](const Record& record) { return same_path(record.path, journal.workspace); });
      require(root_record != journal.records.end() && same_identity(root_record->identity, object_identity(workspace.value)));
      std::vector<std::wstring> files; walk(journal.workspace, files);
      // Unsafe links were absent before granting the directory. Remove only
      // newly created link objects, without following or modifying their target.
      for (auto it = files.rbegin(); it != files.rend(); ++it) {
        Handle object = checked_object(*it, MAXIMUM_ALLOWED, true); BY_HANDLE_FILE_INFORMATION info{};
        require(GetFileInformationByHandle(object.value, &info)); DWORD flags = info.dwFileAttributes; const FILE_ID_INFO identity = object_identity(object.value);
        bool original = std::any_of(journal.records.begin(), journal.records.end(), [&](const Record& record) { return same_path(record.path, *it) && same_identity(record.identity, identity); });
        if (flags & FILE_ATTRIBUTE_REPARSE_POINT) { require(!original); delete_opened_object(object.value); }
        else if (!original && !regular_handle(object.value)) { require(!(flags & FILE_ATTRIBUTE_DIRECTORY)); delete_opened_object(object.value); }
      }
      files.clear(); walk(journal.workspace, files);
      for (auto it = files.rbegin(); it != files.rend(); ++it) {
        Handle object = checked_object(*it); require(regular_handle(object.value));
        const FILE_ID_INFO identity = object_identity(object.value); revoke_handle(object.value, sid.value);
        auto original = std::find_if(journal.records.begin(), journal.records.end(), [&](const Record& record) { return !record.label.empty() && same_identity(record.identity, identity); });
        if (original != journal.records.end()) set_label(object.value, original->label.data());
        else { LocalMemory descriptor; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;ME)", SDDL_REVISION_1,
          reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value), nullptr)); set_label(object.value, descriptor.value); }
      }
    }
    for (auto it = journal.records.rbegin(); it != journal.records.rend(); ++it) {
      revoke(it->path, sid.value, &it->identity, beneath(journal.workspace, it->path));
    }
    // Parents first, then explicit child labels, so inheritance cannot replace
    // a child's original level after it has already been restored.
    for (auto& record : journal.records) if (!record.label.empty() && GetFileAttributesW(record.path.c_str()) != INVALID_FILE_ATTRIBUTES) {
      Handle object = checked_object(record.path); require(regular_handle(object.value));
      if (!same_identity(record.identity, object_identity(object.value))) { require(beneath(journal.workspace, record.path)); continue; }
      set_label(object.value, record.label.data());
    }
    HRESULT deleted = DeleteAppContainerProfile(journal.profile.c_str());
    require(SUCCEEDED(deleted) || deleted == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || deleted == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND) || deleted == HRESULT_FROM_WIN32(ERROR_NOT_FOUND));
    Handle journal_file = checked_object(journal_path); require(regular_handle(journal_file.value)); delete_opened_object(journal_file.value);
    journal.profile.clear(); return true;
  } catch (...) { report_current_exception(__LINE__); return false; }
}

std::wstring quoted(const std::wstring& value) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') { slashes++; continue; }
    if (character == L'\"') { result.append(slashes * 2 + 1, L'\\'); result.push_back(character); }
    else { result.append(slashes, L'\\'); result.push_back(character); }
    slashes = 0;
  }
  result.append(slashes * 2, L'\\'); result.push_back(L'\"'); return result;
}
DWORD parent_pid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); require(snapshot.valid());
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); require(Process32FirstW(snapshot.value, &entry));
  do { if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID; } while (Process32NextW(snapshot.value, &entry));
  throw failure_at(__LINE__);
}
std::vector<wchar_t> environment(const std::wstring& runtime, const std::wstring& workspace) {
  wchar_t system[MAX_PATH + 1]; UINT count = GetWindowsDirectoryW(system, MAX_PATH + 1); require(count && count < MAX_PATH + 1);
  std::vector<std::wstring> values{ L"HOME=" + workspace, L"LANG=en_US.UTF-8", L"LC_ALL=en_US.UTF-8", L"OPENSSL_CONF=NUL", L"PATH=" + runtime,
    L"SystemRoot=" + std::wstring(system, count), L"TEMP=" + workspace, L"TMP=" + workspace, L"TMPDIR=" + workspace, L"USERPROFILE=" + workspace };
  std::sort(values.begin(), values.end(), [](const std::wstring& left, const std::wstring& right) { return _wcsicmp(left.c_str(), right.c_str()) < 0; });
  std::vector<wchar_t> result; for (const auto& value : values) { result.insert(result.end(), value.begin(), value.end()); result.push_back(0); } result.push_back(0); return result;
}
void publish_status(const std::wstring& path, const char *status, DWORD exit_code, const char *reason, bool cleaned) {
  std::string text = "{\"protocol\":1,\"status\":\"" + std::string(status) + "\",\"exitCode\":" + std::to_string(exit_code) + ",\"cleanupComplete\":" + (cleaned ? "true" : "false");
  if (reason) text += ",\"reason\":\"" + std::string(reason) + "\"";
  text += "}\n"; Handle file = private_file(path, CREATE_NEW); write_bytes(file.value, text.data(), static_cast<DWORD>(text.size())); require(FlushFileBuffers(file.value));
}
std::wstring new_profile() {
  BYTE random[16]; require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
  constexpr wchar_t digits[] = L"0123456789abcdef"; std::wstring result = PROFILE_PREFIX;
  for (BYTE byte : random) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); } return result;
}
struct Pipes {
  Handle read, write;
  Pipes() { SECURITY_ATTRIBUTES security{ sizeof(security), nullptr, TRUE }; HANDLE input = nullptr, output = nullptr;
    require(CreatePipe(&input, &output, &security, 0)); read.reset(input); write.reset(output); require(SetHandleInformation(read.value, HANDLE_FLAG_INHERIT, 0)); }
};
struct Attributes {
  std::vector<BYTE> memory;
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  Attributes() { SIZE_T needed = 0; InitializeProcThreadAttributeList(nullptr, 5, 0, &needed); require(needed > 0);
    memory.resize(needed); value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data()); require(InitializeProcThreadAttributeList(value, 5, 0, &needed)); }
  ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
  void add(DWORD_PTR key, void *data, SIZE_T size) { require(UpdateProcThreadAttribute(value, 0, key, data, size, nullptr, nullptr)); }
};
} // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && !wcscmp(argv[1], L"--cleanup")) {
    try {
      Journal journal = load_journal(argv[2]);
      Handle original(OpenProcess(SYNCHRONIZE, FALSE, journal.helperPid));
      if (original.valid() && WaitForSingleObject(original.value, 0) == WAIT_TIMEOUT) return 1;
      if (!original.valid() && GetLastError() != ERROR_INVALID_PARAMETER) return 1;
      return cleanup(journal, argv[2]) ? 0 : 1;
    } catch (...) { report_current_exception(__LINE__); return 1; }
  }
  std::wstring node, code, writable, readable, cwd, status_path, journal_path;
  DWORD timeout = 0, max_output = 0; int command_index = 0;
  Journal journal; Handle job, process, thread; DWORD exit_code = 125;
  const char *reason = "isolation_setup_failed";
  try {
    for (int index = 1; index < argc; index++) {
      if (!wcscmp(argv[index], L"--")) { command_index = index + 1; break; }
      require(index + 1 < argc); std::wstring key = argv[index++], value = argv[index];
      if (key == L"--node") node = value; else if (key == L"--code") code = value; else if (key == L"--write") writable = value;
      else if (key == L"--read") readable = value; else if (key == L"--cwd") cwd = value; else if (key == L"--status") status_path = value;
      else if (key == L"--journal") journal_path = value;
      else if (key == L"--timeout" || key == L"--max-output") {
        wchar_t *end = nullptr; unsigned long number = wcstoul(value.c_str(), &end, 10); require(end && !*end && number > 0);
        if (key == L"--timeout") timeout = number; else max_output = number;
      } else { SetLastError(ERROR_INVALID_PARAMETER); throw failure_at(__LINE__); }
    }
    require(command_index && command_index < argc && timeout && timeout <= 120000 && max_output && max_output <= 1048576
      && is_path(node) && is_path(code) && is_path(writable) && is_path(cwd) && is_path(status_path) && is_path(journal_path)
      && (readable.empty() || is_path(readable)) && plain_object(node, true) && plain_object(code) && plain_object(writable) && plain_object(cwd));
    require(attributes(code) & FILE_ATTRIBUTE_DIRECTORY); require(attributes(writable) & FILE_ATTRIBUTE_DIRECTORY);
    const std::wstring control = parent_path(journal_path);
    require(same_path(parent_path(status_path), control) && !beneath(code, control) && !beneath(writable, control) && (readable.empty() || !beneath(readable, control)));
    Handle parent(OpenProcess(SYNCHRONIZE, FALSE, parent_pid())); require(parent.valid());
    LocalMemory control_descriptor;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(owner_sddl().c_str(), SDDL_REVISION_1,
      reinterpret_cast<PSECURITY_DESCRIPTOR*>(&control_descriptor.value), nullptr));
    PACL control_acl = nullptr; BOOL present = FALSE, defaulted = FALSE;
    require(GetSecurityDescriptorDacl(control_descriptor.value, &present, &control_acl, &defaulted) && present);
    Handle control_handle = checked_object(control); require(regular_handle(control_handle.value));
    require(SetSecurityInfo(control_handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, control_acl, nullptr) == ERROR_SUCCESS);
    std::wstring runtime = control + L"\\runtime"; require(CreateDirectoryW(runtime.c_str(), nullptr));
    std::wstring isolated_node = runtime + L"\\node.exe"; require(CopyFileW(node.c_str(), isolated_node.c_str(), TRUE));
    journal.helperPid = GetCurrentProcessId(); journal.profile = new_profile(); journal.workspace = writable;
    // Save the identity before profile creation so even a crash in setup leaves
    // enough information for the trusted cleanup operation.
    save_journal(journal_path, journal);
    ProfileSid sid;
    require(SUCCEEDED(CreateAppContainerProfile(journal.profile.c_str(), L"NEUMA isolated Node", L"NEUMA generated-code execution", nullptr, 0, &sid.value)));
    grant_tree(journal, journal_path, runtime, sid.value, false, true); grant_tree(journal, journal_path, code, sid.value, false);
    if (!readable.empty()) grant_tree(journal, journal_path, readable, sid.value, false);
    grant_tree(journal, journal_path, writable, sid.value, true);
    job.reset(CreateJobObjectW(nullptr, nullptr)); require(job.valid());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 1; limits.ProcessMemoryLimit = 256 * 1024 * 1024;
    require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
    Pipes output, errors;
    HANDLE stdin_handle = GetStdHandle(STD_INPUT_HANDLE); require(stdin_handle && stdin_handle != INVALID_HANDLE_VALUE);
    require(SetHandleInformation(stdin_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT));
    HANDLE inherited[] = { stdin_handle, output.write.value, errors.write.value };
    SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = sid.value;
    DWORD lpac = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT, child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    Attributes attributes_list;
    attributes_list.add(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities));
    attributes_list.add(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac, sizeof(lpac));
    attributes_list.add(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy, sizeof(child_policy));
    attributes_list.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited));
    HANDLE jobs[] = { job.value }; attributes_list.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs));
    std::wstring command = quoted(isolated_node);
    for (int index = command_index; index < argc; index++) command += L" " + quoted(argv[index]);
    require(command.size() < 32767); std::vector<wchar_t> command_buffer(command.begin(), command.end()); command_buffer.push_back(0);
    auto child_environment = environment(runtime, writable);
    STARTUPINFOEXW start{}; start.StartupInfo.cb = sizeof(start); start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    start.StartupInfo.hStdInput = stdin_handle; start.StartupInfo.hStdOutput = output.write.value; start.StartupInfo.hStdError = errors.write.value; start.lpAttributeList = attributes_list.value;
    PROCESS_INFORMATION launched{};
    require(CreateProcessW(isolated_node.c_str(), command_buffer.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, child_environment.data(), cwd.c_str(), &start.StartupInfo, &launched));
    process.reset(launched.hProcess); thread.reset(launched.hThread); output.write.reset(); errors.write.reset();
    FILETIME created{}, ended{}, kernel{}, user{}; require(GetProcessTimes(process.value, &created, &ended, &kernel, &user));
    journal.childPid = launched.dwProcessId; journal.childCreation = static_cast<ULONGLONG>(created.dwLowDateTime) | (static_cast<ULONGLONG>(created.dwHighDateTime) << 32);
    save_journal(journal_path, journal);
    require(ResumeThread(thread.value) != static_cast<DWORD>(-1)); thread.reset();
    reason = nullptr; DWORD total = 0; ULONGLONG deadline = GetTickCount64() + timeout;
    auto forward = [&](HANDLE input, HANDLE destination) {
      DWORD available = 0; if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { require(GetLastError() == ERROR_BROKEN_PIPE); return; }
      while (available) {
        char bytes[4096]; DWORD received = 0; require(ReadFile(input, bytes, std::min<DWORD>(static_cast<DWORD>(sizeof(bytes)), available), &received, nullptr));
        DWORD permitted = total >= max_output ? 0 : std::min<DWORD>(received, max_output - total);
        if (permitted) write_bytes(destination, bytes, permitted); total += permitted;
        if (received > permitted && !reason) { reason = "output_limit"; require(TerminateJobObject(job.value, 125)); }
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { require(GetLastError() == ERROR_BROKEN_PIPE); break; }
      }
    };
    while (WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {
      forward(output.read.value, GetStdHandle(STD_OUTPUT_HANDLE)); forward(errors.read.value, GetStdHandle(STD_ERROR_HANDLE));
      if (!reason && (GetTickCount64() >= deadline || WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT)) {
        reason = GetTickCount64() >= deadline ? "timeout" : "process_terminated"; require(TerminateJobObject(job.value, 125));
      }
      Sleep(10);
    }
    forward(output.read.value, GetStdHandle(STD_OUTPUT_HANDLE)); forward(errors.read.value, GetStdHandle(STD_ERROR_HANDLE));
    require(GetExitCodeProcess(process.value, &exit_code)); process.reset(); job.reset();
  } catch (...) {
    report_current_exception(__LINE__);
    if (job.valid()) TerminateJobObject(job.value, 125);
    if (process.valid()) WaitForSingleObject(process.value, 3000);
    process.reset(); thread.reset(); job.reset(); reason = "isolation_setup_failed";
  }
  bool cleaned = journal.profile.empty() || (!journal_path.empty() && cleanup(journal, journal_path));
  if (!cleaned && !reason) reason = "cleanup_failed";
  const char *status = reason ? "error" : exit_code ? "failed" : "passed";
  try { require(is_path(status_path)); publish_status(status_path, status, exit_code, reason, cleaned); } catch (...) { report_current_exception(__LINE__); return 125; }
  return !strcmp(status, "passed") ? 0 : 1;
}
