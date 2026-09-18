/**
 * What the file pickers offer.
 *
 * The server's list (`ALLOWED_CONTENT_TYPES` in `apps/api/src/routes/uploads.ts`) decides what is
 * stored; this only keeps a phone's picker from offering files the server would refuse. If the two
 * drift, the server still refuses — the picker only saves a wasted upload on a slow connection.
 *
 * Extensions sit next to the media types because phones often report no type for office files,
 * and a picker filtered by type alone would then hide them.
 */
export const UPLOAD_ACCEPT = [
  "application/pdf",
  "application/json",
  "application/xml",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/tiff",
  ".pdf",
  ".json",
  ".xml",
  ".zip",
  ".xlsx",
  ".docx",
  ".xls",
  ".txt",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
].join(",");

/**
 * A field photo — spec 11 §11.9: phones upload from the site; review stays desktop-first.
 *
 * JPEG and PNG are what phone cameras produce and what the server accepts. The camera is offered
 * on this input only; forcing it on the general picker would stop people attaching a saved file.
 */
export const PHOTO_ACCEPT = "image/jpeg,image/png";
