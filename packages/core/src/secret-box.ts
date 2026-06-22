import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 设备本地 secret 加密(env 变量 at-rest 加密)。
 *
 * - AES-256-GCM，每条 value 独立随机 IV。
 * - 设备密钥存独立文件(0600)，与 sqlite 库分离，方便单独保护/轮换。
 * - 落库格式：`enc:v1:<base64(iv|tag|ciphertext)>`，带前缀便于识别与平滑迁移
 *   (老的明文值没有前缀 → 读时原样返回，写时才升级为密文)。
 */

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export class SecretBox {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_LEN) throw new Error(`SecretBox key must be ${KEY_LEN} bytes`);
    this.key = key;
  }

  /**
   * 从密钥文件加载，缺失则生成(0600)。`:memory:`/缺省路径用进程内随机密钥
   * (测试/纯内存场景，不落盘也就不需要持久密钥)。
   */
  static fromKeyFile(keyPath: string | undefined): SecretBox {
    if (!keyPath || keyPath === ":memory:") return new SecretBox(randomBytes(KEY_LEN));
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath, "utf8").trim();
      const key = Buffer.from(raw, "base64");
      if (key.length === KEY_LEN) return new SecretBox(key);
      // 文件存在但内容异常：不静默覆盖(可能是误配)，直接报错让人介入。
      throw new Error(`invalid device key at ${keyPath} (expected ${KEY_LEN}-byte base64)`);
    }
    const key = randomBytes(KEY_LEN);
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
    return new SecretBox(key);
  }

  /** 是否已是本方案的密文。 */
  static isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
  }

  /** 解密；非本方案前缀的值视为历史明文，原样返回(平滑迁移)。 */
  decrypt(value: string): string {
    if (!SecretBox.isEncrypted(value)) return value;
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}
