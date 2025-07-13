// main.ts
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const FREEAI_API_BASE = "https://freeaichatplayground.com/api/v1";
const DEFAULT_MODEL = "Deepseek R1";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 128000; // 128k tokens

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

// 解析 SSE 格式的响应
async function parseSSEResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No readable stream in response");
  }
  
  let content = "";
  let id = `chatcmpl-${Date.now()}`;
  let finishReason = "stop";
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = new TextDecoder().decode(value);
      content += chunk;
    }
    
    // 解析所有 SSE 消息
    const messages = content.split('\n\n')
      .filter(msg => msg.trim().startsWith('data:'))
      .map(msg => {
        const jsonStr = msg.replace('data:', '').trim();
        try {
          return JSON.parse(jsonStr);
        } catch (e) {
          console.warn("Failed to parse SSE message:", jsonStr);
          return null;
        }
      })
      .filter(Boolean);
    
    // 找到最后一条完整消息
    const lastCompleteMessage = messages.findLast((msg: any) => 
      msg.choices && msg.choices[0] && msg.choices[0].message && msg.choices[0].message.content
    );
    
    if (lastCompleteMessage) {
      id = lastCompleteMessage.id || id;
      if (lastCompleteMessage.choices && 
          lastCompleteMessage.choices[0] && 
          lastCompleteMessage.choices[0].finish_reason) {
        finishReason = lastCompleteMessage.choices[0].finish_reason;
      }
      
      return {
        id,
        content: lastCompleteMessage.choices[0].message.content,
        finish_reason: finishReason,
        usage: lastCompleteMessage.usage || null
      };
    }
    
    // 如果没有找到完整消息，尝试从所有消息中提取内容
    let combinedContent = "";
    for (const msg of messages) {
      if (msg.choices && msg.choices[0] && msg.choices[0].delta && msg.choices[0].delta.content) {
        combinedContent += msg.choices[0].delta.content;
      } else if (msg.choices && msg.choices[0] && msg.choices[0].message && msg.choices[0].message.content) {
        combinedContent += msg.choices[0].message.content;
      }
    }
    
    return {
      id,
      content: combinedContent || "No content found in response",
      finish_reason: finishReason,
      usage: null
    };
    
  } catch (error) {
    console.error("Error parsing SSE response:", error);
    return {
      id,
      content: "Error parsing response: " + error.message,
      finish_reason: "error",
      usage: null
    };
  }
}

// 发送聊天请求到 freeaichatplayground
async function sendChatRequest(modelName: string, messages: any[], apiKey: string, temperature?: number, maxTokens?: number) {
  try {
    const formattedMessages = messages.map((msg, index) => ({
      id: `${Date.now() + index}`,
      role: msg.role,
      content: msg.content,
      parts: [{ type: "text", text: msg.content }],
      model: {
        id: "", // 这个ID会在下面被填充
        name: modelName,
        icon: "",
        provider: "",
        contextWindow: 63920
      }
    }));

    // 获取模型列表以找到正确的ID
    const models = await fetchModels(apiKey);
    const selectedModel = models.find((m: any) => m.name === modelName);
    
    if (!selectedModel) {
      throw new Error(`Model "${modelName}" not found`);
    }
    
    // 填充模型信息
    formattedMessages.forEach(msg => {
      if (msg.model) {
        msg.model.id = selectedModel.id;
        msg.model.icon = selectedModel.icon;
        msg.model.provider = selectedModel.provider;
      }
    });

    const requestBody = {
      model: modelName,
      messages: formattedMessages,
      config: {
        temperature: temperature !== undefined ? temperature : DEFAULT_TEMPERATURE,
        maxTokens: maxTokens !== undefined ? maxTokens : DEFAULT_MAX_TOKENS
      },
      apiKey: `ai-${apiKey}`
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

    // 处理 SSE 流式响应
    const parsedResponse = await parseSSEResponse(response);
    return parsedResponse;
  } catch (error) {
    console.error("Error in chat completion:", error);
    throw error;
  }
}

// 转换为 OpenAI 格式的聊天响应
function transformChatResponseToOpenAIFormat(response: any, modelName: string) {
  return {
    id: response.id || `chatcmpl-${Date.now()}`,
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
        finish_reason: response.finish_reason || "stop",
      },
    ],
    usage: response.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
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
  const formattedMessages = messages.map((msg, index) => ({
    id: `${Date.now() + index}`,
    role: msg.role,
    content: msg.content,
    parts: [{ type: "text", text: msg.content }],
    model: {
      id: "", // 这个ID会在下面被填充
      name: modelName,
      icon: "",
      provider: "",
      contextWindow: 63920
    }
  }));

  // 获取模型列表以找到正确的ID
  const models = await fetchModels(apiKey);
  const selectedModel = models.find((m: any) => m.name === modelName);
  
  if (!selectedModel) {
    throw new Error(`Model "${modelName}" not found`);
  }
  
  // 填充模型信息
  formattedMessages.forEach(msg => {
    if (msg.model) {
      msg.model.id = selectedModel.id;
      msg.model.icon = selectedModel.icon;
      msg.model.provider = selectedModel.provider;
    }
  });

  const requestBody = {
    model: modelName,
    messages: formattedMessages,
    config: {
      temperature: temperature !== undefined ? temperature : DEFAULT_TEMPERATURE,
      maxTokens: maxTokens !== undefined ? maxTokens : DEFAULT_MAX_TOKENS
    },
    apiKey: `ai-${apiKey}`
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
          
          // 处理缓冲区中的所有完整 SSE 消息
          const messages = buffer.split('\n\n');
          buffer = messages.pop() || ""; // 保留最后一个可能不完整的消息
          
          for (const msg of messages) {
            if (!msg.trim().startsWith('data:')) continue;
            
            try {
              const jsonStr = msg.replace('data:', '').trim();
              const data = JSON.parse(jsonStr);
              
              if (data.choices && data.choices[0]) {
                // 转换为 OpenAI 流式格式
                const openAIChunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: data.choices[0].finish_reason || null
                  }]
                };
                
                // 提取内容
                if (data.choices[0].delta && data.choices[0].delta.content) {
                  openAIChunk.choices[0].delta.content = data.choices[0].delta.content;
                } else if (data.choices[0].message && data.choices[0].message.content) {
                  openAIChunk.choices[0].delta.content = data.choices[0].message.content;
                }
                
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                
                // 如果是最后一条消息，发送 [DONE]
                if (data.choices[0].finish_reason) {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
              }
            } catch (e) {
              console.warn("Failed to parse SSE message:", msg);
              continue;
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
