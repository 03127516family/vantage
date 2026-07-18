#!/usr/bin/env node
"use strict";
// 测试用假 S3(往返模拟器):
//   PUT   -> 存内存 + 记 {path, authorization, body} 到 JSONL(返 200)。日志格式不可改:T27 依赖它。
//   GET   /<bucket>           -> ListObjectsV2 XML(回放全部对象 key,支持 prefix)
//   GET   /<bucket>/<key>     -> 回放该对象 body(404 if 缺)
// 这样 restore:s3 的 LIST+GET 往返可在无真实 S3 下验证。用法: node fake-s3.cjs <port> <logPath>
const http = require("node:http");
const fs = require("node:fs");

const [port, logPath] = process.argv.slice(2);
// 内存对象库:rawPath(去 query) -> body
const objects = new Map();
const keyOf = (url) => url.split("?")[0];

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = keyOf(req.url);
      if (req.method === "PUT") {
        const body = Buffer.concat(chunks).toString("utf8");
        objects.set(raw, body);
        fs.appendFileSync(
          logPath,
          JSON.stringify({ path: req.url, authorization: req.headers.authorization || "", body }) + "\n"
        );
        res.writeHead(200, { "content-type": "application/xml" });
        res.end();
        return;
      }
      if (req.method === "GET") {
        const u = new URL(req.url, "http://x");
        const parts = u.pathname.split("/").filter(Boolean); // [bucket] => LIST;[bucket, key...] => GET object
        if (parts.length <= 1) {
          // ListObjectsV2:回放全部 key(解码后)。SDK 即使按 encoding-type=url 再解码也安全
          // —— key 只含 = / - . 字母数字,decodeURIComponent 对它们幂等。
          const prefix = u.searchParams.get("prefix") || "";
          const keys = [...objects.keys()]
            .map((p) => p.split("/").slice(2).join("/")) // path-style:/bucket/key... -> 去 "" 与 bucket
            .map((k) => decodeURIComponent(k)); // %3D -> =(真实 key)
          const filtered = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
          const xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            `<KeyCount>${filtered.length}</KeyCount><IsTruncated>false</IsTruncated>` +
            filtered.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
            "</ListBucketResult>";
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(xml);
          return;
        }
        // GET object:raw path 与 PUT 时一致(SDK 同一套编码,= -> %3D)
        const body = objects.get(raw);
        if (body == null) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
        return;
      }
      res.writeHead(200);
      res.end();
    });
  })
  .listen(Number(port));
