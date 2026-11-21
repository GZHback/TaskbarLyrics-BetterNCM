/**
 * 系统字体枚举（仅中文字体，带本地化显示名）。
 *
 * Chrome 91 没有 queryLocalFonts API，这里借助 BetterNCM 的能力：
 * 写一个 PowerShell 脚本到 BetterNCM 数据目录，用 WPF（PresentationCore，
 * 底层即 DirectWrite）枚举本机字体家族，并通过 GlyphTypeface 检查是否
 * 包含中文字形（U+4E2D），只输出能真正渲染中文的家族。
 *
 * 每行输出格式："source|display"：
 * - source：字体家族英文名（FontFamily.Source），与 DirectWrite
 *   CreateTextFormat 一致，作为配置存储值；
 * - display：本地化名称（中文系统下优先取 zh-Hans/zh-CN 等），仅用于
 *   设置界面展示，如 "KaiTi|楷体"。
 *
 * 原因：歌词文本是中文。若允许用户选择不含中文字形的西文字体
 * （如 Consolas、Dubai Light），DirectWrite 会做字体回退，最终仍用
 * 系统默认中文字体渲染，表现为“切换字体无效”。
 * 结果缓存到插件配置（localStorage）。
 */

/** 字体选项：[配置值(英文名), 显示名(本地化)] */
export type FontOption = [string, string];

const DEFAULT_FONTS: FontOption[] = [
    ["Microsoft YaHei UI", "微软雅黑 UI"],
    ["Microsoft YaHei", "微软雅黑"],
    ["DengXian", "等线"],
    ["SimSun", "宋体"],
    ["NSimSun", "新宋体"],
    ["SimHei", "黑体"],
    ["KaiTi", "楷体"],
    ["FangSong", "仿宋"],
];

const FONT_CACHE_KEY = "cached_installed_fonts_v3";

let loadPromise: Promise<FontOption[]> | null = null;

/** 内置兜底字体列表 */
export function getDefaultFonts(): FontOption[] {
    return [...DEFAULT_FONTS];
}

/** 同步读取上次枚举的缓存字体列表 */
export function getCachedFonts(): FontOption[] | null {
    try {
        const cached = plugin.getConfig(FONT_CACHE_KEY, "");
        if (cached) {
            const list = JSON.parse(cached);
            if (Array.isArray(list) && list.length) {
                return list as FontOption[];
            }
        }
    } catch {
        // ignore malformed cache
    }
    return null;
}

/** 异步获取本机已安装字体列表（带缓存，失败时回退到内置列表） */
export function getInstalledFonts(): Promise<FontOption[]> {
    if (!loadPromise) {
        loadPromise = enumerateFonts().catch((error) => {
            console.error("[Taskbar Lyrics] 枚举系统字体失败:", error);
            return getCachedFonts() ?? getDefaultFonts();
        });
    }
    return loadPromise;
}

function parseFontLine(line: string): FontOption | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }
    const sep = trimmed.indexOf("|");
    if (sep <= 0 || sep === trimmed.length - 1) {
        // 兼容无显示名的旧格式：值与显示名相同
        return [trimmed, trimmed];
    }
    return [trimmed.slice(0, sep), trimmed.slice(sep + 1)];
}

async function enumerateFonts(): Promise<FontOption[]> {
    const dataPath = await betterncm.app.getDataPath();
    if (!dataPath) {
        throw new Error("无法获取 BetterNCM 数据目录");
    }
    const scriptPath = `${dataPath}\\taskbar_lyrics_fonts.ps1`;
    const outPath = `${dataPath}\\taskbar_lyrics_fonts.txt`;

    const script =
        "Add-Type -AssemblyName PresentationCore\n" +
        "$result = New-Object 'System.Collections.Generic.List[string]'\n" +
        "foreach ($fam in [System.Windows.Media.Fonts]::SystemFontFamilies) {\n" +
        "  try {\n" +
        "    $tf = New-Object System.Windows.Media.Typeface($fam)\n" +
        "    $gt = $null\n" +
        "    if ($tf.TryGetGlyphTypeface([ref]$gt)) {\n" +
        "      if ($gt.CharacterToGlyphMap.ContainsKey(0x4E2D)) {\n" +
        "        $name = $fam.Source\n" +
        "        foreach ($entry in $gt.FamilyNames) {\n" +
        "          if ($entry.Key.IetfLanguageTag -like 'zh*') { $name = $entry.Value; break }\n" +
        "        }\n" +
        "        $result.Add(($fam.Source -replace '\\|', '') + '|' + ($name -replace '\\|', ''))\n" +
        "      }\n" +
        "    }\n" +
        "  } catch {}\n" +
        "}\n" +
        `$result | Out-File -Encoding utf8 -FilePath "${outPath}"\n`;

    await betterncm.fs.writeFileText(scriptPath, script);
    // 先删除旧的输出文件，避免读到过期数据
    try {
        await betterncm.fs.remove(outPath);
    } catch {
        // 文件可能不存在
    }

    const ok = await betterncm.app.exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
    );
    if (!ok) {
        throw new Error("无法启动 PowerShell 枚举字体");
    }

    // 等待输出文件生成（最多约 8 秒）
    for (let i = 0; i < 25; i++) {
        await betterncm.utils.delay(300);
        if (await betterncm.fs.exists(outPath)) {
            break;
        }
    }
    if (!(await betterncm.fs.exists(outPath))) {
        throw new Error("字体枚举超时");
    }

    const text = (await betterncm.fs.readFileText(outPath)).replace(/^\uFEFF/, "");
    const fonts: FontOption[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        const option = parseFontLine(line);
        if (option && !seen.has(option[0])) {
            seen.add(option[0]);
            fonts.push(option);
        }
    }
    fonts.sort((a, b) => a[1].localeCompare(b[1], "zh-Hans-CN"));

    if (!fonts.length) {
        throw new Error("字体列表为空");
    }

    plugin.setConfig(FONT_CACHE_KEY, JSON.stringify(fonts));
    return fonts;
}
