import * as crypto from 'crypto';

export class HashUtil {
  /**
   * Genera un hash SHA-256 en formato hexadecimal en minúsculas.
   */
  static sha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
  }

  /**
   * Genera un hash SHA-256 de un objeto JSON ordenando sus claves canónicamente
   * para garantizar determinismo e inmutabilidad en la blockchain.
   */
  static sha256CanonicalJson(obj: unknown): string {
    const canonicalString = this.stringifyCanonical(obj);
    return this.sha256(canonicalString);
  }

  private static stringifyCanonical(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => this.stringifyCanonical(item)).join(',')}]`;
    }
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = sortedKeys.map(
      (key) =>
        `${JSON.stringify(key)}:${this.stringifyCanonical((obj as Record<string, unknown>)[key])}`,
    );
    return `{${pairs.join(',')}}`;
  }
}
