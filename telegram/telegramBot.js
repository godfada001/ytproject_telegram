import { Bot } from "node-telegram-bot-api";
import "dotenv/config";

import {
  getFormats,
  downloadVideo,
  getDownloadProgress,
  getDownloadedFile
} from "../services/ytdlpServices.js";

import { fromPath } from "node-telegram-bot-api/node";
import fs from "node:fs/promises";

import {
  createShareLink,
  startShareServer
} from "../services/shareLinkService.js";

/*
 * Telegram's standard Bot API only accepts uploads up to 50 MB.
 * Stay a little under it. Anything bigger is sent as a temporary
 * download link instead.
 */
const MAX_TELEGRAM_UPLOAD_BYTES =
  Number(
    process.env.MAX_TELEGRAM_UPLOAD_MB || 49
  ) *
  1024 *
  1024;

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing from .env"
  );
}

const bot = new Bot(token);

/*
|--------------------------------------------------------------------------
| Owner notifications
|--------------------------------------------------------------------------
|
| Sends YOU a Telegram message (which pushes to your phone) when someone
| uses the bot. Set OWNER_CHAT_ID in .env. Send /myid to the bot to find it.
| You must have sent /start to the bot at least once yourself, or Telegram
| won't let it message you.
|
*/

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

const notifyOwner = async (ctx, action) => {
  if (!OWNER_CHAT_ID) {
    return;
  }

  try {
    const user =
      ctx.from ||
      ctx.message?.from ||
      ctx.callbackQuery?.from ||
      {};

    const name =
      [user.first_name, user.last_name]
        .filter(Boolean)
        .join(" ") || "Unknown user";

    const handle = user.username
      ? ` (@${user.username})`
      : "";

    await bot.api.sendMessage({
      chat_id: OWNER_CHAT_ID,
      text:
        `🔔 ${name}${handle} [id ${user.id ?? ctx.chat?.id}]\n` +
        action
    });
  } catch (error) {
    console.error(
      "Unable to notify owner:",
      error.message
    );
  }
};

/*
|--------------------------------------------------------------------------
| Temporary storage
|--------------------------------------------------------------------------
|
| We need to remember which YouTube URL belongs to each Telegram user.
|
*/

const pendingDownloads = new Map();

/*
|--------------------------------------------------------------------------
| /start
|--------------------------------------------------------------------------
*/

bot.command("myid", async (ctx) => {
  await ctx.reply(
    `Your chat ID is: ${ctx.chat.id}`
  );
});

bot.command("start", async (ctx) => {
  notifyOwner(ctx, "Started the bot");

  await ctx.reply(
    "👋 Welcome to the YT Downloader Bot!\n\nSend me a YouTube link and I'll show you the available video qualities."
  );
});

/*
|--------------------------------------------------------------------------
| Wait for download
|--------------------------------------------------------------------------
*/


const waitForDownload = async (
  downloadId,
  chatId,
  resolution,
  progressMessage
) => {
  let lastProgress = -1;

  while (true) {
    const progress =
      await getDownloadProgress(
        downloadId
      );

    console.log(
      `Download ${downloadId}: ${progress.status} ${progress.progress}%`
    );

    if (
      progress.progress !== lastProgress
    ) {
      lastProgress =
        progress.progress;

      try {
        await bot.api.editMessageText({
          chat_id: chatId,
          message_id:
            progressMessage.message_id,
          text: formatProgressMessage(
            resolution,
            progress
          )
        });
      } catch (error) {
        console.error(
          "Unable to update progress message:",
          error.message
        );
      }
    }

    if (
      progress.status ===
      "completed"
    ) {
      return await getDownloadedFile(
        downloadId
      );
    }

    if (
      progress.status === "error"
    ) {
      throw new Error(
        progress.error ||
          "Download failed"
      );
    }

    await new Promise(
      (resolve) => {
        setTimeout(
          resolve,
          2000
        );
      }
    );
  }
};


const createProgressBar = (progress) => {
  const totalBars = 12;

  const filledBars = Math.round(
    (progress / 100) * totalBars
  );

  const emptyBars =
    totalBars - filledBars;

  return (
    "█".repeat(filledBars) +
    "░".repeat(emptyBars)
  );
};

const formatProgressMessage = (
  resolution,
  progress
) => {
  const bar = createProgressBar(
    progress.progress
  );

  return (
    `⬇️ Downloading ${
      typeof resolution === "number"
        ? `${resolution}p`
        : resolution
    }\n\n` +
    `${bar} ${progress.progress.toFixed(0)}%\n\n` +
    `⚡ Speed: ${
      progress.speed || "Calculating..."
    }\n` +
    `⏱ ETA: ${
      progress.eta || "Calculating..."
    }`
  );
};

/*
|--------------------------------------------------------------------------
| Format helpers
|--------------------------------------------------------------------------
*/

const formatFileSize = (bytes) => {
  if (!bytes) {
    return "Unknown size";
  }

  const mb = bytes / (1024 * 1024);

  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }

  const gb = mb / 1024;

  return `${gb.toFixed(2)} GB`;
};

const getFormatSize = (format) => {
  return (
    format.filesize ||
    format.filesizeApprox ||
    null
  );
};

/*
|--------------------------------------------------------------------------
| YouTube URL
|--------------------------------------------------------------------------
*/

const youtubeRegex =
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i;

/*
|--------------------------------------------------------------------------
| Messages
|--------------------------------------------------------------------------
*/

bot.on("message", async (ctx) => {
  try {
    const text =
      ctx.message?.text?.trim();

    if (!text) {
      return;
    }

    // Ignore commands
    if (text.startsWith("/")) {
      return;
    }

    /*
    |--------------------------------------------------------------------------
    | YouTube URL
    |--------------------------------------------------------------------------
    */

    if (youtubeRegex.test(text)) {
      notifyOwner(ctx, `Sent a link:\n${text}`);

      try {
        await ctx.reply(
          "🔍 Checking available video qualities..."
        );

        console.log(
          "YouTube URL received:",
          text
        );

        /*
        |--------------------------------------------------------------------------
        | Get formats from yt-dlp
        |--------------------------------------------------------------------------
        */

        const formats =
          await getFormats(text);

        console.log(
  "AVAILABLE FORMATS FROM SERVICE:"
);

console.log(
  JSON.stringify(
    formats,
    null,
    2
  )
);

        /*
        |--------------------------------------------------------------------------
        | Find useful video formats
        |--------------------------------------------------------------------------
        */

  
const wantedResolutions = [
  {
    label: 2160,
    width: 3840
  },
  {
    label: 1440,
    width: 2560
  },
  {
    label: 1080,
    width: 1920
  },
  {
    label: 720,
    width: 1280
  },
  {
    label: 480,
    width: 854
  },
  {
    label: 360,
    width: 640
  }
];

const videoFormats = [];

for (const resolution of wantedResolutions) {
  const matchingFormats =
    formats.video.filter((format) => {
      return (
        format.width ===
        resolution.width
      );
    });

  if (
    matchingFormats.length === 0
  ) {
    continue;
  }

  /*
  |--------------------------------------------------------------------------
  | Prefer MP4
  |--------------------------------------------------------------------------
  */

  const mp4Formats =
    matchingFormats.filter(
      (format) =>
        format.ext === "mp4"
    );

  /*
  |--------------------------------------------------------------------------
  | Prefer formats with a known file size
  |--------------------------------------------------------------------------
  */

  const formatsWithSize =
    mp4Formats.filter(
      (format) =>
        format.filesize ||
        format.filesizeApprox
    );

  const selectedFormat =
    formatsWithSize[0] ||
    mp4Formats[0] ||
    matchingFormats[0];

  /*
  |--------------------------------------------------------------------------
  | Find best audio
  |--------------------------------------------------------------------------
  */

  const audioFormats =
    formats.audio.filter(
      (format) =>
        format.ext === "m4a"
    );

  const audioFormat =
    audioFormats.sort(
      (a, b) =>
        (b.bitrate || 0) -
        (a.bitrate || 0)
    )[0];

  if (!audioFormat) {
    continue;
  }

  /*
  |--------------------------------------------------------------------------
  | Calculate estimated size
  |--------------------------------------------------------------------------
  */

  const videoSize =
    getFormatSize(
      selectedFormat
    );

  const audioSize =
    getFormatSize(
      audioFormat
    );

  let totalSize = null;

  if (
    videoSize &&
    audioSize
  ) {
    totalSize =
      videoSize +
      audioSize;
  }

  videoFormats.push({
    resolution:
      resolution.label,

    videoFormatId:
      selectedFormat.formatId,

    audioFormatId:
      audioFormat.formatId,

    ext:
      selectedFormat.ext,

    size:
      totalSize
  });
}


        /*
        |--------------------------------------------------------------------------
        | No formats
        |--------------------------------------------------------------------------
        */

        if (
          videoFormats.length === 0
        ) {
          await ctx.reply(
            "❌ I couldn't find any downloadable video formats for this video."
          );

          return;
        }

        /*
        |--------------------------------------------------------------------------
        | Save URL and formats
        |--------------------------------------------------------------------------
        */

        /*
         * Best audio-only format (m4a plays everywhere and
         * can be sent to Telegram without converting).
         * formats.audio is already limited to one language.
         */
        const bestAudio =
          formats.audio
            .filter(
              (format) =>
                format.ext === "m4a"
            )
            .sort(
              (a, b) =>
                (b.bitrate || 0) -
                (a.bitrate || 0)
            )[0] || null;

        pendingDownloads.set(
          ctx.chat.id,
          {
            url: text,
            title: formats.title,
            formats: videoFormats,
            audio: bestAudio
              ? {
                  formatId:
                    bestAudio.formatId,
                  size:
                    getFormatSize(
                      bestAudio
                    )
                }
              : null
          }
        );

        /*
        |--------------------------------------------------------------------------
        | Build buttons
        |--------------------------------------------------------------------------
        */

        const buttons =
          videoFormats.map(
            (format) => {
              const size =
                format.size
                  ? formatFileSize(
                      format.size
                    )
                  : "Size unknown";

              return [
                {
                  text: `${format.resolution}p • ${size}`,
                  callback_data:
                    `download_${format.resolution}`
                }
              ];
            }
          );

        /*
        |--------------------------------------------------------------------------
        | Audio button
        |--------------------------------------------------------------------------
        */

        if (bestAudio) {
          const audioSize =
            getFormatSize(bestAudio);

          buttons.push([
            {
              text: `🎵 Audio only • ${
                audioSize
                  ? formatFileSize(
                      audioSize
                    )
                  : "Size unknown"
              }`,
              callback_data:
                "download_audio"
            }
          ]);
        }

        /*
        |--------------------------------------------------------------------------
        | Send choices
        |--------------------------------------------------------------------------
        */

        await ctx.reply(
          `🎬 ${formats.title}\n\n⏱ Duration: ${
            formats.duration || "Unknown"
          }\n\nChoose your download quality:`,
          {
            reply_markup: {
              inline_keyboard:
                buttons
            }
          }
        );

        return;
      } catch (error) {
        console.error(
          "Format lookup error:",
          error
        );

        await ctx.reply(
          `❌ Unable to get video formats.\n\n${error.message}`
        );
      }

      return;
    }

    await ctx.reply(
      "Please send me a valid YouTube link."
    );
  } catch (error) {
    console.error(
      "Telegram bot error:",
      error
    );
  }
});

/*
|--------------------------------------------------------------------------
| Button clicks
|--------------------------------------------------------------------------
*/

bot.on(
  "callback_query",
  async (ctx) => {
    try {
      const data =
        ctx.callbackQuery?.data;

      if (!data) {
        return;
      }

      const chatId =
        ctx.chat?.id;

      if (!chatId) {
        return;
      }

      /*
      |--------------------------------------------------------------------------
      | Get pending download
      |--------------------------------------------------------------------------
      */

      const pending =
        pendingDownloads.get(
          chatId
        );

      if (!pending) {
        await ctx.answerCallbackQuery({
          text: "This download request has expired."
        });

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | Audio
      |--------------------------------------------------------------------------
      */

      if (
        data === "download_audio"
      ) {
        if (!pending.audio) {
          await ctx.answerCallbackQuery({
            text: "No audio format found."
          });

          return;
        }

        await ctx.answerCallbackQuery({
          text: "Audio selected"
        });

        notifyOwner(
          ctx,
          "Started an audio download"
        );

        const audioProgressMessage =
          await ctx.reply(
            `⬇️ Downloading audio...\n\n` +
            `░░░░░░░░░░░░ 0%\n\n` +
            `⚡ Speed: Calculating...\n` +
            `⏱ ETA: Calculating...`
          );

        const audioResult =
          await downloadVideo(
            pending.url,
            `audio:${pending.audio.formatId}`
          );

        const audioFile =
          await waitForDownload(
            audioResult.downloadId,
            chatId,
            "audio",
            audioProgressMessage
          );

        const audioStats =
          await fs.stat(audioFile.path);

        console.log(
          "AUDIO FILE SIZE:",
          (
            audioStats.size /
            (1024 * 1024)
          ).toFixed(2),
          "MB"
        );

        if (
          audioStats.size <=
          MAX_TELEGRAM_UPLOAD_BYTES
        ) {
          await bot.api.sendAudio({
            chat_id: chatId,
            audio:
              await fromPath(
                audioFile.path
              ),
            title: pending.title,
            caption: "🎵 Audio"
          });
        } else {
          const audioLink =
            createShareLink({
              filePath: audioFile.path,
              title: pending.title
            });

          await ctx.reply(
            `📦 This audio is ${formatFileSize(
              audioStats.size
            )}, which is too large to send on Telegram.\n\n` +
              `🔗 Download it here:\n${audioLink.url}\n\n` +
              `⏳ The link expires in ${audioLink.expiresInMinutes} minutes, or right after you finish downloading.`,
            {
              link_preview_options: {
                is_disabled: true
              }
            }
          );
        }

        pendingDownloads.delete(chatId);

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | Video resolution
      |--------------------------------------------------------------------------
      */

      if (
        data.startsWith(
          "download_"
        )
      ) {
        const resolution =
          Number(
            data.replace(
              "download_",
              ""
            )
          );

        const selectedFormat =
          pending.formats.find(
            (format) =>
              format.resolution ===
              resolution
          );

        if (!selectedFormat) {
          await ctx.answerCallbackQuery({
            text: "Format not found."
          });

          return;
        }

        await ctx.answerCallbackQuery({
          text: `${resolution}p selected`
        });

        notifyOwner(
          ctx,
          `Started a ${resolution}p download`
        );

      
const progressMessage =
  await ctx.reply(
    `⬇️ Downloading ${resolution}p...\n\n` +
    `░░░░░░░░░░░░ 0%\n\n` +
    `⚡ Speed: Calculating...\n` +
    `⏱ ETA: Calculating...`
  );


        console.log(
          "Selected format:",
          selectedFormat
        );

        /*
        |--------------------------------------------------------------------------
        | Download selected format
        |--------------------------------------------------------------------------
        */

        const formatString =
          `${selectedFormat.videoFormatId}+${selectedFormat.audioFormatId}`;

        console.log(
          "yt-dlp format:",
          formatString
        );

        const result =
          await downloadVideo(
            pending.url,
            formatString
          );

        console.log(
          "Download started:",
          result
        );

        /*
        |--------------------------------------------------------------------------
        | Wait for completion
        |--------------------------------------------------------------------------
        */

        const file =
          await waitForDownload(
            result.downloadId,
            chatId,
            resolution,
            progressMessage
          );

        console.log(
          "Download completed:",
          file
        );

        await ctx.reply(
          `✅ ${resolution}p download complete!\n\n📤 Sending your video...`
        );

        /*
        |--------------------------------------------------------------------------
        | Send video
        |--------------------------------------------------------------------------
        */
const fileStats =
  await fs.stat(file.path);

console.log(
  "FINAL FILE:",
  file.path
);

console.log(
  "FINAL FILE SIZE:",
  (
    fileStats.size /
    (1024 * 1024)
  ).toFixed(2),
  "MB"
);
        if (
          fileStats.size <=
          MAX_TELEGRAM_UPLOAD_BYTES
        ) {
          await bot.api.sendVideo({
            chat_id: chatId,
            video:
              await fromPath(
                file.path
              ),
            caption:
              `🎬 ${resolution}p video`
          });

          console.log(
            "Video sent to Telegram."
          );
        } else {
          /*
          |--------------------------------------------------------------------------
          | Too big for Telegram: send a temporary download link
          |--------------------------------------------------------------------------
          */

          const link =
            createShareLink({
              filePath: file.path,
              title: pending.title
            });

          await ctx.reply(
            `📦 This video is ${formatFileSize(
              fileStats.size
            )}, which is too large to send on Telegram.\n\n` +
              `🔗 Download it here:\n${link.url}\n\n` +
              `⏳ The link expires in ${link.expiresInMinutes} minutes, or right after you finish downloading.`,
            {
              link_preview_options: {
                is_disabled: true
              }
            }
          );

          console.log(
            "Share link sent:",
            link.url
          );
        }

        /*
        |--------------------------------------------------------------------------
        | Remove pending request
        |--------------------------------------------------------------------------
        */

        pendingDownloads.delete(
          chatId
        );
      }
    } catch (error) {
      console.error(
        "Download error:",
        error
      );

      await ctx.reply(
        `❌ Download failed.\n\n${error.message}`
      );
    }
  }
);

console.log(
  "Telegram bot is running..."
);

startShareServer();

await bot.startPolling();