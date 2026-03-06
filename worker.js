export default {
  async fetch(request, env) {
    const MY_API_KEY = "自定义API";
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${MY_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    try {
      const body = await request.json();
      const model = "@cf/meta/llama-3.1-8b-instruct-fast";
      const isStream = body.stream === true;

      const aiResponse = await env.AI.run(model, {
        messages: body.messages,
        stream: isStream,
      });

      if (isStream) {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let buffer = "";

        const stream = new ReadableStream({
          async start(controller) {
            try {
              const reader = aiResponse.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  break;
                }
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (const line of lines) {
                  if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                      const cfData = JSON.parse(line.slice(6));
                      
                      // 若原生已是标准 OpenAI 格式，直接透传给 Cherry Studio
                      if (cfData.choices && Array.isArray(cfData.choices)) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(cfData)}\n\n`));
                      } 
                      // 若是 Cloudflare 旧版独有格式，拦截并转换为 OpenAI 格式
                      else if (cfData.response !== undefined) {
                        const openAiChunk = {
                          id: `chatcmpl-${Date.now()}`,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: model,
                          choices: [{
                            index: 0,
                            delta: { content: cfData.response },
                            finish_reason: cfData.response === "" ? "stop" : null
                          }]
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
                      }
                    } catch (e) {
                      // 忽略格式损坏的单行数据
                    }
                  }
                }
              }
            } catch (streamErr) {
              controller.enqueue(encoder.encode(`data: {"error": "Stream interrupted"}\n\n`));
            } finally {
              controller.close();
            }
          }
        });

        return new Response(stream, {
          headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
        });
      }

      // 非流式兼容逻辑（同时支持 CF 格式与原生标准格式提取）
      const content = aiResponse.response || (aiResponse.choices && aiResponse.choices[0]?.message?.content) || "";
      return new Response(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: content },
          finish_reason: "stop",
        }]
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (e) {
      return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: corsHeaders });
    }
  },
};
