

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
|--------------------------------------------------------------------------
| Temporary share links
|--------------------------------------------------------------------------
|
| Used when a file is too large for Telegram. The bot gives the user a
| link like https://your-host/d/<token>. The link shows a small landing
| page (so Telegram's link-preview crawler doesn't trigger the download),
| then serves the file. After one complete download, or when the link
| expires, the file is deleted.
|
| Links live in memory, so they are lost if the process restarts.
|
*/

const TTL_MINUTES = Number(
  process.env.SHARE_LINK_TTL_MINUTES || 30
  );

const TTL_MS = TTL_MINUTES * 60 * 1000;

// token -> { filePath, filename, expiresAt, active, completed }
const links = new Map();

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );

const toSafeFilename = (title, filePath) => {
  const ext = path.extname(filePath);

  const cleaned = String(title || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return `${cleaned || "video"}${ext}`;
};

const removeLink = (token) => {
  const entry = links.get(token);

  if (!entry) {
    return;
  }

  links.delete(token);

  fs.unlink(entry.filePath, (error) => {
    if (error && error.code !== "ENOENT") {
      console.error(
        "Unable to delete shared file:",
        error.message
      );
    }
  });
};

const getLiveLink = (token) => {
  const entry = links.get(token);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt < Date.now()) {
    // Don't pull the file out from under a transfer in progress.
    if (entry.active === 0) {
      removeLink(token);
    }

    return null;
  }

  return entry;
};

/**
 * Register a file and return a temporary public URL for it.
 */
export const createShareLink = ({
  filePath,
  title
}) => {
  const publicUrl = (
    process.env.PUBLIC_URL || ""
  ).replace(/\/+$/, "");

  if (!publicUrl) {
    throw new Error(
      "PUBLIC_URL is not set in .env"
    );
  }

  const token = crypto
    .randomBytes(24)
    .toString("base64url");

  links.set(token, {
    filePath,
    filename: toSafeFilename(title, filePath),
    expiresAt: Date.now() + TTL_MS,
    active: 0,
    completed: false
  });

  return {
    url: `${publicUrl}/d/${token}`,
    expiresInMinutes: TTL_MINUTES
  };
};

const router = express.Router();

const noStore = (res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
};

/*
 * Landing page. Telegram fetches links to build previews, so the
 * actual file lives behind a second URL that only the button uses.
 */
router.get("/d/:token", (req, res) => {
  noStore(res);

  const entry = getLiveLink(req.params.token);

  if (!entry) {
    return res
      .status(404)
      .send("This link has expired or is invalid.");
  }

  const minutesLeft = Math.max(
    1,
    Math.ceil((entry.expiresAt - Date.now()) / 60000)
  );

  return res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Download</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}
  main{max-width:420px;padding:24px;text-align:center}
  a.btn{display:inline-block;margin:16px 0;padding:12px 24px;background:#2aabee;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}
  p{color:#aaa;font-size:14px;word-break:break-word}
</style>
</head>
<body>
<main>
  <h1>Your file is ready</h1>
  <p>${escapeHtml(entry.filename)}</p>
  <a class="btn" href="/d/${encodeURIComponent(req.params.token)}/file">Download</a>
  <p>This link expires in about ${minutesLeft} min, or after one complete download.</p>
</main>
</body>
</html>`);
});

router.get("/d/:token/file", (req, res) => {
  noStore(res);

  const token = req.params.token;
  const entry = getLiveLink(token);

  if (!entry) {
    return res
      .status(404)
      .send("This link has expired or is invalid.");
  }

  entry.active += 1;

  res.on("close", () => {
    entry.active -= 1;

    // A full, uninterrupted 200 response means the download is done.
    // Range (206) and aborted transfers keep the link alive.
    if (res.statusCode === 200 && res.writableFinished) {
      entry.completed = true;
    }

    if (entry.active === 0) {
      if (
        entry.completed ||
        entry.expiresAt < Date.now()
      ) {
        removeLink(token);
      }
    }
  });

  return res.download(
    entry.filePath,
    entry.filename,
    (error) => {
      if (error) {
        console.error(
          "Share link transfer error:",
          error.message
        );

        if (!res.headersSent) {
          res.status(404).send("File not available.");
        }
      }
    }
  );
});

// Delete anything that expired without being downloaded.
const sweeper = setInterval(() => {
  for (const [token, entry] of links) {
    if (entry.expiresAt < Date.now() && entry.active === 0) {
      removeLink(token);
    }
  }
}, 60 * 1000);

sweeper.unref();

/**
 * Start the small web server that serves the share links.
 * The bot runs as its own process, so it needs its own server.
 */
export const startShareServer = () => {
  const app = express();

  app.disable("x-powered-by");
  app.use(router);

  const port = Number(process.env.SHARE_PORT || 3001);

  return app.listen(port, () => {
    console.log(
      `Share link server listening on port ${port}`
    );
  });
};