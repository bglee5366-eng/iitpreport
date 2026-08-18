import { spawn } from "node:child_process";

const node = process.execPath;
const api = spawn(node, ["scripts/template-api-server.mjs"], { stdio: "inherit", env: process.env });
const searchApi = spawn(node, ["--experimental-strip-types", "scripts/search-api-server.mjs"], { stdio: "inherit", env: process.env });
const app = spawn(node, ["node_modules/vinext/dist/cli.js", "dev"], { stdio: "inherit", env: process.env });
const stop = (code = 0) => { api.kill(); searchApi.kill(); app.kill(); process.exit(code); };
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
app.on("exit", (code) => stop(code ?? 0));
