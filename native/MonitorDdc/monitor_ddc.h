#pragma once

#include <cstdint>

#ifdef MONITOR_DDC_EXPORTS
#define MONITOR_DDC_API extern "C" __declspec(dllexport)
#else
#define MONITOR_DDC_API extern "C" __declspec(dllimport)
#endif

MONITOR_DDC_API std::uint32_t __cdecl mc_refresh(std::uint32_t* count);
MONITOR_DDC_API std::uint32_t __cdecl mc_get_monitor_id(
    std::uint32_t index,
    char* buffer,
    std::uint32_t buffer_size
);
MONITOR_DDC_API std::uint32_t __cdecl mc_get_monitor_name(
    std::uint32_t index,
    char* buffer,
    std::uint32_t buffer_size
);
MONITOR_DDC_API std::uint32_t __cdecl mc_get_vcp_value(
    std::uint32_t index,
    std::uint8_t code,
    std::uint32_t* current,
    std::uint32_t* maximum
);
MONITOR_DDC_API std::uint32_t __cdecl mc_set_vcp_value(
    std::uint32_t index,
    std::uint8_t code,
    std::uint32_t value
);
MONITOR_DDC_API std::uint32_t __cdecl mc_format_error(
    std::uint32_t code,
    char* buffer,
    std::uint32_t buffer_size
);
MONITOR_DDC_API void __cdecl mc_shutdown();
