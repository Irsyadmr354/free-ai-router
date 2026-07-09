/**
 * lib/tool-polyfill.js
 * Polyfills Tool Calling for providers that do not natively support the OpenAI
 * `tools` array parameter (like Cloudflare Workers AI or Cohere).
 */

export function injectToolPolyfill(params, tools) {
  const polyfillPrompt = `
You have access to the following tools. If you need to use a tool, you MUST respond EXACTLY with an XML block containing the tool call in JSON format. Do not include any other text before or after the XML block if you are calling a tool.

Available Tools:
${JSON.stringify(tools, null, 2)}

Format for calling a tool:
<tool_call>
{"name": "tool_name", "arguments": {"arg1": "value"}}
</tool_call>
`;

  return {
    ...params,
    systemPrompt: params.systemPrompt ? `${params.systemPrompt}\n\n${polyfillPrompt}` : polyfillPrompt,
    tools: undefined,
    toolChoice: undefined
  };
}

export function extractToolPolyfill(text) {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.name && parsed.arguments) {
      return {
        name: parsed.name,
        arguments: typeof parsed.arguments === "string" ? parsed.arguments : JSON.stringify(parsed.arguments)
      };
    }
  } catch (e) {
    // If JSON parsing fails, return null to treat it as a normal text response
    return null;
  }
  return null;
}
