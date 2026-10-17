
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DOWNLOAD_DIR = path.resolve("downloads");
const LINKS_DIR = path.join(DOWNLOAD_DIR, ".temp-links");
const LINK_LIFETIME_MS = 30 * 60 * 1000;

const getRecordPath = (token) =>
  path.join(LINKS_DIR, `${token}.json`);

const removeRecord = async (token) => {
  await fs.unlink(getRecordPath(token)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
};

const isValidToken = (token) =>
  typeof token === "string" &&
  /^[a-f0-9]{64}$/i.test(token);

const deleteVideoFile = async (filePath) => {
  const resolved = path.resolve(filePath);
  const relative = path.relative(DOWNLOAD_DIR, resolved);

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.startsWith(".temp-links")
  ) {
    throw new Error("Invalid download file path.");
  }

  await fs.unlink(resolved).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
};

const readRecord = async (token) => {
  if (!isValidToken(token)) return null;

  try {
    return JSON.parse(
      await fs.readFile(getRecordPath(token), "utf8")
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const saveRecord = async (token, record) => {
  const recordPath = getRecordPath(token);
  const tempPath = `${recordPath}.${randomBytes(8).toString("hex")}.tmp`;

  await fs.writeFile(tempPath, JSON.stringify(record), {
    flag: "wx"
  });

  await fs.rename(tempPath, recordPath);
};

export const createTemporaryDownloadLink = async (file) => {
  await fs.mkdir(LINKS_DIR, { recursive: true });

  const filePath = path.resolve(file.path);
  const relative = path.relative(DOWNLOAD_DIR, filePath);

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.startsWith(".temp-links")
  ) {
    throw new Error("Download file is outside the downloads directory.");
  }

  await fs.access(filePath);

  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + LINK_LIFETIME_MS;

  await saveRecord(token, {
    path: filePath,
    filename: path.basename(file.filename),
    expiresAt,
    inUse: false
  });

  return { token, expiresAt };
};

export const getTemporaryDownload = async (token) => {
  const record = await readRecord(token);

  if (!record) return null;

  if (Date.now() >= record.expiresAt) {
    if (!record.inUse) {
      await removeRecord(token);
      await deleteVideoFile(record.path);
    }

    return null;
  }

  if (record.inUse) return null;

  // Mark the link as being used before serving the file.
  record.inUse = true;
  await saveRecord(token, record);

  return record;
};

export const finishTemporaryDownload = async (
  token,
  successful
) => {
  const record = await readRecord(token);

  if (!record) return;

  if (successful || Date.now() >= record.expiresAt) {
    await removeRecord(token);
    await deleteVideoFile(record.path);
    return;
  }

  record.inUse = false;
  await saveRecord(token, record);
};

// Remove expired records and files periodically.
const cleanup = setInterval(async () => {
  try {
    await fs.mkdir(LINKS_DIR, { recursive: true });
    const files = await fs.readdir(LINKS_DIR);

    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/i.test(name)) continue;

      const token = name.slice(0, -5);
      const record = await readRecord(token);

      if (!record || record.inUse) continue;
      if (Date.now() < record.expiresAt) continue;

      await fs.unlink(getRecordPath(token)).catch(() => {});
      await deleteVideoFile(record.path);
    }
  } catch (error) {
    console.error("Temporary download cleanup error:", error);
  }
}, 60_000);

cleanup.unref();
