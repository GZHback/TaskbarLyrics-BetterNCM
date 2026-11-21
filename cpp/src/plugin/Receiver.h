#pragma once
#include "Plugin.h"
#include "Config.h"

class Receiver {
public:
    static const char *config(void **args) {
        if (args == nullptr || args[0] == nullptr || args[1] == nullptr) {
            return nullptr;
        }
        const auto key = static_cast<const char *>(args[0]);
        const auto value = static_cast<const char *>(args[1]);
        setConfig(key, value);
        return nullptr;
    }

    static const char *update(void **args) {
        (void)args;
        if (auto *window = Plugin::getInstance().window.load(std::memory_order_acquire)) {
            window->updateLayout();
        }
        return nullptr;
    }

    static const char *lyrics(void **args) {
        if (args == nullptr || args[0] == nullptr || args[1] == nullptr) {
            return nullptr;
        }
        setConfig("lyric_primary", static_cast<const char *>(args[0]));
        setConfig("lyric_secondary", static_cast<const char *>(args[1]));
        if (auto *window = Plugin::getInstance().window.load(std::memory_order_acquire)) {
            window->updateLyrics();
        }
        return nullptr;
    }
};
