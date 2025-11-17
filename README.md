## md2overleaf — Obsidian → Overleaf Exporter

Convert any Obsidian note into a full Overleaf project with one click.

This plugin:

- Runs the Pandoc + Lua filter pipeline directly from the plugin (no external shell scripts or extra vault files).

- Rewrites images and embeds into clean LaTeX figure environments.

- Converts TLDraw drawings → PNG automatically.

- Collects only the referenced images/drawings.

- Packs everything into a ZIP.

- Uploads the ZIP to Overleaf Snippet Import (or lets you copy the processed TeX to your clipboard for manual updates).

- (optional) Automatically opens the project in Overleaf.

### Installation (user)
1. Download the latest release ZIP from GitHub Releases.
2. Extract it to: ''' <Vault>/.obsidian/plugins/md2overleaf/''' 
3. Enable it in Settings → Community Plugins. You'll now have two commands: “Export to Overleaf” (creates a ZIP + uploads) and “Copy Overleaf TeX to clipboard” (just copies the TeX output).

### Installation (developer)
1. git clone https://github.com/asafdayan/md2overleaf
2. cd md2overleaf
3. npm install
4. npm run build
5. Then copy the dist/ folder into: '''<Vault>/.obsidian/plugins/md2overleaf/'''
6. Enable it in Settings → Community Plugins.

### Required Tools
pandoc version 3.2.1 or higher
