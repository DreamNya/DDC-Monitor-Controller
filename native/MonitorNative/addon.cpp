#define WIN32_LEAN_AND_MEAN
#include <napi.h>

#include <windows.h>
#include <lowlevelmonitorconfigurationapi.h>
#include <physicalmonitorenumerationapi.h>

#include <cmath>
#include <cstdint>
#include <cwchar>
#include <limits>
#include <string>
#include <vector>

namespace {

    struct PhysicalMonitorBatch final {
        explicit PhysicalMonitorBatch(const DWORD count) : monitors(count) {}

        ~PhysicalMonitorBatch() noexcept {
            for (const auto& monitor : monitors) {
                if (monitor.hPhysicalMonitor != nullptr) {
                    DestroyPhysicalMonitor(monitor.hPhysicalMonitor);
                }
            }
        }

        PhysicalMonitorBatch(const PhysicalMonitorBatch&) = delete;
        PhysicalMonitorBatch& operator=(const PhysicalMonitorBatch&) = delete;

        std::vector<PHYSICAL_MONITOR> monitors;
    };

    SRWLOCK g_mutex = SRWLOCK_INIT;

    class MonitorLock final {
    public:
        MonitorLock() noexcept { AcquireSRWLockExclusive(&g_mutex); }
        ~MonitorLock() noexcept { ReleaseSRWLockExclusive(&g_mutex); }
        MonitorLock(const MonitorLock&) = delete;
        MonitorLock& operator=(const MonitorLock&) = delete;
    };
    std::vector<HANDLE> g_monitors;

    DWORD last_error_or(const DWORD fallback) noexcept {
        const DWORD code = GetLastError();
        return code != ERROR_SUCCESS ? code : fallback;
    }

    void cleanup_locked() noexcept {
        for (const HANDLE monitor : g_monitors) {
            if (monitor != nullptr) {
                DestroyPhysicalMonitor(monitor);
            }
        }

        g_monitors.clear();
    }

    void cleanup_environment(void*) noexcept {
        const MonitorLock lock;
        cleanup_locked();
    }

    BOOL CALLBACK collect_monitor(HMONITOR monitor, HDC, LPRECT, LPARAM user_data) {
        auto* monitors = reinterpret_cast<std::vector<HMONITOR> *>(user_data);
        monitors->push_back(monitor);
        return TRUE;
    }

    std::string wide_to_utf8(const std::wstring& value) {
        if (value.empty()) {
            return {};
        }

        const int size = WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);

        if (size <= 0) {
            return {};
        }

        std::string result(static_cast<std::size_t>(size), '\0');
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), size,
            nullptr, nullptr);
        return result;
    }

    std::string trim_message(std::string message) {
        while (!message.empty() &&
            (message.back() == '\r' || message.back() == '\n' ||
                message.back() == ' ')) {
            message.pop_back();
        }

        return message;
    }

    std::string format_win32_error(const DWORD code) {
        wchar_t* message = nullptr;
        const DWORD length = FormatMessageW(
            FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_IGNORE_INSERTS,
            nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
            reinterpret_cast<LPWSTR>(&message), 0, nullptr);

        if (length == 0 || message == nullptr) {
            return "Unknown Win32 error";
        }

        const std::string result =
            trim_message(wide_to_utf8(std::wstring(message, length)));
        LocalFree(message);
        return result;
    }

    std::string format_vcp_code(const std::uint32_t code) {
        // Callers validate that the VCP code is one byte before formatting it.
        constexpr char hex[] = "0123456789ABCDEF";
        const char result[] = { '0', 'x', hex[(code >> 4) & 0x0f], hex[code & 0x0f] };
        return std::string(result, sizeof(result));
    }

    void throw_win32_error(const Napi::Env& env, const std::string& operation,
        const DWORD code) {
        Napi::Error::New(env, operation + "失败（错误码 " + std::to_string(code) +
            "）：" + format_win32_error(code))
            .ThrowAsJavaScriptException();
    }

    bool read_uint32_argument(const Napi::CallbackInfo& info,
        const std::size_t index, const char* name,
        std::uint32_t& value) {
        const Napi::Env env = info.Env();

        if (info.Length() <= index || !info[index].IsNumber()) {
            Napi::TypeError::New(env, std::string(name) + " 必须是数字")
                .ThrowAsJavaScriptException();
            return false;
        }

        const double number = info[index].As<Napi::Number>().DoubleValue();

        if (!std::isfinite(number) || number < 0 ||
            number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()) ||
            number != static_cast<double>(static_cast<std::uint32_t>(number))) {
            Napi::RangeError::New(env, std::string(name) + " 必须是 uint32 整数")
                .ThrowAsJavaScriptException();
            return false;
        }

        value = static_cast<std::uint32_t>(number);
        return true;
    }

    HANDLE* resolve_monitor(const Napi::Env& env,
        const std::uint32_t index) {
        if (index >= g_monitors.size()) {
            Napi::RangeError::New(env, "显示器索引已失效：" + std::to_string(index) +
                "；请先刷新显示器列表")
                .ThrowAsJavaScriptException();
            return nullptr;
        }

        return &g_monitors[index];
    }

    Napi::Value refresh_monitors(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        const MonitorLock lock;
        cleanup_locked();

        const Napi::Array result = Napi::Array::New(env);
        std::vector<HMONITOR> logical_monitors;

        if (!EnumDisplayMonitors(nullptr, nullptr, collect_monitor,
            reinterpret_cast<LPARAM>(&logical_monitors))) {
            throw_win32_error(env, "刷新物理显示器列表",
                last_error_or(ERROR_GEN_FAILURE));
            return env.Undefined();
        }

        for (const HMONITOR logical_monitor : logical_monitors) {
            DWORD physical_count = 0;

            // 虚拟显示器、远程会话显示器等可能不支持物理显示器 API；直接跳过
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(logical_monitor,
                &physical_count) ||
                physical_count == 0) {
                continue;
            }

            PhysicalMonitorBatch physical_batch(physical_count);
            auto& physical_monitors = physical_batch.monitors;

            if (!GetPhysicalMonitorsFromHMONITOR(logical_monitor, physical_count,
                physical_monitors.data())) {
                continue;
            }

            MONITORINFOEXW monitor_info{};
            monitor_info.cbSize = sizeof(monitor_info);
            const bool has_monitor_info =
                GetMonitorInfoW(logical_monitor, reinterpret_cast<MONITORINFO*>(
                    &monitor_info)) != FALSE;
            const std::wstring device_name =
                has_monitor_info ? monitor_info.szDevice : L"DISPLAY";

            for (DWORD physical_index = 0; physical_index < physical_count;
                ++physical_index) {
                auto& physical = physical_monitors[physical_index];
                const auto description_length =
                    wcsnlen_s(physical.szPhysicalMonitorDescription,
                        _countof(physical.szPhysicalMonitorDescription));
                const std::wstring description(physical.szPhysicalMonitorDescription,
                    description_length);
                const std::wstring display_name =
                    description.empty() ? device_name : description;
                const std::wstring stable_id = device_name + L"|" + display_name + L"|" +
                    std::to_wstring(physical_index);

                const std::size_t index = g_monitors.size();
                Napi::Object item = Napi::Object::New(env);
                item.Set("id", wide_to_utf8(stable_id));
                item.Set("name", wide_to_utf8(display_name));
                item.Set("index", Napi::Number::New(env, static_cast<double>(index)));
                result.Set(static_cast<std::uint32_t>(index), item);

                // Only handles are needed after refresh. Until push_back
                // succeeds, physical_batch retains ownership, including on
                // exceptions from string conversion or Node-API calls above.
                g_monitors.push_back(physical.hPhysicalMonitor);
                physical.hPhysicalMonitor = nullptr;
            }
        }

        return result;
    }

    Napi::Value get_vcp_value(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        std::uint32_t index = 0;
        std::uint32_t code = 0;

        if (!read_uint32_argument(info, 0, "index", index) ||
            !read_uint32_argument(info, 1, "code", code)) {
            return env.Undefined();
        }

        if (code > 0xff) {
            Napi::RangeError::New(env, "code 必须位于 0x00 到 0xFF")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        const MonitorLock lock;
        HANDLE* monitor = resolve_monitor(env, index);

        if (monitor == nullptr) {
            return env.Undefined();
        }

        DWORD current = 0;
        DWORD maximum = 0;

        if (!GetVCPFeatureAndVCPFeatureReply(*monitor, static_cast<BYTE>(code),
            nullptr, &current, &maximum)) {
            throw_win32_error(env, "读取 VCP " + format_vcp_code(code),
                last_error_or(ERROR_GEN_FAILURE));
            return env.Undefined();
        }

        Napi::Object result = Napi::Object::New(env);
        result.Set("current", Napi::Number::New(env, current));
        result.Set("maximum", Napi::Number::New(env, maximum));
        return result;
    }

    Napi::Value get_capabilities(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        std::uint32_t index = 0;

        if (!read_uint32_argument(info, 0, "index", index)) {
            return env.Undefined();
        }

        const MonitorLock lock;
        HANDLE* monitor = resolve_monitor(env, index);

        if (monitor == nullptr) {
            return env.Undefined();
        }

        DWORD length = 0;

        if (!GetCapabilitiesStringLength(*monitor, &length)) {
            throw_win32_error(env, "读取显示器 Capabilities 长度",
                last_error_or(ERROR_GEN_FAILURE));
            return env.Undefined();
        }

        if (length == 0) {
            return Napi::String::New(env, "");
        }

        std::vector<char> buffer(static_cast<std::size_t>(length) + 1, '\0');

        // Windows Monitor Configuration API 内部完成 DDC/CI
        // Capabilities Request (0xF3) / Capabilities Reply (0xE3) 交互
        if (!CapabilitiesRequestAndCapabilitiesReply(
            *monitor, buffer.data(), length)) {
            throw_win32_error(env, "读取显示器 Capabilities",
                last_error_or(ERROR_GEN_FAILURE));
            return env.Undefined();
        }

        return Napi::String::New(env, buffer.data());
    }

    Napi::Value set_vcp_value(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        std::uint32_t index = 0;
        std::uint32_t code = 0;
        std::uint32_t value = 0;

        if (!read_uint32_argument(info, 0, "index", index) ||
            !read_uint32_argument(info, 1, "code", code) ||
            !read_uint32_argument(info, 2, "value", value)) {
            return env.Undefined();
        }

        if (code > 0xff) {
            Napi::RangeError::New(env, "code 必须位于 0x00 到 0xFF")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        const MonitorLock lock;
        HANDLE* monitor = resolve_monitor(env, index);

        if (monitor == nullptr) {
            return env.Undefined();
        }

        if (!SetVCPFeature(*monitor, static_cast<BYTE>(code), value)) {
            throw_win32_error(env, "设置 VCP " + format_vcp_code(code),
                last_error_or(ERROR_GEN_FAILURE));
            return env.Undefined();
        }

        return env.Undefined();
    }

    Napi::Value shutdown(const Napi::CallbackInfo& info) {
        const MonitorLock lock;
        cleanup_locked();
        return info.Env().Undefined();
    }

    Napi::Object initialize(Napi::Env env, Napi::Object exports) {
        napi_add_env_cleanup_hook(env, cleanup_environment, nullptr);

        exports.Set("refreshMonitors", Napi::Function::New(env, refresh_monitors));
        exports.Set("getVcpValue", Napi::Function::New(env, get_vcp_value));
        exports.Set("getCapabilities", Napi::Function::New(env, get_capabilities));
        exports.Set("setVcpValue", Napi::Function::New(env, set_vcp_value));
        exports.Set("shutdown", Napi::Function::New(env, shutdown));
        return exports;
    }

} // namespace

NODE_API_MODULE(MonitorNative, initialize)
