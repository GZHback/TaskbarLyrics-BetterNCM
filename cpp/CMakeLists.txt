cmake_minimum_required(VERSION 3.20)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_compile_options(/utf-8 /D_UNICODE /DUNICODE)

project(native LANGUAGES CXX)

add_library(native SHARED "src/DllMain.cpp")

target_include_directories(native PRIVATE src/plugin src/taskbar src/window)

target_link_libraries(native PRIVATE
    d3d11
    d2d1
    dwrite
    dxgi
    dcomp
    ole32
    oleaut32
    uiautomationcore
    user32
)
