#include "native_shell.h"

#include <napi.h>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
    std::unique_ptr<NativeShell> g_shell;
    Napi::ThreadSafeFunction g_event_callback;
    bool g_event_callback_active = false;

    std::wstring utf8_to_wide(const std::string& value) {
        if (value.empty()) {
            return {};
        }
        const int size =
            MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                static_cast<int>(value.size()), nullptr, 0);
        if (size <= 0) {
            throw std::runtime_error("UTF-8 字符串转换失败");
        }
        std::wstring result(static_cast<std::size_t>(size), L'\0');
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), size);
        return result;
    }

    Napi::Object require_object(const Napi::CallbackInfo& info, std::size_t index,
        const char* name) {
        if (info.Length() <= index || !info[index].IsObject()) {
            throw Napi::TypeError::New(info.Env(), std::string(name) + " 必须是对象");
        }
        return info[index].As<Napi::Object>();
    }

    std::string get_string(const Napi::Object& object, const char* key) {
        const auto value = object.Get(key);
        if (!value.IsString()) {
            throw Napi::TypeError::New(object.Env(),
                std::string(key) + " 必须是字符串");
        }
        return value.As<Napi::String>().Utf8Value();
    }

    int get_int(const Napi::Object& object, const char* key, int fallback = 0) {
        const auto value = object.Get(key);
        if (value.IsUndefined()) {
            return fallback;
        }
        if (!value.IsNumber()) {
            throw Napi::TypeError::New(object.Env(), std::string(key) + " 必须是数字");
        }
        return value.As<Napi::Number>().Int32Value();
    }

    bool get_bool(const Napi::Object& object, const char* key,
        bool fallback = false) {
        const auto value = object.Get(key);
        if (value.IsUndefined()) {
            return fallback;
        }
        if (!value.IsBoolean()) {
            throw Napi::TypeError::New(object.Env(),
                std::string(key) + " 必须是布尔值");
        }
        return value.As<Napi::Boolean>().Value();
    }

    void require_shell(const Napi::Env& env) {
        if (!g_shell) {
            throw Napi::Error::New(env, "WebViewNative 尚未初始化");
        }
    }

    WindowPlacement parse_placement(const Napi::Object& options) {
        const std::string placement = get_string(options, "placement");
        if (placement == "center") {
            return WindowPlacement::Center;
        }
        if (placement == "anchor") {
            return WindowPlacement::Anchor;
        }
        if (placement == "bounds") {
            return WindowPlacement::Bounds;
        }
        throw Napi::TypeError::New(options.Env(),
            "placement 必须是 center、anchor 或 bounds");
    }

    Napi::Value initialize_shell(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            if (g_shell) {
                return env.Undefined();
            }
            const Napi::Object options = require_object(info, 0, "options");
            if (info.Length() < 2 || !info[1].IsFunction()) {
                throw Napi::TypeError::New(env, "eventCallback 必须是函数");
            }

            NativeShellConfig config{};
            config.renderer_root = utf8_to_wide(get_string(options, "rendererRoot"));
            config.webview_data_directory =
                utf8_to_wide(get_string(options, "webviewDataDirectory"));
            config.icon_path = utf8_to_wide(get_string(options, "iconPath"));
            config.tray_tooltip = utf8_to_wide(get_string(options, "trayTooltip"));
            config.development = get_bool(options, "development");

            g_event_callback = Napi::ThreadSafeFunction::New(
                env, info[1].As<Napi::Function>(), "WebViewNative events", 0, 1);
            g_event_callback_active = true;
            auto shell = std::make_unique<NativeShell>(g_event_callback);
            shell->start(std::move(config));
            g_shell = std::move(shell);
            return env.Undefined();
        }
        catch (const Napi::Error& error) {
            if (g_event_callback_active && !g_shell) {
                g_event_callback.Release();
                g_event_callback_active = false;
                g_event_callback = {};
            }
            error.ThrowAsJavaScriptException();
            return env.Undefined();
        }
        catch (const std::exception& error) {
            if (g_event_callback_active && !g_shell) {
                g_event_callback.Release();
                g_event_callback_active = false;
                g_event_callback = {};
            }
            Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    Napi::Value open_window(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            require_shell(env);
            const Napi::Object options = require_object(info, 0, "options");
            WindowOpenOptions window{};
            window.id = get_string(options, "id");
            window.pathname = utf8_to_wide(get_string(options, "pathname"));
            window.title = utf8_to_wide(get_string(options, "title"));
            window.base_width = get_int(options, "width");
            window.base_height = get_int(options, "height");
            window.min_width = get_int(options, "minWidth");
            window.min_height = get_int(options, "minHeight");
            window.ui_scale_percent = get_int(options, "uiScalePercent", 100);
            window.anchor_margin = get_int(options, "anchorMargin");
            window.resizable = get_bool(options, "resizable");
            window.always_on_top = get_bool(options, "alwaysOnTop");
            window.skip_taskbar = get_bool(options, "skipTaskbar");
            window.close_on_deactivate = get_bool(options, "closeOnDeactivate");
            window.emit_bounds_changes = get_bool(options, "emitBoundsChanges");
            window.placement = parse_placement(options);

            const auto x = options.Get("x");
            const auto y = options.Get("y");
            if (x.IsNumber() && y.IsNumber()) {
                window.anchor = POINT{ x.As<Napi::Number>().Int32Value(),
                                      y.As<Napi::Number>().Int32Value() };
            }

            const auto bounds_value = options.Get("initialBounds");
            if (bounds_value.IsObject()) {
                const auto bounds = bounds_value.As<Napi::Object>();
                window.initial_bounds = WindowBounds{
                    get_int(bounds, "x"),
                    get_int(bounds, "y"),
                    get_int(bounds, "width"),
                    get_int(bounds, "height"),
                };
            }

            g_shell->open_window(std::move(window));
            return env.Undefined();
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
            return env.Undefined();
        }
        catch (const std::exception& error) {
            Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    Napi::Value close_window(const Napi::CallbackInfo& info) {
        try {
            require_shell(info.Env());
            g_shell->close_window();
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        return info.Env().Undefined();
    }

    Napi::Value start_window_drag(const Napi::CallbackInfo& info) {
        try {
            require_shell(info.Env());
            g_shell->start_window_drag();
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        return info.Env().Undefined();
    }

    Napi::Value post_web_message(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            require_shell(env);
            if (info.Length() < 1 || !info[0].IsString()) {
                throw Napi::TypeError::New(env, "message 必须是字符串");
            }
            g_shell->post_web_message(info[0].As<Napi::String>().Utf8Value());
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value set_window_scale(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            require_shell(env);
            if (info.Length() < 1 || !info[0].IsNumber()) {
                throw Napi::TypeError::New(env, "percent 必须是数字");
            }
            g_shell->set_window_scale(info[0].As<Napi::Number>().Int32Value());
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value reload(const Napi::CallbackInfo& info) {
        try {
            require_shell(info.Env());
            g_shell->reload();
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        return info.Env().Undefined();
    }

    Napi::Value execute_script(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            require_shell(env);
            if (info.Length() < 1 || !info[0].IsString()) {
                throw Napi::TypeError::New(env, "script 必须是字符串");
            }
            g_shell->execute_script(info[0].As<Napi::String>().Utf8Value());
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value set_tray_menu(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            require_shell(env);
            if (info.Length() < 1 || !info[0].IsArray()) {
                throw Napi::TypeError::New(env, "items 必须是数组");
            }

            const Napi::Array array = info[0].As<Napi::Array>();
            std::vector<TrayMenuItem> items;
            items.reserve(array.Length());

            for (std::uint32_t index = 0; index < array.Length(); ++index) {
                const auto value = array.Get(index);
                if (!value.IsObject()) {
                    throw Napi::TypeError::New(env, "托盘菜单项必须是对象");
                }
                const auto object = value.As<Napi::Object>();
                const std::string type = get_string(object, "type");

                TrayMenuItem item{};
                if (type == "separator") {
                    item.kind = TrayMenuItem::Kind::Separator;
                }
                else if (type == "item") {
                    item.kind = TrayMenuItem::Kind::Item;
                    item.id = get_string(object, "id");
                    item.label = utf8_to_wide(get_string(object, "label"));
                    item.enabled = get_bool(object, "enabled", true);
                    item.checked = get_bool(object, "checked", false);
                }
                else {
                    throw Napi::TypeError::New(env,
                        "托盘菜单项 type 必须是 item 或 separator");
                }
                items.push_back(std::move(item));
            }

            g_shell->set_tray_menu(std::move(items));
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        catch (const std::exception& error) {
            Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value open_path(const Napi::CallbackInfo& info) {
        const Napi::Env env = info.Env();
        try {
            require_shell(env);
            if (info.Length() < 1 || !info[0].IsString()) {
                throw Napi::TypeError::New(env, "path 必须是字符串");
            }
            g_shell->open_path(utf8_to_wide(info[0].As<Napi::String>().Utf8Value()));
        }
        catch (const Napi::Error& error) {
            error.ThrowAsJavaScriptException();
        }
        catch (const std::exception& error) {
            Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    void shutdown_shell() {
        if (!g_shell) {
            return;
        }
        g_shell->shutdown();
        g_shell.reset();
        if (g_event_callback_active) {
            g_event_callback.Release();
            g_event_callback_active = false;
            g_event_callback = {};
        }
    }

    Napi::Value shutdown(const Napi::CallbackInfo& info) {
        shutdown_shell();
        return info.Env().Undefined();
    }

    void cleanup_environment(void*) noexcept { shutdown_shell(); }

    Napi::Object initialize(Napi::Env env, Napi::Object exports) {
        napi_add_env_cleanup_hook(env, cleanup_environment, nullptr);
        exports.Set("initialize", Napi::Function::New(env, initialize_shell));
        exports.Set("openWindow", Napi::Function::New(env, open_window));
        exports.Set("closeWindow", Napi::Function::New(env, close_window));
        exports.Set("startWindowDrag", Napi::Function::New(env, start_window_drag));
        exports.Set("postWebMessage", Napi::Function::New(env, post_web_message));
        exports.Set("setWindowScale", Napi::Function::New(env, set_window_scale));
        exports.Set("reload", Napi::Function::New(env, reload));
        exports.Set("executeScript", Napi::Function::New(env, execute_script));
        exports.Set("setTrayMenu", Napi::Function::New(env, set_tray_menu));
        exports.Set("openPath", Napi::Function::New(env, open_path));
        exports.Set("shutdown", Napi::Function::New(env, shutdown));
        return exports;
    }
} // namespace

NODE_API_MODULE(WebViewNative, initialize)
