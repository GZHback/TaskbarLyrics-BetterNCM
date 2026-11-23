#pragma once
#include <windows.h>
#include <atomic>
#include <thread>
#include "Window.h"

class Plugin {
public:
    HANDLE mutex = nullptr;
    std::atomic<Window *> window{nullptr};

private:
    Plugin() {
        this->mutex = CreateMutex(nullptr, true, L"Global\\Taskbar-Lyrics");
        if (this->mutex == nullptr) {
            return;
        }
        if (GetLastError() == ERROR_ALREADY_EXISTS) {
            CloseHandle(this->mutex);
            this->mutex = nullptr;
        } else {
            this->initialize();
        }
    }

    ~Plugin() {
        if (this->mutex) {
            ReleaseMutex(this->mutex);
            CloseHandle(this->mutex);
            this->mutex = nullptr;
        }
    }

    void initialize() {
        std::thread([this] {
            // 歌词窗口所在线程启用 Per-Monitor-V2 DPI 感知。
            // 宿主进程（网易云渲染进程）是 DPI Unaware：窗口位图按 96 DPI
            // 渲染后由 DWM 拉伸到物理尺寸，在 >100% 缩放下文字明显发糊。
            // 线程级设置只影响本窗口，不干扰网易云自身的 DPI 行为。
            using SetThreadDpiAwarenessContextFn = DPI_AWARENESS_CONTEXT(WINAPI *)(DPI_AWARENESS_CONTEXT);
            if (const auto fn = reinterpret_cast<SetThreadDpiAwarenessContextFn>(
                reinterpret_cast<void *>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetThreadDpiAwarenessContext"))
            ); fn != nullptr) {
                fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            auto *window = new Window();
            this->window.store(window, std::memory_order_release);
            window->create();
            window->runner();
        }).detach();
    }

public:
    static Plugin &getInstance() {
        static Plugin instance;
        return instance;
    }
};
