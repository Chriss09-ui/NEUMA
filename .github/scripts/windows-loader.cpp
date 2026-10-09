// CI-only debugger for the fixed native canary. It does not change sandbox policy.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <algorithm>
#include <array>
#include <string>
#include <unordered_map>
#include <vector>

struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

struct Attributes {
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};

struct Log {
  unsigned lines = 0;
  size_t bytes = 0;
  void write(const std::string& line) {
    const std::string output = line + "\n";
    if (lines >= 128 || bytes + output.size() > 16 * 1024) return;
    ++lines; bytes += output.size();
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), output.data(), static_cast<DWORD>(output.size()), &written, nullptr);
  }
  DWORD error(DWORD code) {
    if (!code) code = ERROR_GEN_FAILURE;
    write("NEUMA_LOADER_ERROR code=" + std::to_string(code));
    return code;
  }
};

static bool nameCharacter(wchar_t value) {
  return (value >= L'A' && value <= L'Z') || (value >= L'a' && value <= L'z')
    || (value >= L'0' && value <= L'9') || value == L'_' || value == L'.' || value == L'-';
}

static std::string imageNameAndClose(HANDLE raw) {
  Handle file(raw);
  if (!raw || raw == INVALID_HANDLE_VALUE) return "unknown";
  std::array<wchar_t, 4096> path{};
  const DWORD size = GetFinalPathNameByHandleW(raw, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!size || size >= path.size()) return "unknown";
  const std::wstring text(path.data(), size);
  const size_t separator = text.find_last_of(L"\\/");
  const std::wstring name = text.substr(separator == std::wstring::npos ? 0 : separator + 1);
  if (name.empty() || name.size() > 128) return "unknown";
  std::string result;
  for (wchar_t character : name) {
    if (!nameCharacter(character)) return "unknown";
    result.push_back(static_cast<char>(character));
  }
  return result;
}

static bool isNode(std::string name) {
  for (char& character : name) if (character >= 'A' && character <= 'Z') character = static_cast<char>(character + ('a' - 'A'));
  return name == "node.exe";
}

static std::wstring quote(const std::wstring& argument) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : argument) {
    if (character == L'\\') { ++backslashes; continue; }
    result.append(character == L'"' ? backslashes * 2 + 1 : backslashes, L'\\');
    result += character;
    backslashes = 0;
  }
  result.append(backslashes * 2, L'\\');
  return result + L'"';
}

struct Process {
  bool node = false;
  bool initialBreakpoint = false;
};

static DWORD run(int argc, wchar_t** argv, Log& log) {
  if (argc < 2) return log.error(ERROR_INVALID_PARAMETER);
  const ULONGLONG deadline = GetTickCount64() + 20000;
  std::array<wchar_t, 32768> originalDirectory{}, executablePath{};
  const DWORD directorySize = GetCurrentDirectoryW(static_cast<DWORD>(originalDirectory.size()), originalDirectory.data());
  if (!directorySize) return log.error(GetLastError());
  if (directorySize >= originalDirectory.size()) return log.error(ERROR_FILENAME_EXCED_RANGE);
  const std::wstring directory(originalDirectory.data(), directorySize);
  const DWORD executableSize = GetFullPathNameW(argv[1], static_cast<DWORD>(executablePath.size()), executablePath.data(), nullptr);
  if (!executableSize) return log.error(GetLastError());
  if (executableSize >= executablePath.size()) return log.error(ERROR_FILENAME_EXCED_RANGE);
  const std::wstring executable(executablePath.data(), executableSize);
  std::wstring volumeRoot;
  if (directory.size() >= 3 && directory[1] == L':' && directory[2] == L'\\') volumeRoot = directory.substr(0, 3);
  else if (directory.size() >= 7 && directory.compare(0, 4, L"\\\\?\\") == 0 && directory[5] == L':' && directory[6] == L'\\') volumeRoot = directory.substr(0, 7);
  else return log.error(ERROR_BAD_PATHNAME);
  // Do not hold the canary's directory open while the helper removes it.
  if (!SetCurrentDirectoryW(volumeRoot.c_str())) return log.error(GetLastError());

  std::wstring commandLine = quote(executable);
  for (int index = 2; index < argc; ++index) commandLine += L' ' + quote(argv[index]);
  if (commandLine.size() >= 32767) return log.error(ERROR_FILENAME_EXCED_RANGE);
  std::array<Handle, 3> standard;
  const DWORD ids[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (size_t index = 0; index < standard.size(); ++index) {
    const HANDLE source = GetStdHandle(ids[index]);
    if (!source || source == INVALID_HANDLE_VALUE) return log.error(ERROR_INVALID_HANDLE);
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &standard[index].value, 0, TRUE, DUPLICATE_SAME_ACCESS)) return log.error(GetLastError());
  }
  HANDLE inherited[] = {standard[0].value, standard[1].value, standard[2].value};
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  if (!attributeSize || attributeSize > 64 * 1024) return log.error(ERROR_INVALID_PARAMETER);
  Attributes attributes; attributes.storage.resize(attributeSize);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.storage.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &attributeSize)) return log.error(GetLastError());
  attributes.value = list;
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)) return log.error(GetLastError());
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = standard[0].value;
  startup.StartupInfo.hStdOutput = standard[1].value;
  startup.StartupInfo.hStdError = standard[2].value;
  PROCESS_INFORMATION created{};
  if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
    DEBUG_PROCESS | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    nullptr, directory.c_str(), &startup.StartupInfo, &created)) return log.error(GetLastError());
  const DWORD helperPid = created.dwProcessId;
  // These original CreateProcess handles are distinct from the later debug-event handles.
  CloseHandle(created.hThread); CloseHandle(created.hProcess);
  if (!DebugSetProcessKillOnExit(TRUE)) return log.error(GetLastError());

  std::unordered_map<DWORD, Process> processes;
  bool helperExited = false;
  DWORD helperExitCode = ERROR_GEN_FAILURE;
  while (GetTickCount64() < deadline) {
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) break;
    DEBUG_EVENT event{};
    const DWORD wait = static_cast<DWORD>(std::min<ULONGLONG>(100, deadline - now));
    if (!WaitForDebugEventEx(&event, wait)) {
      const DWORD code = GetLastError();
      if (code == ERROR_SEM_TIMEOUT || code == ERROR_TIMEOUT) continue;
      return log.error(code);
    }
    DWORD continuation = DBG_CONTINUE;
    bool exiting = false, nodeExiting = false;
    DWORD exitCode = 0;
    if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      const std::string name = imageNameAndClose(event.u.CreateProcessInfo.hFile);
      if (processes.size() >= 256) return log.error(ERROR_TOO_MANY_OPEN_FILES);
      processes.emplace(event.dwProcessId, Process{isNode(name), false});
      // Windows closes debug-event process/thread handles after their EXIT is continued.
    } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      const std::string name = imageNameAndClose(event.u.LoadDll.hFile);
      const auto process = processes.find(event.dwProcessId);
      if (process != processes.end() && process->second.node) log.write("NEUMA_LOADER_DLL pid=" + std::to_string(event.dwProcessId) + " name=" + name);
    } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      const DWORD code = event.u.Exception.ExceptionRecord.ExceptionCode;
      const DWORD first = event.u.Exception.dwFirstChance ? 1 : 0;
      auto process = processes.find(event.dwProcessId);
      if (process != processes.end() && process->second.node) log.write("NEUMA_LOADER_EXCEPTION pid=" + std::to_string(event.dwProcessId) + " code=" + std::to_string(code) + " first=" + std::to_string(first));
      if (code == EXCEPTION_BREAKPOINT && first && process != processes.end() && !process->second.initialBreakpoint) process->second.initialBreakpoint = true;
      else continuation = DBG_EXCEPTION_NOT_HANDLED;
    } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      exiting = true; exitCode = event.u.ExitProcess.dwExitCode;
      const auto process = processes.find(event.dwProcessId);
      nodeExiting = process != processes.end() && process->second.node;
    }
    // Includes all helper/thread/debug-string events; never leave a debuggee suspended.
    if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) return log.error(GetLastError());
    if (exiting) {
      if (nodeExiting) log.write("NEUMA_LOADER_EXIT pid=" + std::to_string(event.dwProcessId) + " code=" + std::to_string(exitCode));
      processes.erase(event.dwProcessId);
      if (event.dwProcessId == helperPid) { helperExited = true; helperExitCode = exitCode; }
    }
    if (helperExited && processes.empty()) return helperExitCode;
  }
  return log.error(ERROR_TIMEOUT);
}

int wmain(int argc, wchar_t** argv) {
  Log log;
  DWORD result = ERROR_GEN_FAILURE;
  try { result = run(argc, argv, log); }
  catch (...) { result = log.error(ERROR_NOT_ENOUGH_MEMORY); }
  // Preserve the helper's unsigned Windows exit code. Debuggees die if this wrapper is killed.
  ExitProcess(result);
}
