const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Launch, Microsoft } = require('minecraft-java-core');

const PORT = 8766;
const ui = path.join(__dirname, 'ui.html');
const publishedDirs = { principal: null, optimizado: null };
const publishedControlsFiles = { principal: null, optimizado: null };
const publishedOptionsFiles = { principal: null, optimizado: null };
let publicServer = null;
let mainWindow = null;
let activeLaunch = null;
let account = null;
let updateCheckInProgress = false;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;
const MC_VERSION = '1.21.1';
const NEOFORGE_VERSION = '21.1.256';
const PACK_FOLDERS = new Set(['mods', 'config', 'defaultconfigs', 'resourcepacks', 'controls']);
const GAME_ROOT = () => path.join(app.getPath('userData'), 'Minecraft');
const INSTANCE_NAME = 'VacacionesLand3';
const PACK_IDS = new Set(['principal', 'optimizado']);
function packId(value) { return PACK_IDS.has(value) ? value : 'principal'; }
function gameInstanceName(value) { return packId(value) === 'optimizado' ? `${INSTANCE_NAME}-Optimizado` : INSTANCE_NAME; }
const GAME_DIR = (value = 'principal') => path.join(GAME_ROOT(), 'instances', gameInstanceName(value));
const ACCOUNT_FILE = () => path.join(app.getPath('userData'), 'account.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const MAX_RAM_GB = () => Math.max(2, Math.min(64, Math.floor(os.totalmem() / (1024 ** 3)) - 2));
function readSettings() {
  let maxRamGb = Math.min(6, MAX_RAM_GB());
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    if (Number.isInteger(saved.maxRamGb)) maxRamGb = saved.maxRamGb;
  } catch {}
  maxRamGb = Math.max(2, Math.min(MAX_RAM_GB(), maxRamGb));
  return { maxRamGb, maxAllowedGb: MAX_RAM_GB(), totalRamGb: Math.floor(os.totalmem() / (1024 ** 3)) };
}

function offlineProfile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name.trim())) {
    throw Error('El nombre offline debe tener entre 3 y 16 caracteres: letras, números o _.');
  }
  name = name.trim();
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return { mode: 'offline', name, uuid: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` };
}

function saveAccount(value) {
  account = value;
  if (value?.mode === 'microsoft') {
    if (!safeStorage.isEncryptionAvailable()) throw Error('Windows no tiene disponible el almacenamiento seguro para guardar la sesión Microsoft.');
    fs.mkdirSync(path.dirname(ACCOUNT_FILE()), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE(), JSON.stringify({ encrypted: safeStorage.encryptString(JSON.stringify(value.auth)).toString('base64') }));
  } else if (value?.mode === 'offline') {
    fs.mkdirSync(path.dirname(ACCOUNT_FILE()), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE(), JSON.stringify({ offline: value.name }));
  } else {
    account = null;
    try { fs.unlinkSync(ACCOUNT_FILE()); } catch {}
  }
  return publicAccount();
}

function publicAccount() {
  const skin = account?.mode === 'offline' ? account.skin : account?.auth?.profile?.skins?.find(item => item.base64)?.base64;
  return account ? { mode: account.mode, name: account.name, skin: typeof skin === 'string' && skin.startsWith('data:image/png;base64,') ? skin : null } : null;
}

async function skinForJavaName(name) {
  try {
    const profileResponse = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
    if (!profileResponse.ok) return null;
    const profile = await profileResponse.json();
    if (typeof profile.id !== 'string' || !/^[a-f0-9]{32}$/i.test(profile.id)) return null;
    const sessionResponse = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`, { signal: AbortSignal.timeout(5000) });
    if (!sessionResponse.ok) return null;
    const session = await sessionResponse.json();
    const encoded = session.properties?.find(property => property.name === 'textures')?.value;
    if (typeof encoded !== 'string') return null;
    const textures = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const skinUrl = textures.textures?.SKIN?.url;
    if (typeof skinUrl !== 'string' || !/^https:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]+$/i.test(skinUrl)) return null;
    const skinResponse = await fetch(skinUrl, { signal: AbortSignal.timeout(7000) });
    if (!skinResponse.ok || !skinResponse.headers.get('content-type')?.includes('image/png')) return null;
    const image = Buffer.from(await skinResponse.arrayBuffer());
    if (image.length > 2_000_000) return null;
    return `data:image/png;base64,${image.toString('base64')}`;
  } catch { return null; }
}

async function loadAccount() {
  if (account) return publicAccount();
  try {
    const saved = JSON.parse(fs.readFileSync(ACCOUNT_FILE(), 'utf8'));
    if (saved.offline) {
      account = offlineProfile(saved.offline);
      account.skin = await skinForJavaName(account.name);
    }
    else if (saved.encrypted && safeStorage.isEncryptionAvailable()) {
      const auth = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
      const refreshed = await new Microsoft().refresh(auth);
      if (refreshed && !refreshed.error) saveAccount({ mode: 'microsoft', name: refreshed.name, auth: refreshed });
      else account = null;
    }
  } catch { account = null; }
  return publicAccount();
}

function sendLaunchStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-status', message);
}

function sendClientUpdateStatus(type, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('client-update-status', { type, ...details });
}

autoUpdater.on('checking-for-update', () => sendClientUpdateStatus('checking'));
autoUpdater.on('update-available', info => sendClientUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', info => sendClientUpdateStatus('current', { version: info.version }));
autoUpdater.on('download-progress', progress => sendClientUpdateStatus('progress', { percent: Math.floor(progress.percent || 0) }));
autoUpdater.on('update-downloaded', info => sendClientUpdateStatus('downloaded', { version: info.version }));
autoUpdater.on('error', error => sendClientUpdateStatus('error', { message: error?.message || 'No se pudo revisar la actualización.' }));

function restoreLauncher() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function safePackPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || relativePath.includes(':')) throw Error('Ruta de archivo no válida.');
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || !PACK_FOLDERS.has(parts[0].toLowerCase())) throw Error('Ruta fuera de las carpetas del modpack.');
  if (parts[0].toLowerCase() === 'mods' && !parts.at(-1).toLowerCase().endsWith('.jar')) throw Error('En mods solo se comparten archivos .jar.');
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (!target.startsWith(base + path.sep)) throw Error('Ruta de archivo no válida.');
  return target;
}

function packRoot(folder) {
  const selected = path.resolve(folder);
  if (path.basename(selected).toLowerCase() === 'mods') return path.dirname(selected);
  return selected;
}

function listPackFiles(root) {
  const files = [];
  for (const folder of PACK_FOLDERS) {
    const top = path.join(root, folder);
    if (!fs.existsSync(top) || !fs.statSync(top).isDirectory()) continue;
    const visit = (directory, relative) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(directory, entry.name);
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(abs, rel);
        else if (entry.isFile() && (folder !== 'mods' || entry.name.toLowerCase().endsWith('.jar'))) {
          const buffer = fs.readFileSync(abs);
          files.push({ path: rel, name: entry.name, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
        }
      }
    };
    visit(top, folder);
  }
  return files;
}

function copyPackFiles(sourceRoot, destinationRoot) {
  let copied = 0;
  for (const file of listPackFiles(sourceRoot)) {
    const source = safePackPath(sourceRoot, file.path);
    const target = safePackPath(destinationRoot, file.path);
    if (path.resolve(source) === path.resolve(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied++;
  }
  return copied;
}

function captureDefaultControls(sourceRoot, id) {
  const optionsFile = path.join(sourceRoot, 'options.txt');
  const controlsFile = path.join(app.getPath('userData'), 'VacacionesLand3', `default-controls-${id}.txt`);
  publishedControlsFiles[id] = null;
  if (!fs.existsSync(optionsFile)) return;
  const bindings = fs.readFileSync(optionsFile, 'utf8').split(/\r?\n/).filter(line => /^key_[^:]+:.+$/.test(line));
  if (!bindings.length) return;
  fs.mkdirSync(path.dirname(controlsFile), { recursive: true });
  fs.writeFileSync(controlsFile, `${[...new Set(bindings)].join('\n')}\n`);
  publishedControlsFiles[id] = controlsFile;
}

function captureInitialOptions(sourceRoot, id) {
  const optionsFile = path.join(sourceRoot, 'options.txt');
  const defaultsFile = path.join(app.getPath('userData'), 'VacacionesLand3', `initial-options-${id}.txt`);
  publishedOptionsFiles[id] = null;
  if (!fs.existsSync(optionsFile)) return;
  const options = fs.readFileSync(optionsFile, 'utf8').split(/\r?\n/).filter(line => /^[^:#\r\n]+:.+$/.test(line));
  if (!options.length) return;
  fs.mkdirSync(path.dirname(defaultsFile), { recursive: true });
  fs.writeFileSync(defaultsFile, `${[...new Set(options)].join('\n')}\n`);
  publishedOptionsFiles[id] = defaultsFile;
}

function publish(folder, selectedPack) {
  const id = packId(selectedPack);
  if (typeof folder !== 'string' || !folder.trim()) throw Error('Elige la carpeta de instancia que vas a compartir.');
  publishedDirs[id] = packRoot(folder);
  if (!fs.existsSync(publishedDirs[id]) || !fs.statSync(publishedDirs[id]).isDirectory()) throw Error('No se encontró esa carpeta.');
  captureDefaultControls(publishedDirs[id], id);
  captureInitialOptions(publishedDirs[id], id);
  const copied = copyPackFiles(publishedDirs[id], GAME_DIR(id));
  if (publicServer) return copied;
  publicServer = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && requestUrl.pathname === '/api/manifest') {
      const requestedPack = requestUrl.searchParams.get('pack') || 'principal';
      if (!PACK_IDS.has(requestedPack) || !publishedDirs[requestedPack]) { response.writeHead(404); response.end('Ese modpack todavía no está publicado.'); return; }
      const files = listPackFiles(publishedDirs[requestedPack]);
      const controlsFile = publishedControlsFiles[requestedPack];
      if (controlsFile && fs.existsSync(controlsFile)) {
        const buffer = fs.readFileSync(controlsFile);
        files.push({ path: 'controls/keybinds.txt', name: 'keybinds.txt', size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      }
      const optionsFile = publishedOptionsFiles[requestedPack];
      if (optionsFile && fs.existsSync(optionsFile)) {
        const buffer = fs.readFileSync(optionsFile);
        files.push({ path: 'controls/initial-options.txt', name: 'initial-options.txt', size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ pack: requestedPack, minecraft: MC_VERSION, loader: `NeoForge ${NEOFORGE_VERSION}`, generatedAt: new Date().toISOString(), files })); return;
    }
    if (request.method === 'GET' && request.url.startsWith('/files/')) {
      const rawParts = request.url.slice('/files/'.length).split('/');
      const firstPart = rawParts.shift();
      const legacyPrincipalRoute = !PACK_IDS.has(firstPart);
      const requestedPack = legacyPrincipalRoute ? 'principal' : firstPart;
      if (!PACK_IDS.has(requestedPack) || !publishedDirs[requestedPack]) { response.writeHead(404); response.end(); return; }
      let name; try { name = decodeURIComponent((legacyPrincipalRoute ? [firstPart, ...rawParts] : rawParts).join('/')); } catch {}
      const controlsFile = publishedControlsFiles[requestedPack];
      const optionsFile = publishedOptionsFiles[requestedPack];
      const sharedFile = name === 'controls/keybinds.txt' ? controlsFile : name === 'controls/initial-options.txt' ? optionsFile : null;
      if (sharedFile && fs.existsSync(sharedFile)) {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': fs.statSync(sharedFile).size });
        fs.createReadStream(sharedFile).pipe(response); return;
      }
      let file; try { file = safePackPath(publishedDirs[requestedPack], name); } catch { response.writeHead(400); response.end(); return; }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': name.toLowerCase().endsWith('.jar') ? 'application/java-archive' : 'application/octet-stream', 'Content-Length': fs.statSync(file).size }); fs.createReadStream(file).pipe(response); return;
    }
    response.writeHead(404); response.end();
  });
  publicServer.listen(8765, '0.0.0.0');
  return copied;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/ui') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(ui).pipe(res);
  }
  if (req.method === 'POST' && req.url === '/api/sync') {
    let body = ''; req.on('data', part => { body += part; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { base, pack, folder, files } = JSON.parse(body);
        const selectedPack = pack || 'principal';
        if (!PACK_IDS.has(selectedPack)) throw Error('Selecciona un modpack válido.');
        const destination = !pack && typeof folder === 'string' && folder.trim() ? path.resolve(folder) : GAME_DIR(selectedPack);
        if (!base || !Array.isArray(files)) throw Error('Faltan datos del modpack.');
        fs.mkdirSync(destination, { recursive: true });
        let updated = 0; let current = 0;
        const nextPackFiles = new Set(files.map(file => file?.path).filter(filePath => typeof filePath === 'string'));
        const stateFile = path.join(destination, '.vacacionesland3-files.json');
        let previousState = [];
        try { previousState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const previousPackFiles = new Set(Array.isArray(previousState) ? previousState : Object.keys(previousState || {}));
        const previousHashes = previousState && !Array.isArray(previousState) && typeof previousState === 'object' ? previousState : {};
        for (const file of files) {
          if (!file || typeof file.path !== 'string') throw Error('La lista incluye una ruta no válida.');
          safePackPath(destination, file.path);
          if (file.path === 'controls/keybinds.txt') {
            const marker = path.join(destination, '.vacacionesland3-controls-installed');
            if (fs.existsSync(marker)) { current++; continue; }
            const response = await fetch(base + '/files/' + selectedPack + '/' + encodeURIComponent(file.path));
            if (!response.ok) throw Error('No se pudieron descargar los controles iniciales.');
            const buffer = Buffer.from(await response.arrayBuffer());
            if (crypto.createHash('sha256').update(buffer).digest('hex') !== file.sha256) throw Error('La verificación de los controles no coincidió.');
            const bindings = buffer.toString('utf8').split(/\r?\n/).filter(line => /^key_[^:]+:.+$/.test(line));
            if (!bindings.length) throw Error('El archivo de controles no contiene asignaciones válidas.');
            const optionsFile = path.join(destination, 'options.txt');
            let options = '';
            try { options = fs.readFileSync(optionsFile, 'utf8'); } catch {}
            const retained = options.split(/\r?\n/).filter(line => line && !/^key_[^:]+:.+$/.test(line));
            fs.writeFileSync(optionsFile, [...retained, ...bindings].join('\n') + '\n');
            fs.writeFileSync(marker, 'installed');
            updated++;
            continue;
          }
          if (file.path === 'controls/initial-options.txt') {
            const marker = path.join(destination, '.vacacionesland3-initial-options-installed');
            if (fs.existsSync(marker)) { current++; continue; }
            const response = await fetch(base + '/files/' + selectedPack + '/' + encodeURIComponent(file.path));
            if (!response.ok) throw Error('No se pudieron descargar los ajustes iniciales.');
            const buffer = Buffer.from(await response.arrayBuffer());
            if (crypto.createHash('sha256').update(buffer).digest('hex') !== file.sha256) throw Error('La verificación de los ajustes iniciales no coincidió.');
            const defaults = buffer.toString('utf8').split(/\r?\n/).filter(line => /^[^:#\r\n]+:.+$/.test(line));
            if (!defaults.length) throw Error('El archivo no contiene ajustes válidos.');
            const optionsFile = path.join(destination, 'options.txt');
            let existing = '';
            try { existing = fs.readFileSync(optionsFile, 'utf8'); } catch {}
            const existingOptions = existing.split(/\r?\n/).filter(line => /^[^:#\r\n]+:.+$/.test(line));
            const hasPersonalSettings = existingOptions.some(line => !/^key_[^:]+:.+$/.test(line));
            if (!hasPersonalSettings) fs.writeFileSync(optionsFile, `${defaults.join('\n')}\n`);
            fs.writeFileSync(marker, 'installed');
            updated++;
            continue;
          }
          const target = safePackPath(destination, file.path);
          if (fs.existsSync(target)) {
            const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
            if (hash === file.sha256) { current++; continue; }
            const isUserConfig = /^(config|defaultconfigs)\//i.test(file.path);
            const oldHash = previousHashes[file.path];
            const sourceUnchanged = oldHash ? oldHash === file.sha256 : previousPackFiles.has(file.path);
            if (isUserConfig && previousPackFiles.has(file.path) && sourceUnchanged) { current++; continue; }
          }
          const response = await fetch(base + '/files/' + selectedPack + '/' + encodeURIComponent(file.path));
          if (!response.ok) throw Error('No se pudo descargar ' + file.path + ' (' + response.status + ').');
          const buffer = Buffer.from(await response.arrayBuffer());
          const hash = crypto.createHash('sha256').update(buffer).digest('hex');
          if (hash !== file.sha256) throw Error('La verificación de ' + file.path + ' no coincidió.');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const temp = target + '.vacacionesland3.tmp'; fs.writeFileSync(temp, buffer); fs.renameSync(temp, target); updated++;
        }
        let removed = 0;
        if (previousPackFiles.size) {
          for (const oldPath of previousPackFiles) {
            if (nextPackFiles.has(oldPath)) continue;
            try {
              const oldFile = safePackPath(destination, oldPath);
              if (fs.existsSync(oldFile) && fs.statSync(oldFile).isFile()) { fs.unlinkSync(oldFile); removed++; }
            } catch {}
          }
        }
        const nextHashes = Object.fromEntries(files.map(file => [file.path, file.sha256]));
        fs.writeFileSync(stateFile, JSON.stringify(nextHashes, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: `${updated} archivo(s) actualizado(s); ${current} ya estaban al día${removed ? `; ${removed} archivo(s) retirado(s) del modpack` : ''}.` }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }
  if (req.method === 'POST' && req.url === '/api/publish') {
    let body = ''; req.on('data', part => body += part); req.on('end', () => {
      try {
        const requestData = JSON.parse(body);
        const id = packId(requestData.pack);
        const copied = publish(requestData.folder, id);
        const label = id === 'principal' ? 'Principal' : 'Optimizado';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `${label} publicado en el puerto 8765. ${copied} archivo(s) copiado(s) a tu instancia local.` }));
      }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }
  if (req.method === 'GET' && req.url === '/api/local-address') {
    const interfaces = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal);
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(interfaces[0]?.address || '127.0.0.1'); return;
  }
  res.writeHead(404); res.end();
});

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1', () => console.log(`Servicio local listo en ${PORT}`));
  ipcMain.handle('pick-folder', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('open-microsoft-register', () => shell.openExternal('https://signup.live.com/'));
  ipcMain.handle('game-instance-folder', (_event, selectedPack) => GAME_DIR(packId(selectedPack)));
  ipcMain.handle('settings-get', () => readSettings());
  ipcMain.handle('settings-set-ram', (_event, value) => {
    const maxRamGb = Number(value);
    if (!Number.isInteger(maxRamGb) || maxRamGb < 2 || maxRamGb > MAX_RAM_GB()) throw Error(`Elige entre 2 y ${MAX_RAM_GB()} GB de RAM.`);
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ maxRamGb }, null, 2));
    return readSettings();
  });
  ipcMain.handle('account-get', loadAccount);
  ipcMain.handle('account-offline', async (_event, name) => {
    const profile = offlineProfile(name);
    profile.skin = await skinForJavaName(profile.name);
    return saveAccount(profile);
  });
  ipcMain.handle('account-microsoft', async () => {
    const result = await new Microsoft().getAuth('electron');
    if (!result) return null;
    if (result.error) throw Error(result.message || result.error_description || result.error);
    return saveAccount({ mode: 'microsoft', name: result.name, auth: result });
  });
  ipcMain.handle('account-logout', () => saveAccount(null));
  ipcMain.handle('client-update-check', async () => {
    if (!app.isPackaged) return { type: 'development' };
    if (updateCheckInProgress) return { type: 'checking' };
    updateCheckInProgress = true;
    try {
      await autoUpdater.checkForUpdates();
      return { type: 'checking' };
    } catch (error) {
      sendClientUpdateStatus('error', { message: error?.message || 'No se pudo revisar la actualización.' });
      return { type: 'error' };
    } finally {
      updateCheckInProgress = false;
    }
  });
  ipcMain.handle('client-update-download', async () => {
    if (!app.isPackaged) throw Error('Las actualizaciones solo funcionan en el launcher instalado.');
    return autoUpdater.downloadUpdate();
  });
  ipcMain.handle('client-update-install', () => {
    if (!app.isPackaged) throw Error('Las actualizaciones solo funcionan en el launcher instalado.');
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle('launch-game', async (_event, selectedPack) => {
    const id = packId(selectedPack);
    const instance = gameInstanceName(id);
    const gameDir = GAME_DIR(id);
    if (activeLaunch) throw Error('Minecraft ya se está iniciando.');
    if (!account) await loadAccount();
    if (!account) throw Error('Primero inicia sesión o crea un perfil offline.');
    const authenticator = account.mode === 'microsoft' ? account.auth : {
      access_token: '0', client_token: account.uuid, uuid: account.uuid, name: account.name,
      user_properties: '{}', meta: { online: false, type: 'legacy' }
    };
    const modsFolder = path.join(gameDir, 'mods');
    fs.mkdirSync(modsFolder, { recursive: true });
    const installedMods = fs.readdirSync(modsFolder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'));
    if (!installedMods.length) throw Error(`No hay mods instalados en esta instancia: ${modsFolder}. La primera vez, conecta con el PC administrador y pulsa Actualizar mods.`);
    const launcher = new Launch();
    activeLaunch = launcher;
    launcher.on('progress', (done, size, item) => sendLaunchStatus({ type: 'progress', percent: size ? Math.floor(done / size * 100) : 0, item: item || 'Preparando archivos del juego…' }));
    launcher.on('extract', item => sendLaunchStatus({ type: 'progress', item: `Instalando ${item}` }));
    launcher.on('patch', item => sendLaunchStatus({ type: 'progress', item: `Configurando ${item}` }));
    launcher.on('data', line => { if (/error|exception|failed/i.test(String(line))) sendLaunchStatus({ type: 'log', item: String(line).slice(0, 300) }); });
    launcher.on('error', err => {
      activeLaunch = null;
      restoreLauncher();
      sendLaunchStatus({ type: 'error', message: err?.error || err?.message || 'No se pudo iniciar Minecraft.' });
    });
    launcher.on('close', () => {
      activeLaunch = null;
      restoreLauncher();
      sendLaunchStatus({ type: 'closed', message: 'Minecraft se cerró.' });
    });
    try {
      const { maxRamGb } = readSettings();
      launcher.Launch({
        path: GAME_ROOT(), instance, version: MC_VERSION,
        authenticator, loader: { type: 'neoforge', build: NEOFORGE_VERSION, enable: true },
        java: { version: '21', type: 'jre' }, memory: { min: '2G', max: `${maxRamGb}G` },
        downloadFileMultiple: 5
      });
      mainWindow.minimize();
    } catch (error) {
      activeLaunch = null;
      restoreLauncher();
      throw error;
    }
    return { started: true, folder: gameDir, pack: id, modCount: installedMods.length };
  });
  mainWindow = new BrowserWindow({ width: 1180, height: 760, minWidth: 900, minHeight: 620, backgroundColor: '#101319', title: 'VacacionesLand3 · Modpack', icon: path.join(__dirname, 'assets', 'vacacionesland-app.png'), webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
  mainWindow.webContents.once('did-finish-load', () => {
    if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(error => sendClientUpdateStatus('error', { message: error?.message || 'No se pudo revisar la actualización.' })), 3500);
  });
  mainWindow.loadFile(ui);
});
