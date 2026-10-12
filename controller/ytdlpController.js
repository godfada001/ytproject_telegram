import {
  getVideoInfo as fetchVideoInfo,
  getFormats as fetchFormats,
  downloadVideo as startDownload,
  getDownloadProgress as fetchDownloadProgress,
  getDownloadedFile as fetchDownloadedFile
} from "../services/ytdlpServices.js";

export const getVideoInfo = async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "URL is required"
      });
    }

    const data = await fetchVideoInfo(url);

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error("Get video info error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to get video information"
    });
  }
};

export const getFormats = async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "URL is required"
      });
    }

    const data = await fetchFormats(url);

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error("Get formats error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to get available formats"
    });
  }
};

export const downloadVideo = async (req, res) => {
  try {
    const { url, format } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "URL is required"
      });
    }

    const result = await startDownload(url, format);

    return res.status(202).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Download video error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to start download"
    });
  }
};

export const getDownloadProgress = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Download ID is required"
      });
    }

    const data = await fetchDownloadProgress(id);

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error("Get download progress error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to get download progress"
    });
  }
};

export const getDownloadedFile = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Download ID is required"
      });
    }

    const file = await fetchDownloadedFile(id);

    return res.download(file.path, file.filename, (error) => {
      if (error) {
        console.error("File download error:", error);

        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: "Failed to send file"
          });
        }
      }
    });
  } catch (error) {
    console.error("Get downloaded file error:", error);

    return res.status(404).json({
      success: false,
      message: error.message || "File not found"
    });
  }
};