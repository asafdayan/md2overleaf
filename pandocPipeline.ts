import fs from "fs-extra";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const HEADING_REGEX = /^\s*#{1,6}\s+\S/;
const ALIGN_ENV_REGEX = /\$\$\s*\\begin\{(align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}\s*\$\$/g;

export interface PandocPipelineOptions {
  vaultPath: string;
  sourcePath: string;
  texPath: string;
  env: NodeJS.ProcessEnv;
  filterPath: string;
}

export function sanitizeMarkdown(input: string): string {
  const lines = input.split(/\r?\n/);
  const output: string[] = [];
  let previousBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING_REGEX.test(line)) {
      if (!previousBlank) {
        output.push("");
      }
      output.push(line);
      const nextLine = lines[i + 1];
      if (nextLine !== undefined && nextLine.trim() !== "") {
        output.push("");
      }
      previousBlank = false;
    } else {
      output.push(line);
      previousBlank = line.trim() === "";
    }
  }

  let result = output.join("\n");
  result = result.replace(ALIGN_ENV_REGEX, (_match, env, body) => {
    return `\\begin{${env}}${body}\\end{${env}}`;
  });
  return result;
}

export async function runPandocPipeline(options: PandocPipelineOptions): Promise<void> {
  const { vaultPath, sourcePath, texPath, env, filterPath } = options;
  const noteDir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath) || ".md");
  const tempSanitized = path.join(noteDir, `.${base}.md2overleaf.sanitized.md`);

  const original = await fs.readFile(sourcePath, "utf8");
  const sanitized = sanitizeMarkdown(original);
  await fs.writeFile(tempSanitized, sanitized, "utf8");

  try {
    const args = [
      tempSanitized,
      `--lua-filter=${filterPath}`,
      "--from=markdown+lists_without_preceding_blankline",
      "--metadata=lang:he",
      "--metadata=dir:rtl",
      "-o",
      texPath,
    ];

    console.log("[md2overleaf] running pandoc", args.join(" "));
    await execFileAsync("pandoc", args, {
      cwd: vaultPath,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    await fs.remove(tempSanitized);
  }
}
