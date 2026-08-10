#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include <napi.h>

#include <array>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

struct WindowBounds {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

struct NativeShellConfig {
    std::wstring renderer_root;
    std::wstring webview_data_directory;
    std::wstring icon_path;
    std::wstring tray_tooltip;
    bool development = false;
};

enum class WindowPlacement {
    Center,
    Anchor,
    Bounds,
};

struct WindowOpenOptions {
    std::string id;
    std::wstring pathname;
    std::wstring title;
    int base_width = 0;
    int base_height = 0;
    int min_width = 0;
    int min_height = 0;
    int ui_scale_percent = 100;
    int anchor_margin = 0;
    bool resizable = false;
    bool always_on_top = false;
    bool skip_taskbar = false;
    bool close_on_deactivate = false;
    bool emit_bounds_changes = false;
    WindowPlacement placement = WindowPlacement::Center;
    std::optional<POINT> anchor;
    std::optional<WindowBounds> initial_bounds;
};

struct TrayMenuItem {
    enum class Kind {
        Item,
        Separator,
    };

    Kind kind = Kind::Item;
    std::string id;
    std::wstring label;
    bool enabled = true;
    bool checked = false;
};

enum class NativeEventKind {
    TrayPrimaryClick,
    TrayCommand,
    WebMessage,
    WindowClosed,
    WindowBoundsChanged,
    Error,
};

struct NativeEvent {
    NativeEventKind kind = NativeEventKind::Error;
    std::string id;
    std::string text;
    int x = 0;
    int y = 0;
    WindowBounds bounds{};
};

class NativeShell final {
public:
    explicit NativeShell(Napi::ThreadSafeFunction event_callback);
    ~NativeShell();

    NativeShell(const NativeShell&) = delete;
    NativeShell& operator=(const NativeShell&) = delete;

    void start(NativeShellConfig config);
    void open_window(WindowOpenOptions options);
    void close_window();
    void start_window_drag();
    void post_web_message(std::string message);
    void set_window_scale(int percent);
    void reload();
    void execute_script(std::string script);
    void set_tray_menu(std::vector<TrayMenuItem> items);
    void open_path(std::wstring path);
    void shutdown();

private:
    static constexpr UINT kCommandMessage = WM_APP + 1;
    static constexpr UINT kTrayMessage = WM_APP + 2;
    static constexpr UINT_PTR kBoundsTimer = 1;

    void post_command(std::function<void()> command);
    void run_ui_thread();
    void drain_commands();
    void cleanup_ui_thread();

    bool register_window_class();
    HWND create_host_window(const WindowOpenOptions& options);
    void create_tray_icon();
    void delete_tray_icon();
    void delete_window_icons();
    void show_tray_menu();
    void handle_tray_message(LPARAM lparam);

    void create_resize_hit_windows();
    void destroy_resize_hit_windows();
    void layout_resize_hit_windows();
    WPARAM resize_hit_test_for_window(HWND window) const;

    void open_window_on_ui(WindowOpenOptions options);
    void close_window_on_ui(bool emit_closed);
    void begin_webview_creation(std::uint64_t generation);
    void configure_webview(std::uint64_t generation);
    void handle_web_message(const std::wstring& message);
    void resize_webview();
    void show_and_focus_window();

    void apply_window_scale(int percent);
    void position_window();
    void position_anchor_window();
    void position_bounds_window();
    void center_window_on_primary_monitor();
    void schedule_bounds_event();
    void emit_window_bounds();

    void emit(NativeEvent event);
    void emit_error(std::string message);

    static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam,
        LPARAM lparam);
    static LRESULT CALLBACK resize_hit_window_proc(HWND window, UINT message,
        WPARAM wparam, LPARAM lparam);
    LRESULT handle_window_message(HWND window, UINT message, WPARAM wparam,
        LPARAM lparam);
    LRESULT handle_resize_hit_window_message(HWND window, UINT message,
        WPARAM wparam, LPARAM lparam);

    Napi::ThreadSafeFunction event_callback_;
    NativeShellConfig config_{};
    WindowOpenOptions window_options_{};

    std::thread ui_thread_;
    std::mutex command_mutex_;
    std::deque<std::function<void()>> commands_;
    std::mutex ready_mutex_;
    std::condition_variable ready_condition_;
    bool ready_ = false;
    std::string startup_error_;
    bool shutting_down_ = false;

    HWND message_window_ = nullptr;
    HWND host_window_ = nullptr;
    std::array<HWND, 8> resize_hit_windows_{};
    HICON window_icon_large_ = nullptr;
    HICON window_icon_small_ = nullptr;
    HICON tray_icon_ = nullptr;
    NOTIFYICONDATAW tray_data_{};
    bool tray_added_ = false;
    std::vector<TrayMenuItem> tray_menu_items_;
    ULONGLONG last_tray_primary_click_tick_ = 0;
    int ui_scale_percent_ = 100;
    std::uint64_t generation_ = 0;

    struct WebViewState;
    std::unique_ptr<WebViewState> webview_state_;
};
