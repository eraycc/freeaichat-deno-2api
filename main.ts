// main.ts
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const FREEAI_API_BASE = "https://freeaichatplayground.com/api/v1";
const DEFAULT_MODEL = "Deepseek R1";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 128000;

// 从环境变量获取API keys
const ENV_API_KEYS = Deno.env.get("apikeys")?.split(",") || [];

// 从Authorization头中解析API keys
function parseAuthHeader(authHeader: string | null): string[] {
  if (!authHeader) return [];
  
  const bearer = authHeader.trim();
  if (!bearer.toLowerCase().startsWith("bearer ")) return [];
  
  const keys = bearer.slice(7).trim();
  if (["none", "null", "false"].includes(keys.toLowerCase()) || !keys) {
    return [];
  }
  
  return keys.split(",");
}

// 从可用keys中随机选择一个
function getRandomApiKey(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error("No API keys available");
  }
  return keys[Math.floor(Math.random() * keys.length)];
}

// 获取可用模型列表
async function fetchModels(apiKey: string) {
  try {
    const response = await fetch(`${FREEAI_API_BASE}/models`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        "Origin": "https://freeaichatplayground.com",
        "Referer": "https://freeaichatplayground.com/chat",
      },
      body: JSON.stringify({ type: "text" }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const models = await response.json();
    return models;
  } catch (error) {
    console.error("Error fetching models:", error);
    return [];
  }
}

// 转换为 OpenAI 格式的模型列表
function transformModelsToOpenAIFormat(models: any[]) {
  return {
    object: "list",
    data: models.map(model => ({
      id: model.name,
      object: "model",
      created: new Date(model.createdAt).getTime() / 1000,
      owned_by: model.provider,
      permission: [],
      root: model.name,
      parent: null,
    })),
  };
}

// 解析 FreeAI 特有的 SSE 格式响应
async function parseFreeAISSE(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No readable stream in response");
  }
  
  let combinedContent = "";
  let finishReason = "stop";
  let usage = { promptTokens: 0, completionTokens: 0 };
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = new TextDecoder().decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        if (line.startsWith('0:"')) {
          // 提取内容部分
          const content = line.slice(3, -1); // 去掉 0:" 和结尾的 "
          combinedContent += content;
        } else if (line.startsWith('e:{') || line.startsWith('d:{')) {
          // 提取结束信息和用量
          try {
            const data = JSON.parse(line.slice(2));
            if (data.finishReason) {
              finishReason = data.finishReason;
            }
            if (data.usage) {
              usage = data.usage;
            }
          } catch (e) {
            console.warn("Failed to parse finish message:", line);
          }
        }
      }
    }
    
    return {
      id: `chatcmpl-${Date.now()}`,
      content: combinedContent,
      finish_reason: finishReason,
      usage: {
        prompt_tokens: usage.promptTokens || 0,
        completion_tokens: usage.completionTokens || 0,
        total_tokens: (usage.promptTokens || 0) + (usage.completionTokens || 0)
      }
    };
    
  } catch (error) {
    console.error("Error parsing SSE response:", error);
    return {
      id: `chatcmpl-${Date.now()}`,
      content: "Error parsing response: " + error.message,
      finish_reason: "error",
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }
}

// 发送聊天请求到 freeaichatplayground
async function sendChatRequest(modelName: string, messages: any[], apiKey: string, temperature?: number, maxTokens?: number) {
  try {
    const formattedMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      parts: [{ type: "text", text: msg.content }]
    }));

    const requestBody = {
      model: modelName,
      messages: formattedMessages,
      config: {
        temperature: temperature !== undefined ? temperature : DEFAULT_TEMPERATURE,
        maxTokens: maxTokens !== undefined ? maxTokens : DEFAULT_MAX_TOKENS
      },
      apiKey: apiKey.startsWith('ai-') ? apiKey : `ai-${apiKey}`
    };

    const response = await fetch(`${FREEAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        "Origin": "https://freeaichatplayground.com",
        "Referer": "https://freeaichatplayground.com/chat",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat completion failed: ${response.status} - ${errorText}`);
    }

    // 处理 FreeAI 特有的 SSE 响应
    const parsedResponse = await parseFreeAISSE(response);
    return parsedResponse;
  } catch (error) {
    console.error("Error in chat completion:", error);
    throw error;
  }
}

// 转换为 OpenAI 格式的聊天响应
function transformChatResponseToOpenAIFormat(response: any, modelName: string) {
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: response.content,
        },
        finish_reason: response.finish_reason,
      },
    ],
    usage: response.usage
  };
}

// 处理流式响应请求
async function handleStreamRequest(
  request: Request, 
  modelName: string, 
  messages: any[], 
  apiKey: string,
  temperature?: number,
  maxTokens?: number
) {
  const encoder = new TextEncoder();
  
  const formattedMessages = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    parts: [{ type: "text", text: msg.content }]
  }));

  const requestBody = {
    model: modelName,
    messages: formattedMessages,
    config: {
      temperature: temperature !== undefined ? temperature : DEFAULT_TEMPERATURE,
      maxTokens: maxTokens !== undefined ? maxTokens : DEFAULT_MAX_TOKENS
    },
    apiKey: apiKey.startsWith('ai-') ? apiKey : `ai-${apiKey}`
  };

  const response = await fetch(`${FREEAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
      "Origin": "https://freeaichatplayground.com",
      "Referer": "https://freeaichatplayground.com/chat",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Chat completion failed: ${response.status} - ${errorText}`);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.error(new Error("No readable stream in response"));
        return;
      }
      
      const chatId = `chatcmpl-${Date.now()}`;
      
      // 发送初始消息
      const initialChunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null
        }]
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));
      
      try {
        let buffer = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = new TextDecoder().decode(value);
          buffer += chunk;
          
          // 处理缓冲区中的所有行
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            if (!line.trim()) continue;
            
            if (line.startsWith('0:"')) {
              // 提取内容部分并创建流式块
              const content = line.slice(3, -1); // 去掉 0:" 和结尾的 "
              
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{
                  index: 0,
                  delta: { content },
                  finish_reason: null
                }]
              };
              
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } else if (line.startsWith('e:{') || line.startsWith('d:{')) {
              // 处理结束消息
              try {
                const data = JSON.parse(line.slice(2));
                if (data.finishReason) {
                  const endChunk = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: data.finishReason
                    }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
              } catch (e) {
                console.warn("Failed to parse finish message:", line);
              }
            }
          }
        }
        
        // 确保发送最终的 [DONE] 消息
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        console.error("Stream processing error:", error);
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    }
  });
}

// 处理请求
async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检请求处理
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // 设置通用响应头
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    // 获取API keys
    const authHeader = request.headers.get("Authorization");
    const requestApiKeys = parseAuthHeader(authHeader);
    const availableApiKeys = requestApiKeys.length > 0 ? requestApiKeys : ENV_API_KEYS;
    const selectedApiKey = getRandomApiKey(availableApiKeys);
    
    // 模型列表接口
    if (path === "/v1/models" && request.method === "GET") {
      const models = await fetchModels(selectedApiKey);
      const openAIModels = transformModelsToOpenAIFormat(models);
      return new Response(JSON.stringify(openAIModels), { headers });
    }
    
    // 聊天完成接口
    else if (path === "/v1/chat/completions" && request.method === "POST") {
      const requestData = await request.json();
      const modelName = requestData.model || DEFAULT_MODEL;
      const messages = requestData.messages || [];
      const stream = requestData.stream || false;
      const temperature = requestData.temperature;
      const maxTokens = requestData.max_tokens;
      
      // 处理流式响应
      if (stream) {
        return handleStreamRequest(request, modelName, messages, selectedApiKey, temperature, maxTokens);
      }
      
      // 处理普通响应
      const chatResponse = await sendChatRequest(modelName, messages, selectedApiKey, temperature, maxTokens);
      const openAIResponse = transformChatResponseToOpenAIFormat(chatResponse, modelName);
      
      return new Response(JSON.stringify(openAIResponse), { headers });
    }
    
    // 未知路径
    else {
      return new Response(JSON.stringify({
        error: {
          message: "Not found",
          type: "invalid_request_error",
          code: "path_not_found",
        }
      }), { status: 404, headers });
    }
  } catch (error) {
    console.error("Error handling request:", error);
    return new Response(JSON.stringify({
      error: {
        message: error.message,
        type: "server_error",
        code: "internal_server_error",
      }
    }), { status: 500, headers });
  }
}

// 启动服务器
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Starting server on port ${port}...`);
serve(handleRequest, { port });
