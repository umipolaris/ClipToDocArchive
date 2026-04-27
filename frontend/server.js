const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 900_000;
  server.timeout = 0;

  server.listen(port, hostname, () => {
    console.log(
      `> Next.js ready on http://${hostname}:${port} (dev=${dev}, requestTimeout=disabled, keepAlive=900s)`,
    );
  });
});
