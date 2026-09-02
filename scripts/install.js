// Package the extension and install the resulting VSIX into VS Code (and Cursor if present).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const vsix = path.join(__dirname, '..', `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`Missing ${vsix}. Run "npm run package" first (or use "npm run install-local").`);
  process.exit(1);
}

const candidates = [
  process.env.VSCODE_CLI,
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
  'code',
].filter(Boolean);
if (process.argv.includes('--cursor')) { candidates.unshift('/Applications/Cursor.app/Contents/Resources/app/bin/code'); }

for (const cli of candidates) {
  try {
    execFileSync(cli, ['--install-extension', vsix, '--force'], { stdio: 'inherit' });
    console.log(`\nInstalled ${path.basename(vsix)} via ${cli}. Reload the VS Code window to activate it.`);
    process.exit(0);
  } catch (err) {
    if (err.code !== 'ENOENT') { process.exit(err.status ?? 1); }
  }
}
console.error('Could not find the VS Code CLI. Set VSCODE_CLI=/path/to/code or add "code" to your PATH.');
process.exit(1);
