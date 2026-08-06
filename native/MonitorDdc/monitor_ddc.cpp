#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "monitor_ddc.h"

#include <windows.h>
#include <physicalmonitorenumerationapi.h>
#include <lowlevelmonitorconfigurationapi.h>

#include <algorithm>
#include <cwchar>
#include <mutex>
#include <new>
#include <string>
#include <vector>

namespace {

struct MonitorRecord {
    HANDLE handle = nullptr;
    std::string id;
    std::string name;
};

std::mutex g_mutex;
std::vector<MonitorRecord> g_monitors;

std::uint32_t last_error_or(const std::uint32_t fallback) noexcept {
    const DWORD code = GetLastError();
    return code != ERROR_SUCCESS ? code : fallback;
}

void cleanup_locked() noexcept {
    for (const auto& monitor : g_monitors) {
        if (monitor.handle != nullptr) {
            DestroyPhysicalMonitor(monitor.handle);
        }
    }

    g_monitors.clear();
}

BOOL CALLBACK collect_monitor(
    HMONITOR monitor,
    HDC,
    LPRECT,
    LPARAM user_data
) {
    auto* monitors = reinterpret_cast<std::vector<HMONITOR>*>(user_data);
    monitors->push_back(monitor);
    return TRUE;
}

std::string wide_to_utf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }

    const int size = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr
    );

    if (size <= 0) {
        return {};
    }

    std::string result(static_cast<std::size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        result.data(),
        size,
        nullptr,
        nullptr
    );
    return result;
}

std::uint32_t copy_utf8(
    const std::string& value,
    char* buffer,
    const std::uint32_t buffer_size
) noexcept {
    if (buffer == nullptr || buffer_size == 0) {
        return ERROR_INVALID_PARAMETER;
    }

    if (value.size() + 1 > buffer_size) {
        buffer[0] = '\0';
        return ERROR_INSUFFICIENT_BUFFER;
    }

    std::copy(value.begin(), value.end(), buffer);
    buffer[value.size()] = '\0';
    return ERROR_SUCCESS;
}

std::uint32_t validate_index(const std::uint32_t index) noexcept {
    return index < g_monitors.size() ? ERROR_SUCCESS : ERROR_NO_MORE_ITEMS;
}

std::string trim_message(std::string message) {
    while (!message.empty() &&
           (message.back() == '\r' || message.back() == '\n' || message.back() == ' ')) {
        message.pop_back();
    }

    return message;
}

}  // namespace

std::uint32_t __cdecl mc_refresh(std::uint32_t* count) {
    if (count == nullptr) {
        return ERROR_INVALID_PARAMETER;
    }

    std::lock_guard lock(g_mutex);
    cleanup_locked();

    std::vector<HMONITOR> logical_monitors;

    if (!EnumDisplayMonitors(
            nullptr,
            nullptr,
            collect_monitor,
            reinterpret_cast<LPARAM>(&logical_monitors))) {
        return last_error_or(ERROR_GEN_FAILURE);
    }

    for (const HMONITOR logical_monitor : logical_monitors) {
        DWORD physical_count = 0;

        // 虚拟显示器、远程会话显示器等可能不支持物理显示器 API；直接跳过
        if (!GetNumberOfPhysicalMonitorsFromHMONITOR(
                logical_monitor,
                &physical_count) ||
            physical_count == 0) {
            continue;
        }

        std::vector<PHYSICAL_MONITOR> physical_monitors(physical_count);

        if (!GetPhysicalMonitorsFromHMONITOR(
                logical_monitor,
                physical_count,
                physical_monitors.data())) {
            continue;
        }

        MONITORINFOEXW monitor_info{};
        monitor_info.cbSize = sizeof(monitor_info);
        const bool has_monitor_info =
            GetMonitorInfoW(
                logical_monitor,
                reinterpret_cast<MONITORINFO*>(&monitor_info)
            ) != FALSE;
        const std::wstring device_name =
            has_monitor_info ? monitor_info.szDevice : L"DISPLAY";

        for (DWORD index = 0; index < physical_count; ++index) {
            auto& physical = physical_monitors[index];
            const auto description_length = wcsnlen_s(
                physical.szPhysicalMonitorDescription,
                _countof(physical.szPhysicalMonitorDescription)
            );
            const std::wstring description(
                physical.szPhysicalMonitorDescription,
                description_length
            );
            const std::wstring display_name =
                description.empty() ? device_name : description;
            const std::wstring stable_id =
                device_name + L"|" + display_name + L"|" + std::to_wstring(index);

            g_monitors.push_back({
                physical.hPhysicalMonitor,
                wide_to_utf8(stable_id),
                wide_to_utf8(display_name),
            });

            // 句柄所有权已转移到 g_monitors，防止错误清理时重复释放
            physical.hPhysicalMonitor = nullptr;
        }
    }

    *count = static_cast<std::uint32_t>(g_monitors.size());
    return ERROR_SUCCESS;
}

std::uint32_t __cdecl mc_get_monitor_id(
    const std::uint32_t index,
    char* buffer,
    const std::uint32_t buffer_size
) {
    std::lock_guard lock(g_mutex);
    const auto validation = validate_index(index);

    if (validation != ERROR_SUCCESS) {
        return validation;
    }

    return copy_utf8(g_monitors[index].id, buffer, buffer_size);
}

std::uint32_t __cdecl mc_get_monitor_name(
    const std::uint32_t index,
    char* buffer,
    const std::uint32_t buffer_size
) {
    std::lock_guard lock(g_mutex);
    const auto validation = validate_index(index);

    if (validation != ERROR_SUCCESS) {
        return validation;
    }

    return copy_utf8(g_monitors[index].name, buffer, buffer_size);
}

std::uint32_t __cdecl mc_get_vcp_value(
    const std::uint32_t index,
    const std::uint8_t code,
    std::uint32_t* current,
    std::uint32_t* maximum
) {
    if (current == nullptr || maximum == nullptr) {
        return ERROR_INVALID_PARAMETER;
    }

    std::lock_guard lock(g_mutex);
    const auto validation = validate_index(index);

    if (validation != ERROR_SUCCESS) {
        return validation;
    }

    DWORD current_value = 0;
    DWORD maximum_value = 0;

    if (!GetVCPFeatureAndVCPFeatureReply(
            g_monitors[index].handle,
            code,
            nullptr,
            &current_value,
            &maximum_value)) {
        return last_error_or(ERROR_GEN_FAILURE);
    }

    *current = current_value;
    *maximum = maximum_value;
    return ERROR_SUCCESS;
}

std::uint32_t __cdecl mc_set_vcp_value(
    const std::uint32_t index,
    const std::uint8_t code,
    const std::uint32_t value
) {
    std::lock_guard lock(g_mutex);
    const auto validation = validate_index(index);

    if (validation != ERROR_SUCCESS) {
        return validation;
    }

    if (!SetVCPFeature(g_monitors[index].handle, code, value)) {
        return last_error_or(ERROR_GEN_FAILURE);
    }

    return ERROR_SUCCESS;
}

std::uint32_t __cdecl mc_format_error(
    const std::uint32_t code,
    char* buffer,
    const std::uint32_t buffer_size
) {
    if (buffer == nullptr || buffer_size == 0) {
        return ERROR_INVALID_PARAMETER;
    }

    wchar_t* message = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER |
            FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        code,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<LPWSTR>(&message),
        0,
        nullptr
    );

    if (length == 0 || message == nullptr) {
        return copy_utf8("Unknown Win32 error", buffer, buffer_size);
    }

    const std::string utf8 = trim_message(
        wide_to_utf8(std::wstring(message, length))
    );
    LocalFree(message);
    return copy_utf8(utf8, buffer, buffer_size);
}

void __cdecl mc_shutdown() {
    std::lock_guard lock(g_mutex);
    cleanup_locked();
}
