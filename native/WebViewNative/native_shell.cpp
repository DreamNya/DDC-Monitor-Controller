#include "native_shell.h"

#include <wrl.h>
#include <WebView2.h>

#include <dwmapi.h>
#include <shellapi.h>
#include <shellscalingapi.h>

#include <algorithm>
#include <cstdio>
#include <cmath>
#include <filesystem>
#include <stdexcept>
#include <utility>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {
constexpr wchar_t kWindowClassName[] = L"WebViewNativeShellWindow";
constexpr wchar_t kResizeHitWindowClassName[] = L"WebViewNativeShellResizeHitWindow";
constexpr wchar_t kVirtualHost[] = L"app.local";
constexpr wchar_t kVirtualOriginPrefix[] = L"https://app.local/";
constexpr UINT kTrayIconId = 1;
constexpr UINT kFirstTrayMenuCommand = 1000;
constexpr int kResizeBorderDip = 8;
constexpr std::array<WPARAM, 8> kResizeHitTests = {
    HTLEFT,
    HTRIGHT,
    HTTOP,
    HTBOTTOM,
    HTTOPLEFT,
    HTTOPRIGHT,
    HTBOTTOMLEFT,
    HTBOTTOMRIGHT,
};

enum class TaskbarSide { Bottom, Top, Left, Right };

TaskbarSide detect_taskbar_side(const MONITORINFO& info, const POINT anchor) {
    // 托盘点击点通常位于 rcMonitor 与 rcWork 的差集内，因此无需查询或枚举任务栏窗口。
    if (anchor.y >= info.rcWork.bottom && anchor.y < info.rcMonitor.bottom) return TaskbarSide::Bottom;
    if (anchor.y < info.rcWork.top && anchor.y >= info.rcMonitor.top) return TaskbarSide::Top;
    if (anchor.x < info.rcWork.left && anchor.x >= info.rcMonitor.left) return TaskbarSide::Left;
    if (anchor.x >= info.rcWork.right && anchor.x < info.rcMonitor.right) return TaskbarSide::Right;

    // 自动隐藏任务栏不会稳定缩小 rcWork；此时用点击点距离屏幕边缘作为回退。
    const LONG left_distance = std::abs(anchor.x - info.rcMonitor.left);
    const LONG right_distance = std::abs(info.rcMonitor.right - anchor.x);
    const LONG top_distance = std::abs(anchor.y - info.rcMonitor.top);
    const LONG bottom_distance = std::abs(info.rcMonitor.bottom - anchor.y);
    const LONG nearest = std::min({left_distance, right_distance, top_distance, bottom_distance});
    if (bottom_distance == nearest) return TaskbarSide::Bottom;
    if (top_distance == nearest) return TaskbarSide::Top;
    if (left_distance == nearest) return TaskbarSide::Left;
    return TaskbarSide::Right;
}

int scale_dimension(const int value, const int percent) {
    return std::max(1, static_cast<int>(std::lround(static_cast<double>(value) * percent / 100.0)));
}

int dip_to_px(const int value, const UINT dpi) {
    return MulDiv(value, static_cast<int>(dpi), 96);
}

DWORD window_style(const WindowOpenOptions& options) {
    DWORD style = WS_POPUP;
    if (options.resizable) {
        style |= WS_THICKFRAME;
    }
    return style;
}

DWORD window_extended_style(const WindowOpenOptions& options) {
    DWORD extended_style = 0;
    if (options.always_on_top) {
        extended_style |= WS_EX_TOPMOST;
    }
    if (options.skip_taskbar) {
        extended_style |= WS_EX_TOOLWINDOW;
    } else {
        extended_style |= WS_EX_APPWINDOW;
    }
    return extended_style;
}

int px_to_dip(const int value, const UINT dpi) {
    return MulDiv(value, 96, static_cast<int>(dpi == 0 ? 96 : dpi));
}

UINT monitor_dpi(HMONITOR monitor) {
    UINT dpi_x = 96;
    UINT dpi_y = 96;
    if (monitor != nullptr && SUCCEEDED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpi_x, &dpi_y))) {
        return dpi_x;
    }
    return 96;
}

std::wstring utf8_to_wide(const std::string& value) {
    if (value.empty()) {
        return {};
    }
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) {
        return {};
    }
    std::wstring result(static_cast<std::size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

std::string wide_to_utf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) {
        return {};
    }
    std::string result(static_cast<std::size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::string hresult_message(const HRESULT value) {
    return "HRESULT 0x" + [] (const HRESULT code) {
        char buffer[16]{};
        sprintf_s(buffer, "%08lX", static_cast<unsigned long>(code));
        return std::string(buffer);
    }(value);
}

bool starts_with(const std::wstring& value, const wchar_t* prefix) {
    return value.rfind(prefix, 0) == 0;
}

int clamp_position(const int value, const int minimum, const int maximum) {
    if (maximum < minimum) {
        return minimum;
    }
    return std::clamp(value, minimum, maximum);
}

void configure_window_frame(const HWND window) {
    // DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2.
    // Keep the numeric values here so VS2019 can still build when paired with an older Windows SDK header.
    constexpr auto corner_attribute = static_cast<DWMWINDOWATTRIBUTE>(33);
    constexpr int round_preference = 2;
    DwmSetWindowAttribute(window, corner_attribute, &round_preference, sizeof(round_preference));

    // Extend one pixel of the DWM frame so frameless host windows keep the native shadow.
    const MARGINS margins{1, 1, 1, 1};
    DwmExtendFrameIntoClientArea(window, &margins);
}
}  // namespace

struct NativeShell::WebViewState {
    ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    EventRegistrationToken web_message_token{};
    EventRegistrationToken navigation_start_token{};
    bool web_message_registered = false;
    bool navigation_start_registered = false;
};

NativeShell::NativeShell(Napi::ThreadSafeFunction event_callback)
    : event_callback_(std::move(event_callback)), webview_state_(std::make_unique<WebViewState>()) {}

NativeShell::~NativeShell() {
    shutdown();
}

void NativeShell::start(NativeShellConfig config) {
    config_ = std::move(config);

    ui_thread_ = std::thread([this] { run_ui_thread(); });

    std::unique_lock lock(ready_mutex_);
    ready_condition_.wait(lock, [this] { return ready_; });
    if (!startup_error_.empty()) {
        lock.unlock();
        shutdown();
        throw std::runtime_error(startup_error_);
    }
}

void NativeShell::open_window(WindowOpenOptions options) {
    post_command([this, options = std::move(options)]() mutable { open_window_on_ui(std::move(options)); });
}

void NativeShell::close_window() {
    post_command([this] { close_window_on_ui(true); });
}

void NativeShell::start_window_drag() {
    post_command([this] {
        if (host_window_) {
            ReleaseCapture();
            SendMessageW(host_window_, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }
    });
}

void NativeShell::post_web_message(std::string message) {
    post_command([this, message = std::move(message)] {
        if (webview_state_->webview) {
            const auto wide = utf8_to_wide(message);
            const HRESULT result = webview_state_->webview->PostWebMessageAsString(wide.c_str());
            if (FAILED(result)) {
                emit_error("向 WebView 发送消息失败：" + hresult_message(result));
            }
        }
    });
}

void NativeShell::set_window_scale(const int percent) {
    post_command([this, percent] { apply_window_scale(percent); });
}

void NativeShell::reload() {
    post_command([this] {
        if (webview_state_->webview) {
            const HRESULT result = webview_state_->webview->Reload();
            if (FAILED(result)) {
                emit_error("重新加载 WebView 失败：" + hresult_message(result));
            }
        }
    });
}

void NativeShell::execute_script(std::string script) {
    post_command([this, script = std::move(script)] {
        if (!webview_state_->webview) {
            return;
        }
        const auto wide = utf8_to_wide(script);
        const HRESULT result = webview_state_->webview->ExecuteScript(wide.c_str(), nullptr);
        if (FAILED(result)) {
            emit_error("执行 WebView 脚本失败：" + hresult_message(result));
        }
    });
}

void NativeShell::set_tray_menu(std::vector<TrayMenuItem> items) {
    post_command([this, items = std::move(items)]() mutable { tray_menu_items_ = std::move(items); });
}

void NativeShell::open_path(std::wstring path) {
    post_command([this, path = std::move(path)] {
        const auto result = reinterpret_cast<std::intptr_t>(
            ShellExecuteW(message_window_, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
        if (result <= 32) {
            emit_error("打开路径失败：" + wide_to_utf8(path));
        }
    });
}

void NativeShell::shutdown() {
    {
        std::lock_guard lock(command_mutex_);
        if (shutting_down_) {
            if (ui_thread_.joinable() && ui_thread_.get_id() != std::this_thread::get_id()) {
                // 已进入退出流程时只等待已有 UI 线程结束。
            } else {
                return;
            }
        } else {
            shutting_down_ = true;
            commands_.push_back([this] {
                close_window_on_ui(false);
                delete_tray_icon();
                if (message_window_) {
                    DestroyWindow(message_window_);
                    message_window_ = nullptr;
                }
                PostQuitMessage(0);
            });
            if (message_window_) {
                PostMessageW(message_window_, kCommandMessage, 0, 0);
            }
        }
    }

    if (ui_thread_.joinable() && ui_thread_.get_id() != std::this_thread::get_id()) {
        ui_thread_.join();
    }
}

void NativeShell::post_command(std::function<void()> command) {
    std::lock_guard lock(command_mutex_);
    if (shutting_down_ || !message_window_) {
        return;
    }
    commands_.push_back(std::move(command));
    PostMessageW(message_window_, kCommandMessage, 0, 0);
}

void NativeShell::run_ui_thread() {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    if (FAILED(com_result)) {
        std::lock_guard lock(ready_mutex_);
        startup_error_ = "初始化 Win32 STA 线程失败：" + hresult_message(com_result);
        ready_ = true;
        ready_condition_.notify_all();
        return;
    }

    try {
        std::filesystem::create_directories(config_.webview_data_directory);
    } catch (const std::exception& error) {
        std::lock_guard lock(ready_mutex_);
        startup_error_ = std::string("创建 WebView data 目录失败：") + error.what();
        ready_ = true;
        ready_condition_.notify_all();
        if (SUCCEEDED(com_result)) {
            CoUninitialize();
        }
        return;
    }

    if (!register_window_class()) {
        std::lock_guard lock(ready_mutex_);
        startup_error_ = "注册 Native Shell 窗口类失败";
        ready_ = true;
        ready_condition_.notify_all();
        if (SUCCEEDED(com_result)) {
            CoUninitialize();
        }
        return;
    }

    message_window_ = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        kWindowClassName,
        L"WebView Native Shell",
        WS_POPUP,
        -32000,
        -32000,
        1,
        1,
        nullptr,
        nullptr,
        GetModuleHandleW(nullptr),
        this);

    if (!message_window_) {
        UnregisterClassW(kWindowClassName, GetModuleHandleW(nullptr));
        delete_window_icons();
        std::lock_guard lock(ready_mutex_);
        startup_error_ = "创建 Native Shell 消息窗口失败";
        ready_ = true;
        ready_condition_.notify_all();
        if (SUCCEEDED(com_result)) {
            CoUninitialize();
        }
        return;
    }

    create_tray_icon();
    {
        std::lock_guard lock(ready_mutex_);
        ready_ = true;
        ready_condition_.notify_all();
    }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    cleanup_ui_thread();
    if (SUCCEEDED(com_result)) {
        CoUninitialize();
    }
}

void NativeShell::drain_commands() {
    std::deque<std::function<void()>> commands;
    {
        std::lock_guard lock(command_mutex_);
        commands.swap(commands_);
    }
    for (auto& command : commands) {
        command();
    }
}

void NativeShell::cleanup_ui_thread() {
    close_window_on_ui(false);
    delete_tray_icon();
    if (message_window_) {
        DestroyWindow(message_window_);
        message_window_ = nullptr;
    }
    UnregisterClassW(kResizeHitWindowClassName, GetModuleHandleW(nullptr));
    UnregisterClassW(kWindowClassName, GetModuleHandleW(nullptr));
    delete_window_icons();
}

bool NativeShell::register_window_class() {
    window_icon_large_ = static_cast<HICON>(LoadImageW(
        nullptr,
        config_.icon_path.c_str(),
        IMAGE_ICON,
        GetSystemMetrics(SM_CXICON),
        GetSystemMetrics(SM_CYICON),
        LR_LOADFROMFILE));
    window_icon_small_ = static_cast<HICON>(LoadImageW(
        nullptr,
        config_.icon_path.c_str(),
        IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON),
        GetSystemMetrics(SM_CYSMICON),
        LR_LOADFROMFILE));
    if (!window_icon_large_ || !window_icon_small_) {
        delete_window_icons();
        return false;
    }

    WNDCLASSEXW window_class{};
    window_class.cbSize = sizeof(window_class);
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.lpfnWndProc = window_proc;
    window_class.hInstance = GetModuleHandleW(nullptr);
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.hIcon = window_icon_large_;
    window_class.hIconSm = window_icon_small_;
    window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    window_class.lpszClassName = kWindowClassName;

    if (RegisterClassExW(&window_class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        delete_window_icons();
        return false;
    }

    WNDCLASSEXW resize_hit_class{};
    resize_hit_class.cbSize = sizeof(resize_hit_class);
    resize_hit_class.lpfnWndProc = resize_hit_window_proc;
    resize_hit_class.hInstance = GetModuleHandleW(nullptr);
    resize_hit_class.lpszClassName = kResizeHitWindowClassName;

    if (RegisterClassExW(&resize_hit_class) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS) {
        return true;
    }

    UnregisterClassW(kWindowClassName, GetModuleHandleW(nullptr));
    delete_window_icons();
    return false;
}

HWND NativeShell::create_host_window(const WindowOpenOptions& options) {
    const DWORD style = window_style(options);
    const DWORD extended_style = window_extended_style(options);
    const int initial_width = scale_dimension(options.base_width, options.ui_scale_percent);
    const int initial_height = scale_dimension(options.base_height, options.ui_scale_percent);

    const HWND window = CreateWindowExW(
        extended_style,
        kWindowClassName,
        options.title.c_str(),
        style,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        initial_width,
        initial_height,
        nullptr,
        nullptr,
        GetModuleHandleW(nullptr),
        this);

    if (window) {
        SendMessageW(window, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(window_icon_large_));
        SendMessageW(window, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(window_icon_small_));
    }

    return window;
}

void NativeShell::create_tray_icon() {
    tray_icon_ = static_cast<HICON>(LoadImageW(
        nullptr,
        config_.icon_path.c_str(),
        IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON),
        GetSystemMetrics(SM_CYSMICON),
        LR_LOADFROMFILE));
    if (!tray_icon_) {
        emit_error("加载托盘图标失败：" + wide_to_utf8(config_.icon_path));
        return;
    }

    tray_data_ = {};
    tray_data_.cbSize = sizeof(tray_data_);
    tray_data_.hWnd = message_window_;
    tray_data_.uID = kTrayIconId;
    tray_data_.uFlags = NIF_MESSAGE | NIF_ICON;
    tray_data_.uCallbackMessage = kTrayMessage;
    tray_data_.hIcon = tray_icon_;
    if (!config_.tray_tooltip.empty()) {
        tray_data_.uFlags |= NIF_TIP;
        wcsncpy_s(tray_data_.szTip, config_.tray_tooltip.c_str(), _TRUNCATE);
    }

    tray_added_ = Shell_NotifyIconW(NIM_ADD, &tray_data_) != FALSE;
    if (!tray_added_) {
        emit_error("创建系统托盘图标失败");
        return;
    }
    tray_data_.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &tray_data_);
}

void NativeShell::delete_tray_icon() {
    if (tray_added_) {
        Shell_NotifyIconW(NIM_DELETE, &tray_data_);
        tray_added_ = false;
    }
    if (tray_icon_) {
        DestroyIcon(tray_icon_);
        tray_icon_ = nullptr;
    }
}

void NativeShell::delete_window_icons() {
    if (window_icon_large_) {
        DestroyIcon(window_icon_large_);
        window_icon_large_ = nullptr;
    }
    if (window_icon_small_) {
        DestroyIcon(window_icon_small_);
        window_icon_small_ = nullptr;
    }
}

void NativeShell::show_tray_menu() {
    if (tray_menu_items_.empty()) {
        return;
    }

    HMENU menu = CreatePopupMenu();
    if (!menu) {
        return;
    }

    struct CommandMapping {
        UINT command = 0;
        std::string id;
    };
    std::vector<CommandMapping> mappings;
    UINT next_command = kFirstTrayMenuCommand;

    for (const auto& item : tray_menu_items_) {
        if (item.kind == TrayMenuItem::Kind::Separator) {
            AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
            continue;
        }

        UINT flags = MF_STRING;
        if (!item.enabled) {
            flags |= MF_GRAYED;
        }
        if (item.checked) {
            flags |= MF_CHECKED;
        }

        const UINT command = next_command++;
        AppendMenuW(menu, flags, command, item.label.c_str());
        mappings.push_back(CommandMapping{command, item.id});
    }

    POINT cursor{};
    GetCursorPos(&cursor);
    SetForegroundWindow(message_window_);
    const UINT selected_command = TrackPopupMenu(
        menu,
        TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
        cursor.x,
        cursor.y,
        0,
        message_window_,
        nullptr);
    DestroyMenu(menu);
    PostMessageW(message_window_, WM_NULL, 0, 0);

    const auto match = std::find_if(
        mappings.begin(),
        mappings.end(),
        [selected_command](const CommandMapping& item) { return item.command == selected_command; });
    if (match == mappings.end()) {
        return;
    }

    NativeEvent event{};
    event.kind = NativeEventKind::TrayCommand;
    event.id = match->id;
    emit(std::move(event));
}

void NativeShell::handle_tray_message(const LPARAM lparam) {
    const UINT message = LOWORD(lparam);
    if (message == WM_LBUTTONUP || message == NIN_SELECT || message == NIN_KEYSELECT) {
        const ULONGLONG now = GetTickCount64();
        if (now - last_tray_primary_click_tick_ < 200) {
            return;
        }
        last_tray_primary_click_tick_ = now;
        POINT cursor{};
        GetCursorPos(&cursor);
        NativeEvent event{};
        event.kind = NativeEventKind::TrayPrimaryClick;
        event.x = cursor.x;
        event.y = cursor.y;
        emit(std::move(event));
    } else if (message == WM_RBUTTONUP || message == WM_CONTEXTMENU) {
        show_tray_menu();
    }
}

void NativeShell::create_resize_hit_windows() {
    if (!host_window_ || !window_options_.resizable || resize_hit_windows_[0]) {
        return;
    }

    for (auto& resize_window : resize_hit_windows_) {
        resize_window = CreateWindowExW(
            WS_EX_TRANSPARENT,
            kResizeHitWindowClassName,
            L"",
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            0,
            0,
            host_window_,
            nullptr,
            GetModuleHandleW(nullptr),
            this);
        if (!resize_window) {
            destroy_resize_hit_windows();
            emit_error("创建窗口缩放命中层失败");
            return;
        }
    }

    layout_resize_hit_windows();
}

void NativeShell::destroy_resize_hit_windows() {
    for (auto& resize_window : resize_hit_windows_) {
        if (resize_window) {
            DestroyWindow(resize_window);
            resize_window = nullptr;
        }
    }
}

void NativeShell::layout_resize_hit_windows() {
    if (!host_window_ || !resize_hit_windows_[0]) {
        return;
    }

    RECT client{};
    if (!GetClientRect(host_window_, &client)) {
        return;
    }

    const int width = std::max(0, static_cast<int>(client.right - client.left));
    const int height = std::max(0, static_cast<int>(client.bottom - client.top));
    const int border = std::max(1, dip_to_px(kResizeBorderDip, GetDpiForWindow(host_window_)));
    const int horizontal_border = std::min(border, width);
    const int vertical_border = std::min(border, height);
    const int middle_width = std::max(0, width - horizontal_border * 2);
    const int middle_height = std::max(0, height - vertical_border * 2);

    const std::array<RECT, 8> bounds = {
        RECT{0, vertical_border, horizontal_border, vertical_border + middle_height},
        RECT{width - horizontal_border, vertical_border, width, vertical_border + middle_height},
        RECT{horizontal_border, 0, horizontal_border + middle_width, vertical_border},
        RECT{horizontal_border, height - vertical_border, horizontal_border + middle_width, height},
        RECT{0, 0, horizontal_border, vertical_border},
        RECT{width - horizontal_border, 0, width, vertical_border},
        RECT{0, height - vertical_border, horizontal_border, height},
        RECT{width - horizontal_border, height - vertical_border, width, height},
    };

    for (std::size_t index = 0; index < resize_hit_windows_.size(); ++index) {
        const RECT& rect = bounds[index];
        SetWindowPos(
            resize_hit_windows_[index],
            HWND_TOP,
            rect.left,
            rect.top,
            std::max(0, static_cast<int>(rect.right - rect.left)),
            std::max(0, static_cast<int>(rect.bottom - rect.top)),
            SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

WPARAM NativeShell::resize_hit_test_for_window(const HWND window) const {
    for (std::size_t index = 0; index < resize_hit_windows_.size(); ++index) {
        if (resize_hit_windows_[index] == window) {
            return kResizeHitTests[index];
        }
    }
    return HTCLIENT;
}

void NativeShell::open_window_on_ui(WindowOpenOptions options) {
    const bool same_window = host_window_ && window_options_.id == options.id;
    if (same_window) {
        window_options_.anchor = options.anchor;
        window_options_.initial_bounds = options.initial_bounds;
        window_options_.placement = options.placement;
        window_options_.anchor_margin = options.anchor_margin;
        window_options_.close_on_deactivate = options.close_on_deactivate;
        window_options_.emit_bounds_changes = options.emit_bounds_changes;
        apply_window_scale(options.ui_scale_percent);
        if (window_options_.placement == WindowPlacement::Anchor) {
            position_anchor_window();
        }
        show_and_focus_window();
        return;
    }

    close_window_on_ui(false);
    window_options_ = std::move(options);
    ui_scale_percent_ = window_options_.ui_scale_percent;
    host_window_ = create_host_window(window_options_);
    if (!host_window_) {
        emit_error("创建宿主窗口失败");
        return;
    }

    configure_window_frame(host_window_);
    if (window_options_.resizable) {
        SetWindowPos(
            host_window_,
            nullptr,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
    position_window();

    const auto generation = ++generation_;
    begin_webview_creation(generation);
}

void NativeShell::close_window_on_ui(const bool emit_closed) {
    if (!host_window_ && !webview_state_->controller && !webview_state_->environment) {
        return;
    }

    const std::string closed_id = window_options_.id;
    ++generation_;
    if (webview_state_->webview && webview_state_->web_message_registered) {
        webview_state_->webview->remove_WebMessageReceived(webview_state_->web_message_token);
    }
    if (webview_state_->webview && webview_state_->navigation_start_registered) {
        webview_state_->webview->remove_NavigationStarting(webview_state_->navigation_start_token);
    }
    webview_state_->web_message_registered = false;
    webview_state_->navigation_start_registered = false;

    destroy_resize_hit_windows();

    if (webview_state_->controller) {
        webview_state_->controller->Close();
    }
    webview_state_->webview.Reset();
    webview_state_->controller.Reset();
    webview_state_->environment.Reset();

    if (host_window_) {
        KillTimer(host_window_, kBoundsTimer);
        const HWND window = host_window_;
        host_window_ = nullptr;
        DestroyWindow(window);
    }

    if (emit_closed) {
        NativeEvent event{};
        event.kind = NativeEventKind::WindowClosed;
        event.id = closed_id;
        emit(std::move(event));
    }
}

void NativeShell::begin_webview_creation(const std::uint64_t generation) {
    const HRESULT result = CreateCoreWebView2EnvironmentWithOptions(
        nullptr,
        config_.webview_data_directory.c_str(),
        nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this, generation](HRESULT environment_result, ICoreWebView2Environment* environment) -> HRESULT {
                if (generation != generation_ || !host_window_) {
                    return S_OK;
                }
                if (FAILED(environment_result) || !environment) {
                    emit_error("创建 WebView2 Environment 失败：" + hresult_message(environment_result));
                    close_window_on_ui(true);
                    return S_OK;
                }
                webview_state_->environment = environment;
                const HRESULT controller_result = environment->CreateCoreWebView2Controller(
                    host_window_,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [this, generation](HRESULT create_result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (generation != generation_ || !host_window_) {
                                return S_OK;
                            }
                            if (FAILED(create_result) || !controller) {
                                emit_error("创建 WebView2 Controller 失败：" + hresult_message(create_result));
                                close_window_on_ui(true);
                                return S_OK;
                            }
                            webview_state_->controller = controller;
                            controller->get_CoreWebView2(&webview_state_->webview);
                            configure_webview(generation);
                            return S_OK;
                        }).Get());
                if (FAILED(controller_result)) {
                    emit_error("请求创建 WebView2 Controller 失败：" + hresult_message(controller_result));
                    close_window_on_ui(true);
                }
                return S_OK;
            }).Get());

    if (FAILED(result)) {
        emit_error("请求创建 WebView2 Environment 失败：" + hresult_message(result));
        close_window_on_ui(true);
    }
}

void NativeShell::configure_webview(const std::uint64_t generation) {
    if (generation != generation_ || !webview_state_->webview || !webview_state_->controller) {
        return;
    }

    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(webview_state_->webview->get_Settings(&settings)) && settings) {
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        settings->put_AreDevToolsEnabled(config_.development ? TRUE : FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
    }

    if (config_.development) {
        // resource-server.ts 原本通过 Cache-Control: no-store 保证热重载读取最新静态资源。
        // Virtual Host Mapping 后直接关闭开发 WebView 的 HTTP cache，避免 HTML 刷新后仍复用旧 JS/CSS。
        webview_state_->webview->CallDevToolsProtocolMethod(
            L"Network.setCacheDisabled",
            L"{\"cacheDisabled\":true}",
            Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(
                [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; }).Get());
    }

    ComPtr<ICoreWebView2_3> webview3;
    if (FAILED(webview_state_->webview.As(&webview3)) || !webview3) {
        emit_error("当前 WebView2 Runtime 不支持 Virtual Host Mapping");
        close_window_on_ui(true);
        return;
    }
    const HRESULT mapping_result = webview3->SetVirtualHostNameToFolderMapping(
        kVirtualHost,
        config_.renderer_root.c_str(),
        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    if (FAILED(mapping_result)) {
        emit_error("映射 Renderer 目录失败：" + hresult_message(mapping_result));
        close_window_on_ui(true);
        return;
    }

    const HRESULT navigation_event_result = webview_state_->webview->add_NavigationStarting(
        Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr;
                if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                    const std::wstring value(uri);
                    CoTaskMemFree(uri);
                    if (!starts_with(value, kVirtualOriginPrefix)) {
                        args->put_Cancel(TRUE);
                    }
                }
                return S_OK;
            }).Get(),
        &webview_state_->navigation_start_token);
    webview_state_->navigation_start_registered = SUCCEEDED(navigation_event_result);

    const HRESULT web_message_event_result = webview_state_->webview->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this, generation](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                if (generation != generation_) {
                    return S_OK;
                }
                LPWSTR source = nullptr;
                if (FAILED(args->get_Source(&source)) || !source) {
                    return S_OK;
                }
                const std::wstring source_value(source);
                CoTaskMemFree(source);
                if (!starts_with(source_value, kVirtualOriginPrefix)) {
                    return S_OK;
                }

                LPWSTR raw_message = nullptr;
                if (SUCCEEDED(args->TryGetWebMessageAsString(&raw_message)) && raw_message) {
                    std::wstring message(raw_message);
                    CoTaskMemFree(raw_message);
                    handle_web_message(message);
                }
                return S_OK;
            }).Get(),
        &webview_state_->web_message_token);
    webview_state_->web_message_registered = SUCCEEDED(web_message_event_result);

    resize_webview();
    webview_state_->controller->put_ZoomFactor(static_cast<double>(ui_scale_percent_) / 100.0);
    webview_state_->controller->put_IsVisible(TRUE);
    create_resize_hit_windows();

    const std::wstring url = std::wstring(kVirtualOriginPrefix) + window_options_.pathname;
    const HRESULT navigate_result = webview_state_->webview->Navigate(url.c_str());
    if (FAILED(navigate_result)) {
        emit_error("加载 WebView 页面失败：" + hresult_message(navigate_result));
        close_window_on_ui(true);
        return;
    }
    show_and_focus_window();
}

void NativeShell::handle_web_message(const std::wstring& message) {
    NativeEvent event{};
    event.kind = NativeEventKind::WebMessage;
    event.text = wide_to_utf8(message);
    emit(std::move(event));
}

void NativeShell::resize_webview() {
    if (!host_window_ || !webview_state_->controller) {
        return;
    }
    RECT bounds{};
    GetClientRect(host_window_, &bounds);
    webview_state_->controller->put_Bounds(bounds);
    layout_resize_hit_windows();
}

void NativeShell::show_and_focus_window() {
    if (!host_window_) {
        return;
    }
    ShowWindow(host_window_, SW_SHOWNORMAL);
    SetForegroundWindow(host_window_);
    SetFocus(host_window_);
    if (webview_state_->controller) {
        webview_state_->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
}

void NativeShell::apply_window_scale(const int percent) {
    if (!host_window_ || percent <= 0 || percent == ui_scale_percent_) {
        return;
    }

    RECT client{};
    GetClientRect(host_window_, &client);
    const UINT dpi = GetDpiForWindow(host_window_);
    const int old_width_dip = px_to_dip(client.right - client.left, dpi);
    const int old_height_dip = px_to_dip(client.bottom - client.top, dpi);
    const double old_factor = static_cast<double>(ui_scale_percent_) / 100.0;
    const double new_factor = static_cast<double>(percent) / 100.0;

    ui_scale_percent_ = percent;
    window_options_.ui_scale_percent = percent;
    if (webview_state_->controller) {
        webview_state_->controller->put_ZoomFactor(new_factor);
    }

    int new_width_dip = scale_dimension(window_options_.base_width, percent);
    int new_height_dip = scale_dimension(window_options_.base_height, percent);
    if (window_options_.resizable && old_factor > 0.0) {
        new_width_dip = std::max(1, static_cast<int>(std::lround(old_width_dip / old_factor * new_factor)));
        new_height_dip = std::max(1, static_cast<int>(std::lround(old_height_dip / old_factor * new_factor)));
    }

    const int width = dip_to_px(new_width_dip, dpi);
    const int height = dip_to_px(new_height_dip, dpi);
    SetWindowPos(host_window_, nullptr, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

    if (window_options_.placement == WindowPlacement::Anchor) {
        position_anchor_window();
    }
}

void NativeShell::position_window() {
    switch (window_options_.placement) {
        case WindowPlacement::Anchor:
            position_anchor_window();
            break;
        case WindowPlacement::Bounds:
            position_bounds_window();
            break;
        case WindowPlacement::Center:
            center_window_on_primary_monitor();
            break;
    }
}

void NativeShell::position_anchor_window() {
    if (!host_window_) {
        return;
    }
    if (!window_options_.anchor) {
        center_window_on_primary_monitor();
        return;
    }

    const POINT anchor = *window_options_.anchor;
    const HMONITOR monitor = MonitorFromPoint(anchor, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) {
        center_window_on_primary_monitor();
        return;
    }

    const UINT dpi = monitor_dpi(monitor);
    const int width = dip_to_px(scale_dimension(window_options_.base_width, ui_scale_percent_), dpi);
    const int height = dip_to_px(scale_dimension(window_options_.base_height, ui_scale_percent_), dpi);
    const int margin = dip_to_px(window_options_.anchor_margin, dpi);

    int x = anchor.x - width / 2;
    int y = anchor.y - height / 2;
    switch (detect_taskbar_side(info, anchor)) {
        case TaskbarSide::Bottom:
            x = clamp_position(x, info.rcWork.left + margin, info.rcWork.right - width - margin);
            y = info.rcWork.bottom - height - margin;
            break;
        case TaskbarSide::Top:
            x = clamp_position(x, info.rcWork.left + margin, info.rcWork.right - width - margin);
            y = info.rcWork.top + margin;
            break;
        case TaskbarSide::Left:
            x = info.rcWork.left + margin;
            y = clamp_position(y, info.rcWork.top + margin, info.rcWork.bottom - height - margin);
            break;
        case TaskbarSide::Right:
            x = info.rcWork.right - width - margin;
            y = clamp_position(y, info.rcWork.top + margin, info.rcWork.bottom - height - margin);
            break;
    }

    SetWindowPos(
        host_window_,
        window_options_.always_on_top ? HWND_TOPMOST : nullptr,
        x,
        y,
        width,
        height,
        SWP_NOACTIVATE | (window_options_.always_on_top ? 0 : SWP_NOZORDER));
}

void NativeShell::position_bounds_window() {
    if (!host_window_) {
        return;
    }
    if (!window_options_.initial_bounds) {
        center_window_on_primary_monitor();
        return;
    }

    const auto bounds = *window_options_.initial_bounds;
    POINT point{bounds.x, bounds.y};
    const HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
    const UINT dpi = monitor_dpi(monitor);
    const int width = dip_to_px(scale_dimension(bounds.width, ui_scale_percent_), dpi);
    const int height = dip_to_px(scale_dimension(bounds.height, ui_scale_percent_), dpi);
    RECT target{bounds.x, bounds.y, bounds.x + width, bounds.y + height};
    const HMONITOR visible_monitor = MonitorFromRect(&target, MONITOR_DEFAULTTONULL);

    if (!visible_monitor) {
        center_window_on_primary_monitor();
        return;
    }
    SetWindowPos(host_window_, nullptr, bounds.x, bounds.y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
}

void NativeShell::center_window_on_primary_monitor() {
    if (!host_window_) {
        return;
    }
    POINT origin{};
    const HMONITOR monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) {
        return;
    }
    const UINT dpi = monitor_dpi(monitor);
    const int width = dip_to_px(scale_dimension(window_options_.base_width, ui_scale_percent_), dpi);
    const int height = dip_to_px(scale_dimension(window_options_.base_height, ui_scale_percent_), dpi);
    const int x = info.rcWork.left + ((info.rcWork.right - info.rcWork.left) - width) / 2;
    const int y = info.rcWork.top + ((info.rcWork.bottom - info.rcWork.top) - height) / 2;
    SetWindowPos(host_window_, nullptr, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
}

void NativeShell::schedule_bounds_event() {
    if (window_options_.emit_bounds_changes && host_window_) {
        SetTimer(host_window_, kBoundsTimer, 300, nullptr);
    }
}

void NativeShell::emit_window_bounds() {
    if (!window_options_.emit_bounds_changes || !host_window_) {
        return;
    }
    RECT window_rect{};
    RECT client_rect{};
    if (!GetWindowRect(host_window_, &window_rect) || !GetClientRect(host_window_, &client_rect)) {
        return;
    }
    const UINT dpi = GetDpiForWindow(host_window_);
    const double factor = static_cast<double>(ui_scale_percent_) / 100.0;
    const int client_width_dip = px_to_dip(client_rect.right - client_rect.left, dpi);
    const int client_height_dip = px_to_dip(client_rect.bottom - client_rect.top, dpi);

    NativeEvent event{};
    event.kind = NativeEventKind::WindowBoundsChanged;
    event.id = window_options_.id;
    event.bounds.x = window_rect.left;
    event.bounds.y = window_rect.top;
    event.bounds.width = std::max(1, static_cast<int>(std::lround(client_width_dip / factor)));
    event.bounds.height = std::max(1, static_cast<int>(std::lround(client_height_dip / factor)));
    emit(std::move(event));
}

void NativeShell::emit(NativeEvent event) {
    auto* payload = new NativeEvent(std::move(event));
    const napi_status status = event_callback_.NonBlockingCall(
        payload,
        [](Napi::Env env, Napi::Function callback, NativeEvent* value) {
            std::unique_ptr<NativeEvent> event(value);
            Napi::Object result = Napi::Object::New(env);
            switch (event->kind) {
                case NativeEventKind::TrayPrimaryClick:
                    result.Set("type", "tray-primary-click");
                    result.Set("x", event->x);
                    result.Set("y", event->y);
                    break;
                case NativeEventKind::TrayCommand:
                    result.Set("type", "tray-command");
                    result.Set("id", event->id);
                    break;
                case NativeEventKind::WebMessage:
                    result.Set("type", "web-message");
                    result.Set("message", event->text);
                    break;
                case NativeEventKind::WindowClosed:
                    result.Set("type", "window-closed");
                    result.Set("id", event->id);
                    break;
                case NativeEventKind::WindowBoundsChanged: {
                    result.Set("type", "window-bounds");
                    result.Set("id", event->id);
                    Napi::Object bounds = Napi::Object::New(env);
                    bounds.Set("x", event->bounds.x);
                    bounds.Set("y", event->bounds.y);
                    bounds.Set("width", event->bounds.width);
                    bounds.Set("height", event->bounds.height);
                    result.Set("bounds", bounds);
                    break;
                }
                case NativeEventKind::Error:
                    result.Set("type", "error");
                    result.Set("message", event->text);
                    break;
            }
            callback.Call({result});
        });
    if (status != napi_ok) {
        delete payload;
    }
}

void NativeShell::emit_error(std::string message) {
    NativeEvent event{};
    event.kind = NativeEventKind::Error;
    event.text = std::move(message);
    emit(std::move(event));
}

LRESULT CALLBACK NativeShell::window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    NativeShell* shell = reinterpret_cast<NativeShell*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
        shell = static_cast<NativeShell*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(shell));
    }
    if (shell) {
        return shell->handle_window_message(window, message, wparam, lparam);
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

LRESULT CALLBACK NativeShell::resize_hit_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    NativeShell* shell = reinterpret_cast<NativeShell*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
        shell = static_cast<NativeShell*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(shell));
    }
    if (shell) {
        return shell->handle_resize_hit_window_message(window, message, wparam, lparam);
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

LRESULT NativeShell::handle_resize_hit_window_message(
    const HWND window,
    const UINT message,
    const WPARAM wparam,
    const LPARAM lparam) {
    const WPARAM hit_test = resize_hit_test_for_window(window);
    switch (message) {
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT paint{};
            BeginPaint(window, &paint);
            EndPaint(window, &paint);
            return 0;
        }
        case WM_SETCURSOR: {
            LPCWSTR cursor_id = IDC_ARROW;
            switch (hit_test) {
                case HTLEFT:
                case HTRIGHT:
                    cursor_id = IDC_SIZEWE;
                    break;
                case HTTOP:
                case HTBOTTOM:
                    cursor_id = IDC_SIZENS;
                    break;
                case HTTOPLEFT:
                case HTBOTTOMRIGHT:
                    cursor_id = IDC_SIZENWSE;
                    break;
                case HTTOPRIGHT:
                case HTBOTTOMLEFT:
                    cursor_id = IDC_SIZENESW;
                    break;
                default:
                    break;
            }
            SetCursor(LoadCursorW(nullptr, cursor_id));
            return TRUE;
        }
        case WM_LBUTTONDOWN:
            if (host_window_ && window_options_.resizable) {
                POINT cursor{};
                GetCursorPos(&cursor);
                ReleaseCapture();
                SendMessageW(
                    host_window_,
                    WM_NCLBUTTONDOWN,
                    hit_test,
                    MAKELPARAM(cursor.x, cursor.y));
            }
            return 0;
        default:
            return DefWindowProcW(window, message, wparam, lparam);
    }
}

LRESULT NativeShell::handle_window_message(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (window == message_window_) {
        if (message == kCommandMessage) {
            drain_commands();
            return 0;
        }
        if (message == kTrayMessage) {
            handle_tray_message(lparam);
            return 0;
        }
        return DefWindowProcW(window, message, wparam, lparam);
    }

    if (window == host_window_) {
        switch (message) {
            case WM_NCCALCSIZE:
                if (window_options_.resizable && wparam != 0) {
                    return 0;
                }
                break;
            case WM_GETMINMAXINFO:
                if (window_options_.resizable) {
                    auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
                    const UINT dpi = GetDpiForWindow(window);
                    info->ptMinTrackSize.x = dip_to_px(scale_dimension(window_options_.min_width, ui_scale_percent_), dpi);
                    info->ptMinTrackSize.y = dip_to_px(scale_dimension(window_options_.min_height, ui_scale_percent_), dpi);
                    return 0;
                }
                break;
            case WM_SIZE:
                resize_webview();
                schedule_bounds_event();
                return 0;
            case WM_MOVE:
                schedule_bounds_event();
                break;
            case WM_TIMER:
                if (wparam == kBoundsTimer) {
                    KillTimer(window, kBoundsTimer);
                    emit_window_bounds();
                    return 0;
                }
                break;
            case WM_DPICHANGED: {
                const auto* suggested = reinterpret_cast<RECT*>(lparam);
                SetWindowPos(
                    window,
                    nullptr,
                    suggested->left,
                    suggested->top,
                    suggested->right - suggested->left,
                    suggested->bottom - suggested->top,
                    SWP_NOZORDER | SWP_NOACTIVATE);
                if (window_options_.placement == WindowPlacement::Anchor) {
                    position_anchor_window();
                }
                return 0;
            }
            case WM_ACTIVATE:
                if (window_options_.close_on_deactivate && LOWORD(wparam) == WA_INACTIVE) {
                    close_window_on_ui(true);
                    return 0;
                }
                break;
            case WM_CLOSE:
                close_window_on_ui(true);
                return 0;
            default:
                break;
        }
    }
    return DefWindowProcW(window, message, wparam, lparam);
}
