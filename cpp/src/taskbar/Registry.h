#pragma once
#include <windows.h>
#include <functional>

class Registry {
public:
    typedef std::function<void()> Callback;

    static void onWatch(const Registry::Callback &callback) {
        HKEY key = nullptr;
        HANDLE event = CreateEventW(nullptr, true, false, nullptr);
        if (event == nullptr || RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion", 0, KEY_NOTIFY, &key) != ERROR_SUCCESS || key == nullptr) {
            if (event != nullptr) {
                CloseHandle(event);
            }
            return;
        }
        while (RegNotifyChangeKeyValue(key, true, REG_NOTIFY_CHANGE_LAST_SET, event, true) == ERROR_SUCCESS) {
            if (WaitForSingleObject(event, INFINITE) != WAIT_OBJECT_0) {
                break;
            }
            ResetEvent(event);
            if (callback) {
                callback();
            }
        }
        RegCloseKey(key);
        CloseHandle(event);
    }

    // Windows 11（build >= 22000）判定，用于注册表值缺失时的默认行为
    static bool isWindows11() {
        RTL_OSVERSIONINFOW info{};
        info.dwOSVersionInfoSize = sizeof(info);
        using RtlGetVersionFn = LONG(WINAPI *)(RTL_OSVERSIONINFOW *);
        if (const auto fn = reinterpret_cast<RtlGetVersionFn>(
            reinterpret_cast<void *>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"))
        ); fn != nullptr && fn(&info) == 0) {
            return info.dwBuildNumber >= 22000;
        }
        return false;
    }

    // TaskbarAl：仅当用户手动切换过任务栏对齐时才会写入。
    // 值缺失时按 Win11 默认行为处理（任务栏居中），否则 LEFT 对齐会
    // 被误判为“任务栏未居中”而落入 RIGHT 分支。
    static bool isTaskbarCentered() {
        const auto path = L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
        const auto name = L"TaskbarAl";
        DWORD data = 0;
        DWORD size = sizeof(data);
        if (RegGetValue(HKEY_CURRENT_USER, path, name, RRF_RT_REG_DWORD, nullptr, &data, &size) != ERROR_SUCCESS) {
            return isWindows11();
        }
        return data;
    }

    // TaskbarDa：值缺失时按 Win11 默认行为处理（小组件开启）。
    static bool isWidgetsEnabled() {
        const auto path = L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
        const auto name = L"TaskbarDa";
        DWORD data = 0;
        DWORD size = sizeof(data);
        if (RegGetValue(HKEY_CURRENT_USER, path, name, RRF_RT_REG_DWORD, nullptr, &data, &size) != ERROR_SUCCESS) {
            return isWindows11();
        }
        return data;
    }
};
