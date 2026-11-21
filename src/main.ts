import { LyricObserver } from "./lyrics";
import { config, restoreConfigFromFile, syncAllConfig, updateConfig, updateLyrics } from "./config";
import { createConfigView } from "./ui/config";

let lyricObserver: LyricObserver | null = null;

/**
 * native 层自检：列出本进程注册的 taskbar API 并做一次真实调用。
 * 若任务栏出现「歌词~歌词~歌词~/未播放」字样，说明 native 窗口与渲染链路完全通畅。
 */
function diagnoseNative(): void {
    try {
        const nativePlugin = (globalThis as any).betterncm_native?.native_plugin;
        if (!nativePlugin?.getRegisteredAPIs) {
            console.error("[Taskbar Lyrics] betterncm_native.native_plugin 不可用");
            return;
        }
        const apis: string[] = nativePlugin.getRegisteredAPIs() ?? [];
        const taskbarApis = apis.filter((api) => api.startsWith("taskbar"));
        console.log(
            "[Taskbar Lyrics] 已注册的 taskbar API:",
            JSON.stringify(taskbarApis),
        );
        // 旧版协议：通过 config 写入歌词内容并触发重绘
        nativePlugin.call("taskbar_lyrics.config", ["lyric_primary", "歌词~歌词~歌词~"]);
        nativePlugin.call("taskbar_lyrics.config", ["lyric_secondary", "未播放"]);
        nativePlugin.call("taskbar_lyrics.update", []);
        console.log("[Taskbar Lyrics] native call 成功（若任务栏出现「歌词~歌词~歌词~/未播放」即渲染正常）");
    } catch (error) {
        console.error("[Taskbar Lyrics] native 诊断失败:", error);
    }
}

function onLoad(): void {
    try {
        // 仅在字体配置为空时设置默认值（字体列表来自系统枚举，不再硬校验）
        if (!config.font_family) {
            config.font_family = "Microsoft YaHei UI";
        }

        if (!lyricObserver) {
            lyricObserver = new LyricObserver(
                (lyrics, index, hasTranslation) => {
                    try {
                        const lyric = lyrics[index];
                        const primary = lyric?.text ?? "";
                        const secondary = hasTranslation
                            ? lyric?.translation ?? ""
                            : lyrics[index + 1]?.text ?? "";
                        updateLyrics(primary, secondary);
                    } catch (error) {
                        console.error("[Taskbar Lyrics] 更新歌词出错:", error);
                    }
                },
            );
        }
        lyricObserver.start();
        // 先按 localStorage 推送一轮，再异步以文件配置为准恢复并重新同步
        // （localStorage 在网易云进程退出时可能丢失未提交的写入）
        syncAllConfig();
        updateConfig();
        restoreConfigFromFile();
        diagnoseNative();
    } catch (error) {
        console.error("[Taskbar Lyrics] 插件初始化失败:", error);
    }
}

plugin.onLoad(onLoad);
plugin.onConfig(() => createConfigView());
