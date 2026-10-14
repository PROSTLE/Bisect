import crypto from 'node:crypto';

/**
 * Normalise an error title/signature so that "Timeout after 3012ms on order 8f3a2c1d"
 * and "Timeout after 2875ms on order 77be01aa" look the same.
 */
export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ' ')
    .replace(/\b(?=[a-f]*\d)[0-9a-f]{7,64}\b/g, ' ') // hashes / ids (must contain a digit)
    .replace(/(["'`]).*?\1/g, ' ') // quoted values
    .replace(/\d+(\.\d+)?(ms|s|m|h|kb|mb|gb|%)?\b/g, ' ') // numbers with units
    .replace(/[^a-z_/.\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeFingerprint(service: string | null | undefined, signature: string): string {
  const basis = `${(service ?? '').toLowerCase()}|${normalizeSignature(signature)}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

const STOPWORDS = new Set(
  'the a an and or of on in at to for from with is are was were be been not no error errors issue failing failed fails failure after when while during via into than then this that these those its it has have had'.split(
    ' ',
  ),
);

/** Content tokens used for similarity and keyword matching. */
export function tokens(text: string): Set<string> {
  return new Set(
    normalizeSignature(text)
      .split(/[\s/._-]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
