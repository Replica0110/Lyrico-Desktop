/** Bounds retained data URLs; decoded browser images are managed by the webview. */
export class ImageCache {
  private entries = new Map<string, string | undefined>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries = 256) {}
  has(key: string) { return this.entries.has(key); }
  get(key: string) {
    const value = this.entries.get(key);
    if (this.entries.has(key)) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: string | undefined) {
    this.delete(key);
    const size = this.sizeOf(key, value);
    if (size > this.maxBytes) return;
    this.entries.set(key, value);
    this.bytes += size;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      this.delete(this.entries.keys().next().value!);
    }
  }
  delete(key: string) {
    if (!this.entries.has(key)) return;
    this.bytes -= this.sizeOf(key, this.entries.get(key));
    this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  private sizeOf(key: string, value?: string) {
    // Conservative UTF-16 estimate rather than assuming compact strings.
    return (key.length + (value?.length ?? 0)) * 2;
  }
}
