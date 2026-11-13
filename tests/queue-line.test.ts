import { expect, test } from "bun:test";
import { queueLine } from "../world/queue-line";

test("the queue says 1 line, then 2 lines", () => {
  expect(queueLine(1, false)).toBe("1 line");
  expect(queueLine(2, false)).toBe("2 lines");
});

test("a rush shipment keeps its rush label", () => {
  expect(queueLine(1, true)).toBe("1 line  rush");
  expect(queueLine(3, true)).toBe("3 lines  rush");
});
