/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUserDataSyncService, SyncStatus, ISynchroniser, IUserDataSyncStoreService, SyncSource, ISettingsSyncService, IUserDataSyncLogService, IUserDataAuthTokenService } from 'vs/platform/userDataSync/common/userDataSync';
import { Disposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { SettingsSynchroniser } from 'vs/platform/userDataSync/common/settingsSync';
import { Emitter, Event } from 'vs/base/common/event';
import { ExtensionsSynchroniser } from 'vs/platform/userDataSync/common/extensionsSync';
import { IExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { KeybindingsSynchroniser } from 'vs/platform/userDataSync/common/keybindingsSync';
import { GlobalStateSynchroniser } from 'vs/platform/userDataSync/common/globalStateSync';
import { toErrorMessage } from 'vs/base/common/errorMessage';

export class UserDataSyncService extends Disposable implements IUserDataSyncService {

	_serviceBrand: any;

	private readonly synchronisers: ISynchroniser[];

	private _status: SyncStatus = SyncStatus.Uninitialized;
	get status(): SyncStatus { return this._status; }
	private _onDidChangeStatus: Emitter<SyncStatus> = this._register(new Emitter<SyncStatus>());
	readonly onDidChangeStatus: Event<SyncStatus> = this._onDidChangeStatus.event;

	readonly onDidChangeLocal: Event<void>;

	private _conflictsSource: SyncSource | null = null;
	get conflictsSource(): SyncSource | null { return this._conflictsSource; }

	private readonly keybindingsSynchroniser: KeybindingsSynchroniser;
	private readonly extensionsSynchroniser: ExtensionsSynchroniser;
	private readonly globalStateSynchroniser: GlobalStateSynchroniser;

	constructor(
		@IUserDataSyncStoreService private readonly userDataSyncStoreService: IUserDataSyncStoreService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISettingsSyncService private readonly settingsSynchroniser: ISettingsSyncService,
		@IUserDataSyncLogService private readonly logService: IUserDataSyncLogService,
		@IUserDataAuthTokenService private readonly userDataAuthTokenService: IUserDataAuthTokenService,
	) {
		super();
		this.keybindingsSynchroniser = this._register(this.instantiationService.createInstance(KeybindingsSynchroniser));
		this.globalStateSynchroniser = this._register(this.instantiationService.createInstance(GlobalStateSynchroniser));
		this.extensionsSynchroniser = this._register(this.instantiationService.createInstance(ExtensionsSynchroniser));
		this.synchronisers = [this.settingsSynchroniser, this.keybindingsSynchroniser, this.globalStateSynchroniser, this.extensionsSynchroniser];
		this.updateStatus();

		if (this.userDataSyncStoreService.userDataSyncStore) {
			this._register(Event.any(...this.synchronisers.map(s => Event.map(s.onDidChangeStatus, () => undefined)))(() => this.updateStatus()));
			this._register(this.userDataAuthTokenService.onDidChangeToken(e => this.onDidChangeAuthTokenStatus(e)));
		}

		this.onDidChangeLocal = Event.any(...this.synchronisers.map(s => s.onDidChangeLocal));
	}

	async pull(): Promise<void> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			try {
				await synchroniser.pull();
			} catch (e) {
				this.logService.error(`${this.getSyncSource(synchroniser)}: ${toErrorMessage(e)}`);
			}
		}
	}

	async push(): Promise<void> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			try {
				await synchroniser.push();
			} catch (e) {
				this.logService.error(`${this.getSyncSource(synchroniser)}: ${toErrorMessage(e)}`);
			}
		}
	}

	async sync(_continue?: boolean): Promise<boolean> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			try {
				if (!await synchroniser.sync(_continue)) {
					return false;
				}
			} catch (e) {
				this.logService.error(`${this.getSyncSource(synchroniser)}: ${toErrorMessage(e)}`);
			}
		}
		return true;
	}

	stop(): void {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		for (const synchroniser of this.synchronisers) {
			synchroniser.stop();
		}
	}

	async hasPreviouslySynced(): Promise<boolean> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			if (await synchroniser.hasPreviouslySynced()) {
				return true;
			}
		}
		return false;
	}

	async hasRemoteData(): Promise<boolean> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			if (await synchroniser.hasRemoteData()) {
				return true;
			}
		}
		return false;
	}

	async hasLocalData(): Promise<boolean> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			if (await synchroniser.hasLocalData()) {
				return true;
			}
		}
		return false;
	}

	async isFirstTimeSyncAndHasUserData(): Promise<boolean> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		if (await this.hasPreviouslySynced()) {
			return false;
		}
		return await this.hasLocalData();
	}

	async reset(): Promise<void> {
		await this.resetRemote();
		await this.resetLocal();
	}

	private async resetRemote(): Promise<void> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		try {
			await this.userDataSyncStoreService.clear();
			this.logService.info('Completed clearing remote data');
		} catch (e) {
			this.logService.error(e);
		}
	}

	async resetLocal(): Promise<void> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
		if (!(await this.userDataAuthTokenService.getToken())) {
			throw new Error('Not Authenticated. Please sign in to start sync.');
		}
		for (const synchroniser of this.synchronisers) {
			try {
				await synchroniser.resetLocal();
			} catch (e) {
				this.logService.error(`${this.getSyncSource(synchroniser)}: ${toErrorMessage(e)}`);
			}
		}
		this.logService.info('Completed resetting local cache');
	}

	removeExtension(identifier: IExtensionIdentifier): Promise<void> {
		return this.extensionsSynchroniser.removeExtension(identifier);
	}

	private updateStatus(): void {
		this._conflictsSource = this.computeConflictsSource();
		this.setStatus(this.computeStatus());
	}

	private setStatus(status: SyncStatus): void {
		if (this._status !== status) {
			this._status = status;
			this._onDidChangeStatus.fire(status);
		}
	}

	private computeStatus(): SyncStatus {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			return SyncStatus.Uninitialized;
		}
		if (this.synchronisers.some(s => s.status === SyncStatus.HasConflicts)) {
			return SyncStatus.HasConflicts;
		}
		if (this.synchronisers.some(s => s.status === SyncStatus.Syncing)) {
			return SyncStatus.Syncing;
		}
		return SyncStatus.Idle;
	}

	private computeConflictsSource(): SyncSource | null {
		const synchroniser = this.synchronisers.filter(s => s.status === SyncStatus.HasConflicts)[0];
		return synchroniser ? this.getSyncSource(synchroniser) : null;
	}

	private getSyncSource(synchroniser: ISynchroniser): SyncSource {
		if (synchroniser instanceof SettingsSynchroniser) {
			return SyncSource.Settings;
		}
		if (synchroniser instanceof KeybindingsSynchroniser) {
			return SyncSource.Keybindings;
		}
		if (synchroniser instanceof ExtensionsSynchroniser) {
			return SyncSource.Extensions;
		}
		return SyncSource.UIState;
	}

	private onDidChangeAuthTokenStatus(token: string | undefined): void {
		if (!token) {
			this.stop();
		}
	}
}
