import { Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import { execFile } from "child_process";
import fs from "fs-extra";
import path from "path";
import AdmZip from "adm-zip";
import { open } from "openurl";
import { promisify } from "util";
import os from "os";
import { randomUUID } from "crypto";
import { clipboard } from "electron";
import { runPandocPipeline } from "./pandocPipeline";

const execFileAsync = promisify(execFile);

interface Md2OverleafSettings {
  uploadHost: string;
  autoOpen: boolean;
}

const DEFAULT_SETTINGS: Md2OverleafSettings = {
  uploadHost: "https://x0.at",
  autoOpen: true,
};

export default class Md2OverleafPlugin extends Plugin {
  settings: Md2OverleafSettings;
  private resolvedPluginDir: string | null = null;

  async onload() {
    await this.loadSettings();
    this.addCommand({
      id: "export-to-overleaf",
      name: "Export to Overleaf",
      callback: () => this.exportToOverleaf(),
    });
    this.addCommand({
      id: "copy-overleaf-tex",
      name: "Copy Overleaf TeX to clipboard",
      callback: () => this.copyTexToClipboard(),
    });
    this.addSettingTab(new Md2OverleafSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async exportToOverleaf() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note selected.");
      return;
    }

    const vaultPath = (this.app.vault.adapter as any).getBasePath();
    const pluginDir = await this.resolvePluginDir(vaultPath);
    const filePath = path.join(vaultPath, file.path);
    const base = path.basename(filePath, ".md");
    const outDir = path.join(vaultPath, ".md2overleaf", base);
      await fs.ensureDir(outDir);

    const texPath = path.join(outDir, `${base}.tex`);
    const shellEnv = this.buildShellEnv();
    const npxEnv = this.buildShellEnv({ npm_config_yes: "true" });

    try {
      await runPandocPipeline({
        vaultPath,
        sourcePath: filePath,
        texPath,
        env: shellEnv,
        filterPath: path.join(pluginDir, "final_filter.lua"),
      });
      new Notice("Conversion complete. Preparing ZIP...");
    } catch (error) {
      console.error("Pandoc conversion failed:", error);
      new Notice("Pandoc conversion failed. Check console for details.");
      return;
    }

    console.log("🔍 Expecting TeX at:", texPath);
    if (!(await fs.pathExists(texPath))) {
      throw new Error(`TeX file not found at ${texPath}`);
    }

    let stageInfo: StageBuildResult | null = null;

    try {
      stageInfo = await this.buildStage({
        texPath,
        base,
        outDir,
        vaultPath,
        pluginDir,
        npxEnv,
      });

      const zip = new AdmZip();
      zip.addLocalFolder(stageInfo.stageDir, ".");
      const uniqueZipName = `${randomUUID()}.zip`;
      const zipPath = path.join(outDir, uniqueZipName);
      zip.writeZip(zipPath);

      new Notice("Uploading to Overleaf...");
      const uploadHost = this.settings.uploadHost?.trim() || "https://x0.at";
      const normalizedHost = uploadHost.replace(/\/+$/, "");
      const { stdout } = await execFileAsync(
        "curl",
        ["-s", "-F", `file=@${uniqueZipName}`, normalizedHost],
        {
          cwd: outDir,
          env: shellEnv,
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      const trimmed = stdout.trim();
      if (!trimmed.startsWith("http")) {
        throw new Error(`Upload failed: ${stdout}`);
      }
      const zipUrl = trimmed.split(/\s+/)[0];

      const overleafUrl = `https://www.overleaf.com/docs?snip_uri=${encodeURIComponent(zipUrl)}&engine=xelatex&name=${encodeURIComponent(base)}`;
      console.log("🌿 Overleaf URL:", overleafUrl);

      if (this.settings.autoOpen) {
        open(overleafUrl);
        new Notice("Opening in Overleaf...");
      } else {
        new Notice("Upload complete. See console for Overleaf URL.");
      }
    } catch (error) {
      console.error("Packaging or upload failed:", error);
      new Notice("Packaging or upload failed. See console for details.");
    } finally {
      if (stageInfo) {
        try {
          await fs.remove(stageInfo.stageDir);
        } catch (cleanupError) {
          console.warn("[md2overleaf] failed to clean temp dir", stageInfo.stageDir, cleanupError);
        }
      }
      try {
        await fs.remove(outDir);
      } catch (cleanupError) {
        console.warn("[md2overleaf] failed to clean export folder", outDir, cleanupError);
      }
    }
  }

  async copyTexToClipboard() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note selected.");
      return;
    }

    const vaultPath = (this.app.vault.adapter as any).getBasePath();
    const pluginDir = await this.resolvePluginDir(vaultPath);
    const filePath = path.join(vaultPath, file.path);
    const base = path.basename(filePath, ".md");
    const outDir = path.join(vaultPath, ".md2overleaf", base);
    await fs.ensureDir(outDir);

    const texPath = path.join(outDir, `${base}.tex`);
    const shellEnv = this.buildShellEnv();
    const npxEnv = this.buildShellEnv({ npm_config_yes: "true" });

    try {
      await runPandocPipeline({
        vaultPath,
        sourcePath: filePath,
        texPath,
        env: shellEnv,
        filterPath: path.join(pluginDir, "final_filter.lua"),
      });
    } catch (error) {
      console.error("Pandoc conversion failed:", error);
      new Notice("Pandoc conversion failed. Check console for details.");
      return;
    }

    let stageInfo: StageBuildResult | null = null;

    try {
      stageInfo = await this.buildStage({
        texPath,
        base,
        outDir,
        vaultPath,
        pluginDir,
        npxEnv,
      });

      clipboard.writeText(stageInfo.tex);
      new Notice("TeX copied to clipboard.");
    } catch (error) {
      console.error("Copy to clipboard failed:", error);
      new Notice("Failed to copy TeX. See console for details.");
    } finally {
      if (stageInfo) {
        try {
          await fs.remove(stageInfo.stageDir);
        } catch (cleanupError) {
          console.warn("[md2overleaf] failed to clean temp dir", stageInfo.stageDir, cleanupError);
        }
      }
      try {
        await fs.remove(outDir);
      } catch (cleanupError) {
        console.warn("[md2overleaf] failed to clean export folder", outDir, cleanupError);
      }
    }
  }

  private buildShellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      ...extra,
    };
  }

  private async buildStage(options: StageBuildOptions): Promise<StageBuildResult> {
    const { texPath, base, outDir, vaultPath, pluginDir, npxEnv } = options;
    const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "md2overleaf-"));

    try {
      let tex = await fs.readFile(texPath, "utf8");
      const stagedTexPath = path.join(stageDir, `${base}.tex`);
      const toCopy: Array<{ abs: string; rel: string }> = [];

      const wrapInFigure = (rel: string): string => {
        const labelBase = rel
          .replace(/^pictures\//, "")
          .replace(/\.[^.]+$/, "")
          .replace(/[^A-Za-z0-9]+/g, "-");

        return (
          `\\begin{figure}[H]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${rel}}\n  \\caption{}\n  \\label{fig:${labelBase}}\n\\end{figure}`
        );
      };

      const reMdImgInTex = /!\{\[\}\{\[}([^{}]+\.png)\{\]\}\{\]\}/g;
      tex = tex.replace(reMdImgInTex, (_full, relPath: string) => {
        const fsRel = decodeURIComponent(relPath);
        const relNormalized = fsRel.replace(/\\/g, "/");
        const cleanRel = relNormalized.replace(/[\r\n]+/g, " ");
        const abs = path.join(vaultPath, cleanRel);
        toCopy.push({ abs, rel: cleanRel });
        return wrapInFigure(cleanRel);
      });

      const reBounded = /\\pandocbounded\{\s*\\includegraphics(?:\[[^\]]*\])?\{(pictures\/[^}]+)\}\s*\}/g;
      tex = tex.replace(reBounded, (_full, relPath: string) => {
        const fsRel = decodeURIComponent(relPath);
        const rel = fsRel.replace(/\\/g, "/");
        const cleanRel = rel.replace(/[\r\n]+/g, " ");
        const abs = path.join(vaultPath, cleanRel);
        toCopy.push({ abs, rel: cleanRel });
        return wrapInFigure(cleanRel);
      });

      const reTldrawEscaped = /!\{\[\}\{\[}(pictures\/[^{}]+?\.md)\{\]\}\{\]\}/g;
      const exportTldrawMdToPng = async (
        mdAbs: string
      ): Promise<{ pngRel: string; pngAbs: string } | null> => {
        try {
          const src = await fs.readFile(mdAbs, "utf8");
          const match = src.match(/```tldraw\s*\n([\s\S]*?)```/);
          if (!match) return null;
          const drawJson = match[1];
          const drawBase = path.basename(mdAbs, ".md");
          const pngRel = `pictures/${drawBase}.png`;
          const pngAbs = path.join(stageDir, pngRel);
          const tmpTldr = path.join(outDir, `${drawBase}.tldr`);

          await fs.ensureDir(path.dirname(pngAbs));
          await fs.writeFile(tmpTldr, drawJson, "utf8");

          await execFileAsync(
            "npx",
            [
              "-y",
              "@tldraw/cli",
              "export",
              tmpTldr,
              "--format",
              "png",
              "--output",
              pngAbs,
              "--overwrite",
            ],
            {
              cwd: vaultPath,
              env: npxEnv,
              maxBuffer: 32 * 1024 * 1024,
            }
          );

          await fs.remove(tmpTldr);
          console.log("[tldraw] converted:", pngAbs);
          return { pngRel, pngAbs };
        } catch (e) {
          console.warn("[md2overleaf] tldraw export failed:", mdAbs, e);
          return null;
        }
      };

      for (const match of Array.from(tex.matchAll(reTldrawEscaped))) {
        const full = match[0];
        const relMd = match[1].trim();
        const absMd = path.join(vaultPath, relMd);
        const exported = await exportTldrawMdToPng(absMd);

        if (exported?.pngRel && exported?.pngAbs) {
          const replacement = `\\begin{figure}[H] \\centering \\includegraphics[width=\\linewidth]{${exported.pngRel}} \\end{figure}`;
          tex = tex.replace(full, replacement);
        } else {
          const replacement = `% [md2overleaf] missing tldraw export for ${relMd}`;
          tex = tex.replace(full, replacement);
        }
      }

      for (const { abs, rel } of toCopy) {
        const dest = path.join(stageDir, rel);
        await fs.ensureDir(path.dirname(dest));
        if (await fs.pathExists(abs)) {
          await fs.copy(abs, dest);
        } else {
          const fallback = await this.resolveMissingImage(rel, vaultPath);
          if (fallback && (await fs.pathExists(fallback))) {
            console.log("[md2overleaf] image found via vault scan:", rel, fallback);
            await fs.copy(fallback, dest);
          } else {
            console.warn(
              "[md2overleaf] missing referenced image despite fallbacks:",
              abs
            );
          }
        }
      }

      await fs.writeFile(stagedTexPath, tex, "utf8");

      const configPath = path.join(pluginDir, "config.tex");
      if (await fs.pathExists(configPath)) {
        await fs.copy(configPath, path.join(stageDir, "config.tex"));
      } else {
        console.warn("[md2overleaf] missing config.tex template at", configPath);
      }

      const baseNoExt = base.replace(/\.tex$/i, "");
      const niceTitle = baseNoExt.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
      const mainTemplatePath = path.join(pluginDir, "main.tex");

      if (await fs.pathExists(mainTemplatePath)) {
        let titletex = await fs.readFile(mainTemplatePath, "utf8");
        titletex = titletex.replace(/\\title\s*\{[^}]*\}/, `\\title{${niceTitle}}`);
        titletex = titletex.replace(/\\include\s*\{[^}]*\}/, `\\include{${baseNoExt}}`);
        const dst = path.join(stageDir, "main.tex");
        await fs.writeFile(dst, titletex, "utf8");
      } else {
        console.warn("[md2overleaf] missing main.tex template at", mainTemplatePath);
      }

      return { tex, stageDir };
    } catch (error) {
      await fs.remove(stageDir);
      throw error;
    }
  }

  private async resolvePluginDir(vaultPath: string): Promise<string> {
    if (this.resolvedPluginDir) {
      return this.resolvedPluginDir;
    }

    const pluginRoot = path.join(vaultPath, ".obsidian", "plugins");
    const tried = new Set<string>();
    const candidateNames = [this.manifest.dir, this.manifest.id].filter(
      (name): name is string => typeof name === "string" && name.length > 0
    );

    for (const name of candidateNames) {
      const abs = path.join(pluginRoot, name);
      tried.add(abs);
      if (await fs.pathExists(abs)) {
        this.resolvedPluginDir = abs;
        return abs;
      }
    }

    try {
      const entries = await fs.readdir(pluginRoot);
      for (const entry of entries) {
        const abs = path.join(pluginRoot, entry);
        if (tried.has(abs)) continue;
        const manifestPath = path.join(abs, "manifest.json");
        if (await fs.pathExists(manifestPath)) {
          try {
            const raw = await fs.readFile(manifestPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed?.id === this.manifest.id) {
              this.resolvedPluginDir = abs;
              return abs;
            }
          } catch (err) {
            console.warn("[md2overleaf] failed to inspect plugin manifest", manifestPath, err);
          }
        }
      }
    } catch (err) {
      console.warn("[md2overleaf] could not enumerate plugin directory", err);
    }

    this.resolvedPluginDir = __dirname;
    return this.resolvedPluginDir;
  }

  private async resolveMissingImage(rel: string, vaultPath: string): Promise<string | null> {
    try {
      const normalized = rel.replace(/\\/g, "/");
      const candidateName = path.basename(normalized);
      if (!candidateName) return null;

      const files = this.app.vault.getFiles();
      const match = files.find((file) => file.name === candidateName);
      if (!match) {
        console.warn("[md2overleaf] global search also failed for image", candidateName);
        return null;
      }
      return path.join(vaultPath, match.path);
    } catch (error) {
      console.warn("[md2overleaf] failed to search attachments for", rel, error);
      return null;
    }
  }

}

interface StageBuildOptions {
  texPath: string;
  base: string;
  outDir: string;
  vaultPath: string;
  pluginDir: string;
  npxEnv: NodeJS.ProcessEnv;
}

interface StageBuildResult {
  tex: string;
  stageDir: string;
}

class Md2OverleafSettingTab extends PluginSettingTab {
  plugin: Md2OverleafPlugin;

  constructor(app: App, plugin: Md2OverleafPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Markdown to Overleaf Settings" });

    new Setting(containerEl)
      .setName("Upload host")
      .setDesc("Where to upload the ZIP file (default: x0.at)")
      .addText((text) =>
        text
          .setPlaceholder("https://x0.at")
          .setValue(this.plugin.settings.uploadHost)
          .onChange(async (value) => {
            this.plugin.settings.uploadHost = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-open Overleaf")
      .setDesc("Automatically open Overleaf after upload")
        .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoOpen = value;
            await this.plugin.saveSettings();
          });
      });
  }
} // ← closes the Md2OverleafSettingTab class

// ✅ Make sure there is nothing else missing here!
