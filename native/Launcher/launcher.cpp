#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace {

constexpr DWORD kBufferChars = 32768;

struct LauncherState {
  wchar_t root[kBufferChars];
  wchar_t node[kBufferChars];
  wchar_t entry[kBufferChars];
  wchar_t command[kBufferChars];

  STARTUPINFOW startup_info;
  PROCESS_INFORMATION process_info;
};

static LauncherState g_state;

void show_error(const wchar_t *message) {
  MessageBoxW(nullptr, message, L"DDC Monitor Controller",
              MB_OK | MB_ICONERROR);
}

bool append_text(wchar_t *destination, DWORD capacity, const wchar_t *source) {
  DWORD destination_length = 0;

  while (destination_length < capacity &&
         destination[destination_length] != L'\0') {
    ++destination_length;
  }

  if (destination_length >= capacity) {
    return false;
  }

  DWORD source_index = 0;

  while (source[source_index] != L'\0') {
    if (destination_length + 1 >= capacity) {
      return false;
    }

    destination[destination_length++] = source[source_index++];
  }

  destination[destination_length] = L'\0';
  return true;
}

bool copy_text(wchar_t *destination, DWORD capacity, const wchar_t *source) {
  if (capacity == 0) {
    return false;
  }

  DWORD index = 0;

  while (source[index] != L'\0') {
    if (index + 1 >= capacity) {
      destination[0] = L'\0';
      return false;
    }

    destination[index] = source[index];
    ++index;
  }

  destination[index] = L'\0';
  return true;
}

bool append_path_component(wchar_t *path, DWORD capacity,
                           const wchar_t *component) {
  DWORD length = 0;

  while (length < capacity && path[length] != L'\0') {
    ++length;
  }

  if (length >= capacity) {
    return false;
  }

  if (length != 0 && path[length - 1] != L'\\' && path[length - 1] != L'/') {
    if (length + 1 >= capacity) {
      return false;
    }

    path[length++] = L'\\';
    path[length] = L'\0';
  }

  return append_text(path, capacity, component);
}

bool join_path(wchar_t *destination, DWORD capacity, const wchar_t *directory,
               const wchar_t *component) {
  return copy_text(destination, capacity, directory) &&
         append_path_component(destination, capacity, component);
}

bool file_exists(const wchar_t *path) {
  const DWORD attributes = GetFileAttributesW(path);

  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool get_launcher_directory(wchar_t *directory, DWORD capacity) {
  const DWORD length = GetModuleFileNameW(nullptr, directory, capacity);

  if (length == 0 || length >= capacity) {
    return false;
  }

  DWORD position = length;

  while (position > 0) {
    const wchar_t ch = directory[position - 1];

    if (ch == L'\\' || ch == L'/') {
      if (position == 3 && directory[1] == L':') {
        directory[position] = L'\0';
      } else {
        directory[position - 1] = L'\0';
      }

      return true;
    }

    --position;
  }

  return false;
}

bool find_system_node(wchar_t *node, DWORD node_capacity, wchar_t *scratch,
                      DWORD scratch_capacity) {
  const DWORD path_length =
      GetEnvironmentVariableW(L"PATH", scratch, scratch_capacity);

  if (path_length == 0 || path_length >= scratch_capacity) {
    return false;
  }

  const DWORD result =
      SearchPathW(scratch, L"node.exe", nullptr, node_capacity, node, nullptr);

  return result != 0 && result < node_capacity;
}

bool build_command_line(wchar_t *command, DWORD capacity, const wchar_t *node,
                        const wchar_t *entry) {
  command[0] = L'\0';

  return append_text(command, capacity, L"\"") &&
         append_text(command, capacity, node) &&
         append_text(command, capacity, L"\" \"") &&
         append_text(command, capacity, entry) &&
         append_text(command, capacity, L"\"");
}

int run_launcher() {
  if (!get_launcher_directory(g_state.root, kBufferChars)) {
    show_error(L"无法确定启动器所在目录");
    return 1;
  }

  const wchar_t *working_directory = nullptr;

  // 优先使用同目录便携 Node：
  // node.exe + app\index.mjs
  if (join_path(g_state.node, kBufferChars, g_state.root, L"node.exe") &&
      file_exists(g_state.node) &&
      join_path(g_state.command, kBufferChars, g_state.root, L"app") &&
      join_path(g_state.entry, kBufferChars, g_state.command, L"index.mjs") &&
      file_exists(g_state.entry)) {
    working_directory = g_state.command;
  }

  // 便携布局不可用时，使用系统 PATH 中的 Node：
  // DDCMonitorController.exe + index.mjs
  if (working_directory == nullptr) {
    if (!find_system_node(g_state.node, kBufferChars, g_state.command,
                          kBufferChars) ||
        !join_path(g_state.entry, kBufferChars, g_state.root, L"index.mjs") ||
        !file_exists(g_state.entry)) {
      show_error(L"找不到 Node.js 或 index.mjs\n"
                 L"请安装 Node.js，或使用完整的便携包");

      return 2;
    }

    working_directory = g_state.root;
  }

  if (!build_command_line(g_state.command, kBufferChars, g_state.node,
                          g_state.entry)) {
    show_error(L"启动命令过长");
    return 3;
  }

  g_state.startup_info.cb = sizeof(g_state.startup_info);

  if (!CreateProcessW(g_state.node, g_state.command, nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW, nullptr, working_directory,
                      &g_state.startup_info, &g_state.process_info)) {
    show_error(L"无法启动 Node.js 后端");
    return 4;
  }

  CloseHandle(g_state.process_info.hThread);
  CloseHandle(g_state.process_info.hProcess);

  return 0;
}

} // namespace

extern "C" __declspec(noreturn) void launcher_entry() {
  ExitProcess(static_cast<UINT>(run_launcher()));
}