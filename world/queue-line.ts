// The text shown after a shipment in the open queue: its line count, and "rush" if flagged.
export function queueLine(lineCount: number, rush: boolean): string {
  const lines = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
  return rush ? `${lines}  rush` : lines;
}
