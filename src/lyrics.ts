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

export interface LyricLine {
    /** 歌词时间戳，单位：秒 */
    time: number;
    /** 歌词原文 */
    text: string;
    /** 翻译（可能为空） */
    translation?: string;
}

export interface SongDetail {
    name: string;
    artists: string;
}

export interface PlayingInfo {
    id: number;
    name: string;
    artists: string;
    /** 当前播放时间（秒） */
    time: number;
    /** 总时长（秒），未知时为 0 */
    duration: number;
}

const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_ATTEMPTS = 2;

// ============ 歌词解析 ============

function timeToSeconds(time: string): number {
    const [minutes, seconds] = time.split(":");
    return Number((Number(minutes) * 60 + Number(seconds)).toFixed(2));
}

/** 解析 LRC 歌词文本为歌词行数组（支持同一行多个时间戳） */
export function parseLyric(lyricText: string): LyricLine[] {
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

/** 按时间戳将翻译歌词合并到原歌词上 */
export function mergeLyrics(
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

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const response = await fetch(url, { signal: controller.signal });
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

async function getLyric(id: number, signal?: AbortSignal): Promise<LyricLine[]> {
    try {
        const lyric = await fetchJson(
            `https://music.163.com/api/song/lyric/v1?tv=-1&lv=-1&rv=0&kv=0&yv=0&ytv=0&yrv=0&cp=false&id=${id}`,
            signal,
        );
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

export class LyricObserver {
    private readonly callback: (
        lyrics: LyricLine[],
        index: number,
        hasTranslation: boolean,
    ) => void;
    private readonly interval: number;
    private timer: number | null = null;

    private currentLyric: LyricLine[] = [];
    private hasTranslation = false;
    private lastIndex = -1;
    private lastSongId: number | null = null;
    private lastTime = -1;

    private loadGeneration = 0;
    private loadController: AbortController | null = null;
    private channelHooked = false;

    constructor(
        callback: (lyrics: LyricLine[], index: number, hasTranslation: boolean) => void,
        interval = 500,
    ) {
        this.callback = callback;
        this.interval = interval;
    }

    start(): void {
        this.stop();
        if (!this.channelHooked) {
            this.tryHookChannel();
        }
        if (this.channelHooked) {
            console.log("[Taskbar Lyrics] 使用 channel 事件驱动播放状态");
            // 同步一次当前播放状态（页面刷新后 channel 不会重放 onLoad）
            const playing = this.getPlaying();
            if (playing) {
                this.lastTime = playing.time;
                if (playing.id !== this.lastSongId) {
                    this.lastSongId = playing.id;
                    this.lastIndex = -1;
                    this.loadLyric(playing.id, playing.name, playing.artists);
                } else {
                    this.updateProgress(playing.time);
                }
            }
        } else {
            console.log("[Taskbar Lyrics] channel 不可用，使用轮询获取播放状态");
            this.tick();
            this.timer = window.setInterval(() => this.tick(), this.interval);
        }
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** 注册网易云内部 channel 播放事件 */
    private tryHookChannel(): boolean {
        try {
            const ch = (globalThis as any).channel;
            if (typeof ch === "undefined" || typeof ch?.registerCall !== "function") {
                return false;
            }
            ch.registerCall("audioplayer.onLoad", (rawId: unknown) => {
                this.onChannelLoad(rawId);
            });
            ch.registerCall("audioplayer.onPlayProgress", (...args: unknown[]) => {
                this.onChannelProgress(args[1]);
            });
            this.channelHooked = true;
            return true;
        } catch (error) {
            console.warn("[Taskbar Lyrics] 注册 channel 事件失败:", error);
            return false;
        }
    }

    /** channel: 歌曲切换事件 */
    private onChannelLoad(rawId: unknown): void {
        try {
            if (typeof rawId !== "string") {
                return;
            }
            const id = rawId.split("_")[0];
            if (!/^\d+$/.test(id)) {
                return;
            }
            const songId = Number(id);
            if (songId === this.lastSongId) {
                return;
            }
            this.lastSongId = songId;
            this.lastIndex = -1;
            this.currentLyric = [];
            this.loadLyric(songId, "加载中...", "");
        } catch (error) {
            console.error("[Taskbar Lyrics] onChannelLoad 出错:", error);
        }
    }

    /** channel: 播放进度事件 */
    private onChannelProgress(time: unknown): void {
        try {
            if (!this.isLoaded()) {
                return;
            }
            const currentTime = Number(time);
            if (!Number.isFinite(currentTime)) {
                return;
            }
            this.lastTime = currentTime;
            this.updateProgress(currentTime);
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
                duration: toSeconds(duration, duration || undefined),
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

        this.lastTime = playing.time;

        if (playing.id !== this.lastSongId) {
            this.lastSongId = playing.id;
            this.lastIndex = -1;
            this.currentLyric = [];
            this.loadLyric(playing.id, playing.name, playing.artists);
        }

        this.updateProgress(playing.time);
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
            this.currentLyric = [
                { time: -1, text: detail.name, translation: detail.artists },
            ].concat(lyric);
            this.hasTranslation = lyric.some((item) => item.translation?.trim());
            // 加载完成后立即用最新进度定位一次
            this.updateProgress(this.lastTime, true);
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

    private updateProgress(currentTime: number, force = false): void {
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
        if (force || currentIndex !== this.lastIndex) {
            this.lastIndex = currentIndex;
            this.callback?.(this.currentLyric, currentIndex, this.hasTranslation);
        }
    }
}
