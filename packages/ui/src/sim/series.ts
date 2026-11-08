/** Fixed-capacity time series buffered by the UI per tick (chart data; never part of sim state). */
export interface SeriesPoint {
  readonly tick: number;
  readonly value: number;
}

export class SeriesBuffer {
  private points: SeriesPoint[] = [];
  constructor(private readonly capacity: number) {}

  push(tick: number, value: number): void {
    this.points.push({ tick, value });
    // Trim in chunks so the cost is amortised O(1).
    if (this.points.length > this.capacity * 1.25) {
      this.points = this.points.slice(this.points.length - this.capacity);
    }
  }

  /** Immutable view of the newest `capacity` points. */
  snapshot(): readonly SeriesPoint[] {
    return this.points.length > this.capacity
      ? this.points.slice(this.points.length - this.capacity)
      : this.points.slice();
  }

  clear(): void {
    this.points = [];
  }
}
