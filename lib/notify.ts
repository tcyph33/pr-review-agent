import { execSync } from "child_process";
import os from "os";

function send(title: string, message: string): void {
  if (os.platform() !== "darwin") return;
  try {
    const escaped      = message.replace(/'/g, "\\'");
    const escapedTitle = title.replace(/'/g, "\\'");
    execSync(`osascript -e 'display notification "${escaped}" with title "${escapedTitle}"'`);
  } catch {
    // notifications are best-effort — never crash the script over them
  }
}

export function notify(title: string, message: string): void {
  send(title, message);
}

export function notifyFailure(failedCount: number, orchLogPath: string): void {
  const logName = orchLogPath.split("/").pop() ?? "log";
  send(
    "PR Review Agent — Failures",
    `${failedCount} review${failedCount !== 1 ? "s" : ""} failed. Check ${logName} for details.`
  );
}

export function buildNotificationSummary(newCount: number, updatedCount: number): string | null {
  const parts: string[] = [];
  if (newCount > 0)     parts.push(`${newCount} new`);
  if (updatedCount > 0) parts.push(`${updatedCount} updated`);
  if (parts.length === 0) return null;
  return parts.join(", ");
}
