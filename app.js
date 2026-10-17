import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import ytdlpRoute from "./routes/ytdlpRoute.js";
import errorMiddleware from "./middleware/errorMiddleware.js";
import tempDownloadRoute from "./routes/tempDownloadRoute.js";

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/ytdlp", ytdlpRoute);
app.use("/api/temp-download", tempDownloadRoute);

// Error handling
app.use(errorMiddleware);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`YT downloader API running on port ${PORT}`);
});

export default app;