export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function roundInt(value: number): number {
  return Math.round(value);
}

export function approxEqual(a: number, b: number, epsilon = 0.01): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** 最大余数法分配整数，保证合计严格等于 total。 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);
  const weightSum = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (weightSum <= 0) {
    const base = Math.floor(total / weights.length);
    const result = weights.map(() => base);
    for (let i = 0; i < total - base * weights.length; i++) result[i] = (result[i] ?? 0) + 1;
    return result;
  }
  const exact = weights.map((value) => (Math.max(0, value) / weightSum) * total);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = total - floors.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const result = [...floors];
  for (let i = 0; i < order.length && remaining > 0; i++) {
    const entry = order[i];
    if (!entry) continue;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remaining--;
  }
  return result;
}

export function formatDate(year: number, month: number): string {
  return `${year} 年 ${String(month).padStart(2, '0')} 月`;
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return formatNumber(value);
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}
