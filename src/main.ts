import { LyricObserver } from "./lyrics";
import { config, restoreConfigFromFile, updateLyrics } from "./config";
import { createConfigView } from "./ui/config";

let lyricObserver: LyricObserver | null = null;

function onLoad(): void {
    try {
        // 仅在字体配置为空时设置默认值（字体列表来自系统枚举，不再硬校验）
        if (!config.font_family) {
            config.font_family = "Microsoft YaHei UI";
        }

        if (!lyricObserver) {
            lyricObserver = new LyricObserver(
                (lyrics, index, hasTranslation, active) => {
                    try {
                        const lyric = lyrics[index];
                        const primary = lyric?.text ?? "";
                        const secondary = hasTranslation
                            ? lyric?.translation ?? ""
                            : lyrics[index + 1]?.text ?? "";
                        updateLyrics(primary, secondary, active);
                    } catch (error) {
                        console.error("[Taskbar Lyrics] 更新歌词出错:", error);
                    }
                },
            );
        }
        lyricObserver.start();
        // 以文件配置为准恢复并一次性同步到 native
        // （localStorage 在网易云进程退出时可能丢失未提交的写入）
        restoreConfigFromFile();
    } catch (error) {
        console.error("[Taskbar Lyrics] 插件初始化失败:", error);
    }
}

plugin.onLoad(onLoad);
plugin.onConfig(() => createConfigView());
