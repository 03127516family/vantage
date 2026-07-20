// E2E 驱动:把一个事件 JSON 文件喂给 Lambda handler,stdout 打印响应 JSON。
// 用法: node --import tsx tests/lambda-driver.mjs <事件JSON文件路径>
// 每次调用都是新进程 = Lambda 冷启动语义(env 由调用方给)。
import { readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { handler } = await import("../server/lambda/handler.ts");
const res = await handler(event);
process.stdout.write(JSON.stringify(res));
