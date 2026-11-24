import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Anonymized Markdown destinations from the 088c313 report and follow-up reply:
// [a.md](C:\Users\xxx\Desktop\a.md) and [`linkFileRef`](file:///Users/.../fileRef.ts#L80-L97).
// Substitute the runner's actual temp root, not a recorded HTTP response.
export function seedFileLinks(root: string) {
  // Exercise CommonMark punctuation after a Windows directory separator, too.
  root = path.join(root, "_reports");
  fs.mkdirSync(root);
  const links = [
    { label: "Parser trace", file: path.join(root, "解析 trace.txt"), line: 42, end: 42 },
    { label: "Resolver report", file: path.join(root, "解析 report.txt"), line: 12, end: 20 },
  ];
  for (const { file, line } of links) {
    const lines = Array.from({ length: 90 }, (_, i) => `frame ${i + 1}`);
    lines[line - 1] = randomUUID();
    fs.writeFileSync(file, lines.join("\n"));
  }
  const drivePath = links[0].file.replaceAll("\\", "\\\\");
  const markdown = `[${links[0].label}](<${drivePath}:42>) · [${links[1].label}](${pathToFileURL(links[1].file).href}#L12-L20)`;
  return { markdown, links };
}
