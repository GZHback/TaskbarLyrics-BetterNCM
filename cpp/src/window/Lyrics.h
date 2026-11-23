#pragma once
#include <d2d1.h>
#include <dwrite.h>
#include <wrl/client.h>
#include <string>
#include "Config.h"

class Lyrics {
private:
    ID2D1RenderTarget *render = nullptr;
    IDWriteFactory *dwrite = nullptr;
    Microsoft::WRL::ComPtr<IDWriteTextFormat> format1{};
    Microsoft::WRL::ComPtr<IDWriteTextFormat> format2{};
    Microsoft::WRL::ComPtr<IDWriteTextLayout> layout1{};
    Microsoft::WRL::ComPtr<IDWriteTextLayout> layout2{};
    DWRITE_TEXT_METRICS metrics1{};
    DWRITE_TEXT_METRICS metrics2{};

public:
    Lyrics(ID2D1RenderTarget *render, IDWriteFactory *dwrite) {
        this->render = render;
        this->dwrite = dwrite;
    }

    void onDraw(
        const std::wstring &primary,
        const std::wstring &secondary,
        const float opacity = 1.f,
        const float offsetX = 0.f,
        const float offsetY = 0.f
    ) {
        if (this->render == nullptr || this->dwrite == nullptr || opacity <= 0.f) {
            return;
        }

        this->format1.Reset();
        this->format2.Reset();
        this->layout1.Reset();
        this->layout2.Reset();

        const auto [width, height] = this->render->GetSize();
        const auto snapshot = getConfigSnapshot();
        const auto primaryText = primary.empty() ? std::wstring(L" ") : primary;
        const auto secondaryText = secondary.empty() ? std::wstring(L" ") : secondary;

        const auto createFormats = [&](const std::wstring &fontFamily) {
            this->format1.Reset();
            this->format2.Reset();
            return SUCCEEDED(this->dwrite->CreateTextFormat(
                fontFamily.data(),
                nullptr,
                snapshot.weight_primary,
                snapshot.slope_primary,
                DWRITE_FONT_STRETCH_NORMAL,
                (float)snapshot.size_primary,
                L"zh-CN",
                &this->format1
            )) && SUCCEEDED(this->dwrite->CreateTextFormat(
                fontFamily.data(),
                nullptr,
                snapshot.weight_secondary,
                snapshot.slope_secondary,
                DWRITE_FONT_STRETCH_NORMAL,
                (float)snapshot.size_secondary,
                L"zh-CN",
                &this->format2
            )) && this->format1 && this->format2;
        };

        if (!createFormats(snapshot.font_family) && !createFormats(L"Microsoft YaHei UI")) {
            return;
        }

        if (FAILED(this->dwrite->CreateTextLayout(primaryText.data(), (UINT32)primaryText.size(), this->format1.Get(), width, height, &this->layout1)) ||
            FAILED(this->dwrite->CreateTextLayout(secondaryText.data(), (UINT32)secondaryText.size(), this->format2.Get(), width, height, &this->layout2)) ||
            !this->layout1 || !this->layout2) {
            return;
        }
        this->layout1->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        this->layout2->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        this->layout1->SetTextAlignment(snapshot.align_primary);
        this->layout2->SetTextAlignment(snapshot.align_secondary);
        this->layout1->SetUnderline(snapshot.underline_primary, DWRITE_TEXT_RANGE(0, (UINT32)primaryText.size()));
        this->layout2->SetUnderline(snapshot.underline_secondary, DWRITE_TEXT_RANGE(0, (UINT32)secondaryText.size()));
        this->layout1->SetStrikethrough(snapshot.strikethrough_primary, DWRITE_TEXT_RANGE(0, (UINT32)primaryText.size()));
        this->layout2->SetStrikethrough(snapshot.strikethrough_secondary, DWRITE_TEXT_RANGE(0, (UINT32)secondaryText.size()));
        this->layout1->GetMetrics(&metrics1);
        this->layout2->GetMetrics(&metrics2);

        // 固定堆叠布局 + 用户可调行间距：副歌词行盒顶部 = 主歌词行盒底部 + line_spacing
        // （负值更紧凑，正值拉开间距；行间距一并计入垂直居中）
        const auto spacing = static_cast<float>(snapshot.line_spacing);
        auto margin = (height - this->metrics1.height - this->metrics2.height - spacing) / 2;
        if (margin < 0.f) {
            margin = 0.f;
        }
        const auto rect1 = D2D1::RectF(
            margin + offsetX,
            margin + offsetY,
            width - margin + offsetX,
            margin + this->metrics1.height + offsetY
        );
        const auto rect2 = D2D1::RectF(rect1.left, rect1.bottom + spacing, rect1.right, rect1.bottom + spacing + this->metrics2.height);

        this->drawText(rect1, this->layout1.Get(), snapshot.color_primary, opacity);
        this->drawActiveGlow(rect1, this->layout1.Get(), static_cast<UINT32>(primaryText.size()), snapshot, opacity);
        this->drawText(rect2, this->layout2.Get(), snapshot.color_secondary, opacity);
    }

    void drawText(
        const D2D1_RECT_F &rect,
        IDWriteTextLayout *layout,
        const unsigned int color,
        const float opacity
    ) {
        Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> brush{};
        const auto alpha = (color >> 24 & 0xFF) / 255.f * opacity;
        this->render->CreateSolidColorBrush(D2D1::ColorF(color, alpha), &brush);
        this->render->PushAxisAlignedClip(rect, D2D1_ANTIALIAS_MODE_ALIASED);
        this->render->DrawTextLayout(
            D2D1::Point2F(rect.left, rect.top),
            layout,
            brush.Get(),
            D2D1_DRAW_TEXT_OPTIONS_NO_SNAP | D2D1_DRAW_TEXT_OPTIONS_DISABLE_COLOR_BITMAP_SNAPPING | D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT
        );
        this->render->PopAxisAlignedClip();
    }

    /**
     * 逐字高亮（卡拉OK）：把当前唱到的字用高亮色绘制，并在其周围叠加柔和光晕。
     *
     * 光晕用径向渐变椭圆实现（中心较亮、边缘透明），不会出现整行文字平移导致
     * 的重影；高亮字用 DirectWrite 的 SetDrawingEffect 只作用于活动字符范围。
     */
    void drawActiveGlow(
        const D2D1_RECT_F &rect,
        IDWriteTextLayout *layout,
        const UINT32 textLength,
        const Config &snapshot,
        const float opacity
    ) {
        if (!snapshot.karaoke_enabled || snapshot.active_offset < 0 || snapshot.active_length <= 0) {
            return;
        }
        const auto offset = static_cast<UINT32>(snapshot.active_offset);
        const auto length = static_cast<UINT32>(snapshot.active_length);
        if (offset >= textLength || offset + length > textLength) {
            return;
        }

        DWRITE_HIT_TEST_METRICS hit{};
        UINT32 actualCount = 0;
        if (FAILED(layout->HitTestTextRange(offset, length, rect.left, rect.top, &hit, 1, &actualCount)) || actualCount == 0) {
            return;
        }

        const auto r = (snapshot.color_primary >> 16) & 0xFF;
        const auto g = (snapshot.color_primary >> 8) & 0xFF;
        const auto b = snapshot.color_primary & 0xFF;
        const auto rf = r / 255.f;
        const auto gf = g / 255.f;
        const auto bf = b / 255.f;

        const auto options =
            D2D1_DRAW_TEXT_OPTIONS_NO_SNAP |
            D2D1_DRAW_TEXT_OPTIONS_DISABLE_COLOR_BITMAP_SNAPPING |
            D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT;

        const auto glow = snapshot.karaoke_glow > 100 ? 100 : snapshot.karaoke_glow;
        const auto glow01 = glow / 100.f;

        // 1) 柔和光晕：活动字中心的径向渐变椭圆
        if (glow01 > 0.f) {
            const auto cx = rect.left + hit.left + hit.width * 0.5f;
            const auto cy = rect.top + hit.top + hit.height * 0.5f;
            const auto radiusX = hit.width * 0.9f + glow01 * 10.f;
            const auto radiusY = hit.height * 0.9f + glow01 * 8.f;
            const auto centerAlpha = 0.45f * glow01 * opacity;

            D2D1_GRADIENT_STOP stops[2] = {
                {0.f, D2D1::ColorF(rf, gf, bf, centerAlpha)},
                {1.f, D2D1::ColorF(rf, gf, bf, 0.f)},
            };
            Microsoft::WRL::ComPtr<ID2D1GradientStopCollection> stopsCollection{};
            if (SUCCEEDED(this->render->CreateGradientStopCollection(stops, 2, &stopsCollection))) {
                const auto props = D2D1::RadialGradientBrushProperties(
                    D2D1::Point2F(cx, cy), D2D1::Point2F(cx, cy), radiusX, radiusY
                );
                Microsoft::WRL::ComPtr<ID2D1RadialGradientBrush> glowBrush{};
                if (SUCCEEDED(this->render->CreateRadialGradientBrush(props, stopsCollection.Get(), &glowBrush))) {
                    this->render->FillEllipse(
                        D2D1::Ellipse(D2D1::Point2F(cx, cy), radiusX, radiusY),
                        glowBrush.Get()
                    );
                }
            }
        }

        // 2) 高亮当前字：默认画刷画整行普通色，SetDrawingEffect 只让活动字用提亮色
        const auto brighten = [](float c) { return c + (1.f - c) * 0.55f; };
        Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> normalBrush{};
        Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> highlightBrush{};
        if (FAILED(this->render->CreateSolidColorBrush(
            D2D1::ColorF(rf, gf, bf, opacity), &normalBrush
        )) || FAILED(this->render->CreateSolidColorBrush(
            D2D1::ColorF(brighten(rf), brighten(gf), brighten(bf), opacity),
            &highlightBrush
        ))) {
            return;
        }
        const DWRITE_TEXT_RANGE range{offset, length};
        layout->SetDrawingEffect(highlightBrush.Get(), range);
        this->render->DrawTextLayout(
            D2D1::Point2F(rect.left, rect.top), layout, normalBrush.Get(), options
        );
        layout->SetDrawingEffect(nullptr, range);
    }
};
