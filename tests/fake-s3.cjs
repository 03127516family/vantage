#!/usr/bin/env node
"use strict";
// 测试用假 S3:任意 PUT 记录 {path, authorization, body} 到 JSONL 并返 200。
// 用法: node fake-s3.cjs <port> <logPath>
const http = require("node:http");
const fs = require("node:fs");

const [port, logPath] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        fs.appendFileSync(
          logPath,
          JSON.stringify({
            path: req.url,
            authorization: req.headers.authorization || "",
            body: Buffer.concat(chunks).toString("utf8"),
          }) + "\n"
        );
      }
      res.writeHead(200, { "content-type": "application/xml" });
      res.end();
    });
  })
  .listen(Number(port));
