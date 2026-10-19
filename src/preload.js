const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('neoSync', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openMicrosoftRegister: () => ipcRenderer.invoke('open-microsoft-register'),
  getGameInstanceFolder: pack => ipcRenderer.invoke('game-instance-folder', pack),
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setRamLimit: value => ipcRenderer.invoke('settings-set-ram', value),
  getAccount: () => ipcRenderer.invoke('account-get'),
  useOfflineAccount: name => ipcRenderer.invoke('account-offline', name),
  loginMicrosoft: () => ipcRenderer.invoke('account-microsoft'),
  logoutAccount: () => ipcRenderer.invoke('account-logout'),
  launchGame: pack => ipcRenderer.invoke('launch-game', pack),
  onLaunchStatus: callback => ipcRenderer.on('launch-status', (_event, message) => callback(message)),
  checkClientUpdate: () => ipcRenderer.invoke('client-update-check'),
  downloadClientUpdate: () => ipcRenderer.invoke('client-update-download'),
  installClientUpdate: () => ipcRenderer.invoke('client-update-install'),
  onClientUpdateStatus: callback => ipcRenderer.on('client-update-status', (_event, message) => callback(message))
});
