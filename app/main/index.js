'use strict';
const path = require('path');
const electron = require('electron');
const windowStateKeeper = require('electron-window-state');
const isDev = require('electron-is-dev');
const appMenu = require('./menu');
const { appUpdater } = require('./autoupdater');

const { setAutoLaunch } = require('./startup');

const { app, ipcMain } = electron;

const BadgeSettings = require('./../renderer/js/pages/preference/badge-settings.js');
const ConfigUtil = require('./../renderer/js/utils/config-util.js');
const ProxyUtil = require('./../renderer/js/utils/proxy-util.js');
const { sentryInit } = require('./../renderer/js/utils/sentry-util.js');

// Adds debug features like hotkeys for triggering dev tools and reload
// in development mode
if (isDev) {
	require('electron-debug')();
}

// Prevent window being garbage collected
let mainWindow;
let badgeCount;

let isQuitting = false;

// Load this url in main window
const mainURL = 'file://' + path.join(__dirname, '../renderer', 'main.html');

const isAlreadyRunning = app.makeSingleInstance(() => {
	if (mainWindow) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}

		mainWindow.show();
	}
});

if (isAlreadyRunning) {
	return app.quit();
}

const APP_ICON = path.join(__dirname, '../resources', 'Icon');

const iconPath = () => {
	return APP_ICON + (process.platform === 'win32' ? '.ico' : '.png');
};

function createMainWindow() {
	// Load the previous state with fallback to defaults
	const mainWindowState = windowStateKeeper({
		defaultWidth: 1100,
		defaultHeight: 720,
		path: `${app.getPath('userData')}/config`
	});

	// Let's keep the window position global so that we can access it in other process
	global.mainWindowState = mainWindowState;

	const win = new electron.BrowserWindow({
		// This settings needs to be saved in config
		title: 'Zulip',
		icon: iconPath(),
		x: mainWindowState.x,
		y: mainWindowState.y,
		width: mainWindowState.width,
		height: mainWindowState.height,
		minWidth: 300,
		minHeight: 400,
		webPreferences: {
			plugins: true,
			nodeIntegration: true,
			partition: 'persist:webviewsession'
		},
		show: false
	});

	win.on('focus', () => {
		win.webContents.send('focus');
	});

	win.once('ready-to-show', () => {
		if (ConfigUtil.getConfigItem('startMinimized')) {
			win.minimize();
		} else {
			win.show();
		}
	});

	win.loadURL(mainURL);

	// Keep the app running in background on close event
	win.on('close', e => {
		if (!isQuitting) {
			e.preventDefault();

			if (process.platform === 'darwin') {
				app.hide();
			} else {
				win.hide();
			}
		}
	});

	win.setTitle('Zulip');

	win.on('enter-full-screen', () => {
		win.webContents.send('enter-fullscreen');
	});

	win.on('leave-full-screen', () => {
		win.webContents.send('leave-fullscreen');
	});

	//  To destroy tray icon when navigate to a new URL
	win.webContents.on('will-navigate', e => {
		if (e) {
			win.webContents.send('destroytray');
		}
	});

	// Let us register listeners on the window, so we can update the state
	// automatically (the listeners will be removed when the window is closed)
	// and restore the maximized or full screen state
	mainWindowState.manage(win);

	return win;
}

// Decrease load on GPU (experimental)
app.disableHardwareAcceleration();

// Temporary fix for Electron render colors differently
// More info here - https://github.com/electron/electron/issues/10732
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// eslint-disable-next-line max-params
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
	event.preventDefault();
	callback(true);
});

app.on('activate', () => {
	if (!mainWindow) {
		mainWindow = createMainWindow();
	}
});

app.on('ready', () => {
	appMenu.setMenu({
		tabs: []
	});
	mainWindow = createMainWindow();

	// Initialize sentry for main process
	sentryInit();

	const isSystemProxy = ConfigUtil.getConfigItem('useSystemProxy');

	if (isSystemProxy) {
		ProxyUtil.resolveSystemProxy(mainWindow);
	}

	const page = mainWindow.webContents;

	page.on('dom-ready', () => {
		if (ConfigUtil.getConfigItem('startMinimized')) {
			mainWindow.minimize();
		} else {
			mainWindow.show();
		}
	});

	page.once('did-frame-finish-load', () => {
		// Initiate auto-updates on MacOS and Windows
		if (ConfigUtil.getConfigItem('autoUpdate')) {
			appUpdater();
		}
	});

	// Temporarily remove this event
	// electron.powerMonitor.on('resume', () => {
	// 	mainWindow.reload();
	// 	page.send('destroytray');
	// });

	ipcMain.on('focus-app', () => {
		mainWindow.show();
	});

	ipcMain.on('quit-app', () => {
		app.quit();
	});

	// Reload full app not just webview, useful in debugging
	ipcMain.on('reload-full-app', () => {
		mainWindow.reload();
		page.send('destroytray');
	});

	ipcMain.on('clear-app-settings', () => {
		global.mainWindowState.unmanage(mainWindow);
		app.relaunch();
		app.exit();
	});

	ipcMain.on('toggle-app', () => {
		if (mainWindow.isVisible()) {
			mainWindow.hide();
		} else {
			mainWindow.show();
		}
	});

	ipcMain.on('toggle-badge-option', () => {
		BadgeSettings.updateBadge(badgeCount, mainWindow);
	});

	ipcMain.on('update-badge', (event, messageCount) => {
		badgeCount = messageCount;
		BadgeSettings.updateBadge(badgeCount, mainWindow);
		page.send('tray', messageCount);
	});

	ipcMain.on('update-taskbar-icon', (event, data, text) => {
		BadgeSettings.updateTaskbarIcon(data, text, mainWindow);
	});

	ipcMain.on('forward-message', (event, listener, ...params) => {
		page.send(listener, ...params);
	});

	ipcMain.on('update-menu', (event, props) => {
		appMenu.setMenu(props);
	});

	ipcMain.on('toggleAutoLauncher', (event, AutoLaunchValue) => {
		setAutoLaunch(AutoLaunchValue);
	});

	ipcMain.on('downloadFile', (event, url, downloadPath) => {
		page.downloadURL(url);
		page.session.once('will-download', (event, item) => {
			const filePath = path.join(downloadPath, item.getFilename());
			item.setSavePath(filePath);
			item.on('updated', (event, state) => {
				switch (state) {
					case 'interrupted' : {
						// Can interrupted to due to network error, cancel download then
						console.log('Download interrupted, cancelling and fallback to dialog download.');
						item.cancel();
						break;
					}
					case 'progressing': {
						if (item.isPaused()) {
							item.cancel();
						}
						// This event can also be used to show progres in percentage in future.
						break;
					}
					default: {
						console.info('Unknown updated state of download item');
					}
				}
			});
			item.once('done', (event, state) => {
				if (state === 'completed') {
					page.send('downloadFileCompleted', item.getSavePath(), item.getFilename());
				} else {
					console.log('Download failed state: ', state);
					page.send('downloadFileFailed');
				}
				// To stop item for listening to updated events of this file
				item.removeAllListeners('updated');
			});
		});
	});

	ipcMain.on('realm-icon-changed', (event, serverURL, iconURL) => {
		page.send('update-realm-icon', serverURL, iconURL);
	});
});

app.on('before-quit', () => {
	isQuitting = true;
});

// Send crash reports
process.on('uncaughtException', err => {
	console.error(err);
	console.error(err.stack);
});
