import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const YTDLP_PATH = path.resolve(
  "bin",
  "yt-dlp_win",
  "yt-dlp.exe"
);

const DOWNLOAD_DIR = path.resolve("downloads");

const downloads = new Map();

/**
 * Cookie arguments so YouTube treats yt-dlp as a signed-in user
 * instead of a bot ("Sign in to confirm you're not a bot").
 *
 * Set ONE of these in .env:
 *   YTDLP_COOKIES_FILE=cookies.txt
 *   YTDLP_COOKIES_BROWSER=firefox
 *
 * Read lazily (not at import time) because app.js loads .env
 * after its imports have already run.
 */
const getAuthArgs = () => {
  if (process.env.YTDLP_COOKIES_FILE) {
    return [
      "--cookies",
      path.resolve(process.env.YTDLP_COOKIES_FILE)
    ];
  }

  if (process.env.YTDLP_COOKIES_BROWSER) {
    return [
      "--cookies-from-browser",
      process.env.YTDLP_COOKIES_BROWSER
    ];
  }

  return [];
};

/**
 * Make sure the downloads directory exists
 */
const ensureDownloadDirectory = async () => {
  if (!existsSync(DOWNLOAD_DIR)) {
    await fs.mkdir(DOWNLOAD_DIR, {
      recursive: true
    });
  }
};

/**
 * Run yt-dlp and return its stdout
 */
const runYtdlp = (args) => {
  return new Promise((resolve, reject) => {
    const process = spawn(
      YTDLP_PATH,
      [...getAuthArgs(), ...args]
    );

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {
      reject(
        new Error(
          `Failed to start yt-dlp: ${error.message}`
        )
      );
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            stderr.trim() ||
              `yt-dlp exited with code ${code}`
          )
        );
      }
    });
  });
};

/**
 * Get video information
 */
export const getVideoInfo = async (url) => {
  const output = await runYtdlp([
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    url
  ]);

  try {
    const info = JSON.parse(output);

    return {
      id: info.id,
      title: info.title,
      channel:
        info.channel ||
        info.uploader,
      uploader: info.uploader,
      duration: info.duration,
      durationString:
        info.duration_string,
      thumbnail: info.thumbnail,
      description: info.description,
      uploadDate: info.upload_date,
      viewCount: info.view_count,
      likeCount: info.like_count,
      webpageUrl: info.webpage_url,
      extractor: info.extractor,
      formats:
        info.formats?.length || 0
    };
  } catch (error) {
    throw new Error(
      `Unable to parse yt-dlp response: ${error.message}`
    );
  }
};

/**
 * Videos with several dubbed audio tracks list one audio format per
 * language. Keep only one language so the bot can't grab a random one.
 *
 * Order of preference:
 *   1. AUDIO_LANGUAGE from .env (e.g. "en", "ja"), if the video has it
 *   2. the track YouTube marks as original/default
 *   3. otherwise leave the list alone (single-track videos)
 */
const filterAudioByLanguage = (audio) => {
  const wanted = (process.env.AUDIO_LANGUAGE || "")
    .trim()
    .toLowerCase();

  const languageOf = (format) =>
    (format.language || "").toLowerCase();

  let chosen = [];

  if (wanted) {
    chosen = audio.filter((format) => {
      const language = languageOf(format);

      return (
        language === wanted ||
        language.startsWith(`${wanted}-`)
      );
    });
  }

  if (chosen.length === 0) {
    chosen = audio.filter((format) => format.isDefault);
  }

  return chosen.length > 0 ? chosen : audio;
};

/**
 * Get available formats
 */
export const getFormats = async (url) => {
  const output = await runYtdlp([
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    url
  ]);

  let info;

  try {
    info = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Unable to parse yt-dlp response: ${error.message}`
    );
  }

  const formats =
    info.formats || [];

  const video = formats
    .filter((format) => {
      return (
        format.vcodec &&
        format.vcodec !== "none"
      );
    })
    .map((format) => ({
      formatId: format.format_id,
      ext: format.ext,
      resolution: format.resolution,
      width: format.width,
      height: format.height,
      fps: format.fps,
      videoCodec: format.vcodec,
      audioCodec: format.acodec,
      filesize: format.filesize,
      filesizeApprox:
        format.filesize_approx,
      bitrate: format.tbr,
      hasAudio:
        format.acodec &&
        format.acodec !== "none"
    }));

  const audio = formats
    .filter((format) => {
      return (
        format.acodec &&
        format.acodec !== "none" &&
        (!format.vcodec ||
          format.vcodec === "none")
      );
    })
    .map((format) => ({
      formatId: format.format_id,
      ext: format.ext,
      audioCodec: format.acodec,
      bitrate: format.abr,
      sampleRate: format.asr,
      filesize: format.filesize,
      filesizeApprox:
        format.filesize_approx,
      language: format.language,
      formatNote: format.format_note,
      isDefault:
        (format.language_preference || 0) > 0 ||
        /\b(default|original)\b/i.test(
          format.format_note || ""
        )
    }));

  return {
    title: info.title,
    thumbnail: info.thumbnail,
    duration: info.duration,
    video,
    audio: filterAudioByLanguage(audio)
  };
};

/**
 * Convert quality into a yt-dlp
 * format selector.
 */

/**
 * Convert quality or format IDs into
 * a yt-dlp format selector.
 */
const getFormatSelector = (
  quality
) => {
  /*
   * Audio-only download, e.g. "audio:140-1".
   * Falls back to yt-dlp's best audio if that
   * exact format isn't available.
   */
  if (
    typeof quality === "string" &&
    quality.startsWith("audio:")
  ) {
    const formatId = quality.slice(
      "audio:".length
    );

    return `${formatId}/bestaudio`;
  }

  /*
   * If Telegram already supplied
   * specific format IDs such as:
   *
   * 137+140-drc
   *
   * use them directly.
   */
  if (
    typeof quality === "string" &&
    quality.includes("+")
  ) {
    return quality;
  }

  const qualityMap = {
    "360p": 360,
    "480p": 480,
    "720p": 720,
    "1080p": 1080,
    "1440p": 1440,
    "2160p": 2160
  };

  const height =
    qualityMap[quality];

  if (!height) {
    throw new Error(
      `Unsupported video quality: ${quality}`
    );
  }

  return (
    `bestvideo[height<=${height}]+bestaudio/` +
    `best[height<=${height}]`
  );
};

/**
 * Start a video download
 */
export const downloadVideo = async (
  url,
  quality = "1080p"
) => {
  await ensureDownloadDirectory();

  const downloadId =
    randomUUID();

  /*
   * yt-dlp will initially create the
   * downloaded streams and then FFmpeg
   * will merge them.
   */
  const outputTemplate =
    path.join(
      DOWNLOAD_DIR,
      `${downloadId}.%(ext)s`
    );

  downloads.set(
    downloadId,
    {
      id: downloadId,
      status: "starting",
      progress: 0,
      speed: null,
      eta: null,
      filename: null,
      path: null,
      error: null
    }
  );

  const format =
    getFormatSelector(
      quality
    );

  console.log(
    `Downloading ${quality} using format:`,
    format
  );

  const args = [
    "--no-playlist",

    "--newline",

    "--progress",

    "-f",
    format,

    /*
     * FFmpeg merges separate video
     * and audio streams into MP4.
     */
    "--merge-output-format",
    "mp4",

    "-o",
    outputTemplate,

    url
  ];

  const process = spawn(
    YTDLP_PATH,
    [...getAuthArgs(), ...args]
  );

  let stderr = "";

  process.stdout.on(
    "data",
    (data) => {
      const output =
        data.toString();

      parseProgress(
        downloadId,
        output
      );
    }
  );

  process.stderr.on(
    "data",
    (data) => {
      const output =
        data.toString();

      stderr += output;

      console.error(
        `[yt-dlp ${downloadId}]`,
        output
      );
    }
  );

  process.on(
    "error",
    (error) => {
      const download =
        downloads.get(
          downloadId
        );

      if (download) {
        download.status =
          "error";

        download.error =
          error.message;
      }
    }
  );

  process.on(
    "close",
    async (code) => {
      const download =
        downloads.get(
          downloadId
        );

      if (!download) {
        return;
      }

      if (code === 0) {
        try {
          const files =
            await fs.readdir(
              DOWNLOAD_DIR
            );

          /*
           * Find the final output,
           * not a temporary .part file.
           */
          const downloadedFile =
            files.find(
              (file) =>
                file.startsWith(
                  `${downloadId}.`
                ) &&
                !file.endsWith(
                  ".part"
                )
            );

          if (!downloadedFile) {
            throw new Error(
              "Downloaded file could not be found"
            );
          }

          download.status =
            "completed";

          download.progress =
            100;

          download.filename =
            downloadedFile;

          download.path =
            path.join(
              DOWNLOAD_DIR,
              downloadedFile
            );

          console.log(
            `Download completed: ${download.path}`
          );
        } catch (error) {
          download.status =
            "error";

          download.error =
            error.message;
        }
      } else {
        download.status =
          "error";

        download.error =
          stderr.trim() ||
          `yt-dlp exited with code ${code}`;
      }
    }
  );

  return {
    downloadId,
    status: "started",
    quality
  };
};

/**
 * Parse yt-dlp progress output
 */
const parseProgress = (
  downloadId,
  output
) => {
  const download =
    downloads.get(
      downloadId
    );

  if (!download) {
    return;
  }

  download.status =
    "downloading";

  /*
   * Example:
   *
   * [download] 45.3% of 10.00MiB
   * at 2.50MiB/s ETA 00:03
   */

  const progressMatch =
    output.match(
      /(\d+(?:\.\d+)?)%/
    );

  const speedMatch =
    output.match(
      /at\s+([^\s]+\/s)/
    );

  const etaMatch =
    output.match(
      /ETA\s+([^\s]+)/
    );

  if (progressMatch) {
    download.progress =
      Number(
        progressMatch[1]
      );
  }

  if (speedMatch) {
    download.speed =
      speedMatch[1];
  }

  if (etaMatch) {
    download.eta =
      etaMatch[1];
  }
};

/**
 * Get download progress
 */
export const getDownloadProgress =
  async (id) => {
    const download =
      downloads.get(id);

    if (!download) {
      throw new Error(
        "Download not found"
      );
    }

    return {
      id: download.id,
      status:
        download.status,
      progress:
        download.progress,
      speed:
        download.speed,
      eta:
        download.eta,
      filename:
        download.filename,
      error:
        download.error
    };
  };

/**
 * Get completed downloaded file
 */
export const getDownloadedFile =
  async (id) => {
    const download =
      downloads.get(id);

    if (!download) {
      throw new Error(
        "Download not found"
      );
    }

    if (
      download.status !==
      "completed"
    ) {
      throw new Error(
        `Download is not completed. Current status: ${download.status}`
      );
    }

    if (!download.path) {
      throw new Error(
        "Downloaded file path is missing"
      );
    }

    try {
      await fs.access(
        download.path
      );
    } catch {
      throw new Error(
        "Downloaded file no longer exists"
      );
    }

    return {
      path: download.path,
      filename:
        download.filename
    };
  };