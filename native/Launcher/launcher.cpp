#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <filesystem>
#include <string>
#include <vector>

namespace {

std::wstring quote(const std::filesystem::path& path) {
    return L"\"" + path.wstring() + L"\"";
}

void show_error(const wchar_t* message) {
    MessageBoxW(nullptr, message, L"DDC Monitor Controller", MB_OK | MB_ICONERROR);
}

std::filesystem::path find_on_path(const wchar_t* executable) {
    std::vector<wchar_t> buffer(32768);
    const DWORD length = SearchPathW(
        nullptr,
        executable,
        nullptr,
        static_cast<DWORD>(buffer.size()),
        buffer.data(),
        nullptr
    );

    if (length == 0 || length >= buffer.size()) {
        return {};
    }

    return std::filesystem::path(buffer.data());
}

struct LaunchTarget {
    std::filesystem::path node;
    std::filesystem::path entry;
    std::filesystem::path working_directory;
};

LaunchTarget resolve_target(const std::filesystem::path& root) {
    // 便携包布局：
    // DDCMonitorController.exe
    // node.exe
    // app/index.mjs
    const auto portable_node = root / L"node.exe";
    const auto portable_app = root / L"app";
    const auto portable_entry = portable_app / L"index.mjs";

    if (
        std::filesystem::exists(portable_node) &&
        std::filesystem::exists(portable_entry)
    ) {
        return { portable_node, portable_entry, portable_app };
    }

    const auto system_node = find_on_path(L"node.exe");

    if (system_node.empty()) {
        return {};
    }

    // 改为同级目录/相对路径布局：DDCMonitorController.exe + index.mjs
    // 工作目录为 DDCMonitorController.exe 所在目录 (./)
    const auto local_entry = root / L"index.mjs";

    if (std::filesystem::exists(local_entry)) {
        return { system_node, local_entry, root };
    }

    return {};
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    std::vector<wchar_t> module_path(32768);
    const DWORD length = GetModuleFileNameW(
        nullptr,
        module_path.data(),
        static_cast<DWORD>(module_path.size())
    );

    if (length == 0 || length >= module_path.size()) {
        show_error(L"无法确定启动器所在目录");
        return 1;
    }

    const std::filesystem::path root =
        std::filesystem::path(module_path.data()).parent_path();
    const LaunchTarget target = resolve_target(root);

    if (
        target.node.empty() ||
        target.entry.empty() ||
        target.working_directory.empty()
    ) {
        show_error(
            L"找不到 Node.js 或 index.mjs\n"
            L"请先执行 npm run build，或使用完整的便携包"
        );
        return 2;
    }

    std::wstring command = quote(target.node) + L" " + quote(target.entry);
    std::vector<wchar_t> command_buffer(command.begin(), command.end());
    command_buffer.push_back(L'\0');

    STARTUPINFOW startup_info{};
    startup_info.cb = sizeof(startup_info);
    PROCESS_INFORMATION process_info{};

    if (!CreateProcessW(
            target.node.c_str(),
            command_buffer.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW,
            nullptr,
            target.working_directory.c_str(),
            &startup_info,
            &process_info)) {
        show_error(L"无法启动 Node.js 后端");
        return 3;
    }

    CloseHandle(process_info.hThread);
    CloseHandle(process_info.hProcess);
    return 0;
}