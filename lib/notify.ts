import { execSync } from "child_process";
import os from "os";

export function notify(title: string, message: string): void {
  if (os.platform() !== "darwin") return; // notifications only supported on macOS
  try {
    const escaped      = message.replace(/'/g, "\\'");
    const escapedTitle = title.replace(/'/g, "\\'");
    execSync(`osascript -e 'display notification "${escaped}" with title "${escapedTitle}"'`);
  } catch {
    // notifications are best-effort — never crash the script over them
  }
}

export function buildNotificationSummary(newCount: number, updatedCount: number): string | null {
  const parts: string[] = [];
  if (newCount > 0)     parts.push(`${newCount} new`);
  if (updatedCount > 0) parts.push(`${updatedCount} updated`);
  if (parts.length === 0) return null;
  return parts.join(", ");
}
