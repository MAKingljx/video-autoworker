// The standalone release manifest enumerates the complete runtime tree and is
// materially larger than ordinary receipts. Keep its size contract separate
// so control-plane JSON remains subject to the existing narrow limits.
export const MAX_APPLICATION_RELEASE_MANIFEST_BYTES = 32 * 1024 * 1024
