/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IUserDataSyncService, SyncStatus, SyncSource, CONTEXT_SYNC_STATE } from 'vs/platform/userDataSync/common/userDataSync';
import { localize } from 'vs/nls';
import { Disposable, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { MenuRegistry, MenuId, IMenuItem } from 'vs/platform/actions/common/actions';
import { IContextKeyService, IContextKey, ContextKeyExpr, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IActivityService, IBadge, NumberBadge, ProgressBadge } from 'vs/workbench/services/activity/common/activity';
import { GLOBAL_ACTIVITY_ID } from 'vs/workbench/common/activity';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { URI } from 'vs/base/common/uri';
import { registerAndGetAmdImageURL } from 'vs/base/common/amd';
import { ResourceContextKey } from 'vs/workbench/common/resources';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { Event } from 'vs/base/common/event';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { isEqual } from 'vs/base/common/resources';
import { IEditorInput } from 'vs/workbench/common/editor';
import { IAuthTokenService, AuthTokenStatus } from 'vs/platform/auth/common/auth';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';

const CONTEXT_AUTH_TOKEN_STATE = new RawContextKey<string>('authTokenStatus', AuthTokenStatus.Inactive);
const SYNC_PUSH_LIGHT_ICON_URI = URI.parse(registerAndGetAmdImageURL(`vs/workbench/contrib/userDataSync/browser/media/check-light.svg`));
const SYNC_PUSH_DARK_ICON_URI = URI.parse(registerAndGetAmdImageURL(`vs/workbench/contrib/userDataSync/browser/media/check-dark.svg`));

export class UserDataSyncWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	private static readonly ENABLEMENT_SETTING = 'configurationSync.enable';

	private readonly syncStatusContext: IContextKey<string>;
	private readonly authTokenContext: IContextKey<string>;
	private readonly badgeDisposable = this._register(new MutableDisposable());
	private readonly conflictsWarningDisposable = this._register(new MutableDisposable());
	private readonly signInNotificationDisposable = this._register(new MutableDisposable());

	constructor(
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IAuthTokenService private readonly authTokenService: IAuthTokenService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActivityService private readonly activityService: IActivityService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IHistoryService private readonly historyService: IHistoryService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this.syncStatusContext = CONTEXT_SYNC_STATE.bindTo(contextKeyService);
		this.authTokenContext = CONTEXT_AUTH_TOKEN_STATE.bindTo(contextKeyService);

		this.onDidChangeAuthTokenStatus(this.authTokenService.status);
		this.onDidChangeSyncStatus(this.userDataSyncService.status);
		this._register(Event.debounce(authTokenService.onDidChangeStatus, () => undefined, 500)(() => this.onDidChangeAuthTokenStatus(this.authTokenService.status)));
		this._register(Event.debounce(userDataSyncService.onDidChangeStatus, () => undefined, 500)(() => this.onDidChangeSyncStatus(this.userDataSyncService.status)));
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING))(() => this.onDidChangeEnablement()));
		this.registerActions();
	}

	private onDidChangeAuthTokenStatus(status: AuthTokenStatus) {
		this.authTokenContext.set(status);
		if (status === AuthTokenStatus.Active) {
			this.signInNotificationDisposable.clear();
		}
		this.updateBadge();
	}

	private onDidChangeSyncStatus(status: SyncStatus) {
		this.syncStatusContext.set(status);

		this.updateBadge();

		if (this.userDataSyncService.status === SyncStatus.HasConflicts) {
			if (!this.conflictsWarningDisposable.value) {
				const handle = this.notificationService.prompt(Severity.Warning, localize('conflicts detected', "Unable to sync due to conflicts. Please resolve them to continue."),
					[
						{
							label: localize('resolve', "Resolve Conflicts"),
							run: () => this.handleConflicts()
						}
					]);
				this.conflictsWarningDisposable.value = toDisposable(() => handle.close());
				handle.onDidClose(() => this.conflictsWarningDisposable.clear());
			}
		} else {
			const previewEditorInput = this.getPreviewEditorInput();
			if (previewEditorInput) {
				previewEditorInput.dispose();
			}
			this.conflictsWarningDisposable.clear();
		}
	}

	private onDidChangeEnablement() {
		this.updateBadge();
		const enabled = this.configurationService.getValue<boolean>(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING);
		if (enabled) {
			if (this.authTokenService.status === AuthTokenStatus.Inactive) {
				const handle = this.notificationService.prompt(Severity.Info, localize('ask to sign in', "Please sign in to '{0}' to turn on configuration sync", "{ACCOUNT_NAME}"),
					[
						{
							label: localize('Sign in', "Sign in"),
							run: () => this.signIn()
						}
					]);
				this.signInNotificationDisposable.value = toDisposable(() => handle.close());
				handle.onDidClose(() => this.signInNotificationDisposable.clear());
			}
		} else {
			this.signInNotificationDisposable.clear();
		}
	}

	private updateBadge(): void {
		this.badgeDisposable.clear();

		let badge: IBadge | undefined = undefined;
		let clazz: string | undefined;

		if (this.userDataSyncService.status !== SyncStatus.Uninitialized && this.configurationService.getValue<boolean>(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING) && this.authTokenService.status === AuthTokenStatus.Inactive) {
			badge = new NumberBadge(1, () => localize('sign in', "Configuration Sync: Sign in..."));
		} else if (this.userDataSyncService.status === SyncStatus.HasConflicts) {
			badge = new NumberBadge(1, () => localize('resolve conflicts', "Resolve Conflicts"));
		} else if (this.userDataSyncService.status === SyncStatus.Syncing) {
			badge = new ProgressBadge(() => localize('syncing', "Synchronizing User Configuration..."));
			clazz = 'progress-badge';
		}

		if (badge) {
			this.badgeDisposable.value = this.activityService.showActivity(GLOBAL_ACTIVITY_ID, badge, clazz);
		}
	}

	private async turnOn(): Promise<void> {
		if (this.authTokenService.status === AuthTokenStatus.Inactive) {
			const result = await this.dialogService.confirm({
				type: 'info',
				message: localize('turn on', "Turn on Configuration Sync"),
				detail: localize('ask to sign in', "Please sign in to '{0}' to turn on configuration sync", "{ACCOUNT_NAME}"),
				primaryButton: localize('Sign in', "Sign in")
			});
			if (!result.confirmed) {
				return;
			}
			await this.signIn();
		}
		await this.configurationService.updateValue(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING, true);
	}

	private async turnOff(): Promise<void> {
		await this.configurationService.updateValue(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING, false);
	}

	private async signIn(): Promise<void> {
		return this.authTokenService.login();
	}

	private async signOut(): Promise<void> {
		await this.authTokenService.logout();
	}

	private async continueSync(): Promise<void> {
		// Get the preview editor
		const previewEditorInput = this.getPreviewEditorInput();
		// Save the preview
		if (previewEditorInput && previewEditorInput.isDirty()) {
			await this.textFileService.save(previewEditorInput.getResource()!);
		}
		try {
			// Continue Sync
			await this.userDataSyncService.sync(true);
		} catch (error) {
			this.notificationService.error(error);
			return;
		}
		// Close the preview editor
		if (previewEditorInput) {
			previewEditorInput.dispose();
		}
	}

	private getPreviewEditorInput(): IEditorInput | undefined {
		return this.editorService.editors.filter(input => isEqual(input.getResource(), this.workbenchEnvironmentService.settingsSyncPreviewResource))[0];
	}

	private async handleConflicts(): Promise<void> {
		if (this.userDataSyncService.conflictsSource === SyncSource.Settings) {
			const resourceInput = {
				resource: this.workbenchEnvironmentService.settingsSyncPreviewResource,
				options: {
					preserveFocus: false,
					pinned: false,
					revealIfVisible: true,
				},
				mode: 'jsonc'
			};
			this.editorService.openEditor(resourceInput)
				.then(editor => {
					this.historyService.remove(resourceInput);
					if (editor && editor.input) {
						// Trigger sync after closing the conflicts editor.
						const disposable = editor.input.onDispose(() => {
							disposable.dispose();
							this.userDataSyncService.sync(true);
						});
					}
				});
		}
	}

	private registerActions(): void {

		const startSyncMenuItem: IMenuItem = {
			group: '5_sync',
			command: {
				id: 'workbench.userData.actions.syncStart',
				title: localize('start sync', "Configuration Sync: Turn On")
			},
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), ContextKeyExpr.not(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`)),
		};
		CommandsRegistry.registerCommand(startSyncMenuItem.command.id, () => this.turnOn());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, startSyncMenuItem);
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, startSyncMenuItem);

		const signInMenuItem: IMenuItem = {
			group: '5_sync',
			command: {
				id: 'workbench.userData.actions.login',
				title: localize('global activity sign in', "Configuration Sync: Sign in... (1)")
			},
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), ContextKeyExpr.has(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`), CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.Inactive)),
		};
		CommandsRegistry.registerCommand(signInMenuItem.command.id, () => this.signIn());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, signInMenuItem);
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, signInMenuItem);

		const stopSycCommand = {
			id: 'workbench.userData.actions.stopSync',
			title: localize('stop sync', "Configuration Sync: Turn Off")
		};
		CommandsRegistry.registerCommand(stopSycCommand.id, () => this.turnOff());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: stopSycCommand,
			when: ContextKeyExpr.and(ContextKeyExpr.has(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`), CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.Active), CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.HasConflicts))
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: stopSycCommand,
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), ContextKeyExpr.has(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`)),
		});

		const resolveConflictsMenuItem: IMenuItem = {
			group: '5_sync',
			command: {
				id: 'sync.resolveConflicts',
				title: localize('resolveConflicts', "Configuration Sync: Resolve Conflicts (1)"),
			},
			when: CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts),
		};
		CommandsRegistry.registerCommand(resolveConflictsMenuItem.command.id, () => this.handleConflicts());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, resolveConflictsMenuItem);
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, resolveConflictsMenuItem);

		const continueSyncCommandId = 'workbench.userData.actions.continueSync';
		CommandsRegistry.registerCommand(continueSyncCommandId, () => this.continueSync());
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: continueSyncCommandId,
				title: localize('continue sync', "Configuration Sync: Continue")
			},
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts)),
		});
		MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
			command: {
				id: continueSyncCommandId,
				title: localize('continue sync', "Configuration Sync: Continue"),
				iconLocation: {
					light: SYNC_PUSH_LIGHT_ICON_URI,
					dark: SYNC_PUSH_DARK_ICON_URI
				}
			},
			group: 'navigation',
			order: 1,
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts), ResourceContextKey.Resource.isEqualTo(this.workbenchEnvironmentService.settingsSyncPreviewResource.toString())),
		});

		const signOutMenuItem: IMenuItem = {
			group: '5_sync',
			command: {
				id: 'workbench.userData.actions.logout',
				title: localize('sign out', "Sign Out")
			},
			when: ContextKeyExpr.and(CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.Active)),
		};
		CommandsRegistry.registerCommand(signOutMenuItem.command.id, () => this.signOut());
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, signOutMenuItem);
	}
}
