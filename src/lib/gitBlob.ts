const encoder = new TextEncoder();

/** The SHA-1 git assigns to a blob with this content, so local and remote versions can be compared without downloading. */
export async function gitBlobSha(content: string): Promise<string> {
  const body = encoder.encode(content);
  const header = encoder.encode(`blob ${body.byteLength}\0`);
  const buf = new Uint8Array(header.byteLength + body.byteLength);
  buf.set(header, 0);
  buf.set(body, header.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
