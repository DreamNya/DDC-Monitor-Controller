cmake_minimum_required(VERSION 3.20)
project(MonitorDdc LANGUAGES CXX)

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_library(MonitorDdc SHARED monitor_ddc.cpp monitor_ddc.h)
target_compile_features(MonitorDdc PRIVATE cxx_std_20)
target_compile_definitions(MonitorDdc PRIVATE MONITOR_DDC_EXPORTS UNICODE _UNICODE)
target_compile_options(MonitorDdc PRIVATE /W4 /permissive-)
target_link_libraries(MonitorDdc PRIVATE Dxva2 User32)
set_target_properties(MonitorDdc PROPERTIES OUTPUT_NAME "MonitorDdc")
