export class Watcher {
  constructor(hub, account) {
    this.hub = hub;
    this.account = account;
    this.stopped = false;
    this.wakers = new Set();
    this.timers = new Set();
  }
  log(level, msg) { this.hub.log(level, this.platform, msg); }
  update(patch) { this.hub.update(this.platform, patch); }
  /** Sleep that resolves early when the watcher is stopped. */
  wait(ms) {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const t = setTimeout(done, ms);
      const self = this;
      function done() { clearTimeout(t); self.wakers.delete(done); resolve(); }
      this.wakers.add(done);
    });
  }
  every(ms, fn) {
    const t = setInterval(() => !this.stopped && fn(), ms);
    this.timers.add(t);
  }
  stop() {
    this.stopped = true;
    for (const w of [...this.wakers]) w();
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.onStop?.();
  }
}
