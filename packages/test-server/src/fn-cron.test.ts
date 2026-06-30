import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextCronAfter } from "@agent-phonon/core";

/**
 * L4 cron 解析器单测（纯逻辑、确定性）。
 * 覆盖：字段解析、范围/步进、列表、dom∪dow 语义、tz wall-clock、非法输入。
 */

test("cron: parse basic fields", () => {
  const p = parseCron("0 3 * * *");
  assert.ok(p.minute.values.has(0));
  assert.equal(p.minute.values.size, 1);
  assert.ok(p.hour.values.has(3));
  assert.ok(p.dom.isWildcard);
  assert.ok(p.month.isWildcard);
  assert.ok(p.dow.isWildcard);
});

test("cron: ranges, steps, lists", () => {
  const p = parseCron("*/15 9-17 1,15 * 1-5");
  assert.deepEqual([...p.minute.values].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...p.hour.values].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...p.dom.values].sort((a, b) => a - b), [1, 15]);
  assert.deepEqual([...p.dow.values].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("cron: invalid expressions throw", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /out of range/);
  assert.throws(() => parseCron("* 24 * * *"), /out of range/);
  assert.throws(() => parseCron("*/0 * * * *"), /step/);
});

test("cron: nextCronAfter daily at 03:00 UTC", () => {
  // 2026-06-30T01:00:00Z → 下一次 03:00 应是同日 03:00Z
  const after = new Date("2026-06-30T01:00:00Z");
  const next = nextCronAfter("0 3 * * *", after, "UTC");
  assert.ok(next);
  assert.equal(next!.toISOString(), "2026-06-30T03:00:00.000Z");
});

test("cron: nextCronAfter rolls to next day when past", () => {
  const after = new Date("2026-06-30T05:00:00Z");
  const next = nextCronAfter("0 3 * * *", after, "UTC");
  assert.equal(next!.toISOString(), "2026-07-01T03:00:00.000Z");
});

test("cron: timezone wall-clock — 03:00 Asia/Shanghai is 19:00Z prev day", () => {
  // Asia/Shanghai = UTC+8（无 DST）。03:00 CST == 19:00 UTC 前一天。
  const after = new Date("2026-06-30T10:00:00Z"); // 18:00 CST
  const next = nextCronAfter("0 3 * * *", after, "Asia/Shanghai");
  assert.ok(next);
  // 下一次 03:00 CST = 2026-07-01 03:00 CST = 2026-06-30 19:00Z
  assert.equal(next!.toISOString(), "2026-06-30T19:00:00.000Z");
});

test("cron: every minute", () => {
  const after = new Date("2026-06-30T01:00:30Z");
  const next = nextCronAfter("* * * * *", after, "UTC");
  // 严格晚于 after 的下一整分钟
  assert.equal(next!.toISOString(), "2026-06-30T01:01:00.000Z");
});

test("cron: dom∪dow union semantics (both restricted = OR)", () => {
  // 「每月 1 号 或 每周一」 00:00
  const expr = "0 0 1 * 1";
  // 2026-06-30 是周二；7-01 是周三(1号命中 dom)；下一次应是 7-01 00:00
  const after = new Date("2026-06-30T12:00:00Z");
  const next = nextCronAfter(expr, after, "UTC");
  assert.equal(next!.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("cron: weekday-only matches correct day", () => {
  // 每周一 09:00 UTC。2026-06-30 周二 → 下一个周一是 2026-07-06
  const after = new Date("2026-06-30T12:00:00Z");
  const next = nextCronAfter("0 9 * * 1", after, "UTC");
  assert.equal(next!.toISOString(), "2026-07-06T09:00:00.000Z");
});
