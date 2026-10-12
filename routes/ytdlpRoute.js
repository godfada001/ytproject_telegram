import express from "express";
import {
  getVideoInfo,
  getFormats,
  downloadVideo,
  getDownloadProgress,
  getDownloadedFile
} from "../controller/ytdlpController.js";

const router = express.Router();

// Get video information
router.post("/info", getVideoInfo);

// Get available formats
router.post("/formats", getFormats);

// Start a download
router.post("/download", downloadVideo);

// Check download progress
router.get("/progress/:id", getDownloadProgress);

// Get/download completed file
router.get("/file/:id", getDownloadedFile);

export default router;