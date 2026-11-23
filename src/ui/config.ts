/**
 * 配置界面构建（原生 DOM，不依赖 React / JSX）。
 *
 * 视觉风格参考 BetterNCM 现代插件设置页：
 * - 顶部大标题 + 左侧竖线分组标题；
 * - 每个配置项为一个圆角行卡片：图标 + 标题/描述 + 右侧控件；
 * - 布尔项使用 toggle 开关样式；
 * - 通过 CSS 变量实现亮 / 暗两套配色，自动跟随系统主题。
 */
import {
    config,
    DEFAULT_CONFIG,
    DWRITE_FONT_STYLE,
    DWRITE_FONT_WEIGHT,
    DWRITE_TEXT_ALIGNMENT,
    TASKBAR_WINDOW_ALIGNMENT,
    updateConfig,
} from "../config";
import type { PluginConfig } from "../config";
import { getCachedFonts, getDefaultFonts, getInstalledFonts } from "../fonts";
import type { FontOption } from "../fonts";

// ============ 主题 ============

const LIGHT_VARS: Record<string, string> = {
    "--tl-text": "#333333",
    "--tl-sub-text": "#8c8c8c",
    "--tl-accent": "#1890ff",
    "--tl-row-bg": "#ffffff",
    "--tl-row-hover": "#f5f6f8",
    "--tl-control-bg": "#ffffff",
    "--tl-control-border": "#d9d9d9",
    "--tl-switch-off": "#d9d9d9",
};

const DARK_VARS: Record<string, string> = {
    "--tl-text": "#e8e8ea",
    "--tl-sub-text": "#8b8b93",
    "--tl-accent": "#4096ff",
    "--tl-row-bg": "#2a2a30",
    "--tl-row-hover": "#33333a",
    "--tl-control-bg": "#232328",
    "--tl-control-border": "#3f3f46",
    "--tl-switch-off": "#4a4a52",
};

/** 读取 Windows 系统主题并应用到配置界面 */
async function applySystemTheme(container: HTMLElement): Promise<void> {
    let isLight = true;
    try {
        const result = await betterncm.app.isLightTheme();
        isLight =
            result === true ||
            result === 1 ||
            result === "true" ||
            result === "1";
    } catch (error) {
        console.warn("[TaskBarLyrics] 检测系统主题失败，使用亮色:", error);
    }
    const vars = isLight ? LIGHT_VARS : DARK_VARS;
    for (const [key, value] of Object.entries(vars)) {
        container.style.setProperty(key, value);
    }
}

// ============ 图标（内联 SVG，跟随主题色） ============

function createIcon(kind: string): HTMLElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.style.cssText =
        "flex: 0 0 20px; margin-right: 14px; color: var(--tl-sub-text);";
    const shapes: Record<string, string> = {
        font: `<text x="3" y="17" font-size="14" font-weight="600" fill="currentColor" font-family="sans-serif">Aa</text>`,
        "margin-left": `<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="6" width="7" height="12" rx="1" fill="currentColor" opacity="0.45"/>`,
        "margin-right": `<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="6" width="7" height="12" rx="1" fill="currentColor" opacity="0.45"/>`,
        "align-window": `<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="6" width="6" height="12" rx="1" fill="currentColor" opacity="0.45"/>`,
        color: `<path d="M12 3 C12 3 6 10 6 14 a6 6 0 0 0 12 0 C18 10 12 3 12 3 Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 14 a3 3 0 0 0 3 3" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
        size: `<text x="2" y="18" font-size="16" font-weight="700" fill="currentColor" font-family="sans-serif">A</text><text x="15" y="18" font-size="10" fill="currentColor" font-family="sans-serif">a</text>`,
        weight: `<text x="6" y="18" font-size="15" font-weight="800" fill="currentColor" font-family="sans-serif">B</text>`,
        slope: `<text x="8" y="18" font-size="15" font-style="italic" fill="currentColor" font-family="sans-serif">I</text>`,
        underline: `<text x="7" y="13" font-size="12" fill="currentColor" font-family="sans-serif">U</text><rect x="6" y="16" width="12" height="2" rx="1" fill="currentColor"/>`,
        strike: `<text x="7" y="17" font-size="12" fill="currentColor" font-family="sans-serif">S</text><rect x="5" y="10" width="14" height="2" rx="1" fill="currentColor"/>`,
        align: `<rect x="4" y="5" width="16" height="2" rx="1" fill="currentColor"/><rect x="4" y="10" width="10" height="2" rx="1" fill="currentColor"/><rect x="4" y="15" width="14" height="2" rx="1" fill="currentColor"/>`,
        link: `<path d="M9 15l6-6M11 7l1.5-1.5a3.5 3.5 0 0 1 5 5L15 13M13 17l-1.5 1.5a3.5 3.5 0 0 1-5-5L9 11" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
    };
    svg.innerHTML = shapes[kind] ?? `<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
    return svg;
}

// ============ 基础控件 ============

function createRow(
    icon: string,
    title: string,
    subtitle: string,
    control: HTMLElement,
): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = `
        display: flex;
        align-items: center;
        margin-bottom: 8px;
        padding: 12px 16px;
        border-radius: 10px;
        background-color: var(--tl-row-bg);
        transition: background-color .15s;
    `;
    row.addEventListener("mouseenter", () => {
        row.style.backgroundColor = "var(--tl-row-hover)";
    });
    row.addEventListener("mouseleave", () => {
        row.style.backgroundColor = "var(--tl-row-bg)";
    });

    row.appendChild(createIcon(icon));

    const textWrap = document.createElement("div");
    textWrap.style.cssText = "flex: 1; min-width: 0;";
    const titleElem = document.createElement("div");
    titleElem.textContent = title;
    titleElem.style.cssText = `
        font-size: 14px;
        font-weight: 500;
        color: var(--tl-text);
    `;
    const subElem = document.createElement("div");
    subElem.textContent = subtitle;
    subElem.style.cssText = `
        font-size: 12px;
        color: var(--tl-sub-text);
        margin-top: 3px;
    `;
    textWrap.appendChild(titleElem);
    textWrap.appendChild(subElem);
    row.appendChild(textWrap);

    const controlWrap = document.createElement("div");
    controlWrap.style.cssText =
        "flex: 0 0 auto; margin-left: 16px; display: flex; align-items: center;";
    controlWrap.appendChild(control);
    row.appendChild(controlWrap);
    return row;
}

function createSelect(
    options: string[] | FontOption[] | Record<string | number, string>,
    currentValue: string | number,
    onChange: (value: string) => void,
    minWidth = "150px",
): HTMLSelectElement {
    const select = document.createElement("select");
    select.style.cssText = `
        padding: 7px 12px;
        border: 1px solid var(--tl-control-border);
        border-radius: 6px;
        min-width: ${minWidth};
        background-color: var(--tl-control-bg);
        color: var(--tl-text);
        font-size: 13px;
        cursor: pointer;
        outline: none;
    `;
    const entries: [string, string][] = Array.isArray(options)
        ? (options as Array<string | FontOption>).map((option) =>
              Array.isArray(option) ? option : [option, option],
          )
        : Object.entries(options).map(([value, text]) => [value, text]);
    for (const [value, text] of entries) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        option.selected = value == String(currentValue);
        select.appendChild(option);
    }
    select.addEventListener("change", () => onChange(select.value));
    return select;
}

/** 用新的字体列表重建 select 的选项，保持当前选中值（值为英文名，显示中文名） */
function fillFontSelect(select: HTMLSelectElement, fonts: FontOption[]): void {
    const currentValue = config.font_family;
    const list = fonts.some((font) => font[0] === currentValue)
        ? fonts
        : [[currentValue, currentValue] as FontOption, ...fonts];
    select.replaceChildren();
    for (const [value, label] of list) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === currentValue;
        select.appendChild(option);
    }
}

/** 滑杆控件：拖动实时触发 onChange，右侧显示当前数值 */
function createSlider(
    currentValue: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
): HTMLElement {
    const container = document.createElement("div");
    container.style.cssText =
        "display: flex; align-items: center; gap: 10px;";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(currentValue);
    input.style.cssText =
        "width: 150px; accent-color: var(--tl-accent); cursor: pointer;";
    const label = document.createElement("span");
    label.textContent = String(currentValue);
    label.style.cssText =
        "min-width: 26px; text-align: right; font-size: 13px; color: var(--tl-text);";
    input.addEventListener("input", () => {
        const value = parseInt(input.value, 10);
        label.textContent = String(value);
        onChange(value);
    });
    container.appendChild(input);
    container.appendChild(label);
    return container;
}

/** 可点击的外部链接控件（用 betterncm.ncm.openUrl 打开浏览器） */
function createLinkControl(url: string): HTMLElement {
    const link = document.createElement("a");
    link.textContent = "打开 ↗";
    link.style.cssText = `
        padding: 7px 14px;
        border: 1px solid var(--tl-control-border);
        border-radius: 6px;
        background-color: var(--tl-control-bg);
        color: var(--tl-accent);
        font-size: 13px;
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;
    `;
    link.addEventListener("click", () => {
        try {
            betterncm.ncm.openUrl(url);
        } catch (error) {
            console.error("[Taskbar Lyrics] 打开链接失败:", error);
        }
    });
    return link;
}

function createNumberInput(
    currentValue: number,
    onChange: (value: number) => void,
    minWidth = "90px",
): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(currentValue);
    input.style.cssText = `
        padding: 7px 12px;
        border: 1px solid var(--tl-control-border);
        border-radius: 6px;
        min-width: ${minWidth};
        background-color: var(--tl-control-bg);
        color: var(--tl-text);
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
    `;
    input.addEventListener("change", () => onChange(parseInt(input.value, 10)));
    return input;
}

/** toggle 开关（替代原生 checkbox） */
function createSwitch(
    checked: boolean,
    onChange: (value: boolean) => void,
): HTMLElement {
    const label = document.createElement("label");
    label.style.cssText =
        "position: relative; display: inline-block; width: 42px; height: 24px; cursor: pointer;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.style.cssText = "opacity: 0; width: 0; height: 0; position: absolute;";
    const slider = document.createElement("span");
    slider.style.cssText =
        "position: absolute; inset: 0; border-radius: 12px; transition: background-color .2s;";
    const dot = document.createElement("span");
    dot.style.cssText = `
        position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
        border-radius: 50%; background-color: #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .2s;
    `;
    slider.appendChild(dot);
    const update = () => {
        slider.style.backgroundColor = input.checked
            ? "var(--tl-accent)"
            : "var(--tl-switch-off)";
        dot.style.transform = input.checked ? "translateX(18px)" : "translateX(0)";
    };
    input.addEventListener("change", () => {
        update();
        onChange(input.checked);
    });
    update();
    label.appendChild(input);
    label.appendChild(slider);
    return label;
}

function createColorPicker(
    currentColor: number,
    onChange: (value: number) => void,
): HTMLElement {
    const container = document.createElement("div");
    container.style.cssText = "display: flex; align-items: center;";

    const alpha = (currentColor >> 24) & 0xff;
    const r = (currentColor >> 16) & 0xff;
    const g = (currentColor >> 8) & 0xff;
    const b = currentColor & 0xff;

    const colorPicker = document.createElement("input");
    colorPicker.type = "color";
    colorPicker.value = `#${r.toString(16).padStart(2, "0")}${g
        .toString(16)
        .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    colorPicker.style.cssText = `
        width: 42px;
        height: 28px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        background: none;
        padding: 0;
    `;

    const alphaLabel = document.createElement("span");
    alphaLabel.textContent = "透明度";
    alphaLabel.style.cssText =
        "margin: 0 8px 0 14px; font-size: 12px; color: var(--tl-sub-text);";

    const alphaInput = document.createElement("input");
    alphaInput.type = "number";
    alphaInput.min = "0";
    alphaInput.max = "255";
    alphaInput.value = String(alpha);
    alphaInput.style.cssText = `
        width: 64px;
        padding: 7px 10px;
        border: 1px solid var(--tl-control-border);
        border-radius: 6px;
        background-color: var(--tl-control-bg);
        color: var(--tl-text);
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
    `;

    const updateColor = () => {
        const hex = colorPicker.value.substring(1);
        const rgb = parseInt(hex, 16);
        const a = parseInt(alphaInput.value, 10) & 0xff;
        onChange((a << 24) | rgb);
    };

    colorPicker.addEventListener("change", updateColor);
    alphaInput.addEventListener("change", updateColor);

    container.appendChild(colorPicker);
    container.appendChild(alphaLabel);
    container.appendChild(alphaInput);
    return container;
}

// ============ 标题 ============

function createPageTitle(title: string): HTMLElement {
    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.cssText = `
        font-size: 20px;
        font-weight: 700;
        color: var(--tl-text);
        margin: 0 0 6px;
    `;
    return heading;
}

function createSectionTitle(title: string): HTMLElement {
    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.cssText = `
        font-size: 15px;
        font-weight: 600;
        color: var(--tl-text);
        margin: 22px 0 10px;
        padding-left: 10px;
        border-left: 3px solid var(--tl-accent);
        line-height: 1.3;
    `;
    return heading;
}

// ============ 配置界面 ============

/** 构建界面全部内容（可重复调用以重建） */
function buildContent(container: HTMLElement): void {
    container.appendChild(createPageTitle("TaskBarLyrics 设置"));

    // 字体下拉框：先用内置 / 缓存列表，后台重新枚举系统字体
    const fontSelect = createSelect(
        getCachedFonts() ?? getDefaultFonts(),
        config.font_family,
        (value) => {
            config.font_family = value;
            updateConfig();
        },
        "220px",
    );
    getInstalledFonts().then((fonts) => fillFontSelect(fontSelect, fonts));

    // 通用设置
    container.appendChild(createSectionTitle("通用设置"));
    container.appendChild(
        createRow("font", "字体", "歌词文本使用的字体家族", fontSelect),
    );
    container.appendChild(
        createRow(
            "size",
            "行间距",
            "主歌词与副歌词之间的间距",
            createSlider(config.line_spacing, -10, 20, 1, (value) => {
                config.line_spacing = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "font",
            "逐字高亮",
            "当前唱到的字高亮发光（卡拉OK，仅逐字歌词可用）",
            createSwitch(config.karaoke_enabled, (value) => {
                config.karaoke_enabled = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "weight",
            "光晕强度",
            "逐字高亮的光晕强弱",
            createSlider(config.karaoke_glow, 0, 100, 5, (value) => {
                config.karaoke_glow = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "margin-left",
            "左边距",
            "歌词窗口左侧留出的空白距离（像素）",
            createNumberInput(config.margin_left, (value) => {
                config.margin_left = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "margin-right",
            "右边距",
            "歌词窗口右侧留出的空白距离（像素）",
            createNumberInput(config.margin_right, (value) => {
                config.margin_right = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "align-window",
            "窗口对齐方式",
            "歌词窗口在任务栏上的排布位置",
            createSelect(
                {
                    [TASKBAR_WINDOW_ALIGNMENT.AUTO]: "自动",
                    [TASKBAR_WINDOW_ALIGNMENT.LEFT]: "左对齐",
                    [TASKBAR_WINDOW_ALIGNMENT.CENTER]: "居中",
                    [TASKBAR_WINDOW_ALIGNMENT.RIGHT]: "右对齐",
                },
                config.window_alignment,
                (value) => {
                    config.window_alignment = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );

    // 主要歌词设置
    container.appendChild(createSectionTitle("主要歌词设置"));
    container.appendChild(
        createRow(
            "color",
            "颜色",
            "主要歌词的颜色与不透明度",
            createColorPicker(config.color_primary, (value) => {
                config.color_primary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "size",
            "字体大小",
            "主要歌词的字号（像素）",
            createNumberInput(config.size_primary, (value) => {
                config.size_primary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "weight",
            "字体粗细",
            "主要歌词的笔画粗细",
            createSelect(
                {
                    [DWRITE_FONT_WEIGHT.THIN]: "极细",
                    [DWRITE_FONT_WEIGHT.LIGHT]: "细体",
                    [DWRITE_FONT_WEIGHT.NORMAL]: "正常",
                    [DWRITE_FONT_WEIGHT.MEDIUM]: "中等",
                    [DWRITE_FONT_WEIGHT.BOLD]: "粗体",
                    [DWRITE_FONT_WEIGHT.BLACK]: "超粗",
                },
                config.weight_primary,
                (value) => {
                    config.weight_primary = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );
    container.appendChild(
        createRow(
            "slope",
            "字体样式",
            "正常 / 斜体 / 强制倾斜",
            createSelect(
                {
                    [DWRITE_FONT_STYLE.NORMAL]: "正常",
                    [DWRITE_FONT_STYLE.ITALIC]: "斜体（字体包含的设计）",
                    [DWRITE_FONT_STYLE.OBLIQUE]: "倾斜（强制将字符倾斜）",
                },
                config.slope_primary,
                (value) => {
                    config.slope_primary = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );
    container.appendChild(
        createRow(
            "underline",
            "下划线",
            "为主要歌词添加下划线",
            createSwitch(config.underline_primary, (value) => {
                config.underline_primary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "strike",
            "删除线",
            "为主要歌词添加删除线",
            createSwitch(config.strikethrough_primary, (value) => {
                config.strikethrough_primary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "align",
            "文本对齐",
            "主要歌词在窗口内的对齐方向",
            createSelect(
                {
                    [DWRITE_TEXT_ALIGNMENT.LEADING]: "左对齐",
                    [DWRITE_TEXT_ALIGNMENT.CENTER]: "居中",
                    [DWRITE_TEXT_ALIGNMENT.TRAILING]: "右对齐",
                    [DWRITE_TEXT_ALIGNMENT.JUSTIFIED]: "两端对齐",
                },
                config.align_primary,
                (value) => {
                    config.align_primary = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );

    // 次要歌词设置
    container.appendChild(createSectionTitle("次要歌词设置"));
    container.appendChild(
        createRow(
            "color",
            "颜色",
            "次要歌词（翻译或下一句）的颜色与不透明度",
            createColorPicker(config.color_secondary, (value) => {
                config.color_secondary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "size",
            "字体大小",
            "次要歌词的字号（像素）",
            createNumberInput(config.size_secondary, (value) => {
                config.size_secondary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "weight",
            "字体粗细",
            "次要歌词的笔画粗细",
            createSelect(
                {
                    [DWRITE_FONT_WEIGHT.THIN]: "极细",
                    [DWRITE_FONT_WEIGHT.LIGHT]: "细体",
                    [DWRITE_FONT_WEIGHT.NORMAL]: "正常",
                    [DWRITE_FONT_WEIGHT.MEDIUM]: "中等",
                    [DWRITE_FONT_WEIGHT.BOLD]: "粗体",
                    [DWRITE_FONT_WEIGHT.BLACK]: "超粗",
                },
                config.weight_secondary,
                (value) => {
                    config.weight_secondary = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );
    container.appendChild(
        createRow(
            "slope",
            "字体样式",
            "正常 / 斜体 / 强制倾斜",
            createSelect(
                {
                    [DWRITE_FONT_STYLE.NORMAL]: "正常",
                    [DWRITE_FONT_STYLE.ITALIC]: "斜体（字体包含的设计）",
                    [DWRITE_FONT_STYLE.OBLIQUE]: "倾斜（强制将字符倾斜）",
                },
                config.slope_secondary,
                (value) => {
                    config.slope_secondary = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );
    container.appendChild(
        createRow(
            "underline",
            "下划线",
            "为次要歌词添加下划线",
            createSwitch(config.underline_secondary, (value) => {
                config.underline_secondary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "strike",
            "删除线",
            "为次要歌词添加删除线",
            createSwitch(config.strikethrough_secondary, (value) => {
                config.strikethrough_secondary = value;
                updateConfig();
            }),
        ),
    );
    container.appendChild(
        createRow(
            "align",
            "文本对齐",
            "次要歌词在窗口内的对齐方向",
            createSelect(
                {
                    [DWRITE_TEXT_ALIGNMENT.LEADING]: "左对齐",
                    [DWRITE_TEXT_ALIGNMENT.CENTER]: "居中",
                    [DWRITE_TEXT_ALIGNMENT.TRAILING]: "右对齐",
                    [DWRITE_TEXT_ALIGNMENT.JUSTIFIED]: "两端对齐",
                },
                config.align_secondary,
                (value) => {
                    config.align_secondary = parseInt(value, 10);
                    updateConfig();
                },
            ),
        ),
    );

    // 重置为默认设置
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "重置为默认设置";
    resetBtn.style.cssText = `
        margin-top: 16px;
        padding: 9px 20px;
        border-radius: 6px;
        border: 1px solid var(--tl-control-border);
        background-color: var(--tl-control-bg);
        color: var(--tl-text);
        font-size: 13px;
        cursor: pointer;
        transition: border-color .15s;
    `;
    resetBtn.addEventListener("mouseenter", () => {
        resetBtn.style.borderColor = "var(--tl-accent)";
    });
    resetBtn.addEventListener("mouseleave", () => {
        resetBtn.style.borderColor = "var(--tl-control-border)";
    });
    resetBtn.addEventListener("click", () => {
        for (const key of Object.keys(DEFAULT_CONFIG) as (keyof PluginConfig)[]) {
            config[key] = DEFAULT_CONFIG[key];
        }
        updateConfig();
        // 原地重建界面，立即反映新默认值
        container.replaceChildren();
        applySystemTheme(container);
        buildContent(container);
    });
    container.appendChild(resetBtn);

    // 关于 / 反馈：满足插件商店上架准则（源码仓库 + 反馈渠道链接）
    const REPO_URL = "https://github.com/GZHback/TaskbarLyrics-BetterNCM";
    container.appendChild(createSectionTitle("关于"));
    container.appendChild(
        createRow(
            "link",
            "源码仓库",
            "在 GitHub 上查看项目源代码",
            createLinkControl(REPO_URL),
        ),
    );
    container.appendChild(
        createRow(
            "link",
            "问题反馈",
            "遇到问题或建议，欢迎提交 Issue",
            createLinkControl(`${REPO_URL}/issues`),
        ),
    );
}

export function createConfigView(): HTMLElement {
    const container = document.createElement("div");
    container.style.cssText = `
        font-family: 'Microsoft YaHei UI', sans-serif;
        color: var(--tl-text);
        padding: 0;
        margin: 0;
    `;

    // 异步跟随系统主题
    applySystemTheme(container);
    buildContent(container);

    return container;
}
