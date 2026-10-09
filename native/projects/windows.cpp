// Standalone Windows helper: no Node ABI, shell parsing of model text, or command-line inspection.
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <tlhelp32.h>
#include <iphlpapi.h>
#include <ws2tcpip.h>
#include <shobjidl.h>
#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE v = nullptr) : value(v) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  operator HANDLE() const { return value; }
};

static std::mutex outputMutex;
static std::string utf8(const std::wstring& value) {
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  if (size) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}
static std::string json(const std::string& text) {
  std::string result = "\"";
  const char hex[] = "0123456789abcdef";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') { result += '\\'; result += c; }
    else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
    else result += c;
  }
  return result + '"';
}
static void frame(const std::string& text) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << text << '\n' << std::flush;
}
static std::wstring quoted(const std::wstring& arg) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') { ++slashes; continue; }
    if (c == L'"') { result.append(slashes * 2 + 1, L'\\'); result += c; }
    else { result.append(slashes, L'\\'); result += c; }
    slashes = 0;
  }
  result.append(slashes * 2, L'\\'); return result + L'"';
}
static std::wstring imagePath(DWORD pid) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.value) return L"";
  std::wstring result(32768, L'\0'); DWORD size = static_cast<DWORD>(result.size());
  if (!QueryFullProcessImageNameW(process, 0, result.data(), &size)) return L"";
  result.resize(size); return result;
}

static int scan() {
  Handle list(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (list.value == INVALID_HANDLE_VALUE) return 2;
  std::string processes = "[", ports = "["; bool first = true, complete = true; size_t processCount = 0;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (!Process32FirstW(list, &entry)) return 2;
  do {
    if (!entry.th32ProcessID) continue;
    if (++processCount > 4096) { complete = false; break; }
    const auto image = imagePath(entry.th32ProcessID);
    if (!first) processes += ','; first = false;
    processes += "{\"pid\":" + std::to_string(entry.th32ProcessID) + ",\"ppid\":" + std::to_string(entry.th32ParentProcessID)
      + ",\"name\":" + json(utf8(entry.szExeFile));
    if (!image.empty()) processes += ",\"exe\":" + json(utf8(image));
    processes += '}';
  } while (Process32NextW(list, &entry));
  processes += ']'; first = true;
  for (ULONG family : {AF_INET, AF_INET6}) {
    ULONG size = 0;
    GetExtendedTcpTable(nullptr, &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (size > 8 * 1024 * 1024) { complete = false; continue; }
    std::vector<unsigned char> data(size);
    if (GetExtendedTcpTable(data.data(), &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0) != NO_ERROR) { complete = false; continue; }
    if (family == AF_INET) {
      auto table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(data.data());
      for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const auto& row = table->table[i]; IN_ADDR address{}; address.S_un.S_addr = row.dwLocalAddr; char text[INET_ADDRSTRLEN]{};
        if (!InetNtopA(AF_INET, &address, text, sizeof(text))) { complete = false; continue; }
        if (!first) ports += ','; first = false;
        ports += "{\"pid\":" + std::to_string(row.dwOwningPid) + ",\"port\":" + std::to_string(ntohs(static_cast<u_short>(row.dwLocalPort)))
          + ",\"protocol\":\"TCP\",\"address\":" + json(text) + '}';
      }
    } else {
      auto table = reinterpret_cast<MIB_TCP6TABLE_OWNER_PID*>(data.data());
      for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const auto& row = table->table[i]; char text[INET6_ADDRSTRLEN]{};
        if (!InetNtopA(AF_INET6, row.ucLocalAddr, text, sizeof(text))) { complete = false; continue; }
        if (!first) ports += ','; first = false;
        ports += "{\"pid\":" + std::to_string(row.dwOwningPid) + ",\"port\":" + std::to_string(ntohs(static_cast<u_short>(row.dwLocalPort)))
          + ",\"protocol\":\"TCP\",\"address\":" + json(text) + '}';
      }
    }
  }
  frame("{\"processes\":" + processes + ",\"ports\":" + ports + "],\"complete\":" + (complete ? "true" : "false") + '}');
  return 0;
}

static int pickFolder() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 2;
  IFileDialog* dialog = nullptr; int result = 2;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
    DWORD options = 0; dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"选择要添加到 NEUMA 的项目文件夹");
    const HRESULT shown = dialog->Show(nullptr);
    if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) { frame("{\"cancelled\":true}"); result = 0; }
    else if (SUCCEEDED(shown)) {
      IShellItem* item = nullptr; PWSTR path = nullptr;
      if (SUCCEEDED(dialog->GetResult(&item))) {
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) { frame("{\"cancelled\":false,\"path\":" + json(utf8(path)) + '}'); result = 0; CoTaskMemFree(path); }
        item->Release();
      }
    }
    dialog->Release();
  }
  CoUninitialize(); return result;
}

static std::string base64(const char* data, DWORD size) {
  static const char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result; result.reserve((size + 2) / 3 * 4);
  for (DWORD i = 0; i < size; i += 3) {
    uint32_t n = static_cast<unsigned char>(data[i]) << 16;
    if (i + 1 < size) n |= static_cast<unsigned char>(data[i + 1]) << 8;
    if (i + 2 < size) n |= static_cast<unsigned char>(data[i + 2]);
    result += chars[(n >> 18) & 63]; result += chars[(n >> 12) & 63];
    result += i + 1 < size ? chars[(n >> 6) & 63] : '=';
    result += i + 2 < size ? chars[n & 63] : '=';
  }
  return result;
}
static void streamOutput(HANDLE pipe, const char* kind) {
  char buffer[8192]; DWORD size;
  while (ReadFile(pipe, buffer, sizeof(buffer), &size, nullptr) && size) {
    frame(std::string("{\"event\":\"") + kind + "\",\"data\":" + json(base64(buffer, size)) + '}');
  }
}

static int manage(int argc, wchar_t** argv) {
  if (argc < 4) return 2;
  std::wstring executable = argv[3], line;
  std::wstring lower = executable; std::transform(lower.begin(), lower.end(), lower.begin(), ::towlower);
  const bool batch = lower.size() >= 4 && (lower.substr(lower.size() - 4) == L".cmd" || lower.substr(lower.size() - 4) == L".bat");
  if (batch) {
    wchar_t system[MAX_PATH]; const UINT n = GetSystemDirectoryW(system, MAX_PATH);
    if (!n || n >= MAX_PATH) return 2;
    executable = std::wstring(system) + L"\\cmd.exe"; line = quoted(executable) + L" /d /v:off /s /c \"";
    for (int i = 3; i < argc; ++i) {
      const std::wstring arg = argv[i];
      if (arg.find_first_of(L"%\"\r\n") != std::wstring::npos) return 2;
      if (i > 3) line += L' '; line += L'"' + arg + L'"';
    }
    line += L'"';
  } else {
    if (executable.find(L'\\') == std::wstring::npos && executable.find(L'/') == std::wstring::npos) {
      std::wstring search(32768, L'\0');
      const DWORD size = GetEnvironmentVariableW(L"PATH", search.data(), static_cast<DWORD>(search.size()));
      if (!size || size >= search.size()) return 2;
      search.resize(size);
      wchar_t path[32768]; const DWORD n = SearchPathW(search.c_str(), executable.c_str(), L".exe", 32768, path, nullptr);
      if (!n || n >= 32768) return 2;
      executable = path;
    }
    line = quoted(executable);
    for (int i = 4; i < argc; ++i) line += L' ' + quoted(argv[i]);
  }
  if (line.size() >= 32767) return 2;
  Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job.value || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 2;
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE outReadRaw, outWriteRaw, errReadRaw, errWriteRaw;
  if (!CreatePipe(&outReadRaw, &outWriteRaw, &security, 0)) return 2;
  Handle outRead(outReadRaw), outWrite(outWriteRaw);
  if (!CreatePipe(&errReadRaw, &errWriteRaw, &security, 0)) return 2;
  Handle errRead(errReadRaw), errWrite(errWriteRaw);
  if (!SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0)) return 2;
  Handle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
  if (nullInput.value == INVALID_HANDLE_VALUE) return 2;
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  std::vector<unsigned char> attributes(attributeSize);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &attributeSize)) return 2;
  HANDLE inherited[] = {nullInput.value, outWrite.value, errWrite.value};
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)) { DeleteProcThreadAttributeList(list); return 2; }
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nullInput; startup.StartupInfo.hStdOutput = outWrite; startup.StartupInfo.hStdError = errWrite;
  PROCESS_INFORMATION info{};
  const BOOL created = CreateProcessW(executable.c_str(), line.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, nullptr, argv[2], &startup.StartupInfo, &info);
  DeleteProcThreadAttributeList(list);
  if (!created) { frame("{\"event\":\"error\"}"); return 2; }
  Handle process(info.hProcess), thread(info.hThread);
  if (!AssignProcessToJobObject(job, process)) { TerminateProcess(process, 2); WaitForSingleObject(process, INFINITE); return 2; }
  CloseHandle(outWrite.value); outWrite.value = nullptr; CloseHandle(errWrite.value); errWrite.value = nullptr;
  if (ResumeThread(thread) == static_cast<DWORD>(-1)) { TerminateJobObject(job, 2); return 2; }
  frame("{\"event\":\"started\",\"pid\":" + std::to_string(info.dwProcessId) + '}');
  std::thread output(streamOutput, outRead.value, "stdout"), errors(streamOutput, errRead.value, "stderr");
  bool exited = false, failed = false, stopping = false, treeEmpty = false; DWORD code = 0; std::vector<ULONG_PTR> previous;
  while (true) {
    if (!stopping) {
      DWORD available = 0;
      // Poll the parent pipe in this loop. A separate blocking reader cannot be safely cancelled before it enters ReadFile.
      const BOOL visible = PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr);
      if (!visible || available) {
        const DWORD error = visible ? ERROR_SUCCESS : GetLastError();
        if (!visible && error != ERROR_BROKEN_PIPE) { failed = true; TerminateJobObject(job, 2); break; }
        if (available) {
          char buffer[16]; DWORD size = 0;
          if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, std::min<DWORD>(available, sizeof(buffer)), &size, nullptr)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) { failed = true; TerminateJobObject(job, 2); break; }
          }
        }
        stopping = true;
        if (!TerminateJobObject(job, 0)) { failed = true; break; }
      }
    }
    if (!exited && WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
      GetExitCodeProcess(process, &code); exited = true;
      frame("{\"event\":\"launcherExit\",\"code\":" + std::to_string(code) + '}');
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) { failed = true; TerminateJobObject(job, 2); break; }
    if (accounting.ActiveProcesses == 0) { treeEmpty = true; break; }
    const size_t capacity = std::min<size_t>(accounting.ActiveProcesses + 32, 4096);
    std::vector<unsigned char> members(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
    auto ids = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(members.data());
    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, ids, static_cast<DWORD>(members.size()), nullptr)) {
      std::vector<ULONG_PTR> current(ids->ProcessIdList, ids->ProcessIdList + ids->NumberOfProcessIdsInList);
      if (current != previous) {
        std::string value = "{\"event\":\"members\",\"pids\":[";
        for (size_t i = 0; i < current.size(); ++i) { if (i) value += ','; value += std::to_string(current[i]); }
        frame(value + "]}"); previous = std::move(current);
      }
    } else { frame("{\"event\":\"members\",\"pids\":[]}"); previous.clear(); }
    Sleep(100);
  }
  if (treeEmpty) frame("{\"event\":\"treeEmpty\"}");
  output.join(); errors.join();
  return failed ? 2 : stopping ? 0 : static_cast<int>(code);
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 2;
  const std::wstring operation = argv[1];
  if (operation == L"scan") return scan();
  if (operation == L"pick-folder") return pickFolder();
  if (operation == L"manage") return manage(argc, argv);
  return 2;
}
