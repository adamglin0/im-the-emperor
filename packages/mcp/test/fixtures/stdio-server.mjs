// stdio 测试夹具：node stdio-server.mjs [--fail-start | --fail-start-echo-secret]
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildFixtureServer } from "./tools.mjs";

if (process.argv.includes("--fail-start")) {
  process.stderr.write("fixture: 启动失败（测试用）\n");
  process.exit(3);
}
if (process.argv.includes("--fail-start-echo-secret")) {
  // 密钥后跟 990 个字符：错误信息只取 stderr 末尾 1000 字时，截断点正好落在密钥中间
  process.stderr.write(`env dump: ${process.env.FIXTURE_SECRET}${"z".repeat(990)}\n`);
  process.exit(3);
}
const server = buildFixtureServer("stdio-fixture");
await server.connect(new StdioServerTransport());
