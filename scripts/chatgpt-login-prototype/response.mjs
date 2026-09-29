import { apiError } from "./core.mjs";

function safeTag(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/+-]{1,100}$/.test(value)
    ? value
    : "unknown";
}

export async function consumeResponseStream(response, options = {}) {
  const maxTextBytes = options.maxTextBytes ?? 32 * 1024;
  if (
    !Number.isInteger(maxTextBytes) ||
    maxTextBytes < 1 ||
    maxTextBytes > 2 * 1024 * 1024
  )
    throw new Error("Invalid response output limit.");
  const diagnostic = {
    httpStatus: response.status,
    contentType: safeTag(
      (response.headers.get("content-type") ?? "missing")
        .split(";")[0]
        .trim()
        .toLowerCase(),
    ),
    format: "unknown",
    eventCount: 0,
    lastEvent: "none",
    textDeltaCount: 0,
    textDeltaCharacters: 0,
    outputItems: [],
    completedOutput: [],
    requestId:
      response.headers
        .get("x-request-id")
        ?.match(/^[a-zA-Z0-9_-]{1,120}$/)?.[0] ?? null,
  };
  let reader;
  try {
    if (!response.body)
      throw new Error("OpenAI returned an empty response body.");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "",
      bytes = 0,
      text = "",
      completed = false,
      usage;
    const finishedItems = new Map();
    const finish = (data) => {
      if (data?.error)
        throw apiError(
          response.status,
          { error: data.error },
          diagnostic.requestId,
        );
      if (data?.status !== "completed")
        throw new Error(
          "OpenAI did not return a completed response. Partial output was discarded.",
        );
      let output = data.output;
      diagnostic.completedOutput = Array.isArray(output)
        ? output.slice(0, 20).map((item) => ({
            type: safeTag(item?.type),
            role: safeTag(item?.role),
            status: safeTag(item?.status),
            content: Array.isArray(item?.content)
              ? item.content.slice(0, 20).map((part) => ({
                  type: safeTag(part?.type),
                  characters:
                    typeof part?.text === "string" ? part.text.length : null,
                }))
              : null,
          }))
        : null;
      if (!Array.isArray(output))
        throw new Error(
          "OpenAI's completed response contains no valid output array.",
        );
      // This ChatGPT route can omit items from the terminal response. Completed
      // item events carry the authoritative output; deltas alone never suffice.
      if (!output.length && diagnostic.format === "sse") {
        output = [...finishedItems.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item);
        diagnostic.outputSource = "completed-item-events";
      } else diagnostic.outputSource = "completed-response";
      const messages = output.filter(
        (item) => item.type === "message" && item.role === "assistant",
      );
      if (messages.some((item) => item.status && item.status !== "completed"))
        throw new Error("The assistant message did not complete.");
      const content = messages.flatMap((item) =>
        Array.isArray(item.content) ? item.content : [],
      );
      if (content.some((item) => item.type === "refusal"))
        throw new Error("The model declined to produce a translation.");
      const pieces = content.filter((item) => item.type === "output_text");
      if (
        !pieces.length ||
        pieces.some((item) => typeof item.text !== "string")
      )
        throw new Error(
          "OpenAI's completed response contains no translation text.",
        );
      // Accept only complete output items after the response completes.
      text = pieces.map((item) => item.text).join("");
      if (Buffer.byteLength(text) > maxTextBytes)
        throw new Error("The translation exceeded the output limit.");
      if (!text.trim())
        throw new Error(
          "The completed response contains empty translation text.",
        );
      completed = true;
      if (data.usage)
        usage = {
          inputTokens: Number.isFinite(data.usage.input_tokens)
            ? data.usage.input_tokens
            : null,
          outputTokens: Number.isFinite(data.usage.output_tokens)
            ? data.usage.output_tokens
            : null,
          cachedInputTokens: Number.isFinite(
            data.usage.input_tokens_details?.cached_tokens,
          )
            ? data.usage.input_tokens_details.cached_tokens
            : null,
          reasoningOutputTokens: Number.isFinite(
            data.usage.output_tokens_details?.reasoning_tokens,
          )
            ? data.usage.output_tokens_details.reasoning_tokens
            : null,
        };
    };
    const parseEvent = (block) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      diagnostic.eventCount++;
      diagnostic.lastEvent = safeTag(event.type);
      options.onEvent?.(diagnostic.lastEvent);
      if (event.type === "response.output_item.done") {
        if (
          !Number.isInteger(event.output_index) ||
          event.output_index < 0 ||
          event.output_index > 100 ||
          !event.item ||
          typeof event.item !== "object"
        )
          throw new Error("OpenAI returned a malformed completed output item.");
        if (finishedItems.has(event.output_index))
          throw new Error("OpenAI returned a duplicate completed output item.");
        finishedItems.set(event.output_index, event.item);
        if (diagnostic.outputItems.length < 20)
          diagnostic.outputItems.push({
            type: safeTag(event.item?.type),
            role: safeTag(event.item?.role),
            status: safeTag(event.item?.status),
            content: Array.isArray(event.item?.content)
              ? event.item.content.slice(0, 20).map((part) => ({
                  type: safeTag(part?.type),
                  characters:
                    typeof part?.text === "string" ? part.text.length : null,
                }))
              : null,
          });
      }
      if (event.type === "response.output_text.delta") {
        if (typeof event.delta !== "string")
          throw new Error("OpenAI returned malformed output text.");
        text += event.delta;
        diagnostic.textDeltaCount++;
        diagnostic.textDeltaCharacters += event.delta.length;
        if (Buffer.byteLength(text) > maxTextBytes)
          throw new Error("The translation exceeded the output limit.");
      }
      if (
        [
          "response.failed",
          "response.incomplete",
          "error",
          "response.refusal.delta",
        ].includes(event.type)
      )
        throw apiError(
          400,
          { error: event.response?.error ?? event.error },
          diagnostic.requestId,
        );
      if (event.type === "response.completed") finish(event.response);
    };
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (cause.name === "AbortError" || cause.name === "TimeoutError")
          throw cause;
        const error = new Error(
          "The OpenAI response stream was interrupted. Try again.",
        );
        error.failureCategory = "transient";
        throw error;
      }
      const { value, done } = chunk;
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024)
        throw new Error("The service response exceeded the size limit.");
      buffer += decoder.decode(value, { stream: true });
      if (diagnostic.format === "unknown" && buffer.trim()) {
        if (buffer.trimStart().startsWith("{")) diagnostic.format = "json";
        else if (/^(data:|event:|:)/.test(buffer.trimStart()))
          diagnostic.format = "sse";
        else if (buffer.length > 128)
          throw new Error("OpenAI returned an unsupported response format.");
      }
      if (diagnostic.format !== "sse") continue;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        parseEvent(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (completed) break;
      }
      if (completed) break;
    }
    if (!completed) {
      buffer += decoder.decode();
      if (diagnostic.format === "json") {
        const data = JSON.parse(buffer);
        if (data.error)
          throw apiError(response.status, data, diagnostic.requestId);
        // Also accept a terminal event transported as one JSON object.
        if (data.type === "response.completed") {
          diagnostic.lastEvent = "response.completed";
          finish(data.response);
        } else {
          diagnostic.lastEvent = safeTag(data.object);
          if (data.object !== "response")
            throw new Error(
              "OpenAI returned JSON without a completed Responses API result.",
            );
          finish(data);
        }
      } else if (diagnostic.format === "sse" && buffer.trim())
        parseEvent(buffer);
    }
    if (!completed)
      throw new Error(
        "The stream ended without a completed translation. Partial output was discarded.",
      );
    return { text, usage, requestId: diagnostic.requestId, diagnostic };
  } catch (error) {
    const failure =
      error instanceof SyntaxError
        ? new Error("OpenAI returned malformed response data.")
        : error;
    failure.diagnostic = diagnostic;
    throw failure;
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
