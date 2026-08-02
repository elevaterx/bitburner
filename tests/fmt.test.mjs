import test from "node:test";
import assert from "node:assert/strict";
import { num, money, ram, pct, time } from "../lib/fmt.js";

test("num: suffixes and sign", () => {
  assert.equal(num(999), "999");
  assert.equal(num(1234), "1.23k");
  assert.equal(num(1_500_000), "1.5m");
  assert.equal(num(-2_000_000_000), "-2b");
  assert.equal(num(2), "2");
});

test("money: leading $ and sign outside", () => {
  assert.equal(money(1_500_000), "$1.5m");
  assert.equal(money(-1_500_000), "-$1.5m");
  assert.equal(money(0), "$0");
});

test("ram: GB -> TB/PB", () => {
  assert.equal(ram(512), "512GB");
  assert.equal(ram(2048), "2TB");
  assert.equal(ram(1024 * 1024), "1PB");
});

test("pct: fraction to percent", () => {
  assert.equal(pct(0.0731), "7.3%");
  assert.equal(pct(1), "100%");
});

test("time: compact durations", () => {
  assert.equal(time(3400), "3.4s");
  assert.equal(time(3661000), "1h 01m");
  assert.equal(time(90000), "1m 30s");
});
