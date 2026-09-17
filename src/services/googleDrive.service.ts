import { HttpError } from "../utils/HttpError";
import { extractPdfText, MAX_UPLOAD_BYTES } from "./source.service";

// The only place the Google Drive REST API is called — plain fetch against
// the v3 REST endpoints (no googleapis SDK) since this is just two GET
// calls, both taking the caller's own OAuth access token directly as a
// Bearer token. That token is the user's own (obtained by the client via
// Google Sign-In with Drive scope, e.g. drive.readonly) — this backend
// never has its own Drive credentials and never stores the token.
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const PDF_MIME_TYPE = "application/pdf";

interface GoogleDriveSourceResult {
  title: string;
  contents: string;
  sourceType: "text" | "pdf";
}

async function driveFetch(path: string, accessToken: string): Promise<Response> {
  const response = await fetch(`${DRIVE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.ok) return response;

  // Map Drive's own error responses to ours rather than leaking Google's
  // error JSON shape — these are the only statuses actually worth
  // distinguishing for a caller.
  if (response.status === 401) {
    throw new HttpError(401, "Google Drive access token is invalid or expired");
  }
  if (response.status === 403) {
    throw new HttpError(403, "Not authorized to access this Google Drive file with the given token");
  }
  if (response.status === 404) {
    throw HttpError.notFound("Google Drive file not found");
  }
  throw new HttpError(502, `Google Drive request failed with status ${response.status}`);
}

/**
 * Fetches a Google Drive file's content by id, using the caller's own
 * OAuth access token — Google Docs are exported as plain text; PDFs are
 * downloaded as raw bytes and run through the same extraction used for
 * uploaded PDFs. Any other file type is rejected.
 */
export async function fetchGoogleDriveSource(
  fileId: string,
  accessToken: string,
): Promise<GoogleDriveSourceResult> {
  const metadataResponse = await driveFetch(
    `/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size`,
    accessToken,
  );
  const metadata = (await metadataResponse.json()) as {
    name: string;
    mimeType: string;
    size?: string;
  };

  if (metadata.mimeType === GOOGLE_DOC_MIME_TYPE) {
    const exportResponse = await driveFetch(
      `/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
      accessToken,
    );
    const contents = (await exportResponse.text()).trim();
    if (!contents) {
      throw HttpError.badRequest("The Google Doc appears to be empty");
    }
    return { title: metadata.name, contents, sourceType: "text" };
  }

  if (metadata.mimeType === PDF_MIME_TYPE) {
    const sizeBytes = metadata.size ? Number(metadata.size) : undefined;
    if (sizeBytes !== undefined && sizeBytes > MAX_UPLOAD_BYTES) {
      throw HttpError.badRequest("File exceeds the 15MB upload limit");
    }
    const fileResponse = await driveFetch(`/files/${encodeURIComponent(fileId)}?alt=media`, accessToken);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    const contents = await extractPdfText(buffer);
    return { title: metadata.name, contents, sourceType: "pdf" };
  }

  throw HttpError.badRequest(
    `Unsupported Google Drive file type "${metadata.mimeType}" — only Google Docs and PDF files are supported`,
  );
}
