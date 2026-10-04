const responseId = "resp-m11";

export function buildSyntheticResponsesEvents() {
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "msg-m11", content: [{ type: "output_text", text: "M11 synthetic response." }] } },
    { type: "response.completed", response: { id: responseId } },
  ];
}

export function encodeSyntheticResponsesSse(events = buildSyntheticResponsesEvents()) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function inspectSyntheticResponsesSse(body) {
  if (typeof body !== "string" || !body.endsWith("\n\n")) return { status: "PROTOCOL_FAILURE", completed: false };
  const frames = body.slice(0, -2).split("\n\n");
  let created = false, completed = false, outputItems = 0;
  for (const frame of frames) {
    const lines = frame.split("\n");
    if (lines.length !== 2 || !lines[0].startsWith("event: ") || !lines[1].startsWith("data: ")) return { status: "PROTOCOL_FAILURE", completed: false };
    const eventName = lines[0].slice(7), data = lines[1].slice(6);
    let event; try { event = JSON.parse(data); } catch { return { status: "PROTOCOL_FAILURE", completed: false }; }
    if (event?.type !== eventName || completed) return { status: "PROTOCOL_FAILURE", completed: false };
    if (eventName === "response.created") {
      if (created || typeof event.response?.id !== "string") return { status: "PROTOCOL_FAILURE", completed: false };
      created = true;
    } else if (eventName === "response.output_item.done") {
      if (event.item?.type !== "message" || event.item?.role !== "assistant" || !Array.isArray(event.item?.content)) return { status: "PROTOCOL_FAILURE", completed: false };
      outputItems += 1;
    } else if (eventName === "response.completed") {
      if (typeof event.response?.id !== "string") return { status: "PROTOCOL_FAILURE", completed: false };
      completed = true;
    } else if (eventName === "response.failed") return { status: "FAILED", completed: false };
    else if (eventName === "response.incomplete") return { status: "INCOMPLETE", completed: false };
  }
  return completed ? { status: "COMPLETED", completed: true, created, outputItems } : { status: "MISSING_COMPLETED", completed: false };
}
