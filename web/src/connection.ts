/** EventSource retries silently for a grace period; loading is not an outage. */
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "interrupted";
export class ConnectionMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interrupted = false;
  private disposed = false;
  constructor(private publish: (state: ConnectionState) => void) {
    this.publish("connecting");
    this.wait(8000);
  }
  private wait(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) { this.interrupted = true; this.publish("interrupted"); }
    }, delay);
  }
  open() {
    if (this.disposed) return;
    this.interrupted = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.publish("connected");
  }
  error() {
    if (this.disposed) return;
    // The initial deadline already exists. Repeated retry errors must neither
    // postpone it nor replace an interruption with a reassuring loading state.
    if (this.timer === undefined && !this.interrupted) {
      this.publish("reconnecting");
      this.wait(4000);
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
