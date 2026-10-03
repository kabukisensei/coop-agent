// The composer's draft around a send (#281): what the person typed and attached
// is theirs until Pi has accepted it, and the image limits the RPC boundary
// enforces are checked here first so a send that would be refused never clears
// the draft.

/** Decoded size of a base64 image payload, as the RPC validator counts it. */
export function imageBytes(image) {
  return typeof image.data === "string" ? Math.floor(image.data.length * 3 / 4) : 0;
}

/**
 * Why `files` cannot be sent as images, or null when they fit: the count, one
 * image over the per-image size, or all images over the total. `limits` is the
 * main process's attachLimits (images, imageBytes, imageTotalBytes).
 */
export function imageBudgetProblem(files, limits) {
  const images = files.filter((file) => file.kind === "image");
  if (limits.images && images.length > limits.images) return `${limits.images} images at most per message.`;
  const mib = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
  if (limits.imageBytes) {
    const big = images.find((image) => imageBytes(image) > limits.imageBytes);
    if (big) return `${big.name || "An image"} is over ${mib(limits.imageBytes)}; images up to ${mib(limits.imageBytes)} can be sent.`;
  }
  if (limits.imageTotalBytes) {
    const total = images.reduce((sum, image) => sum + imageBytes(image), 0);
    if (total > limits.imageTotalBytes) return `The images add up to ${mib(total)}; one message carries ${mib(limits.imageTotalBytes)} of images at most. Remove one and send again.`;
  }
  return null;
}

/**
 * The draft to show after a send was refused: the failed text comes back only
 * when the box is still empty (typing meanwhile is kept), and the failed
 * attachments come back ahead of anything attached meanwhile, each once.
 */
export function restoreDraft(current, failed) {
  const text = current.text ? current.text : failed.text;
  const kept = current.attachments.filter((file) => !failed.attachments.includes(file));
  return { text, attachments: [...failed.attachments, ...kept] };
}
