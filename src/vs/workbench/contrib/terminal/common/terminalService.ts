/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Event, Emitter } from 'vs/base/common/event';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { ITerminalService, ITerminalInstance, IShellLaunchConfig, ITerminalConfigHelper, KEYBINDING_CONTEXT_TERMINAL_FOCUS, KEYBINDING_CONTEXT_TERMINAL_FIND_WIDGET_VISIBLE, TERMINAL_PANEL_ID, ITerminalTab, ITerminalProcessExtHostProxy, ITerminalProcessExtHostRequest, KEYBINDING_CONTEXT_TERMINAL_IS_OPEN } from 'vs/workbench/contrib/terminal/common/terminal';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { URI } from 'vs/base/common/uri';
import { FindReplaceState } from 'vs/editor/contrib/find/findState';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { escapeNonWindowsPath } from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { isWindows, Platform } from 'vs/base/common/platform';
import { basename } from 'vs/base/common/path';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { timeout } from 'vs/base/common/async';

export abstract class TerminalService implements ITerminalService {
	public _serviceBrand: any;

	protected _isShuttingDown: boolean;
	protected _terminalFocusContextKey: IContextKey<boolean>;
	protected _findWidgetVisible: IContextKey<boolean>;
	protected _terminalContainer: HTMLElement;
	protected _terminalTabs: ITerminalTab[] = [];
	protected get _terminalInstances(): ITerminalInstance[] {
		return this._terminalTabs.reduce((p, c) => p.concat(c.terminalInstances), <ITerminalInstance[]>[]);
	}
	private _findState: FindReplaceState;
	private _extHostsReady: { [authority: string]: boolean } = {};
	private _activeTabIndex: number;

	public get activeTabIndex(): number { return this._activeTabIndex; }
	public get terminalInstances(): ITerminalInstance[] { return this._terminalInstances; }
	public get terminalTabs(): ITerminalTab[] { return this._terminalTabs; }

	private readonly _onActiveTabChanged = new Emitter<void>();
	public get onActiveTabChanged(): Event<void> { return this._onActiveTabChanged.event; }
	protected readonly _onInstanceCreated = new Emitter<ITerminalInstance>();
	public get onInstanceCreated(): Event<ITerminalInstance> { return this._onInstanceCreated.event; }
	protected readonly _onInstanceDisposed = new Emitter<ITerminalInstance>();
	public get onInstanceDisposed(): Event<ITerminalInstance> { return this._onInstanceDisposed.event; }
	protected readonly _onInstanceProcessIdReady = new Emitter<ITerminalInstance>();
	public get onInstanceProcessIdReady(): Event<ITerminalInstance> { return this._onInstanceProcessIdReady.event; }
	protected readonly _onInstanceRequestExtHostProcess = new Emitter<ITerminalProcessExtHostRequest>();
	public get onInstanceRequestExtHostProcess(): Event<ITerminalProcessExtHostRequest> { return this._onInstanceRequestExtHostProcess.event; }
	protected readonly _onInstanceDimensionsChanged = new Emitter<ITerminalInstance>();
	public get onInstanceDimensionsChanged(): Event<ITerminalInstance> { return this._onInstanceDimensionsChanged.event; }
	protected readonly _onInstancesChanged = new Emitter<void>();
	public get onInstancesChanged(): Event<void> { return this._onInstancesChanged.event; }
	protected readonly _onInstanceTitleChanged = new Emitter<ITerminalInstance>();
	public get onInstanceTitleChanged(): Event<ITerminalInstance> { return this._onInstanceTitleChanged.event; }
	protected readonly _onActiveInstanceChanged = new Emitter<ITerminalInstance | undefined>();
	public get onActiveInstanceChanged(): Event<ITerminalInstance | undefined> { return this._onActiveInstanceChanged.event; }
	protected readonly _onTabDisposed = new Emitter<ITerminalTab>();
	public get onTabDisposed(): Event<ITerminalTab> { return this._onTabDisposed.event; }

	public abstract get configHelper(): ITerminalConfigHelper;

	constructor(
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IPanelService protected readonly _panelService: IPanelService,
		@ILifecycleService readonly lifecycleService: ILifecycleService,
		@IStorageService protected readonly _storageService: IStorageService,
		@INotificationService protected readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IFileService protected readonly _fileService: IFileService,
		@IRemoteAgentService readonly _remoteAgentService: IRemoteAgentService
	) {
		this._activeTabIndex = 0;
		this._isShuttingDown = false;
		this._findState = new FindReplaceState();
		lifecycleService.onBeforeShutdown(event => event.veto(this._onBeforeShutdown()));
		lifecycleService.onShutdown(() => this._onShutdown());
		this._terminalFocusContextKey = KEYBINDING_CONTEXT_TERMINAL_FOCUS.bindTo(this._contextKeyService);
		this._findWidgetVisible = KEYBINDING_CONTEXT_TERMINAL_FIND_WIDGET_VISIBLE.bindTo(this._contextKeyService);
		this.onTabDisposed(tab => this._removeTab(tab));
		this.onActiveTabChanged(() => {
			const instance = this.getActiveInstance();
			this._onActiveInstanceChanged.fire(instance ? instance : undefined);
		});

		this._handleContextKeys();
	}

	private _handleContextKeys(): void {
		const terminalIsOpenContext = KEYBINDING_CONTEXT_TERMINAL_IS_OPEN.bindTo(this._contextKeyService);

		const updateTerminalContextKeys = () => {
			terminalIsOpenContext.set(this.terminalInstances.length > 0);
		};

		this.onInstancesChanged(() => updateTerminalContextKeys());
	}

	protected abstract _getWslPath(path: string): Promise<string>;
	protected abstract _getWindowsBuildNumber(): number;

	public abstract createTerminal(shell?: IShellLaunchConfig, wasNewTerminalAction?: boolean): ITerminalInstance;
	public abstract createInstance(terminalFocusContextKey: IContextKey<boolean>, configHelper: ITerminalConfigHelper, container: HTMLElement, shellLaunchConfig: IShellLaunchConfig, doCreateProcess: boolean): ITerminalInstance;
	public abstract getDefaultShell(platform: Platform): string;
	public abstract selectDefaultWindowsShell(): Promise<string | undefined>;
	public abstract setContainers(panelContainer: HTMLElement, terminalContainer: HTMLElement): void;

	public createTerminalRenderer(name: string): ITerminalInstance {
		return this.createTerminal({ name, isRendererOnly: true });
	}

	public getActiveOrCreateInstance(wasNewTerminalAction?: boolean): ITerminalInstance {
		const activeInstance = this.getActiveInstance();
		return activeInstance ? activeInstance : this.createTerminal(undefined, wasNewTerminalAction);
	}

	public requestExtHostProcess(proxy: ITerminalProcessExtHostProxy, shellLaunchConfig: IShellLaunchConfig, activeWorkspaceRootUri: URI, cols: number, rows: number, isWorkspaceShellAllowed: boolean): void {
		this._extensionService.whenInstalledExtensionsRegistered().then(async () => {
			// Wait for the remoteAuthority to be ready (and listening for events) before proceeding
			const conn = this._remoteAgentService.getConnection();
			const remoteAuthority = conn ? conn.remoteAuthority : 'null';
			let retries = 0;
			while (!this._extHostsReady[remoteAuthority] && ++retries < 50) {
				await timeout(100);
			}
			this._onInstanceRequestExtHostProcess.fire({ proxy, shellLaunchConfig, activeWorkspaceRootUri, cols, rows, isWorkspaceShellAllowed });
		});
	}

	public extHostReady(remoteAuthority: string): void {
		this._extHostsReady[remoteAuthority] = true;
	}

	private _onBeforeShutdown(): boolean | Promise<boolean> {
		if (this.terminalInstances.length === 0) {
			// No terminal instances, don't veto
			return false;
		}

		if (this.configHelper.config.confirmOnExit) {
			// veto if configured to show confirmation and the user choosed not to exit
			return this._showTerminalCloseConfirmation().then(veto => {
				if (!veto) {
					this._isShuttingDown = true;
				}
				return veto;
			});
		}

		this._isShuttingDown = true;

		return false;
	}

	private _onShutdown(): void {
		// Dispose of all instances
		this.terminalInstances.forEach(instance => instance.dispose(true));
	}

	public getTabLabels(): string[] {
		return this._terminalTabs.filter(tab => tab.terminalInstances.length > 0).map((tab, index) => `${index + 1}: ${tab.title ? tab.title : ''}`);
	}

	public getFindState(): FindReplaceState {
		return this._findState;
	}

	private _removeTab(tab: ITerminalTab): void {
		// Get the index of the tab and remove it from the list
		const index = this._terminalTabs.indexOf(tab);
		const wasActiveTab = tab === this.getActiveTab();
		if (index !== -1) {
			this._terminalTabs.splice(index, 1);
		}

		// Adjust focus if the tab was active
		if (wasActiveTab && this._terminalTabs.length > 0) {
			// TODO: Only focus the new tab if the removed tab had focus?
			// const hasFocusOnExit = tab.activeInstance.hadFocusOnExit;
			const newIndex = index < this._terminalTabs.length ? index : this._terminalTabs.length - 1;
			this.setActiveTabByIndex(newIndex);
			const activeInstance = this.getActiveInstance();
			if (activeInstance) {
				activeInstance.focus(true);
			}
		}

		// Hide the panel if there are no more instances, provided that VS Code is not shutting
		// down. When shutting down the panel is locked in place so that it is restored upon next
		// launch.
		if (this._terminalTabs.length === 0 && !this._isShuttingDown) {
			this.hidePanel();
			this._onActiveInstanceChanged.fire(undefined);
		}

		// Fire events
		this._onInstancesChanged.fire();
		if (wasActiveTab) {
			this._onActiveTabChanged.fire();
		}
	}

	public getActiveTab(): ITerminalTab | null {
		if (this._activeTabIndex < 0 || this._activeTabIndex >= this._terminalTabs.length) {
			return null;
		}
		return this._terminalTabs[this._activeTabIndex];
	}

	public getActiveInstance(): ITerminalInstance | null {
		const tab = this.getActiveTab();
		if (!tab) {
			return null;
		}
		return tab.activeInstance;
	}

	public getInstanceFromId(terminalId: number): ITerminalInstance {
		return this.terminalInstances[this._getIndexFromId(terminalId)];
	}

	public getInstanceFromIndex(terminalIndex: number): ITerminalInstance {
		return this.terminalInstances[terminalIndex];
	}

	public setActiveInstance(terminalInstance: ITerminalInstance): void {
		this.setActiveInstanceByIndex(this._getIndexFromId(terminalInstance.id));
	}

	public setActiveTabByIndex(tabIndex: number): void {
		if (tabIndex >= this._terminalTabs.length) {
			return;
		}

		const didTabChange = this._activeTabIndex !== tabIndex;
		this._activeTabIndex = tabIndex;

		this._terminalTabs.forEach((t, i) => t.setVisible(i === this._activeTabIndex));
		if (didTabChange) {
			this._onActiveTabChanged.fire();
		}
	}

	private _getInstanceFromGlobalInstanceIndex(index: number): { tab: ITerminalTab, tabIndex: number, instance: ITerminalInstance, localInstanceIndex: number } | null {
		let currentTabIndex = 0;
		while (index >= 0 && currentTabIndex < this._terminalTabs.length) {
			const tab = this._terminalTabs[currentTabIndex];
			const count = tab.terminalInstances.length;
			if (index < count) {
				return {
					tab,
					tabIndex: currentTabIndex,
					instance: tab.terminalInstances[index],
					localInstanceIndex: index
				};
			}
			index -= count;
			currentTabIndex++;
		}
		return null;
	}

	public setActiveInstanceByIndex(terminalIndex: number): void {
		const query = this._getInstanceFromGlobalInstanceIndex(terminalIndex);
		if (!query) {
			return;
		}

		query.tab.setActiveInstanceByIndex(query.localInstanceIndex);
		const didTabChange = this._activeTabIndex !== query.tabIndex;
		this._activeTabIndex = query.tabIndex;
		this._terminalTabs.forEach((t, i) => t.setVisible(i === query.tabIndex));

		// Only fire the event if there was a change
		if (didTabChange) {
			this._onActiveTabChanged.fire();
		}
	}

	public setActiveTabToNext(): void {
		if (this._terminalTabs.length <= 1) {
			return;
		}
		let newIndex = this._activeTabIndex + 1;
		if (newIndex >= this._terminalTabs.length) {
			newIndex = 0;
		}
		this.setActiveTabByIndex(newIndex);
	}

	public setActiveTabToPrevious(): void {
		if (this._terminalTabs.length <= 1) {
			return;
		}
		let newIndex = this._activeTabIndex - 1;
		if (newIndex < 0) {
			newIndex = this._terminalTabs.length - 1;
		}
		this.setActiveTabByIndex(newIndex);
	}

	public splitInstance(instanceToSplit: ITerminalInstance, shellLaunchConfig: IShellLaunchConfig = {}): ITerminalInstance | null {
		const tab = this._getTabForInstance(instanceToSplit);
		if (!tab) {
			return null;
		}

		const instance = tab.split(this._terminalFocusContextKey, this.configHelper, shellLaunchConfig);
		if (!instance) {
			this._showNotEnoughSpaceToast();
			return null;
		}

		this._initInstanceListeners(instance);
		this._onInstancesChanged.fire();

		this._terminalTabs.forEach((t, i) => t.setVisible(i === this._activeTabIndex));
		return instance;
	}

	protected _initInstanceListeners(instance: ITerminalInstance): void {
		instance.addDisposable(instance.onDisposed(this._onInstanceDisposed.fire, this._onInstanceDisposed));
		instance.addDisposable(instance.onTitleChanged(this._onInstanceTitleChanged.fire, this._onInstanceTitleChanged));
		instance.addDisposable(instance.onProcessIdReady(this._onInstanceProcessIdReady.fire, this._onInstanceProcessIdReady));
		instance.addDisposable(instance.onDimensionsChanged(() => this._onInstanceDimensionsChanged.fire(instance)));
		instance.addDisposable(instance.onFocus(this._onActiveInstanceChanged.fire, this._onActiveInstanceChanged));
	}

	private _getTabForInstance(instance: ITerminalInstance): ITerminalTab | null {
		for (const tab of this._terminalTabs) {
			if (tab.terminalInstances.indexOf(instance) !== -1) {
				return tab;
			}
		}
		return null;
	}

	public showPanel(focus?: boolean): Promise<void> {
		return new Promise<void>((complete) => {
			const panel = this._panelService.getActivePanel();
			if (!panel || panel.getId() !== TERMINAL_PANEL_ID) {
				this._panelService.openPanel(TERMINAL_PANEL_ID, focus);
				if (focus) {
					// Do the focus call asynchronously as going through the
					// command palette will force editor focus
					setTimeout(() => {
						const instance = this.getActiveInstance();
						if (instance) {
							instance.focusWhenReady(true).then(() => complete(undefined));
						} else {
							complete(undefined);
						}
					}, 0);
				} else {
					complete(undefined);
				}
			} else {
				if (focus) {
					// Do the focus call asynchronously as going through the
					// command palette will force editor focus
					setTimeout(() => {
						const instance = this.getActiveInstance();
						if (instance) {
							instance.focusWhenReady(true).then(() => complete(undefined));
						} else {
							complete(undefined);
						}
					}, 0);
				} else {
					complete(undefined);
				}
			}
			return undefined;
		});
	}

	public abstract hidePanel(): void;

	public abstract focusFindWidget(): Promise<void>;
	public abstract hideFindWidget(): void;

	public abstract findNext(): void;
	public abstract findPrevious(): void;

	private _getIndexFromId(terminalId: number): number {
		let terminalIndex = -1;
		this.terminalInstances.forEach((terminalInstance, i) => {
			if (terminalInstance.id === terminalId) {
				terminalIndex = i;
			}
		});
		if (terminalIndex === -1) {
			throw new Error(`Terminal with ID ${terminalId} does not exist (has it already been disposed?)`);
		}
		return terminalIndex;
	}

	public setWorkspaceShellAllowed(isAllowed: boolean): void {
		this.configHelper.setWorkspaceShellAllowed(isAllowed);
	}

	protected _showTerminalCloseConfirmation(): Promise<boolean> {
		let message;
		if (this.terminalInstances.length === 1) {
			message = nls.localize('terminalService.terminalCloseConfirmationSingular', "There is an active terminal session, do you want to kill it?");
		} else {
			message = nls.localize('terminalService.terminalCloseConfirmationPlural', "There are {0} active terminal sessions, do you want to kill them?", this.terminalInstances.length);
		}

		return this._dialogService.confirm({
			message,
			type: 'warning',
		}).then(res => !res.confirmed);
	}

	protected _showNotEnoughSpaceToast(): void {
		this._notificationService.info(nls.localize('terminal.minWidth', "Not enough space to split terminal."));
	}

	protected _validateShellPaths(label: string, potentialPaths: string[]): Promise<[string, string] | null> {
		if (potentialPaths.length === 0) {
			return Promise.resolve(null);
		}
		const current = potentialPaths.shift();
		if (current! === '') {
			return this._validateShellPaths(label, potentialPaths);
		}
		return this._fileService.exists(URI.file(current!)).then(exists => {
			if (!exists) {
				return this._validateShellPaths(label, potentialPaths);
			}
			return [label, current] as [string, string];
		});
	}

	public preparePathForTerminalAsync(originalPath: string, executable: string, title: string): Promise<string> {
		return new Promise<string>(c => {
			const exe = executable;
			if (!exe) {
				c(originalPath);
				return;
			}

			const hasSpace = originalPath.indexOf(' ') !== -1;

			const pathBasename = basename(exe, '.exe');
			const isPowerShell = pathBasename === 'pwsh' ||
				title === 'pwsh' ||
				pathBasename === 'powershell' ||
				title === 'powershell';

			if (isPowerShell && (hasSpace || originalPath.indexOf('\'') !== -1)) {
				c(`& '${originalPath.replace(/'/g, '\'\'')}'`);
				return;
			}

			if (isWindows) {
				// 17063 is the build number where wsl path was introduced.
				// Update Windows uriPath to be executed in WSL.
				if (((exe.indexOf('wsl') !== -1) || ((exe.indexOf('bash.exe') !== -1) && (exe.indexOf('git') === -1))) && (this._getWindowsBuildNumber() >= 17063)) {
					c(this._getWslPath(originalPath));
					return;
				} else if (hasSpace) {
					c('"' + originalPath + '"');
				} else {
					c(originalPath);
				}
				return;
			}
			c(escapeNonWindowsPath(originalPath));
		});
	}
}
