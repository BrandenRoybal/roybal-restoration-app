/* ============================================================
   Roybal phone agent — the brain (streaming Claude tool loop)
   ------------------------------------------------------------
   Same one-brain registry as the in-app assistant (personas.ts:
   PERSONAS.phone + PHONE_TOOLS), different mouth: tokens stream
   straight to Twilio's TTS as they arrive, so the caller hears
   the answer start in well under a second. Tool rounds happen
   mid-stream — any preamble the model spoke ("let me check the
   schedule") plays while the tool runs, then the next round
   streams the answer. Bounded at 3 rounds, then it must answer.
   ============================================================ */
import { LLM_API_KEY, PHONE_MODEL } from "./config.mjs";
import { runPhoneTool } from "./tools.mjs";

/* One streamed Anthropic call. onToken fires per text_delta. Returns the
   assembled content blocks (for the history), tool uses, and usage. */
export async function streamOnce({ system, messages, tools, onToken, signal }) {
  if (!LLM_API_KEY) throw new Error("LLM_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal,
    headers: { "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: PHONE_MODEL, max_tokens: 400, stream: true, system, messages, ...(tools?.length ? { tools } : {}) }),
  });
  if (!res.ok) throw new Error(`llm_failed (${res.status}): ${(await res.text()).slice(0, 300)}`);

  const usage = { inTok: 0, outTok: 0 };
  const blocks = [];       // rebuilt content blocks, in order
  let stopReason = "";
  let buf = "";
  const reader = res.body.getReader();
  const td = new TextDecoder();
  const handle = (ev) => {
    switch (ev.type) {
      case "message_start":
        usage.inTok += Number(ev.message?.usage?.input_tokens) || 0;
        break;
      case "content_block_start":
        blocks[ev.index] = ev.content_block.type === "tool_use"
          ? { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, _json: "" }
          : { type: "text", text: "" };
        break;
      case "content_block_delta":
        if (ev.delta.type === "text_delta") {
          blocks[ev.index].text += ev.delta.text;
          onToken && onToken(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta") {
          blocks[ev.index]._json += ev.delta.partial_json;
        }
        break;
      case "message_delta":
        stopReason = ev.delta?.stop_reason || stopReason;
        usage.outTok = Number(ev.usage?.output_tokens) || usage.outTok;
        break;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += td.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try { handle(JSON.parse(line.slice(5).trim())); } catch { /* keep-alives / partial noise */ }
      }
    }
  }
  const content = blocks.filter(Boolean).map((b) =>
    b.type === "tool_use"
      ? { type: "tool_use", id: b.id, name: b.name, input: (() => { try { return JSON.parse(b._json || "{}"); } catch { return {}; } })() }
      : { type: "text", text: b.text });
  return { content, stopReason, usage };
}

/** One caller turn: stream rounds until the model answers without tools
    (≤3 rounds). Mutates session.messages; totals ride session.usage. */
export async function runTurn(session, userText, { system, tools, onToken }) {
  session.messages.push({ role: "user", content: userText });
  for (let round = 0; round < 3; round++) {
    const useTools = round < 2 ? tools : [];    // final round must answer
    const { content, stopReason, usage } = await streamOnce({
      system, messages: session.messages, tools: useTools, onToken, signal: session.abort?.signal,
    });
    session.usage.inTok += usage.inTok;
    session.usage.outTok += usage.outTok;
    session.messages.push({ role: "assistant", content });
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (stopReason !== "tool_use" || !toolUses.length) return;
    const results = [];
    for (const tu of toolUses) {
      session.toolCalls++;
      const out = await runPhoneTool(tu.name, tu.input, session);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 4000) });
    }
    session.messages.push({ role: "user", content: results });
  }
}
