import fs from "node:fs";
import path from "node:path";

export class JsonlTelemetryStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  append(event) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
      router_version: event.router_version ?? "0.1.0",
    };
    if (!normalized.event_type) throw new Error("telemetry event_type is required");
    if (!normalized.task_id) throw new Error("telemetry task_id is required");
    fs.appendFileSync(this.filePath, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8")
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  byTask(taskId) { return this.readAll().filter((x) => x.task_id === taskId); }
}
