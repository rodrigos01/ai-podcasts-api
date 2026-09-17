import { PDFParse } from "pdf-parse";
import { HttpError } from "../utils/HttpError";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw HttpError.badRequest("File exceeds the 15MB upload limit");
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = result.pages
      .map((page) => page.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!text) {
      throw HttpError.badRequest("Could not extract any text from the uploaded PDF");
    }
    return text;
  } finally {
    await parser.destroy();
  }
}
