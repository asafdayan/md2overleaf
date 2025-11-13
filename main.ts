import { Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import { exec } from "child_process";
import fs from "fs-extra";
import path from "path";
import AdmZip from "adm-zip";
import { open } from "openurl";

interface Md2OverleafSettings {
  scriptPath: string;
  uploadHost: string;
  autoOpen: boolean;
}

const DEFAULT_SETTINGS: Md2OverleafSettings = {
  scriptPath: "${vault}/mdtex.sh",
  uploadHost: "https://transfer.sh",
  autoOpen: true,
};

export default class Md2OverleafPlugin extends Plugin {
  settings: Md2OverleafSettings;

  async onload() {
    await this.loadSettings();
    this.addCommand({
      id: "export-to-overleaf",
      name: "Export to Overleaf",
      callback: () => this.exportToOverleaf(),
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

    const Plugindir = this.manifest.dir || __dirname;
    const vaultPath = (this.app.vault.adapter as any).getBasePath();
    const expand = (p: string) => p.replace("${vault}", vaultPath);

    const filePath = path.join(vaultPath, file.path);
    const base = path.basename(filePath, ".md");
    const outDir = path.join(vaultPath, ".md2overleaf", base);
    fs.ensureDirSync(outDir);

    const script = expand(this.settings.scriptPath);
    const vaultDir = path.dirname(expand("${vault}/."));
    const cmd = `./mdtex.sh -v "${filePath}"`;

    console.log("🧠 Running:", cmd);
    console.log("Vault base path:", vaultPath);
    exec(cmd, {
  cwd: vaultPath,
  shell: "/bin/bash",
  env: {
    ...process.env,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    }
    }, async (err, stdout, stderr) => {
    if (err) {
    console.error("Script error:", stderr);
    new Notice("Conversion script failed. See console.");
    return;
  }

  console.log(stdout);
  new Notice("Conversion complete. Preparing ZIP...");

  const texPath = path.join(vaultPath, ".md2overleaf", base, `${base}.tex`);
  ///
  //const found = await waitForFile(texPath);
  //if (!found) {
   // console.error("❌ TEX not found at:", texPath);
    //new Notice("No .tex file produced by script! (waited for iCloud)");
   //return;
//}
  //---------- BEGIN: stage + rewrite from .tex patterns ----------

console.log("🔍 Expecting TEX at:", texPath);

// (icloud can be a bit slow)

// read tex
let tex = await fs.readFile(texPath, "utf8");

// stage root: <outDir>/__stage__
const stageRoot = path.join(outDir, "__stage__");
await fs.remove(stageRoot);
await fs.ensureDir(stageRoot);

// we will always place the (rewritten) tex at the root of the zip
const stagedTexPath = path.join(stageRoot, `${base}.tex`);

// keep track of images we need to copy (absolute src → staged rel)
const toCopy: Array<{abs:string, rel:string}> = [];

// 1) handle: \pandocbounded{\includegraphics[...]{pictures/...}}
const reBounded = /\\pandocbounded\{\s*\\includegraphics(?:\[[^\]]*\])?\{(pictures\/[^}]+)\}\s*\}/g;

tex = tex.replace(reBounded, (_full, relPath: string) => {
  const abs = path.join(vaultPath, relPath);
  const relNormalized = relPath.replace(/\\/g, "/"); // safety
  toCopy.push({ abs, rel: relNormalized });
  // normalize to our preferred includegraphics
  return `\\includegraphics[width=\\linewidth]{${relNormalized}}`;
});

// 2) handle: !{[}{[}pictures/... .md{]}{]}
//   (escaped form of ![[pictures/...md]] that leaked into LaTeX)
const reTldrawEscaped = /!\{\[\}\{\[\}(pictures\/[^{}]+?\.md)\{\]\}\{\]\}/g;

const exportTldrawMdToPng = async (mdAbs: string): Promise<{pngRel:string, pngAbs:string} | null> => {
  try {
    const src = await fs.readFile(mdAbs, "utf8");
    const m = src.match(/```tldraw\s*\n([\s\S]*?)```/);
    if (!m) return null;
    const drawJson = m[1];

    const drawBase = path.basename(mdAbs, ".md");
    const pngRel = `pictures/${drawBase}.png`;
    const pngAbs = path.join(stageRoot, pngRel);

    // write tmp .tldr next to outDir (not in iCloud pictures)
    const tmpTldr = path.join(outDir, `${drawBase}.tldr`);
    await fs.ensureDir(path.dirname(pngAbs));
    await fs.writeFile(tmpTldr, drawJson, "utf8");

    const converter = path.join(vaultPath, "tldraw_convert.sh");
     const cmd = `"${converter}" "${tmpTldr}" "${pngAbs}"`;

    exec(cmd, {
      cwd: vaultPath,
      shell: "/bin/bash",
      env: {
        ...process.env,
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        npm_config_yes: "true"
      }
    }, (err, stdout, stderr) => {
      if (err) {
        console.error("[tldraw] convert failed:", stderr || err);
      } else {
        console.log("[tldraw] converted:", pngAbs);
      }
    });


    await fs.remove(tmpTldr);
    return { pngRel, pngAbs };
  } catch (e) {
    console.warn("[md2overleaf] tldraw export failed:", mdAbs, e);
    return null;
  }
};

// replace tldraw placeholders inline, export PNGs, stage results
for (const match of Array.from(tex.matchAll(reTldrawEscaped))) {
  const full = match[0];
  const relMd = match[1].trim(); // e.g., pictures/Foo.md
  const absMd = path.join(vaultPath, relMd);
  const exported = await exportTldrawMdToPng(absMd);

  if (exported?.pngRel && exported?.pngAbs) {
    // replace the placeholder in tex with proper includegraphics
    const replacement = `\\includegraphics[width=\\linewidth]{${exported.pngRel}}`;
    tex = tex.replace(full, replacement);
    // image is already written under stageRoot/pictures/..., nothing more to copy here
  } else {
    // if we couldn't export, just drop in a warning comment so LaTeX still compiles
    const replacement = `% [md2overleaf] missing tldraw export for ${relMd}`;
    tex = tex.replace(full, replacement);
  }
}

// 3) copy all normal images referenced by the bounded includegraphics
for (const { abs, rel } of toCopy) {
  const dest = path.join(stageRoot, rel);
  await fs.ensureDir(path.dirname(dest));
  if (await fs.pathExists(abs)) {
    await fs.copy(abs, dest);
  } else {
    console.warn("[md2overleaf] missing referenced image:", abs);
  }
}

// write the rewritten tex into stage root
await fs.writeFile(stagedTexPath, tex, "utf8");

// 4) zip the staged structure

["config.tex", "main.tex"].forEach(f =>
  fs.copyFileSync(path.join(vaultPath, f), path.join(stageRoot, f))
);
const baseNoExt = base.replace(/\.tex$/i, "");
const niceTitle = baseNoExt.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

const src = path.join(vaultPath, "main.tex");
let titletex = fs.readFileSync(src, "utf8");

// עדכן title
titletex = titletex.replace(/\\title\s*\{[^}]*\}/, `\\title{${niceTitle}}`);

// עדכן קובץ ראשי שמוזן למסמך (אם יש \input או \include)
titletex = titletex.replace(/\\include\s*\{[^}]*\}/, `\\include{${baseNoExt}}`);

// (אופציונלי) לעדכן גם author לשם הקובץ/לשם קבוע:
// tex = tex.replace(/\\author\s*\{[^}]*\}/, `\\author{${niceTitle}}`);

// כתוב גרסה מעודכנת ל-stage לפני הזיפ
const dst = path.join(stageRoot, "main.tex");
fs.writeFileSync(dst, titletex);


const zip = new AdmZip();
zip.addLocalFolder(stageRoot, "."); // keep structure: <base>.tex + pictures/...
const zipPath = path.join(outDir, `${base}.zip`);
zip.writeZip(zipPath);

// ---------- END: stage + rewrite from .tex patterns ----------


  // 🧩 Upload ZIP
  new Notice("Uploading to Overleaf...");
  const uploadCmd = `cd "${outDir}" && curl bashupload.app -T "${base}.zip"`;
  console.log("📤 Upload command:", uploadCmd);

    exec(uploadCmd, { shell: "/bin/bash" }, (err, stdout, stderr) => {
    if (err) {
      console.error("Upload error:", stderr);
      new Notice("Upload failed. See console for details.");
      return;
    }

    const m = stdout.match(/https?:\/\/bashupload\.app\/\S+/);
    if (!m) {
    console.error("Could not find URL in output:", stdout);
    new Notice("Upload finished, but no URL found in output.");
    return;
  }

    const zipUrl = m[0].trim();

    const overleafUrl = `https://www.overleaf.com/docs?snip_uri=${zipUrl}&engine=xelatex&name=${base}`;
    console.log("🌿 Overleaf URL:", overleafUrl);

    if (this.settings.autoOpen) {
      open(overleafUrl);
      new Notice("Opening in Overleaf...");
    } else {
      new Notice("Upload complete. See console for Overleaf URL.");
    }
  });
}); // ← closes the outer exec()
}
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
      .setName("Conversion script path")
      .setDesc("Path to your mdtex.sh script (use ${vault} placeholder)")
      .addText((text) =>
        text
          .setPlaceholder("${vault}/mdtex.sh")
          .setValue(this.plugin.settings.scriptPath)
          .onChange(async (value) => {
            this.plugin.settings.scriptPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Upload host")
      .setDesc("Where to upload the ZIP file (default: transfer.sh)")
      .addText((text) =>
        text
          .setPlaceholder("https://transfer.sh")
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


