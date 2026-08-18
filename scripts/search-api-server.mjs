import http from "node:http";
import { POST } from "../app/api/search/route.ts";

const port = Number(process.env.SEARCH_API_PORT ?? 3002);

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/api/search") {
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  try {
    const webRequest = new Request(`http://127.0.0.1:${port}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: request,
      duplex: "half",
    });
    const result = await POST(webRequest);
    const body = await result.text();
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "검색 API 서버 오류" }));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`search API listening on http://127.0.0.1:${port}`));
