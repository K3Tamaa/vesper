import crypto from 'node:crypto';

/**
 * Checksum helpers shared by the yt-dlp, ffmpeg and app updaters.
 *
 * Every download in Vesper is checked against a digest published by the
 * distributor. The helpers are pure so the policy can be tested without
 * touching the network.
 */

export function findChecksum(text, assetName) {
  const wanted = String(assetName || '');
  if (!wanted) return null;
  for (const line of String(text || '').split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === wanted) return match[1].toLowerCase();
  }
  return null;
}

export function parseDigestLine(text) {
  const match = String(text || '').match(/[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : null;
}

export function verifyDigest(actual, expected) {
  if (!expected) return false;
  return String(actual || '').toLowerCase() === String(expected).toLowerCase();
}

export function digestOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
