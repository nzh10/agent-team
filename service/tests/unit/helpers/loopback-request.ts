import * as http from "node:http";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

// Send the path verbatim: URL normalization would invalidate path-handling tests.
export function loopbackRequest(
  port: number,
  path: string,
  opts: RequestOptions = {},
  agent?: false,
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: opts.method ?? "GET",
          headers: opts.headers,
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    },
  );
}
