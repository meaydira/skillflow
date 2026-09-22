import { app, BrowserWindow, Menu, dialog, shell, nativeTheme } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

let win = null;
let serverUrl = null;
let workspace = null;

/* ------------------------------------------------------------------ config */

const configFile = () => join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(next) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...readConfig(), ...next }, null, 2), 'utf8');
}

/**
 * The workspace is the directory that owns `.skillflow/`: your tasks, runs and
 * workflow files. Keeping it outside the app bundle is what lets it survive an
 * app update, and lets you point the app at a folder you already have.
 */
function resolveWorkspace() {
  const saved = readConfig().workspace;
  if (saved && existsSync(saved)) return saved;

  const fallback = join(homedir(), 'skillflow');
  mkdirSync(fallback, { recursive: true });

  // Seed a new workspace with the bundled workflows, so a first launch has
  // something to look at rather than an empty board and no examples.
  for (const dir of ['workflows', 'examples']) {
    const from = join(app.getAppPath(), dir);
    const to = join(fallback, dir);
    if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
  }
  writeConfig({ workspace: fallback });
  return fallback;
}

/* -------------------------------------------------------------------- PATH */

/**
 * A GUI app launched from Finder gets a minimal PATH, not the one your terminal
 * has. Without this the app cannot find `claude`, and every task fails with
 * something that looks like an auth problem but is not. So ask the login shell
 * what the PATH really is, once, at startup.
 */
async function inheritShellPath() {
  const shellBin = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await run(shellBin, ['-ilc', 'echo -n "$PATH"'], { timeout: 5000 });
    if (stdout.trim()) process.env.PATH = stdout.trim();
  } catch {
    // Fall through to the defaults below rather than failing to start.
  }
  // Belt and braces for the usual install locations.
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]) {
    if (existsSync(dir) && !process.env.PATH.split(':').includes(dir)) {
      process.env.PATH = `${dir}:${process.env.PATH}`;
    }
  }
}

/**
 * Point the Agent SDK at a binary that really exists on disk.
 *
 * Inside the packaged app the SDK resolves its own CLI to a path within
 * app.asar. That archive is not a directory, so spawning through it fails with
 * ENOTDIR and every task dies the moment it starts. electron-builder unpacks
 * the binary next door, so rewrite the path; if that is missing for any reason,
 * fall back to a Claude Code the user installed themselves.
 */
async function resolveClaudeBinary() {
  const unpacked = join(
    app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    'claude',
  );
  if (existsSync(unpacked)) return unpacked;

  try {
    const { stdout } = await run('which', ['claude'], { timeout: 5000 });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Neither available: tasks will fail with a clear message from the dialog
    // below rather than a spawn error nobody can read.
  }
  return null;
}

async function claudeStatus() {
  try {
    const { stdout } = await run('claude', ['auth', 'status'], { timeout: 12000 });
    const parsed = JSON.parse(stdout);
    return parsed.loggedIn ? { ok: true } : { ok: false, reason: 'not-logged-in' };
  } catch (err) {
    if (process.env.ANTHROPIC_API_KEY) return { ok: true };
    return { ok: false, reason: /ENOENT|not found/.test(String(err)) ? 'missing' : 'unknown' };
  }
}

/* ------------------------------------------------------------------ server */

async function startServer(dir) {
  const { startUi } = await import(join(app.getAppPath(), 'dist', 'ui', 'server.js'));
  // Walk up from the preferred port rather than failing when something else
  // already holds it, including a second copy of this app.
  for (let port = 4600; port < 4620; port += 1) {
    try {
      return await startUi(dir, port);
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error('no free port between 4600 and 4619');
}

/* -------------------------------------------------------------------- menu */

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Change Workspace...',
          click: async () => {
            const picked = await dialog.showOpenDialog(win, {
              title: 'Choose a workspace folder',
              message: 'skillflow keeps its tasks and runs in a .skillflow folder here.',
              properties: ['openDirectory', 'createDirectory'],
              defaultPath: workspace,
            });
            if (picked.canceled || picked.filePaths.length === 0) return;
            writeConfig({ workspace: picked.filePaths[0] });
            app.relaunch();
            app.exit(0);
          },
        },
        {
          label: 'Reveal Workspace in Finder',
          click: () => shell.openPath(workspace),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    { role: 'help', submenu: [
      { label: 'Open in Browser', click: () => serverUrl && shell.openExternal(serverUrl) },
      { label: 'skillflow on GitHub', click: () => shell.openExternal('https://github.com/meaydira/skillflow') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  await inheritShellPath();
  workspace = resolveWorkspace();

  const claudeBinary = await resolveClaudeBinary();
  if (claudeBinary) process.env.SKILLFLOW_CLAUDE_PATH = claudeBinary;

  try {
    serverUrl = await startServer(workspace);
  } catch (err) {
    dialog.showErrorBox('skillflow could not start', String(err && err.message ? err.message : err));
    app.exit(1);
    return;
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'skillflow',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151412' : '#fbfbfa',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // The board is served locally; anything else opens in the real browser rather
  // than turning this window into an unmanaged one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(serverUrl);
  buildMenu();

  const status = await claudeStatus();
  if (!status.ok) {
    const missing = status.reason === 'missing';
    dialog.showMessageBox(win, {
      type: 'warning',
      title: missing ? 'Claude Code is not installed' : 'Claude Code is not signed in',
      message: missing
        ? 'skillflow runs your agents through Claude Code, which is not on this machine yet.'
        : 'skillflow found Claude Code but it is not signed in.',
      detail: missing
        ? 'In a terminal:\n\n  npm install -g @anthropic-ai/claude-code\n  claude auth login\n\nThe board works without it. Running a task does not.'
        : 'In a terminal:\n\n  claude auth login\n\nThe board works without it. Running a task does not.',
      buttons: ['Continue anyway'],
    });
  }
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
