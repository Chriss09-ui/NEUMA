/** A scope only releases resources it owns. Shared services remain with their owner. */
export class ExecutionLifecycle {
  private resources: { name: string; release(): unknown | Promise<unknown> }[] = [];
  private closing: Promise<void> | undefined;
  own(name: string, release: () => unknown | Promise<unknown>): void {
    if (this.closing) throw new Error("执行资源已开始关闭");
    this.resources.push({ name, release });
  }
  close(primaryFailure?: unknown): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      const failures: Error[] = [];
      for (const resource of this.resources.splice(0).reverse()) {
        try { await resource.release(); }
        catch (cause) { failures.push(new Error(`执行资源清理失败：${resource.name}`, { cause })); }
      }
      if (failures.length) throw new AggregateError(primaryFailure === undefined ? failures : [primaryFailure, ...failures], "执行资源未完全释放");
    });
    return this.closing;
  }
}
