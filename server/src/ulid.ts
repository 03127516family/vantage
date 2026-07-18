// ULID:48bit 毫秒时间戳(10 字符)+ 80bit 随机(16 字符),Crockford Base32,共 26 字符。
// 用途:S3 event 的 event_id(唯一性 + 文件名安全)。零依赖。
// 注:随机部分按字节取模 32(256 整除 32,无偏),非位打包的标准 ULID,
// 但长度/字符集/字典序/唯一性与之一致,对"唯一 ID"用途等价。
import { randomFillSync } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford(无 I/L/O/U)

export function ulid(now: number = Date.now()): string {
  let id = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    id = ENCODING[t % 32] + id;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  randomFillSync(rand);
  for (const byte of rand) id += ENCODING[byte % 32];
  return id;
}
