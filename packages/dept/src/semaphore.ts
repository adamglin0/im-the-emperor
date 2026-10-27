// 部门内 LLM 并发信号量：只包单次 LLM 调用（不包整轮），避免一人等回信时占住名额。
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) this.active++;
    // 名额由释放者直接移交给排队者（active 不变），避免释放与唤醒之间被新来者插队而超额
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}
