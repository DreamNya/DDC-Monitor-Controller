#define WIN32_LEAN_AND_MEAN
#include "monitor-identity.h"

#include <windows.h>
#include <wbemidl.h>

#include <algorithm>
#include <cwctype>
#include <utility>

namespace {
    template <typename T>
    class ComPtr final {
    public:
        ~ComPtr() { if (value_ != nullptr) value_->Release(); }
        T** put() { return &value_; }
        T* get() const { return value_; }
        T* operator->() const { return value_; }

    private:
        T* value_ = nullptr;
    };

    class ComApartment final {
    public:
        ComApartment() : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
        ~ComApartment() { if (SUCCEEDED(result_)) CoUninitialize(); }
        bool available() const { return SUCCEEDED(result_) || result_ == RPC_E_CHANGED_MODE; }

    private:
        HRESULT result_;
    };

    class Bstr final {
    public:
        explicit Bstr(const wchar_t* value) : value_(SysAllocString(value)) {}
        ~Bstr() { SysFreeString(value_); }
        BSTR get() const { return value_; }

    private:
        BSTR value_;
    };

    std::wstring lower(std::wstring value) {
        std::transform(value.begin(), value.end(), value.begin(),
            [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
        return value;
    }

    std::wstring read_string(IWbemClassObject* object, const wchar_t* property) {
        VARIANT value;
        VariantInit(&value);
        std::wstring result;
        if (SUCCEEDED(object->Get(property, 0, &value, nullptr, nullptr)) &&
            value.vt == VT_BSTR && value.bstrVal != nullptr) {
            result = value.bstrVal;
        }
        VariantClear(&value);
        return result;
    }

    std::wstring read_uint16_text(IWbemClassObject* object, const wchar_t* property) {
        VARIANT value;
        VariantInit(&value);
        std::wstring result;
        if (SUCCEEDED(object->Get(property, 0, &value, nullptr, nullptr)) &&
            (value.vt & VT_ARRAY) != 0 && value.parray != nullptr) {
            const VARTYPE element_type = static_cast<VARTYPE>(value.vt & VT_TYPEMASK);
            if (element_type == VT_UI2 || element_type == VT_I2 ||
                element_type == VT_UI4 || element_type == VT_I4) {
                LONG first = 0;
                LONG last = -1;
                if (SUCCEEDED(SafeArrayGetLBound(value.parray, 1, &first)) &&
                    SUCCEEDED(SafeArrayGetUBound(value.parray, 1, &last))) {
                    for (LONG index = first; index <= last; ++index) {
                        LONG character = 0;
                        const HRESULT read_result = element_type == VT_I4 || element_type == VT_UI4
                            ? SafeArrayGetElement(value.parray, &index, &character)
                            : [&]() {
                                USHORT short_character = 0;
                                const HRESULT result = SafeArrayGetElement(value.parray, &index, &short_character);
                                character = short_character;
                                return result;
                            }();
                        if (FAILED(read_result) || character <= 0 || character > 0xffff) {
                            break;
                        }
                        result.push_back(static_cast<wchar_t>(character));
                    }
                }
            }
        }
        VariantClear(&value);
        const std::size_t first = result.find_first_not_of(L" \t\r\n");
        if (first == std::wstring::npos) return {};
        const std::size_t last = result.find_last_not_of(L" \t\r\n");
        return result.substr(first, last - first + 1);
    }

    std::wstring instance_name_from_interface(const std::wstring& path) {
        // \\?\DISPLAY#HPN2702#5&...#{GUID} -> DISPLAY\HPN2702\5&...
        const std::wstring normalized_path = lower(path);
        const std::size_t prefix = normalized_path.find(L"display#");
        if (prefix == std::wstring::npos) return {};
        const std::size_t guid = normalized_path.find(L"#{", prefix);
        if (guid == std::wstring::npos) return {};
        std::wstring instance = normalized_path.substr(prefix, guid - prefix);
        std::replace(instance.begin(), instance.end(), L'#', L'\\');
        return instance;
    }
}

std::vector<MonitorIdentity> read_monitor_identities() {
    std::vector<MonitorIdentity> identities;
    const ComApartment apartment;
    if (!apartment.available()) return identities;

    ComPtr<IWbemLocator> locator;
    if (FAILED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER,
        IID_IWbemLocator, reinterpret_cast<void**>(locator.put())))) return identities;

    ComPtr<IWbemServices> services;
    const Bstr name_space(L"ROOT\\WMI");
    if (FAILED(locator->ConnectServer(name_space.get(), nullptr, nullptr, nullptr,
        0, nullptr, nullptr, services.put()))) return identities;

    if (FAILED(CoSetProxyBlanket(services.get(), RPC_C_AUTHN_WINNT,
        RPC_C_AUTHZ_NONE, nullptr, RPC_C_AUTHN_LEVEL_CALL,
        RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE))) return identities;

    // CoInitializeSecurity belongs to the process; the host may already have
    // called it. A local WMI query can use the existing security configuration.
    ComPtr<IEnumWbemClassObject> enumerator;
    const Bstr language(L"WQL");
    const Bstr query(L"SELECT InstanceName, ProductCodeID, SerialNumberID FROM WmiMonitorID WHERE Active = TRUE");
    if (FAILED(services->ExecQuery(language.get(), query.get(),
        WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
        nullptr, enumerator.put()))) return identities;

    if (FAILED(CoSetProxyBlanket(enumerator.get(), RPC_C_AUTHN_WINNT,
        RPC_C_AUTHZ_NONE, nullptr, RPC_C_AUTHN_LEVEL_CALL,
        RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE))) return identities;

    while (true) {
        IWbemClassObject* object = nullptr;
        ULONG returned = 0;
        const HRESULT result = enumerator->Next(5000, 1, &object, &returned);
        if (FAILED(result) || returned == 0 || object == nullptr) break;

        MonitorIdentity identity{
            lower(read_string(object, L"InstanceName")),
            read_uint16_text(object, L"ProductCodeID"),
            read_uint16_text(object, L"SerialNumberID")
        };
        object->Release();
        if (!identity.instance_name.empty()) identities.push_back(std::move(identity));
    }
    return identities;
}

const MonitorIdentity* find_monitor_identity(
    const std::vector<MonitorIdentity>& identities,
    const std::wstring& device_interface_path) {
    const std::wstring instance = instance_name_from_interface(device_interface_path);
    if (instance.empty()) return nullptr;

    const MonitorIdentity* match = nullptr;
    for (const auto& identity : identities) {
        // WmiMonitorID commonly adds _0 to the PnP instance name.
        if (identity.instance_name != instance && identity.instance_name != instance + L"_0") continue;
        if (match != nullptr) return nullptr;
        match = &identity;
    }
    return match;
}
