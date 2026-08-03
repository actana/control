/** Max upload size for project card images, enforced by the upload route. */
export const MAX_PROJECT_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The image formats a project card accepts, as one map from the extension we
 * store the file under to the MIME type we accept it as and serve it back with.
 *
 * One map rather than a list plus a separate lookup: the upload route has to
 * answer both "is this type allowed" and "what do I name the file", and two
 * structures that must agree would eventually not.
 */
export const PROJECT_IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const;

export type ProjectImageExtension = keyof typeof PROJECT_IMAGE_TYPES;

/** File extensions accepted for project card images. */
export const PROJECT_IMAGE_EXTENSIONS = Object.keys(
  PROJECT_IMAGE_TYPES,
) as readonly ProjectImageExtension[];

export const PROJECT_IMAGE_EXTENSION_SET = new Set<string>(PROJECT_IMAGE_EXTENSIONS);

/**
 * The extension to store a given upload under, or null when we don't accept it.
 *
 * `image/jpeg` normalizes to `jpg` — one extension per format, so a replace
 * always overwrites rather than leaving a `.jpeg` twin behind. Browsers may add
 * parameters (`image/png; charset=binary`), so only the type itself is compared.
 */
export function projectImageExtensionFor(
  contentType: string | null | undefined,
): ProjectImageExtension | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "image/jpeg") return "jpg";
  for (const [extension, mime] of Object.entries(PROJECT_IMAGE_TYPES)) {
    if (mime === type) return extension as ProjectImageExtension;
  }
  return null;
}

/** The MIME type to serve a stored file back as, keyed by its extension. */
export function projectImageContentType(extension: string): string {
  return (
    PROJECT_IMAGE_TYPES[extension.toLowerCase() as ProjectImageExtension] ??
    "application/octet-stream"
  );
}
