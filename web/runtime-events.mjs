export const RUNTIME_EVENT_CONTRACT_VERSION = 1;

export class RuntimeEventStream {
  constructor({ streamId, maxEvents = 2000, now = () => new Date() } = {}) {
    if (typeof streamId !== "string" || !streamId) throw new TypeError("streamId is required");
    this.streamId = streamId;
    this.maxEvents = Math.max(10, Math.min(10_000, Number(maxEvents) || 2000));
    this.now = now;
    this.sequence = 0;
    this.baseSequence = 0;
    this.snapshotRevision = 0;
    this.events = [];
  }

  revise() {
    this.snapshotRevision++;
    return this.snapshotRevision;
  }

  append(type, payload = {}, fields = {}) {
    const sequence = ++this.sequence;
    const event = {
      contractVersion: RUNTIME_EVENT_CONTRACT_VERSION,
      eventId: `${this.streamId}:${sequence}`,
      streamId: this.streamId,
      sequence,
      snapshotRevision: this.snapshotRevision,
      type,
      occurredAt: this.now().toISOString(),
      sessionId: fields.sessionId || this.streamId,
      ...(fields.commandId ? { commandId: fields.commandId } : {}),
      ...(fields.runId ? { runId: fields.runId } : {}),
      ...(fields.causationId ? { causationId: fields.causationId } : {}),
      payload,
      raw: fields.raw || null,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      const removed = this.events.splice(0, this.events.length - this.maxEvents);
      this.baseSequence = removed.at(-1)?.sequence || this.baseSequence;
    }
    return event;
  }

  poll(since = 0) {
    const cursor = Number.isSafeInteger(Number(since)) && Number(since) >= 0 ? Number(since) : 0;
    return {
      contractVersion: RUNTIME_EVENT_CONTRACT_VERSION,
      streamId: this.streamId,
      baseSequence: this.baseSequence,
      nextSequence: this.sequence,
      snapshotRevision: this.snapshotRevision,
      resetRequired: cursor < this.baseSequence,
      events: this.events.filter((event) => event.sequence > Math.max(cursor, this.baseSequence)),
    };
  }
}
