#pragma once
#include <windows.h>
#include <atomic>
#include "Config.h"
#include "Taskbar.h"
#include "Registry.h"
#include "Renderer.h"

class Window {
private:
    std::atomic<HWND> hwnd{nullptr};
    std::atomic<bool> layoutPending{false};
    UINT taskbarCreatedMessage = 0;
    static constexpr auto LAYOUT_MESSAGE = WM_APP + 1;
    static constexpr auto ANIMATION_TIMER = 1;

    static LRESULT CALLBACK WindowProc(const HWND hwnd, const UINT message, const WPARAM wParam, const LPARAM lParam) {
        if (message == WM_CREATE) {
            const auto create = reinterpret_cast<LPCREATESTRUCT>(lParam);
            const auto window = static_cast<Window *>(create->lpCreateParams);
            SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(window));
        }
        if (const auto that = reinterpret_cast<Window *>(GetWindowLongPtr(hwnd, GWLP_USERDATA))) {
            return that->handleMessage(hwnd, message, wParam, lParam);
        }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    LRESULT handleMessage(const HWND hwnd, const UINT message, const WPARAM wParam, const LPARAM lParam) {
        if (this->taskbarCreatedMessage != 0 && message == this->taskbarCreatedMessage) {
            this->updateLayout();
            return 0;
        }
        switch (message) {
            case WM_CREATE: {
                this->hwnd.store(hwnd, std::memory_order_release);
                this->renderer.onCreate(hwnd);
                this->taskbar.initialize();
                this->taskbar.setListener([this]() { this->updateLayout(); });
                if (this->layoutPending.exchange(false, std::memory_order_acq_rel)) {
                    PostMessage(hwnd, LAYOUT_MESSAGE, 0, 0);
                } else {
                    this->updateLayout();
                }
                break;
            }
            case WM_SIZE: {
                const auto width = LOWORD(lParam);
                const auto height = HIWORD(lParam);
                const auto dpi = GetDpiForWindow(hwnd);
                this->renderer.onSize(width, height, dpi);
                break;
            }
            case WM_DPICHANGED: {
                // 跨显示器拖动 / 系统缩放变化时按系统建议矩形调整窗口，
                // 随后的 WM_SIZE 会以新 DPI 重建渲染目标，保证文字清晰
                const auto suggested = reinterpret_cast<LPRECT>(lParam);
                if (suggested != nullptr) {
                    SetWindowPos(
                        hwnd,
                        nullptr,
                        suggested->left,
                        suggested->top,
                        suggested->right - suggested->left,
                        suggested->bottom - suggested->top,
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER
                    );
                }
                this->updateLayout();
                break;
            }
            case WM_PAINT: {
                PAINTSTRUCT paint{};
                BeginPaint(hwnd, &paint);
                this->renderer.onPaint();
                EndPaint(hwnd, &paint);
                break;
            }
            case LAYOUT_MESSAGE: {
                this->updateWindow();
                this->layoutPending.store(false, std::memory_order_release);
                if (this->renderer.startTransition()) {
                    SetTimer(hwnd, ANIMATION_TIMER, 16, nullptr);
                }
                InvalidateRect(hwnd, nullptr, false);
                break;
            }
            case WM_TIMER: {
                if (wParam == ANIMATION_TIMER) {
                    InvalidateRect(hwnd, nullptr, false);
                    if (!this->renderer.isAnimating()) {
                        KillTimer(hwnd, ANIMATION_TIMER);
                    }
                }
                break;
            }
            case WM_DESTROY: {
                KillTimer(hwnd, ANIMATION_TIMER);
                this->hwnd.store(nullptr, std::memory_order_release);
                break;
            }
            case WM_NCHITTEST: return HTTRANSPARENT;
            case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
            case WM_ERASEBKGND: return 1;
            default: return DefWindowProc(hwnd, message, wParam, lParam);
        }
        return 0;
    }

    void updateWindow() {
        if (!this->taskbar.ensureInitialized()) {
            return;
        }

        const auto taskbarFrame = this->taskbar.getRectForTaskbarFrame();
        const auto trayFrameRect = this->taskbar.getRectForTrayFrame();
        const auto widgetsButtonRect = this->taskbar.getRectForWidgetsButton();
        const auto taskListRect = this->taskbar.getRectForTaskList();
        if (taskbarFrame.right <= taskbarFrame.left || taskbarFrame.bottom <= taskbarFrame.top) {
            if (const auto window = this->hwnd.load(std::memory_order_acquire)) {
                ShowWindow(window, SW_HIDE);
            }
            return;
        }

        const auto snapshot = getConfigSnapshot();

        auto offset = 0L;
        auto width = 0L;
        auto height = 0L;

        switch (snapshot.window_alignment) {
            case TASKBAR_WINDOW_ALIGNMENT::TASKBAR_WINDOW_ALIGNMENT_AUTO: [[fallthrough]];
            case TASKBAR_WINDOW_ALIGNMENT::TASKBAR_WINDOW_ALIGNMENT_LEFT: {
                if (Registry::isTaskbarCentered()) {
                    width += taskListRect.left;
                    if (Registry::isWidgetsEnabled()) {
                        offset += widgetsButtonRect.right;
                    }
                    break;
                }
                [[fallthrough]];
            }
            case TASKBAR_WINDOW_ALIGNMENT::TASKBAR_WINDOW_ALIGNMENT_RIGHT: {
                offset += taskListRect.right;
                if (Registry::isTaskbarCentered()) {
                    width += trayFrameRect.left;
                } else if (Registry::isWidgetsEnabled()) {
                    width += widgetsButtonRect.left;
                } else {
                    width += trayFrameRect.left;
                }
                break;
            }
            case TASKBAR_WINDOW_ALIGNMENT::TASKBAR_WINDOW_ALIGNMENT_CENTER: {
                offset += taskbarFrame.left;
                width += taskbarFrame.right;
                break;
            }
        }

        offset += snapshot.margin_left;
        width -= snapshot.margin_right + offset;
        height += taskbarFrame.bottom - taskbarFrame.top;
        if (width <= 0 || height <= 0) {
            if (const auto window = this->hwnd.load(std::memory_order_acquire)) {
                ShowWindow(window, SW_HIDE);
            }
            return;
        }

        const auto window = this->hwnd.load(std::memory_order_acquire);
        if (window != nullptr) {
            SetWindowPos(
                window,
                HWND_TOPMOST,
                offset,
                taskbarFrame.top,
                width,
                height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING | SWP_SHOWWINDOW
            );
        }
    }

public:
    Renderer renderer{};
    Taskbar taskbar{};

    void create() {
        const auto dll_instance = GetModuleHandle(nullptr);
        const auto class_name = L"taskbar_lyrics";
        this->taskbarCreatedMessage = RegisterWindowMessage(L"TaskbarCreated");
        RegisterClassEx(new WNDCLASSEX{
            .cbSize = sizeof(WNDCLASSEX),
            .lpfnWndProc = Window::WindowProc,
            .hInstance = dll_instance,
            .lpszClassName = class_name,
        });
        CreateWindowEx(
            WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_NOREDIRECTIONBITMAP,
            class_name,
            nullptr,
            WS_POPUP | WS_DISABLED,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            nullptr,
            nullptr,
            dll_instance,
            this
        );
    }

    void runner() {
        MSG msg{};
        while (GetMessage(&msg, nullptr, 0, 0)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
    }

    void updateLayout() {
        if (this->layoutPending.exchange(true, std::memory_order_acq_rel)) {
            return;
        }
        const auto window = this->hwnd.load(std::memory_order_acquire);
        if (window == nullptr) {
            this->layoutPending.store(false, std::memory_order_release);
            return;
        }
        if (!PostMessage(window, LAYOUT_MESSAGE, 0, 0)) {
            this->layoutPending.store(false, std::memory_order_release);
        }
    }

};
