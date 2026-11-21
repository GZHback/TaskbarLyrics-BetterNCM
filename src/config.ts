/**
 * 插件配置管理以及与 C++ native 插件的通信。
 *
 * 配置通过 BetterNCM 的 `plugin.getConfig` / `plugin.setConfig` 持久化到
 * localStorage，并通过 `betterncm_native.native_plugin.call` 同步给
 * C++ 渲染窗口。
 */

export const DWRITE_TEXT_ALIGNMENT = Object.freeze({
    LEADING: 0,
    TRAILING: 1,
    CENTER: 2,
    JUSTIFIED: 3,
} as const);

export const DWRITE_FONT_WEIGHT = Object.freeze({
    THIN: 100,
    EXTRA_LIGHT: 200,
    LIGHT: 300,
    NORMAL: 400,
    MEDIUM: 500,
    SEMI_BOLD: 600,
    BOLD: 700,
    EXTRA_BOLD: 800,
    BLACK: 900,
} as const);

export const DWRITE_FONT_STYLE = Object.freeze({
    NORMAL: 0,
    OBLIQUE: 1,
    ITALIC: 2,
} as const);

export const TASKBAR_WINDOW_ALIGNMENT = Object.freeze({
    AUTO: 0,
    LEFT: 1,
    CENTER: 2,
    RIGHT: 3,
} as const);

export interface PluginConfig {
    font_family: string;
    margin_left: number;
    margin_right: number;
    line_spacing: number;
    window_alignment: number;
    color_primary: number;
    size_primary: number;
    underline_primary: boolean;
    strikethrough_primary: boolean;
    weight_primary: number;
    slope_primary: number;
    align_primary: number;
    color_secondary: number;
    size_secondary: number;
    underline_secondary: boolean;
    strikethrough_secondary: boolean;
    weight_secondary: number;
    slope_secondary: number;
    align_secondary: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
    font_family: "Microsoft YaHei UI",
    margin_left: 0,
    margin_right: 0,
    line_spacing: 0,
    window_alignment: TASKBAR_WINDOW_ALIGNMENT.LEFT,
    color_primary: 0xffffffff,
    size_primary: 18,
    underline_primary: false,
    strikethrough_primary: false,
    weight_primary: DWRITE_FONT_WEIGHT.NORMAL,
    slope_primary: DWRITE_FONT_STYLE.NORMAL,
    align_primary: DWRITE_TEXT_ALIGNMENT.CENTER,
    color_secondary: 0xffffffff,
    size_secondary: 14,
    underline_secondary: false,
    strikethrough_secondary: false,
    weight_secondary: DWRITE_FONT_WEIGHT.NORMAL,
    slope_secondary: DWRITE_FONT_STYLE.NORMAL,
    align_secondary: DWRITE_TEXT_ALIGNMENT.CENTER,
};

/** 读取单个配置项 */
function readConfig<K extends keyof PluginConfig>(key: K): PluginConfig[K] {
    return plugin.getConfig(key, DEFAULT_CONFIG[key]);
}

/** 文件持久化：localStorage（plugin.setConfig）依赖 Chromium 的落盘机制，
 *  网易云客户端进程退出时未提交的写入会丢失，导致“改了颜色重启后回退”。
 *  因此把整份配置镜像到 BetterNCM 的 config.json 文件（可靠落盘），
 *  启动时以文件为准恢复。 */
const FILE_CONFIG_KEY = "taskbar_lyrics_config";
let fileConfigReady = false;

async function readConfigFile(): Promise<Partial<PluginConfig> | null> {
    try {
        const raw = await betterncm.app.readConfig(FILE_CONFIG_KEY, "");
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                return parsed as Partial<PluginConfig>;
            }
        }
    } catch (error) {
        console.error("[Taskbar Lyrics] 读取文件配置失败:", error);
    }
    return null;
}

function writeConfigFile(): void {
    // 启动时文件尚未加载完成，先不回写，避免用旧值覆盖文件
    if (!fileConfigReady) {
        return;
    }
    const obj: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof PluginConfig)[]) {
        obj[key] = readConfig(key);
    }
    Promise.resolve(
        betterncm.app.writeConfig(FILE_CONFIG_KEY, JSON.stringify(obj)),
    ).catch((error) => {
        console.error("[Taskbar Lyrics] 写入文件配置失败:", error);
    });
}

/** 从文件恢复配置到 localStorage 并同步到 native（启动时调用） */
export async function restoreConfigFromFile(): Promise<void> {
    const data = await readConfigFile();
    if (data) {
        for (const key of Object.keys(DEFAULT_CONFIG) as (keyof PluginConfig)[]) {
            if (data[key] !== undefined) {
                plugin.setConfig(key, data[key] as PluginConfig[keyof PluginConfig]);
            }
        }
    }
    fileConfigReady = true;
    syncAllConfig();
    updateConfig();
}

/** 写入单个配置项并同步到 C++ 窗口 */
function writeConfig<K extends keyof PluginConfig>(key: K, value: PluginConfig[K]): void {
    plugin.setConfig(key, value);
    writeConfigFile();
    try {
        betterncm_native.native_plugin.call("taskbar_lyrics.config", [
            key,
            String(value),
        ]);
    } catch (error) {
        console.error("[Taskbar Lyrics] 同步配置到 native 失败:", error);
    }
}

/** 可读写配置代理：读取走 getConfig，写入走 setConfig 并同步 native */
export const config: PluginConfig = new Proxy(
    { ...DEFAULT_CONFIG } as PluginConfig,
    {
        get(target, property) {
            const key = property as keyof PluginConfig;
            if (key in DEFAULT_CONFIG) {
                return readConfig(key);
            }
            return (target as any)[property];
        },
        set(target, property, value) {
            const key = property as keyof PluginConfig;
            if (key in DEFAULT_CONFIG) {
                writeConfig(key, value);
                return true;
            }
            (target as any)[property] = value;
            return true;
        },
    },
);

/** 将全部配置项同步到 C++ 窗口。
 *
 * native 侧的 config 是内存变量，进程重启后恢复默认值；
 * 启动时必须逐项推送持久化配置，否则歌词颜色 / 字体等
 * 在下次打开客户端时会回退为默认样式。
 */
export function syncAllConfig(): void {
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof PluginConfig)[]) {
        writeConfig(key, readConfig(key));
    }
}

/** 通知 C++ 窗口配置已更新。
 *
 * 旧版 DLL（2.0.0）的 update 调用只重新布局窗口位置、不触发重绘，
 * 因此在布局之后重发一次当前歌词内容，强制窗口用新样式立即重绘。
 */
export function updateConfig(): void {
    try {
        const native = betterncm_native.native_plugin;
        native.call("taskbar_lyrics.update", []);
        native.call("taskbar_lyrics.config", ["lyric_primary", lastLyrics.primary]);
        native.call("taskbar_lyrics.config", ["lyric_secondary", lastLyrics.secondary]);
    } catch (error) {
        console.error("[Taskbar Lyrics] 通知 native 更新布局失败:", error);
    }
}

/** 记录最近一次发送的歌词，供样式变更后触发重绘使用 */
const lastLyrics = { primary: " ", secondary: " " };

/**
 * 将当前行歌词（主 / 次）发送给 C++ 窗口渲染。
 *
 * 注意：当前 native.dll 为旧版协议（2.0.0），未注册 taskbar_lyrics.lyrics
 * API，歌词需通过 taskbar_lyrics.config 写入 lyric_primary / lyric_secondary
 * 两个配置键，再调用 taskbar_lyrics.update 触发重绘。
 */
export function updateLyrics(primary: string, secondary: string): void {
    lastLyrics.primary = primary || " ";
    lastLyrics.secondary = secondary || " ";
    try {
        const native = betterncm_native.native_plugin;
        native.call("taskbar_lyrics.config", ["lyric_primary", lastLyrics.primary]);
        native.call("taskbar_lyrics.config", ["lyric_secondary", lastLyrics.secondary]);
        native.call("taskbar_lyrics.update", []);
    } catch (error) {
        console.error("[Taskbar Lyrics] 发送歌词到 native 失败:", error);
    }
}
