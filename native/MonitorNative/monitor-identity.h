#pragma once

#include <string>
#include <vector>

struct MonitorIdentity {
    std::wstring instance_name;
    std::wstring product_code;
    std::wstring serial_number;
};

// WMI may be unavailable on some systems; an empty result leaves the existing
// display-path identity in place.
std::vector<MonitorIdentity> read_monitor_identities();

// EnumDisplayDevices(EDD_GET_DEVICE_INTERFACE_NAME) returns a SetupAPI path.
// Match it to WmiMonitorID.InstanceName without relying on enumeration order.
const MonitorIdentity* find_monitor_identity(
    const std::vector<MonitorIdentity>& identities,
    const std::wstring& device_interface_path);
