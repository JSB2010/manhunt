import type { FirebaseHandles } from './firebase.js';

/** Private object storage (photos, route archives). No public ACLs, ever. */
export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  exists(key: string): Promise<boolean>;
}

export class GcsObjectStore implements ObjectStore {
  constructor(private bucket: FirebaseHandles['bucket']) {}

  async put(key: string, bytes: Buffer, contentType: string, metadata: Record<string, string> = {}) {
    await this.bucket.file(key).save(bytes, {
      resumable: false,
      contentType,
      metadata: { cacheControl: 'private, no-store', metadata },
    });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const [buf] = await this.bucket.file(key).download();
      return buf;
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 404) return null;
      throw e;
    }
  }

  async exists(key: string) {
    const [ok] = await this.bucket.file(key).exists();
    return ok;
  }

  async delete(key: string) {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }

  async deletePrefix(prefix: string) {
    const [files] = await this.bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    return files.length;
  }
}

/** In-memory store for unit tests only. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async put(key: string, bytes: Buffer, contentType: string) {
    this.objects.set(key, { bytes, contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.bytes ?? null;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string) {
    let n = 0;
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) (this.objects.delete(k), n++);
    return n;
  }
}

/**
 * Remove metadata segments (EXIF/GPS in APP1, XMP, ICC, comments, maker notes)
 * from a JPEG while keeping image data intact. Served photos never carry the
 * capture device's location metadata (spec §11.4).
 */
export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new Error('not a JPEG');
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i < input.length) {
    if (input[i] !== 0xff) throw new Error('corrupt JPEG marker');
    let marker = input[i + 1]!;
    while (marker === 0xff) {
      i++;
      marker = input[i + 1]!;
    }
    if (marker === 0xda) {
      // Start of scan: copy the rest verbatim.
      out.push(input.subarray(i));
      break;
    }
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    const len = input.readUInt16BE(i + 2);
    const segment = input.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe1 && marker <= 0xef; // keep APP0 (JFIF)
    const isComment = marker === 0xfe;
    if (!isApp && !isComment) out.push(segment);
    i += 2 + len;
  }
  return Buffer.concat(out);
}
