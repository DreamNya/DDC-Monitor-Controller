#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

namespace {

    constexpr DWORD kBufferChars = 32768;
    constexpr DWORD kUtf8BufferBytes = kBufferChars * 3;
    constexpr DWORD kResultPipeChars = 256;
    constexpr DWORD kResultBufferBytes = 2 * 1024 * 1024;
    constexpr DWORD kLauncherResultMagic = 0x31434d44;
    constexpr DWORD kLauncherResultStreamStdout = 1;
    constexpr DWORD kLauncherResultStreamStderr = 2;
    constexpr wchar_t kLauncherResultPipeEnv[] = L"DDCMC_LAUNCHER_RESULT_PIPE";

    struct LauncherResultHeader {
        DWORD magic;
        DWORD exit_code;
        DWORD stream;
        DWORD payload_length;
    };

    static_assert(sizeof(LauncherResultHeader) == 16,
        "LauncherResultHeader must remain 16 bytes");

    struct LauncherState {
        wchar_t root[kBufferChars];
        wchar_t node[kBufferChars];
        wchar_t entry[kBufferChars];
        wchar_t working_directory[kBufferChars];
        wchar_t command[kBufferChars];
        wchar_t result_pipe_name[kResultPipeChars];
        char utf8_buffer[kUtf8BufferBytes];
        char result_buffer[kResultBufferBytes];
        wchar_t result_wide_buffer[kResultBufferBytes];

        STARTUPINFOW startup_info;
        PROCESS_INFORMATION process_info;
        HANDLE child_stdin;
        HANDLE child_stdout;
        HANDLE child_stderr;
        HANDLE result_pipe;
        HANDLE result_event;
        OVERLAPPED result_connect_overlapped;
    };

    static LauncherState g_state;

    bool is_valid_handle(HANDLE handle) {
        return handle != nullptr && handle != INVALID_HANDLE_VALUE;
    }

    void show_error(const wchar_t* message) {
        MessageBoxW(nullptr, message, L"DDC Monitor Controller",
            MB_OK | MB_ICONERROR);
    }

    bool write_utf8_to_standard_handle(DWORD standard_handle, const char* content,
        DWORD content_length) {
        const HANDLE output_handle = GetStdHandle(standard_handle);

        if (!is_valid_handle(output_handle)) {
            return false;
        }

        if (content_length == 0) {
            return true;
        }

        DWORD console_mode = 0;
        if (GetConsoleMode(output_handle, &console_mode)) {
            const int wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                content, static_cast<int>(content_length),
                g_state.result_wide_buffer, static_cast<int>(kResultBufferBytes));

            if (wide_length <= 0) {
                return false;
            }

            DWORD written = 0;
            return WriteConsoleW(output_handle, g_state.result_wide_buffer,
                static_cast<DWORD>(wide_length), &written, nullptr) != FALSE;
        }

        DWORD offset = 0;
        while (offset < content_length) {
            DWORD written = 0;
            if (!WriteFile(output_handle, content + offset, content_length - offset,
                &written, nullptr) || written == 0) {
                return false;
            }
            offset += written;
        }

        return true;
    }

    bool write_stderr(const wchar_t* message) {
        const HANDLE stderr_handle = GetStdHandle(STD_ERROR_HANDLE);

        if (!is_valid_handle(stderr_handle)) {
            return false;
        }

        DWORD console_mode = 0;
        DWORD written = 0;

        if (GetConsoleMode(stderr_handle, &console_mode)) {
            DWORD length = 0;
            while (message[length] != L'\0') {
                ++length;
            }

            static constexpr wchar_t newline[] = L"\r\n";
            return WriteConsoleW(stderr_handle, message, length, &written, nullptr) &&
                WriteConsoleW(stderr_handle, newline,
                    static_cast<DWORD>((sizeof(newline) / sizeof(newline[0])) - 1),
                    &written, nullptr);
        }

        const int utf8_length = WideCharToMultiByte(CP_UTF8, 0, message, -1,
            g_state.utf8_buffer, static_cast<int>(kUtf8BufferBytes), nullptr,
            nullptr);

        if (utf8_length <= 0) {
            return false;
        }

        const DWORD content_length = static_cast<DWORD>(utf8_length - 1);

        if (content_length != 0 &&
            !WriteFile(stderr_handle, g_state.utf8_buffer, content_length,
                &written, nullptr)) {
            return false;
        }

        static constexpr char newline[] = "\r\n";
        return WriteFile(stderr_handle, newline,
            static_cast<DWORD>(sizeof(newline) - 1), &written, nullptr) != FALSE;
    }

    void report_error(const wchar_t* message, bool silent_mode) {
        if (silent_mode && write_stderr(message)) {
            return;
        }

        show_error(message);
    }

    HANDLE create_inheritable_nul(DWORD access) {
        SECURITY_ATTRIBUTES security_attributes{};
        security_attributes.nLength = sizeof(security_attributes);
        security_attributes.bInheritHandle = TRUE;

        return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE,
            &security_attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    }

    HANDLE duplicate_standard_handle(DWORD standard_handle, DWORD fallback_access) {
        const HANDLE source = GetStdHandle(standard_handle);

        if (is_valid_handle(source)) {
            HANDLE duplicate = nullptr;
            if (DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(),
                &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
                return duplicate;
            }
        }

        return create_inheritable_nul(fallback_access);
    }

    void close_child_standard_handles() {
        if (is_valid_handle(g_state.child_stdin)) {
            CloseHandle(g_state.child_stdin);
            g_state.child_stdin = nullptr;
        }

        if (is_valid_handle(g_state.child_stdout)) {
            CloseHandle(g_state.child_stdout);
            g_state.child_stdout = nullptr;
        }

        if (is_valid_handle(g_state.child_stderr)) {
            CloseHandle(g_state.child_stderr);
            g_state.child_stderr = nullptr;
        }
    }

    bool prepare_silent_startup() {
        g_state.child_stdin = duplicate_standard_handle(
            STD_INPUT_HANDLE, GENERIC_READ);
        g_state.child_stdout = duplicate_standard_handle(
            STD_OUTPUT_HANDLE, GENERIC_WRITE);
        g_state.child_stderr = duplicate_standard_handle(
            STD_ERROR_HANDLE, GENERIC_WRITE);

        if (!is_valid_handle(g_state.child_stdin) ||
            !is_valid_handle(g_state.child_stdout) ||
            !is_valid_handle(g_state.child_stderr)) {
            close_child_standard_handles();
            return false;
        }

        g_state.startup_info.dwFlags |= STARTF_USESTDHANDLES;
        g_state.startup_info.hStdInput = g_state.child_stdin;
        g_state.startup_info.hStdOutput = g_state.child_stdout;
        g_state.startup_info.hStdError = g_state.child_stderr;
        return true;
    }

    bool append_text(wchar_t* destination, DWORD capacity, const wchar_t* source) {
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

    bool copy_text(wchar_t* destination, DWORD capacity, const wchar_t* source) {
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

    bool append_path_component(wchar_t* path, DWORD capacity,
        const wchar_t* component) {
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

    bool join_path(wchar_t* destination, DWORD capacity, const wchar_t* directory,
        const wchar_t* component) {
        return copy_text(destination, capacity, directory) &&
            append_path_component(destination, capacity, component);
    }

    bool file_exists(const wchar_t* path) {
        const DWORD attributes = GetFileAttributesW(path);

        return attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
    }

    bool get_launcher_directory(wchar_t* directory, DWORD capacity) {
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
                }
                else {
                    directory[position - 1] = L'\0';
                }

                return true;
            }

            --position;
        }

        return false;
    }

    bool find_system_node(wchar_t* node, DWORD node_capacity, wchar_t* scratch,
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

    const wchar_t* find_argument_tail(const wchar_t* command_line) {
        const wchar_t* cursor = command_line;

        while (*cursor == L' ' || *cursor == L'\t') {
            ++cursor;
        }

        if (*cursor == L'"') {
            ++cursor;

            while (*cursor != L'\0' && *cursor != L'"') {
                ++cursor;
            }

            if (*cursor == L'"') {
                ++cursor;
            }
        }
        else {
            while (*cursor != L'\0' && *cursor != L' ' && *cursor != L'\t') {
                ++cursor;
            }
        }

        while (*cursor == L' ' || *cursor == L'\t') {
            ++cursor;
        }

        return cursor;
    }

    bool equals_text(const wchar_t* left, const wchar_t* right) {
        DWORD index = 0;

        while (left[index] != L'\0' && right[index] != L'\0') {
            if (left[index] != right[index]) {
                return false;
            }
            ++index;
        }

        return left[index] == right[index];
    }

    void detach_unowned_console_early() {
        DWORD process_ids[2]{};
        const DWORD process_count = GetConsoleProcessList(
            process_ids, static_cast<DWORD>(sizeof(process_ids) / sizeof(process_ids[0])));

        // Console subsystem 是 PowerShell 等调用方可靠等待 Launcher、获取 stdout 和
        // exit code 的前提。Explorer 双击时系统会先创建一个仅属于 Launcher 的控制台；
        // 一进入入口就立即隐藏并释放，把普通 GUI 启动的控制台闪现压到最短。
        // 如果控制台还有父进程则绝不隐藏，避免破坏 PowerShell/cmd/Windows Terminal。
        if (process_count == 1 && process_ids[0] == GetCurrentProcessId()) {
            const HWND console_window = GetConsoleWindow();
            if (console_window != nullptr) {
                ShowWindow(console_window, SW_HIDE);
            }
            FreeConsole();
        }
    }

    bool detect_launch_mode(bool* silent_mode, bool* cli_mode) {
        int argc = 0;
        LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);

        if (argv == nullptr) {
            return false;
        }

        *silent_mode = false;
        *cli_mode = argc > 1;

        for (int index = 1; index < argc; ++index) {
            if (equals_text(argv[index], L"--silent")) {
                *silent_mode = true;
                break;
            }
        }

        LocalFree(argv);
        return true;
    }

    bool build_command_line(wchar_t* command, DWORD capacity, const wchar_t* node,
        const wchar_t* entry, const wchar_t* argument_tail) {
        command[0] = L'\0';

        if (!append_text(command, capacity, L"\"") ||
            !append_text(command, capacity, node) ||
            !append_text(command, capacity, L"\" \"") ||
            !append_text(command, capacity, entry) ||
            !append_text(command, capacity, L"\"")) {
            return false;
        }

        if (argument_tail[0] == L'\0') {
            return true;
        }

        return append_text(command, capacity, L" ") &&
            append_text(command, capacity, argument_tail);
    }

    void close_launcher_result_pipe() {
        if (is_valid_handle(g_state.result_pipe)) {
            CancelIoEx(g_state.result_pipe, nullptr);
            DisconnectNamedPipe(g_state.result_pipe);
            CloseHandle(g_state.result_pipe);
            g_state.result_pipe = nullptr;
        }

        if (is_valid_handle(g_state.result_event)) {
            CloseHandle(g_state.result_event);
            g_state.result_event = nullptr;
        }
    }

    bool prepare_launcher_result_pipe() {
        const int name_length = wsprintfW(g_state.result_pipe_name,
            L"\\\\.\\pipe\\DreamNya.DDCMonitorController.Launcher.%lu.%lu",
            GetCurrentProcessId(), GetTickCount());

        if (name_length <= 0 || static_cast<DWORD>(name_length) >= kResultPipeChars) {
            return false;
        }

        g_state.result_pipe = CreateNamedPipeW(g_state.result_pipe_name,
            PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, 0, 4096, 0, nullptr);

        if (!is_valid_handle(g_state.result_pipe)) {
            g_state.result_pipe = nullptr;
            return false;
        }

        g_state.result_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!is_valid_handle(g_state.result_event)) {
            close_launcher_result_pipe();
            return false;
        }

        g_state.result_connect_overlapped = {};
        g_state.result_connect_overlapped.hEvent = g_state.result_event;

        if (ConnectNamedPipe(g_state.result_pipe, &g_state.result_connect_overlapped)) {
            SetEvent(g_state.result_event);
            return true;
        }

        const DWORD error = GetLastError();
        if (error == ERROR_IO_PENDING) {
            return true;
        }
        if (error == ERROR_PIPE_CONNECTED) {
            SetEvent(g_state.result_event);
            return true;
        }

        close_launcher_result_pipe();
        return false;
    }

    bool read_exact_from_result_pipe(void* destination, DWORD length) {
        auto* output = static_cast<unsigned char*>(destination);
        DWORD offset = 0;

        while (offset < length) {
            ResetEvent(g_state.result_event);

            OVERLAPPED overlapped{};
            overlapped.hEvent = g_state.result_event;
            DWORD bytes_read = 0;

            if (!ReadFile(g_state.result_pipe, output + offset, length - offset,
                &bytes_read, &overlapped)) {
                if (GetLastError() != ERROR_IO_PENDING) {
                    return false;
                }

                if (WaitForSingleObject(g_state.result_event, INFINITE) != WAIT_OBJECT_0 ||
                    !GetOverlappedResult(g_state.result_pipe, &overlapped,
                        &bytes_read, FALSE)) {
                    return false;
                }
            }

            if (bytes_read == 0) {
                return false;
            }

            offset += bytes_read;
        }

        return true;
    }

    int wait_for_launcher_result(HANDLE process_handle) {
        HANDLE wait_handles[2] = { g_state.result_event, process_handle };
        const DWORD wait_result = WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);

        if (wait_result == WAIT_OBJECT_0 + 1) {
            DWORD exit_code = 0;
            if (!GetExitCodeProcess(process_handle, &exit_code)) {
                exit_code = 3;
            }
            report_error(L"Node.js 后端在返回 CLI 结果前退出", true);
            return static_cast<int>(exit_code);
        }

        if (wait_result != WAIT_OBJECT_0) {
            report_error(L"等待 CLI API 结果失败", true);
            return 3;
        }

        DWORD transferred = 0;
        if (!GetOverlappedResult(g_state.result_pipe,
            &g_state.result_connect_overlapped, &transferred, FALSE) &&
            GetLastError() != ERROR_PIPE_CONNECTED) {
            report_error(L"连接 CLI API 结果通道失败", true);
            return 3;
        }

        LauncherResultHeader header{};
        if (!read_exact_from_result_pipe(&header, sizeof(header)) ||
            header.magic != kLauncherResultMagic ||
            (header.stream != kLauncherResultStreamStdout &&
                header.stream != kLauncherResultStreamStderr) ||
            header.payload_length > kResultBufferBytes) {
            report_error(L"CLI API 返回了无效结果", true);
            return 3;
        }

        if (!read_exact_from_result_pipe(g_state.result_buffer, header.payload_length)) {
            report_error(L"读取 CLI API 结果失败", true);
            return 3;
        }

        const DWORD standard_handle = header.stream == kLauncherResultStreamStderr
            ? STD_ERROR_HANDLE
            : STD_OUTPUT_HANDLE;

        if (!write_utf8_to_standard_handle(standard_handle, g_state.result_buffer,
            header.payload_length)) {
            report_error(L"输出 CLI API 结果失败", true);
            return 3;
        }

        return static_cast<int>(header.exit_code);
    }

    int wait_for_child_process(HANDLE process_handle, bool cli_mode) {
        if (WaitForSingleObject(process_handle, INFINITE) != WAIT_OBJECT_0) {
            report_error(L"等待 Node.js 后端退出失败", cli_mode);
            return 5;
        }

        DWORD exit_code = 0;
        if (!GetExitCodeProcess(process_handle, &exit_code)) {
            report_error(L"无法获取 Node.js 后端退出码", cli_mode);
            return 6;
        }

        return static_cast<int>(exit_code);
    }

    int run_launcher() {
        // 必须尽可能早执行：如果由 Explorer 双击而得到独占控制台，立即隐藏/释放。
        detach_unowned_console_early();

        bool silent_mode = false;
        bool cli_mode = false;

        if (!detect_launch_mode(&silent_mode, &cli_mode)) {
            show_error(L"无法解析启动参数");
            return 1;
        }

        if (!get_launcher_directory(g_state.root, kBufferChars)) {
            report_error(L"无法确定启动器所在目录", cli_mode);
            return 1;
        }

        const wchar_t* working_directory = nullptr;

        // 优先使用同目录便携 Node：
        // node.exe + app\index.mjs
        if (join_path(g_state.node, kBufferChars, g_state.root, L"node.exe") &&
            file_exists(g_state.node) &&
            join_path(g_state.working_directory, kBufferChars, g_state.root, L"app") &&
            join_path(g_state.entry, kBufferChars, g_state.working_directory,
                L"index.mjs") &&
            file_exists(g_state.entry)) {
            working_directory = g_state.working_directory;
        }

        // 便携布局不可用时，使用系统 PATH 中的 Node：
        // DDCMonitorController.exe + index.mjs
        if (working_directory == nullptr) {
            if (!find_system_node(g_state.node, kBufferChars, g_state.command,
                kBufferChars) ||
                !join_path(g_state.entry, kBufferChars, g_state.root, L"index.mjs") ||
                !file_exists(g_state.entry)) {
                report_error(L"找不到 Node.js 或 index.mjs\n"
                    L"请安装 Node.js，或使用完整的便携包", cli_mode);

                return 2;
            }

            working_directory = g_state.root;
        }

        const wchar_t* argument_tail = find_argument_tail(GetCommandLineW());
        if (!build_command_line(g_state.command, kBufferChars, g_state.node,
            g_state.entry, argument_tail)) {
            report_error(L"启动命令过长", cli_mode);
            return 3;
        }

        g_state.startup_info.cb = sizeof(g_state.startup_info);

        if (silent_mode && !prepare_silent_startup()) {
            report_error(L"无法准备 CLI 标准输入输出", true);
            return 4;
        }

        const bool launcher_result_mode = cli_mode && !silent_mode;
        if (launcher_result_mode) {
            if (!prepare_launcher_result_pipe() ||
                !SetEnvironmentVariableW(kLauncherResultPipeEnv,
                    g_state.result_pipe_name)) {
                close_launcher_result_pipe();
                report_error(L"无法准备 CLI API 结果通道", true);
                return 4;
            }
        }

        const DWORD creation_flags = silent_mode
            ? NORMAL_PRIORITY_CLASS
            : CREATE_NO_WINDOW | NORMAL_PRIORITY_CLASS;

        const BOOL process_created = CreateProcessW(g_state.node, g_state.command,
            nullptr, nullptr, silent_mode ? TRUE : FALSE, creation_flags, nullptr,
            working_directory, &g_state.startup_info, &g_state.process_info);

        if (launcher_result_mode) {
            SetEnvironmentVariableW(kLauncherResultPipeEnv, nullptr);
        }

        if (silent_mode) {
            close_child_standard_handles();
        }

        if (!process_created) {
            close_launcher_result_pipe();
            report_error(L"无法启动 Node.js 后端", cli_mode);
            return 4;
        }

        CloseHandle(g_state.process_info.hThread);

        if (launcher_result_mode) {
            const int exit_code = wait_for_launcher_result(g_state.process_info.hProcess);
            close_launcher_result_pipe();
            CloseHandle(g_state.process_info.hProcess);
            return exit_code;
        }

        if (!silent_mode) {
            CloseHandle(g_state.process_info.hProcess);
            return 0;
        }

        const int exit_code = wait_for_child_process(
            g_state.process_info.hProcess, cli_mode);
        CloseHandle(g_state.process_info.hProcess);
        return exit_code;
    }

} // namespace

extern "C" __declspec(noreturn) void launcher_entry() {
    ExitProcess(static_cast<UINT>(run_launcher()));
}
