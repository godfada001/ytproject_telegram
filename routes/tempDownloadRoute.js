
import express from "express";

import {
  getTemporaryDownload,
  finishTemporaryDownload
} from "../services/tempDownloadService.js";

const router = express.Router();

router.get("/:token", async (req, res) => {
  const { token } = req.params;

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(404).send("Download link is invalid or expired.");
  }

  let file;

  try {
    file = await getTemporaryDownload(token);
  } catch (error) {
    console.error("Download link error:", error);
    return res.status(500).send("Unable to process this download.");
  }

  if (!file) {
    return res.status(410).send(
      "This download link is expired or unavailable."
    );
  }

  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");

  res.download(file.path, file.filename, async (error) => {
    try {
      if (error) {
        console.error("Browser download error:", error.message);
        await finishTemporaryDownload(token, false);
        return;
      }

      await finishTemporaryDownload(token, true);
    } catch (finishError) {
      console.error(
        "Unable to finalize temporary download:",
        finishError
      );
    }
  });
});

export default router;
