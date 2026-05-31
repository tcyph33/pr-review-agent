import Anthropic from "@anthropic-ai/sdk";
import type { PRDetails, PRFile } from "./github.js";

export function createAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export async function fetchReviewSkill(
  skillUrl: string,
  githubToken: string
): Promise<string> {
  console.log(`📥  Fetching review skill from ${skillUrl} ...`);
  const res = await fetch(skillUrl, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github.raw",
    },
  });
  if (!res.ok) {
    console.error(`❌  Failed to fetch review skill: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  console.log(`    Loaded ${text.length} characters.`);
  return text;
}

export async function reviewPRWithClaude(
  anthropic: Anthropic,
  reviewSkill: string,
  pr: { title: string | null },
  owner: string,
  repo: string,
  pull_number: number,
  details: PRDetails,
  files: PRFile[],
  diff: string
): Promise<string> {
  const fileList = files
    .map((f) => `- ${f.filename} (+${f.additions} -${f.deletions})`)
    .join("\n");

  const userMessage = `
## Pull Request: ${pr.title}
**Repo:** ${owner}/${repo}
**PR #${pull_number}**
**Author:** ${details.user?.login ?? "unknown"}
**Branch:** \`${details.head.ref}\` → \`${details.base.ref}\`
**Description:**
${details.body ?? "_No description provided._"}

## Files Changed
${fileList}

## Diff
\`\`\`diff
${diff.slice(0, 20000)}
\`\`\`
`.trim();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: reviewSkill,
    messages: [{ role: "user", content: userMessage }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}
