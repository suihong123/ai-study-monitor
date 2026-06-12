import { mkdir, writeFile } from "fs/promises";
import path from "path";

export async function saveCaptureLocally(dataUrl: string, sessionId: string) {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const base64 = dataUrl.slice(commaIndex + 1);
  const buffer = Buffer.from(base64, "base64");
  const dir = path.join(process.cwd(), "public", "captures", sessionId);
  await mkdir(dir, { recursive: true });

  const fileName = `${Date.now()}.jpg`;
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, buffer);

  return `/captures/${sessionId}/${fileName}`;
}

export async function uploadToTencentCosPlaceholder() {
  return null;
}
