/**
 * 极简 cron 解析器（零依赖，配合 L4 SchedulerEngine）。
 *
 * 支持标准 5 段：分 时 日 月 周
 *   minute   0-59
 *   hour     0-23
 *   day      1-31
 *   month    1-12
 *   weekday  0-6  (0=Sunday)
 *
 * 每段支持：`*`、`a`、`a-b`、`a-b/c`、`* / c`、逗号列表 `a,b,c`。
 * 不支持 @yearly 等别名、L/W/# 等扩展（按 design：通用底层最小实现，够用即可）。
 *
 * 时区：可选 IANA tz。计算「下一次触发」时按该 tz 的 wall-clock 匹配字段，
 * 再转回绝对 UTC Date。tz 缺省用宿主机本地时区。
 *
 * day-of-month 与 day-of-week 的经典 cron 语义：
 *   两者都非 `*` 时取**并集**（满足任一即触发）；否则取交集（都要满足）。
 */

interface CronField {
  values: Set<number>;
  isWildcard: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField; // day of month
  month: CronField;
  dow: CronField; // day of week
}

function parseField(spec: string, min: number, max: number): CronField {
  const values = new Set<number>();
  let isWildcard = false;
  for (const part of spec.split(",")) {
    const slash = part.split("/");
    const range = slash[0]!;
    const step = slash[1] ? parseInt(slash[1], 10) : 1;
    if (!Number.isFinite(step) || step <= 0) throw new Error(`invalid cron step in "${spec}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min; hi = max;
      if (part === "*") isWildcard = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a!, 10);
      hi = parseInt(b!, 10);
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`invalid cron field "${spec}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field "${spec}" out of range [${min},${max}]`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`empty cron field "${spec}"`);
  return { values, isWildcard };
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expr must have 5 fields, got ${parts.length}: "${expr}"`);
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6),
  };
}

/**
 * 取某绝对时刻在指定 tz 下的 wall-clock 分解（year/month/day/hour/minute/weekday）。
 * 用 Intl.DateTimeFormat 做 tz 转换，避免引第三方时区库。
 */
function partsInTz(date: Date, tz?: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(map.hour!, 10);
  if (hour === 24) hour = 0; // some environments emit 24 for midnight
  return {
    year: parseInt(map.year!, 10),
    month: parseInt(map.month!, 10),
    day: parseInt(map.day!, 10),
    hour,
    minute: parseInt(map.minute!, 10),
    weekday: weekdayMap[map.weekday!] ?? 0,
  };
}

/**
 * 计算严格晚于 `after` 的下一次 cron 触发（按 tz wall-clock 匹配）。
 *
 * 安全修复 B3：原实现逐分钟扫描最多 366 天（527040 次 Intl 调用），
 * 给一个永不匹配的合法表达式（如 `0 0 30 2 *` = 2月30日）会同步阻塞 ~24s（DoS）。
 * 且 366 天上限会误杀 `0 0 29 2 *`（Feb 29，每 4 年一次）这类合法表达式。
 *
 * 新实现：**按天跳过**不匹配的日期（每个非匹配日仅 1 次 Intl 调用，直接跳到该 tz 日的次日 00:00），
 * 仅在日期匹配的当天才逐分钟扫。水平线设 1500 天（~4.1 年，覆盖闰年 Feb 29 周期），
 * 扫满仍无匹配（真不可能日期）→ 返回 undefined。最坏情况 Intl 调用 ~3000 次（毫秒级）。
 */
export function nextCronAfter(expr: string, after: Date, tz?: string): Date | undefined {
  const parsed = parseCron(expr);
  // 从下一整分钟开始（秒/毫秒清零并 +1 分钟）
  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  let cursor = new Date(start.getTime() + 60_000);
  const maxDays = 1500; // ~4.1 年，覆盖闰年 Feb 29；不可能日期扫满即返回 undefined
  let dayChecks = 0;
  // 绝对安全阀：即便逻辑异常也不会无界循环
  const hardIterCap = maxDays * 1440 + 10_000;
  let iters = 0;
  while (dayChecks < maxDays && iters < hardIterCap) {
    iters++;
    const p = partsInTz(cursor, tz);
    if (!dateMatches(parsed, p)) {
      // 当前 tz 日期不匹配 → 整天都不会匹配，一跳到该 tz 日的次日 00:00
      const minsToMidnight = 24 * 60 - (p.hour * 60 + p.minute);
      cursor = new Date(cursor.getTime() + Math.max(1, minsToMidnight) * 60_000);
      dayChecks++;
      continue;
    }
    if (timeMatches(parsed, p)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return undefined;
}

/** 日期字段是否匹配（month + dom∪dow），不看时分。 */
function dateMatches(parsed: ParsedCron, p: { month: number; day: number; weekday: number }): boolean {
  if (!parsed.month.values.has(p.month)) return false;
  const domWild = parsed.dom.isWildcard;
  const dowWild = parsed.dow.isWildcard;
  const domOk = parsed.dom.values.has(p.day);
  const dowOk = parsed.dow.values.has(p.weekday);
  if (domWild && dowWild) return true;
  if (!domWild && !dowWild) return domOk || dowOk;
  if (!domWild) return domOk;
  return dowOk;
}

/** 时分字段是否匹配。 */
function timeMatches(parsed: ParsedCron, p: { hour: number; minute: number }): boolean {
  return parsed.hour.values.has(p.hour) && parsed.minute.values.has(p.minute);
}
