#pragma once
#include <UIAutomation.h>
#include <atomic>
#include <functional>

class Handler : public IUIAutomationStructureChangedEventHandler {
public:
    typedef std::function<void()> Callback;

private:
    std::atomic<ULONG> refCount{1};
    Handler::Callback callback{};

public:
    Handler(const Handler::Callback &callback) {
        this->callback = callback;
    }

    ULONG AddRef() override {
        return ++this->refCount;
    }

    ULONG Release() override {
        const auto count = --this->refCount;
        if (count == 0) {
            delete this;
        }
        return count;
    }

    HRESULT QueryInterface(const IID &riid, void **ppvObject) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IUIAutomationStructureChangedEventHandler)) {
            *ppvObject = static_cast<IUIAutomationStructureChangedEventHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppvObject = nullptr;
        return E_NOINTERFACE;
    }

    HRESULT HandleStructureChangedEvent(IUIAutomationElement *sender, StructureChangeType changeType, SAFEARRAY *runtimeId) override {
        (void)sender;
        (void)changeType;
        (void)runtimeId;
        if (this->callback) {
            this->callback();
        }
        return S_OK;
    }
};
