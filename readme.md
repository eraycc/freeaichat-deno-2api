# FreeAI Chat Playground 代理服务部署与使用指南

## 一、服务概述

这个 Deno 脚本是一个代理服务，用于将 OpenAI 格式的 API 请求转发到 FreeAI Chat Playground 的 API。主要功能包括：

- 支持多 API Key 轮换
- 兼容 OpenAI API 格式
- 支持流式和非流式响应
- 自动处理模型列表请求

## 二、部署说明

### 1. 环境准备

确保已安装 Deno 运行时环境（版本 1.30+）：

```bash
# 使用 curl 安装 Deno
curl -fsSL https://deno.land/x/install/install.sh | sh

# 或者使用 brew (macOS)
brew install deno
```

### 2. 获取 API Keys

API Keys 可以从以下途径获取：

1. **FreeAI Chat Playground 账户**：
   - 登录 [FreeAI Chat Playground](https://freeaichatplayground.com)
   - 发送一条聊天请求后在网络选项卡内聊天请求中找apiKey
```
   {"id":"xxx-xxx-xxx-xxx-xxx","messages":[{"role":"user","content":"你好","parts":[{"type":"text","text":"你好"}]}],"model":"GPT 4o mini","config":{"temperature":0.7,"maxTokens":150},"apiKey":"ai-xxx-xxx-xxx-xxx-xxxxxx"}
```
   - 格式通常为 `ai-xxx-xxx-xxx-xxx-xxxxxx`
   - 设置环境变量或当做apikey请求时，去掉前缀`ai-`

### 3. 部署方式

#### 方式一：本地运行

1. 将脚本保存为 `main.ts`
2. 设置环境变量并运行：

```bash
# 设置 API Keys（多个用逗号分隔）
export apikeys="key1,key2,key3"

# 运行服务（默认端口8000）
deno run --allow-net --allow-env main.ts

# 指定端口运行
PORT=3000 deno run --allow-net --allow-env main.ts
```

#### 方式二：Docker 部署

1. 创建 Dockerfile：

```dockerfile
FROM denoland/deno:latest

WORKDIR /app
COPY main.ts .

ENV PORT=8000
ENV apikeys="key1,key2,key3"

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "main.ts"]
```

2. 构建并运行：

```bash
docker build -t freeai-proxy .
docker run -p 8000:8000 -e apikeys="key1,key2" freeai-proxy
```

#### 方式三：Deno Deploy

1. 登录 [Deno Deploy](https://deno.com/deploy)
2. 创建新项目并粘贴脚本代码
3. 在设置中添加环境变量：
   - `apikeys` = "key1,key2,key3"

## 三、使用说明

### 1. 基本请求

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_api_key" \
  -d '{
    "model": "GPT 4o mini",
    "messages": [{"role": "user", "content": "你好"}],
    "temperature": 0.7,
    "max_tokens": 150
  }'
```

### 2. 流式请求

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_api_key" \
  -d '{
    "model": "Deepseek v3 0324",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 3. 获取模型列表

```bash
curl http://localhost:8000/v1/models \
  -H "Authorization: Bearer your_api_key"
```

### 4. 通过请求头传递多个 API Key

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer key1,key2,key3" \
  -d '{"model": "GPT 4o mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

## 四、配置选项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | 8000 | 服务监听端口 |
| `apikeys` | 无 | 默认 API Keys（逗号分隔） |
| `DEFAULT_MODEL` | Deepseek R1 | 默认模型名称 |
| `DEFAULT_TEMPERATURE` | 0.7 | 默认温度参数 |
| `DEFAULT_MAX_TOKENS` | 128000 | 默认最大 token 数 |

## 五、注意事项

1. **API Key 安全**：
   - 不要将 API Keys 提交到公共代码仓库
   - 建议使用环境变量或密钥管理服务存储 Keys
   - 定期轮换 API Keys

2. **性能考虑**：
   - 单个 Key 可能有速率限制
   - 多 Key 轮换可以提高可用性
   - 复杂任务建议使用流式响应

3. **错误处理**：
   - 模型不可用会返回 400 错误
   - 服务器错误会返回 500 错误

4. **计费信息**：
   - 不同模型的 `costPerMessage` 不同
   - 使用前请确认各模型的计费标准
   - 监控 API 使用量避免意外费用

## 六、常见问题

**Q：如何知道我的 API Key 是否有效？**

A：可以发送一个简单的聊天请求测试：

如果返回聊天内容，则 Key 有效。

**Q：为什么我的请求返回 401 错误？**

A：可能原因：
- 未提供 Authorization 头
- API Key 已过期或被撤销
- 所有提供的 Key 都无效

**Q：如何增加并发请求处理能力？**

A：
1. 部署多个实例并使用负载均衡
2. 提供更多的有效 API Keys
3. 调整 Deno 的 worker 数量（高级配置）

**Q：如何监控 API 使用情况？**

A：目前脚本没有内置监控功能，但可以：
1. 查看 FreeAI Chat Playground 账户的使用统计
2. 在代理层添加日志记录功能
3. 使用第三方监控工具
