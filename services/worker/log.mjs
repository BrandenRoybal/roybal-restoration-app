/* One JSON line per event, to stdout (Fly collects it). Never a message body,
   never a token: callers pass ids, counts and error text only. */
export function makeLog(stream = process.stdout, clock = () => new Date()) {
  return function log(event, fields = {}) {
    const line = { t: clock().toISOString(), event, ...fields };
    stream.write(JSON.stringify(line) + "\n");
  };
}

/** Error → a short string for a log line or an outbox error column. */
export function errText(e, max = 500) {
  const m = e && typeof e === "object" && "message" in e ? e.message : e;
  return String(m ?? "error").slice(0, max);
}
