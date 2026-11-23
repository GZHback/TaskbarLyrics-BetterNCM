/**
 * 歌词获取、解析与播放进度监听。
 *
 * 播放状态获取采用双通道策略：
 * 1. 首选网易云内部的 `channel.registerCall("audioplayer.onLoad"/"audioplayer.onPlayProgress")`
 *    事件（旧版 Taskbar-Lyrics 长期验证的方式，跨网易云版本稳定）；
 * 2. 若 channel 不可用，则回退到轮询 `betterncm.ncm.getPlayingSong()`。
 *
 * 歌词本身通过网易云公开的 HTTP 接口获取。
 */

/** 单个字 / 词的逐字时间信息 */
interface WordTiming {
    /** 字 / 词文本 */
    text: string;
    /** 与播放进度同基准的起始时间，单位：秒 */
    start: number;
}

export interface LyricLine {
    /** 歌词时间戳，单位：秒 */
    time: number;
    /** 歌词原文 */
    text: string;
    /** 翻译（可能为空） */
    translation?: string;
    /** 逐字时间（仅当网易云提供逐字歌词时存在） */
    words?: WordTiming[];
}

interface SongDetail {
    name: string;
    artists: string;
}

interface PlayingInfo {
    id: number;
    name: string;
    artists: string;
    /** 当前播放时间（秒） */
    time: number;
}

const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_ATTEMPTS = 2;

// ============ 歌词解析 ============

function timeToSeconds(time: string): number {
    const [minutes, seconds] = time.split(":");
    return Number((Number(minutes) * 60 + Number(seconds)).toFixed(2));
}

/** 解析 LRC 歌词文本为歌词行数组（支持同一行多个时间戳） */
function parseLyric(lyricText: string): LyricLine[] {
    const result: LyricLine[] = [];
    try {
        const lines = lyricText.split("\n");
        for (const line of lines) {
            const timestamps = [
                ...line.matchAll(/\[(\d{1,3}:\d{1,2}(?:\.\d{1,3})?)\]/g),
            ];
            if (!timestamps.length) {
                continue;
            }
            const last = timestamps[timestamps.length - 1];
            const text = line.slice(last.index! + last[0].length).trim();
            if (!text) {
                continue;
            }
            for (const timestamp of timestamps) {
                result.push({ time: timeToSeconds(timestamp[1]), text });
            }
        }
    } catch (error) {
        console.error("[Taskbar Lyrics] 歌词解析失败:", error);
    }
    return result.sort((left, right) => left.time - right.time);
}

/**
 * 解析网易云逐字歌词（yrc）。
 *
 * 网易云 yrc 每行形如：
 *   `[00:00.00](0,1000,0)你(1000,500,0)好`
 * 即句首一个句级时间戳，之后每个字跟一个 `(起始毫秒,持续毫秒,0)`，
 * 起始毫秒是相对句首的偏移。部分旧数据可能是 `<mm:ss.xx>` 字级标签，
 * 这里一并兼容。
 */
function parseYrc(yrcText: string): Map<number, WordTiming[]> {
    const map = new Map<number, WordTiming[]>();
    if (!yrcText) {
        return map;
    }
    for (const rawLine of yrcText.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const timeMatch = line.match(/\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/);
        if (!timeMatch) {
            continue;
        }
        const lineTime = timeToSeconds(`${timeMatch[1]}:${timeMatch[2]}`);
        const rest = line.slice(timeMatch.index! + timeMatch[0].length);
        const words: WordTiming[] = [];

        // 格式 A：`(start,dur,0)` 相对偏移
        const tagA = [...rest.matchAll(/\((\d+),(\d+),\d+\)/g)];
        if (tagA.length) {
            for (let i = 0; i < tagA.length; i++) {
                const start = Number(tagA[i][1]) / 1000;
                const textStart = tagA[i].index! + tagA[i][0].length;
                const textEnd = i + 1 < tagA.length ? tagA[i + 1].index! : rest.length;
                const text = rest.slice(textStart, textEnd).trim();
                if (text) {
                    words.push({ text, start });
                }
            }
        } else {
            // 格式 B：`<mm:ss.xx>` 绝对时间
            const tagB = [...rest.matchAll(/<(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)>/g)];
            for (let i = 0; i < tagB.length; i++) {
                const abs = timeToSeconds(`${tagB[i][1]}:${tagB[i][2]}`);
                const textStart = tagB[i].index! + tagB[i][0].length;
                const textEnd = i + 1 < tagB.length ? tagB[i + 1].index! : rest.length;
                const text = rest.slice(textStart, textEnd).trim();
                if (text) {
                    words.push({ text, start: abs - lineTime });
                }
            }
        }
        if (words.length) {
            map.set(lineTime, words);
        }
    }
    return map;
}

/** 按时间戳将翻译歌词合并到原歌词上 */
function mergeLyrics(
    originalLyrics: LyricLine[],
    translatedLyrics: LyricLine[],
): LyricLine[] {
    let translationIndex = 0;
    return originalLyrics.map((original) => {
        while (
            translationIndex + 1 < translatedLyrics.length &&
            Math.abs(translatedLyrics[translationIndex + 1].time - original.time) <=
                Math.abs(translatedLyrics[translationIndex].time - original.time)
        ) {
            translationIndex++;
        }
        const translation = translatedLyrics[translationIndex];
        return {
            time: original.time,
            text: original.text,
            translation:
                translation && Math.abs(translation.time - original.time) <= 0.75
                    ? translation.text
                    : "",
        };
    });
}

// ============ HTTP 获取 ============

async function fetchJson(
    url: string,
    signal?: AbortSignal,
    init?: RequestInit,
): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const response = await fetch(url, {
                ...init,
                credentials: "include",
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(
                    `请求失败: ${response.status} ${response.statusText}`,
                );
            }
            return await response.json();
        } catch (error) {
            lastError = error;
            if (signal?.aborted) {
                throw error;
            }
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
        }
    }
    throw lastError ?? new Error("请求失败");
}

/**
 * 从网易云客户端环境请求歌词原始数据。
 * 在客户端内 fetch 会带上登录态，接口可直接返回逐字歌词字段。
 */
async function requestLyricEapi(id: number, signal?: AbortSignal): Promise<any> {
    // RNPNext 同款：window.APP_CONF.domain + 全 0 参数 + credentials
    const rnpDomain =
        (globalThis as any).APP_CONF?.domain ?? "https://music.163.com";
    const url = `${rnpDomain}/api/song/lyric/v1?tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0&cp=false&id=${id}`;
    console.log("[Taskbar Lyrics] 歌词请求 URL:", url);
    return fetchJson(url, signal);
}

/**
 * 解析 klyric 逐字歌词（卡拉OK格式）。
 * 每行形如 `[3000,5000](0,300,0)我(300,400,0)爱(700,600,0)你`：
 * 句首 `[句开始毫秒,句时长毫秒]`，其后每个 `(起始毫秒,持续毫秒,标志)字`，
 * 字的起始时间是相对句首的偏移，与 WordTiming 定义一致。
 */
function parseKlyric(klyricText: string): Map<number, WordTiming[]> {
    const map = new Map<number, WordTiming[]>();
    if (!klyricText) {
        return map;
    }
    for (const rawLine of klyricText.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const head = line.match(/^\[(\d+),\d+\]/);
        if (!head) {
            continue;
        }
        const lineStartMs = Number(head[1]);
        const lineTime = lineStartMs / 1000;
        const rest = line.slice(head[0].length);
        const tags = [...rest.matchAll(/\((\d+),(\d+),\d+\)/g)];
        if (!tags.length) {
            continue;
        }
        const words: WordTiming[] = [];
        for (let i = 0; i < tags.length; i++) {
            // MiniLyrics absolute 模式：字时间直接用绝对毫秒（不减行首）。
            // 行时间也是绝对毫秒，查找时统一用绝对时间二分，避免基准不一致。
            const start = Number(tags[i][1]) / 1000;
            const textStart = tags[i].index! + tags[i][0].length;
            const textEnd = i + 1 < tags.length ? tags[i + 1].index! : rest.length;
            const text = rest.slice(textStart, textEnd).trim();
            if (text) {
                words.push({ text, start });
            }
        }
        if (words.length) {
            map.set(lineTime, words);
        }
    }
    return map;
}

async function getLyric(id: number, signal?: AbortSignal): Promise<LyricLine[]> {
    try {
        // 取原始歌词数据（RNP 同款 fetch，客户端环境内带 cookie）

        const lyric = await requestLyricEapi(id, signal);
        console.log(
            "[Taskbar Lyrics] 歌词原始数据:",
            `lrc=${lyric?.lrc?.lyric?.length ?? 0}`,
            `klyric=${lyric?.klyric?.lyric?.length ?? 0}`,
            `yrc=${lyric?.yrc?.lyric?.length ?? 0}`,
            `tlyric=${lyric?.tlyric?.lyric?.length ?? 0}`,
        );

        // 2. 逐字歌词：用 yrc 的行时间直接构造歌词行（行时间/字时间同源，都是绝对秒），
        //    与 channel 播放进度同基准，杜绝错位。
        const yrcNewMap = parseKlyric(lyric.yrc?.lyric ?? "");
        const wordMap = new Map(yrcNewMap);
        const yrcOldMap = parseYrc(lyric.yrc?.lyric ?? "");
        for (const [time, words] of yrcOldMap) {
            if (!wordMap.has(time)) {
                wordMap.set(time, words);
            }
        }
        const klyricMap = parseKlyric(lyric.klyric?.lyric ?? "");
        for (const [time, words] of klyricMap) {
            if (!wordMap.has(time)) {
                wordMap.set(time, words);
            }
        }
        console.log(
            `[Taskbar Lyrics] 逐字解析: wordMap=${wordMap.size} (yrc新=${yrcNewMap.size}, yrc老=${yrcOldMap.size}, klyric=${klyricMap.size})`,
        );

        if (wordMap.size > 0) {
            const translations = parseLyric(lyric.tlyric?.lyric ?? "");
            const lines: LyricLine[] = [];
            for (const [time, words] of wordMap) {
                const text = words.map((word) => word.text).join("");
                if (!text.trim()) {
                    continue;
                }
                let translation = "";
                for (const tr of translations) {
                    if (Math.abs(tr.time - time) <= 0.6) {
                        translation = tr.text;
                        break;
                    }
                }
                lines.push({ time, text, translation, words });
            }
            lines.sort((a, b) => a.time - b.time);
            console.log(`[Taskbar Lyrics] 使用 yrc 同源歌词，${lines.length} 行`);
            return lines;
        }

        // 3. 无逐字数据：回退普通 lrc / tlyric
        const originalLyrics = parseLyric(lyric.lrc?.lyric ?? "");
        const translatedLyrics = parseLyric(lyric.tlyric?.lyric ?? "");
        return mergeLyrics(originalLyrics, translatedLyrics);
    } catch (error) {
        console.error("[Taskbar Lyrics] 获取歌词失败:", error);
        return [];
    }
}

async function getDetail(id: number, signal?: AbortSignal): Promise<SongDetail> {
    try {
        const detail = await fetchJson(
            `https://music.163.com/api/song/detail?ids=[${id}]`,
            signal,
        );
        return {
            name: detail.songs[0].name,
            artists: detail.songs[0].artists
                ?.map((value: any) => value.name)
                .join(" / "),
        };
    } catch (error) {
        console.error("[Taskbar Lyrics] 获取歌曲详情失败:", error);
        return { name: "未知歌曲", artists: "未知歌手" };
    }
}

// ============ 播放信息规范化（轮询兜底用） ============

/** 从对象中按候选键顺序取出第一个有限数值 */
function pickNumber(data: any, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = data?.[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}

/**
 * 将网易云返回的时间统一转换为秒。
 * 各版本返回的单位可能是毫秒也可能是秒，依据量级做启发式判断。
 */
function toSeconds(value: number, duration?: number): number {
    const looksLikeMillis =
        duration !== undefined && duration > 0
            ? duration > 3600
            : value > 3600;
    return looksLikeMillis ? value / 1000 : value;
}

// ============ 播放状态监听 ============

/** 逐字高亮：当前字在歌词文本中的位置信息（UTF-16 码元偏移与长度） */
export interface ActiveChar {
    offset: number;
    length: number;
}

export type LyricCallback = (
    lyrics: LyricLine[],
    index: number,
    hasTranslation: boolean,
    active?: ActiveChar,
) => void;

export class LyricObserver {
    private readonly callback: LyricCallback;
    private timer: number | null = null;
    private wordTimer: number | null = null;

    private currentLyric: LyricLine[] = [];
    private hasTranslation = false;
    private lastIndex = -1;
    private lastActiveKey = "-1";
    private lastSongId: number | null = null;
    /** 当前播放实例 ID，用于丢弃切歌前后的旧事件 */
    private currentPlayId: string | null = null;
    /** 进度锚点（秒）与对应墙钟时间 */
    private lastTime = -1;
    private anchorPerf = 0;
    private duration = 0;
    private isPlaying = true;
    /** 拖动进度后的当前句不显示高亮，等下一句再恢复同步 */
    private seekPending = false;
    private seekSuppressIndex = -1;

    private loadGeneration = 0;
    private loadController: AbortController | null = null;
    private channelHooked = false;

    constructor(callback: LyricCallback) {
        this.callback = callback;
    }

    start(): void {
        this.stop();
        this.seekPending = false;
        this.seekSuppressIndex = -1;
        this.isPlaying = true;
        this.anchorPerf = performance.now();
        if (!this.channelHooked) {
            this.tryHookChannel();
        }
        if (this.channelHooked) {
            console.log("[Taskbar Lyrics] 使用 channel 事件驱动播放状态");
            const playing = this.getPlaying();
            if (playing) {
                this.lastTime = playing.time;
                this.anchorPerf = performance.now();
                if (playing.id !== this.lastSongId) {
                    this.lastSongId = playing.id;
                    this.lastIndex = -1;
                    this.loadLyric(playing.id, playing.name, playing.artists);
                }
            }
        } else {
            console.log("[Taskbar Lyrics] channel 不可用，使用轮询获取播放状态");
            this.tick();
            this.timer = window.setInterval(() => this.tick(), 200);
        }
        // 100ms 定时器：用锚点时间平滑推进逐字高亮
        this.wordTimer = window.setInterval(() => {
            const currentTime = this.getCurrentTime();
            if (this.isLoaded() && currentTime >= 0) {
                this.emit(currentTime);
            }
        }, 100);
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.wordTimer !== null) {
            clearInterval(this.wordTimer);
            this.wordTimer = null;
        }
    }

    /** 注册网易云内部 channel 播放事件 */
    private tryHookChannel(): boolean {
        try {
            const ch = (globalThis as any).channel;
            if (typeof ch === "undefined" || typeof ch?.registerCall !== "function") {
                return false;
            }
            ch.registerCall("audioplayer.onLoad", (...args: unknown[]) => {
                this.onChannelLoad(args[0], args[1]);
            });
            ch.registerCall("audioplayer.onPlayProgress", (...args: unknown[]) => {
                if (this.isCurrentPlay(args[0])) {
                    this.onChannelProgress(args[1]);
                }
            });
            ch.registerCall("audioplayer.onSeek", (...args: unknown[]) => {
                if (this.isCurrentPlay(args[0])) {
                    this.onChannelSeek(args[3]);
                }
            });
            ch.registerCall("audioplayer.onPlayState", (...args: unknown[]) => {
                if (this.isCurrentPlay(args[0])) {
                    this.onChannelPlayState(args[2]);
                }
            });
            this.channelHooked = true;
            return true;
        } catch (error) {
            console.warn("[Taskbar Lyrics] 注册 channel 事件失败:", error);
            return false;
        }
    }

    /** channel: 歌曲切换 */
    private onChannelLoad(playId: unknown, info: unknown): void {
        try {
            const playing = this.getPlaying();
            let songId = playing?.id;
            if (songId === undefined || !Number.isFinite(songId)) {
                const match = String(playId ?? "").match(/\d+/);
                songId = match ? Number(match[0]) : undefined;
            }
            if (songId === undefined || songId === this.lastSongId) {
                return;
            }
            const duration = Number((info as any)?.duration);
            this.lastSongId = songId;
            this.currentPlayId = playId === undefined || playId === null
                ? null
                : String(playId);
            this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
            this.lastIndex = -1;
            this.lastActiveKey = "-1";
            this.lastTime = playing?.time ?? 0;
            this.anchorPerf = performance.now();
            this.isPlaying = true;
            this.seekPending = false;
            this.seekSuppressIndex = -1;
            this.currentLyric = [];
            this.loadLyric(songId, playing?.name ?? "加载中...", playing?.artists ?? "");
        } catch (error) {
            console.error("[Taskbar Lyrics] onChannelLoad 出错:", error);
        }
    }

    /** 判断事件是否属于当前播放实例，丢弃切歌前后的旧事件 */
    private isCurrentPlay(playId: unknown): boolean {
        return this.currentPlayId === null ||
            playId === undefined ||
            playId === null ||
            String(playId) === this.currentPlayId;
    }

    /** 进度突变记为一次 seek：当前句不再显示逐字高亮，下一句自动恢复 */
    private markSeek(): void {
        this.seekPending = true;
        this.lastActiveKey = "-1";
    }

    /** 用真实进度重新锚定；小幅 IPC 抖动不重置锚点，避免高亮来回跳 */
    private setProgressAnchor(currentTime: number): void {
        const delta = currentTime - this.lastTime;
        if (this.lastTime >= 0 && delta > -0.25 && delta < 0.05) {
            return;
        }
        if (this.lastTime >= 0 && (delta <= -0.25 || delta > 2)) {
            this.markSeek();
        }
        this.lastTime = currentTime;
        this.anchorPerf = performance.now();
    }

    /** 当前时间：真实进度锚点 + 受上限约束的单调时钟推进 */
    private getCurrentTime(): number {
        if (this.lastTime < 0) {
            return -1;
        }
        if (!this.isPlaying) {
            return this.lastTime;
        }
        const elapsed = Math.max(0, (performance.now() - this.anchorPerf) / 1000);
        let currentTime = this.lastTime + Math.min(elapsed, 1.5);
        if (this.duration > 0 && currentTime > this.duration) {
            currentTime = this.duration;
        }
        return currentTime;
    }

    /** channel: 原生 seek 事件，args[3] 是拖动后的目标秒数 */
    private onChannelSeek(position: unknown): void {
        try {
            const raw = Number(position);
            if (!Number.isFinite(raw)) {
                return;
            }
            const currentTime = raw > 3600 ? raw / 1000 : raw;
            this.markSeek();
            this.lastTime = currentTime;
            this.anchorPerf = performance.now();
        } catch (error) {
            console.error("[Taskbar Lyrics] onChannelSeek 出错:", error);
        }
    }

    /** channel: 播放状态，state === 1 表示播放中 */
    private onChannelPlayState(state: unknown): void {
        try {
            const frozenTime = this.getCurrentTime();
            const nextPlaying = Number(state) === 1;
            if (this.isPlaying && !nextPlaying && frozenTime >= 0) {
                this.lastTime = frozenTime;
            }
            this.isPlaying = nextPlaying;
            this.anchorPerf = performance.now();
        } catch (error) {
            console.error("[Taskbar Lyrics] onChannelPlayState 出错:", error);
        }
    }

    /** channel: 播放进度 */
    private onChannelProgress(time: unknown): void {
        try {
            const raw = Number(time);
            if (!Number.isFinite(raw)) {
                return;
            }
            const currentTime = raw > 3600 ? raw / 1000 : raw;
            this.setProgressAnchor(currentTime);
        } catch (error) {
            console.error("[Taskbar Lyrics] onChannelProgress 出错:", error);
        }
    }

    private isLoaded(): boolean {
        return this.currentLyric.length > 0;
    }

    /** 从 BetterNCM 提供的接口读取并规范化当前播放状态（轮询兜底用） */
    private getPlaying(): PlayingInfo | null {
        try {
            const raw = betterncm.ncm.getPlayingSong();
            const data = raw?.data ?? raw;
            if (!data || data.id === undefined || data.id === null) {
                return null;
            }
            const duration =
                pickNumber(data, ["duration", "length", "totalTime", "allTime"]) ?? 0;
            const rawTime =
                pickNumber(data, [
                    "playTime",
                    "playedTime",
                    "currentTime",
                    "time",
                    "position",
                    "progress",
                    "current",
                ]) ?? 0;
            const artists = Array.isArray(data.artists)
                ? data.artists.map((value: any) => value?.name ?? value).join(" / ")
                : String(data.artists ?? data.artist ?? "");
            return {
                id: Number(data.id),
                name: String(data.name ?? "未知歌曲"),
                artists: artists || "未知歌手",
                time: toSeconds(rawTime, duration || undefined),
            };
        } catch (error) {
            console.error("[Taskbar Lyrics] 获取播放状态失败:", error);
            return null;
        }
    }

    private async tick(): Promise<void> {
        const playing = this.getPlaying();
        if (!playing) {
            if (this.lastSongId !== null) {
                this.lastSongId = null;
                this.lastIndex = -1;
                this.currentLyric = [];
                this.callback?.([], -1, false);
            }
            return;
        }

        this.setProgressAnchor(playing.time);

        if (playing.id !== this.lastSongId) {
            this.lastSongId = playing.id;
            this.currentPlayId = null;
            this.lastIndex = -1;
            this.lastActiveKey = "-1";
            this.seekPending = false;
            this.seekSuppressIndex = -1;
            this.currentLyric = [];
            this.loadLyric(playing.id, playing.name, playing.artists);
        }

        this.emit(this.getCurrentTime());
    }

    private async loadLyric(
        id: number,
        name: string,
        artists: string,
    ): Promise<void> {
        this.loadController?.abort();
        const controller = new AbortController();
        const generation = ++this.loadGeneration;
        this.loadController = controller;

        // 加载过程中先用歌名 / 歌手兜底
        this.currentLyric = [{ time: -1, text: name || "加载中...", translation: artists }];
        this.hasTranslation = false;
        this.lastIndex = 0;
        this.callback?.(this.currentLyric, 0, false);

        try {
            const [detail, lyric] = await Promise.all([
                getDetail(id, controller.signal),
                getLyric(id, controller.signal),
            ]);
            if (generation !== this.loadGeneration) {
                return;
            }
            const header: LyricLine = {
                time: -1,
                text: detail.name,
                translation: detail.artists,
            };
            this.currentLyric = [header, ...lyric];
            this.hasTranslation = lyric.some((item) => item.translation?.trim());
            // 加载完成后立即用最新进度定位一次
            this.emit(this.getCurrentTime(), true);
        } catch (error) {
            if (generation !== this.loadGeneration) {
                return;
            }
            console.error("[Taskbar Lyrics] 加载歌词出错:", error);
            this.currentLyric = [
                { time: -1, text: name || "加载失败", translation: artists || String(error) },
            ];
            this.hasTranslation = false;
            this.lastIndex = 0;
            this.callback?.(this.currentLyric, 0, false);
        } finally {
            if (generation === this.loadGeneration) {
                this.loadController = null;
            }
        }
    }

    /** 计算当前句内正在唱的字在整句文本中的位置（无逐字数据时返回 undefined） */
    private computeActive(line: LyricLine, currentTime: number): ActiveChar | undefined {
        if (!line.words?.length || !line.text.length) {
            return undefined;
        }
        const words = line.words;

        // MiniLyrics 同款：二分找 start <= currentTime 的最后一个字（字时间为绝对秒）。
        // 字与字的间隙/尾音期间保持当前字，不回退到第一个字。句首之前取第一个字。
        let lo = 0;
        let hi = words.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (words[mid].start <= currentTime) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        const wordIndex = Math.max(0, lo - 1);

        // 定位当前字在 line.text 中的 UTF-16 偏移。
        // yrc 的逐字文本按顺序拼接通常等于 line.text，因此按累积长度定位最可靠；
        // 若拼接结果与 line.text 不一致，则退回逐字 indexOf 匹配。
        const joined = words.map((word) => word.text).join("");
        const lengthOf = (index: number) => words[index].text.length || 1;
        if (joined === line.text) {
            let offset = 0;
            for (let i = 0; i < wordIndex; i++) {
                offset += lengthOf(i);
            }
            return { offset, length: lengthOf(wordIndex) };
        }

        // 回退：逐字 indexOf，带首尾空格容错
        const locate = (word: string, from: number) => {
            const found = line.text.indexOf(word, from);
            if (found >= 0) {
                return { offset: found, length: word.length };
            }
            const trimmed = word.trim();
            if (trimmed.length && trimmed !== word) {
                const foundTrimmed = line.text.indexOf(trimmed, from);
                if (foundTrimmed >= 0) {
                    return { offset: foundTrimmed, length: trimmed.length };
                }
            }
            return undefined;
        };
        let offset = 0;
        for (let i = 0; i < wordIndex; i++) {
            const located = locate(words[i].text, offset);
            if (!located) {
                break;
            }
            offset = located.offset + located.length;
        }
        const located = locate(words[wordIndex].text, offset);
        if (located) {
            return located;
        }
        // 全部匹配失败：按字数比例估算，保证至少有个高亮位置
        const ratio = words.length > 1 ? wordIndex / words.length : 0;
        const offsetFallback = Math.floor(line.text.length * ratio);
        const lengthFallback = Math.max(
            1,
            Math.min(line.text.length - offsetFallback, lengthOf(wordIndex)),
        );
        return { offset: offsetFallback, length: lengthFallback };
    }

    private emit(currentTime: number, force = false): void {
        if (this.currentLyric.length <= 1) {
            return;
        }
        // 二分查找当前时间对应的歌词行
        let low = 0;
        let high = this.currentLyric.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.currentLyric[middle].time <= currentTime) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        const currentIndex = Math.max(0, low - 1);
        const computedActive = this.computeActive(
            this.currentLyric[currentIndex],
            currentTime,
        );

        // seek 后的当前句“将错就错”：不显示逐字高亮；行号一变就恢复正常同步。
        if (this.seekPending) {
            this.seekSuppressIndex = currentIndex;
            this.seekPending = false;
        }
        let active = computedActive;
        if (this.seekSuppressIndex === currentIndex) {
            active = undefined;
        } else if (this.seekSuppressIndex >= 0) {
            this.seekSuppressIndex = -1;
        }

        const activeKey = active ? `${active.offset}:${active.length}` : "-1";
        if (force || currentIndex !== this.lastIndex || activeKey !== this.lastActiveKey) {
            this.lastIndex = currentIndex;
            this.lastActiveKey = activeKey;
            this.callback?.(this.currentLyric, currentIndex, this.hasTranslation, active);
        }
    }

}
