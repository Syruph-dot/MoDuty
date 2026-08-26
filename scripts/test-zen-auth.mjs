// 最小测试脚本：验证 OpenCode Zen API 的认证方式
// 用法：先在 .env 中配置 OPENAI_API_KEY，然后运行：node scripts/test-zen-auth.mjs

import { readFileSync } from "node:fs";
import path from "node:path";

// 读取 .env 文件中的配置
const envPath = path.resolve(process.cwd(), ".env");
let apiKey = "";
let baseUrl = "";
let model = "";

try {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "OPENAI_API_KEY") apiKey = value;
    if (key === "OPENAI_BASE_URL") baseUrl = value;
    if (key === "MOMOKA_MODEL") model = value;
  }
} catch {
  console.error("无法读取 .env 文件");
  process.exit(1);
}

if (!apiKey) {
  console.error("错误：.env 中未配置 OPENAI_API_KEY");
  console.error("请前往 https://opencode.ai/auth 注册免费账号并获取 API key");
  process.exit(1);
}

if (!baseUrl) baseUrl = "https://opencode.ai/zen/v1";
if (!model) model = "hy3-free";

const endpoint = `${baseUrl}/chat/completions`;
const payload = {
  model,
  messages: [{ role: "user", content: "Hello, reply with just 'OK'" }],
  max_tokens: 10,
};

async function testAuth(label, headers) {
  console.log(`\n=== 测试 ${label} ===`);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`状态码: ${res.status}`);
    if (res.ok) {
      console.log(`响应成功: ${text.slice(0, 200)}`);
      return true;
    } else {
      console.log(`响应失败: ${text.slice(0, 300)}`);
      return false;
    }
  } catch (err) {
    console.error(`请求异常: ${err.message}`);
    return false;
  }
}

console.log(`\n测试配置:`);
console.log(`  Base URL: ${baseUrl}`);
console.log(`  Model: ${model}`);
console.log(`  API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

// 测试 1: x-api-key header（Zen 推荐方式）
const ok1 = await testAuth("x-api-key header", { "x-api-key": apiKey });

// 测试 2: Authorization: Bearer header（标准方式）
const ok2 = await testAuth("Authorization: Bearer", { authorization: `Bearer ${apiKey}` });

console.log(`\n=== 总结 ===`);
console.log(`x-api-key: ${ok1 ? "✅ 成功" : "❌ 失败"}`);
console.log(`Bearer:    ${ok2 ? "✅ 成功" : "❌ 失败"}`);

if (!ok1 && !ok2) {
  console.log("\n两种认证方式均失败，请检查 API key 是否正确。");
  process.exit(1);
}