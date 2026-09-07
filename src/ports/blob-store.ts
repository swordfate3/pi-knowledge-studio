export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  /** Must return hash-verified bytes; callers cannot provide filesystem paths. */
  get(hash: string): Promise<Uint8Array>;
}
