/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { PickerQuickAccessProvider, IPickerQuickAccessItem } from 'vs/platform/quickinput/common/quickAccess';
import { distinct } from 'vs/base/common/arrays';
import { CancellationToken } from 'vs/base/common/cancellation';
import { DisposableStore, Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { or, matchesPrefix, matchesWords, matchesContiguousSubString } from 'vs/base/common/filters';
import { withNullAsUndefined } from 'vs/base/common/types';
import { LRUCache } from 'vs/base/common/map';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification } from 'vs/base/common/actions';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { isPromiseCanceledError } from 'vs/base/common/errors';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { isFirefox } from 'vs/base/browser/browser';
import { timeout } from 'vs/base/common/async';

export interface ICommandQuickPick extends IPickerQuickAccessItem {
	commandId: string;
	commandAlias: string | undefined;
}

export interface ICommandsQuickAccessOptions {
	showAlias: boolean;
}

export abstract class AbstractCommandsQuickAccessProvider extends PickerQuickAccessProvider<ICommandQuickPick> implements IDisposable {

	static PREFIX = '>';

	private static WORD_FILTER = or(matchesPrefix, matchesWords, matchesContiguousSubString);

	private readonly disposables = new DisposableStore();

	private readonly commandsHistory = this.disposables.add(this.instantiationService.createInstance(CommandsHistory));

	constructor(
		private options: ICommandsQuickAccessOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(AbstractCommandsQuickAccessProvider.PREFIX);
	}

	protected async getPicks(filter: string, disposables: DisposableStore, token: CancellationToken): Promise<Array<ICommandQuickPick | IQuickPickSeparator>> {

		// Ask subclass for all command picks
		const allCommandPicks = await this.getCommandPicks(disposables, token);

		// Filter
		const filteredCommandPicks: ICommandQuickPick[] = [];
		for (const commandPick of allCommandPicks) {
			const labelHighlights = withNullAsUndefined(AbstractCommandsQuickAccessProvider.WORD_FILTER(filter, commandPick.label));
			const aliasHighlights = commandPick.commandAlias ? withNullAsUndefined(AbstractCommandsQuickAccessProvider.WORD_FILTER(filter, commandPick.commandAlias)) : undefined;

			if (labelHighlights || aliasHighlights) {
				commandPick.highlights = {
					label: labelHighlights,
					detail: this.options.showAlias ? aliasHighlights : undefined
				};

				filteredCommandPicks.push(commandPick);
			}
		}

		// Remove duplicates
		const distinctCommandPicks = distinct(filteredCommandPicks, pick => `${pick.label}${pick.commandId}`);

		// Add description to commands that have duplicate labels
		const mapLabelToCommand = new Map<string, ICommandQuickPick>();
		for (const commandPick of distinctCommandPicks) {
			const existingCommandForLabel = mapLabelToCommand.get(commandPick.label);
			if (existingCommandForLabel) {
				commandPick.description = commandPick.commandId;
				existingCommandForLabel.description = existingCommandForLabel.commandId;
			} else {
				mapLabelToCommand.set(commandPick.label, commandPick);
			}
		}

		// Sort by MRU order and fallback to name otherwise
		distinctCommandPicks.sort((commandPickA, commandPickB) => {
			const commandACounter = this.commandsHistory.peek(commandPickA.commandId);
			const commandBCounter = this.commandsHistory.peek(commandPickB.commandId);

			if (commandACounter && commandBCounter) {
				return commandACounter > commandBCounter ? -1 : 1; // use more recently used command before older
			}

			if (commandACounter) {
				return -1; // first command was used, so it wins over the non used one
			}

			if (commandBCounter) {
				return 1; // other command was used so it wins over the command
			}

			// both commands were never used, so we sort by name
			return commandPickA.label.localeCompare(commandPickB.label);
		});

		const commandPicks: Array<ICommandQuickPick | IQuickPickSeparator> = [];

		let addSeparator = false;
		for (let i = 0; i < distinctCommandPicks.length; i++) {
			const commandPick = distinctCommandPicks[i];
			const keybinding = this.keybindingService.lookupKeybinding(commandPick.commandId);
			const ariaLabel = keybinding ?
				localize('commandPickAriaLabelWithKeybinding', "{0}, {1}, commands picker", commandPick.label, keybinding.getAriaLabel()) :
				localize('commandPickAriaLabel', "{0}, commands picker", commandPick.label);

			// Separator: recently used
			if (i === 0 && this.commandsHistory.peek(commandPick.commandId)) {
				commandPicks.push({ type: 'separator', label: localize('recentlyUsed', "recently used") });
				addSeparator = true;
			}

			// Separator: other commands
			if (i !== 0 && addSeparator && !this.commandsHistory.peek(commandPick.commandId)) {
				commandPicks.push({ type: 'separator', label: localize('morecCommands', "other commands") });
				addSeparator = false; // only once
			}

			// Command
			commandPicks.push({
				...commandPick,
				ariaLabel,
				detail: this.options.showAlias ? commandPick.commandAlias : undefined,
				keybinding,
				accept: async () => {

					// Add to history
					this.commandsHistory.push(commandPick.commandId);

					if (!isFirefox) {
						// Use a timeout to give the quick open widget a chance to close itself first
						// Firefox: since the browser is quite picky for certain commands, we do not
						// use a timeout (https://github.com/microsoft/vscode/issues/83288)
						await timeout(50);
					}

					// Telementry
					this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', {
						id: commandPick.commandId,
						from: 'quick open'
					});

					// Run
					try {
						await this.commandService.executeCommand(commandPick.commandId);
					} catch (error) {
						if (!isPromiseCanceledError(error)) {
							this.notificationService.error(localize('canNotRun', "Command '{0}' resulted in an error ({1})", commandPick.label, toErrorMessage(error)));
						}
					}
				}
			});
		}

		return commandPicks;
	}

	protected abstract getCommandPicks(disposables: DisposableStore, token: CancellationToken): Promise<Array<ICommandQuickPick>>;

	dispose(): void {
		this.disposables.dispose();
	}
}

interface ISerializedCommandHistory {
	usesLRU?: boolean;
	entries: { key: string; value: number }[];
}

interface ICommandsQuickAccessConfiguration {
	workbench: {
		commandPalette: {
			history: number;
			preserveInput: boolean;
		}
	};
}

class CommandsHistory extends Disposable {

	static readonly DEFAULT_COMMANDS_HISTORY_LENGTH = 50;

	private static readonly PREF_KEY_CACHE = 'commandPalette.mru.cache';
	private static readonly PREF_KEY_COUNTER = 'commandPalette.mru.counter';

	private static cache: LRUCache<string, number> | undefined;
	private static counter = 1;

	private configuredCommandsHistoryLength = 0;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		this.updateConfiguration();
		this.load();

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(() => this.updateConfiguration()));
	}

	private updateConfiguration(): void {
		this.configuredCommandsHistoryLength = CommandsHistory.getConfiguredCommandHistoryLength(this.configurationService);

		if (CommandsHistory.cache && CommandsHistory.cache.limit !== this.configuredCommandsHistoryLength) {
			CommandsHistory.cache.limit = this.configuredCommandsHistoryLength;

			CommandsHistory.saveState(this.storageService);
		}
	}

	private load(): void {
		const raw = this.storageService.get(CommandsHistory.PREF_KEY_CACHE, StorageScope.GLOBAL);
		let serializedCache: ISerializedCommandHistory | undefined;
		if (raw) {
			try {
				serializedCache = JSON.parse(raw);
			} catch (error) {
				// invalid data
			}
		}

		const cache = CommandsHistory.cache = new LRUCache<string, number>(this.configuredCommandsHistoryLength, 1);
		if (serializedCache) {
			let entries: { key: string; value: number }[];
			if (serializedCache.usesLRU) {
				entries = serializedCache.entries;
			} else {
				entries = serializedCache.entries.sort((a, b) => a.value - b.value);
			}
			entries.forEach(entry => cache.set(entry.key, entry.value));
		}

		CommandsHistory.counter = this.storageService.getNumber(CommandsHistory.PREF_KEY_COUNTER, StorageScope.GLOBAL, CommandsHistory.counter);
	}

	push(commandId: string): void {
		if (!CommandsHistory.cache) {
			return;
		}

		CommandsHistory.cache.set(commandId, CommandsHistory.counter++); // set counter to command

		CommandsHistory.saveState(this.storageService);
	}

	peek(commandId: string): number | undefined {
		return CommandsHistory.cache?.peek(commandId);
	}

	static saveState(storageService: IStorageService): void {
		if (!CommandsHistory.cache) {
			return;
		}

		const serializedCache: ISerializedCommandHistory = { usesLRU: true, entries: [] };
		CommandsHistory.cache.forEach((value, key) => serializedCache.entries.push({ key, value }));

		storageService.store(CommandsHistory.PREF_KEY_CACHE, JSON.stringify(serializedCache), StorageScope.GLOBAL);
		storageService.store(CommandsHistory.PREF_KEY_COUNTER, CommandsHistory.counter, StorageScope.GLOBAL);
	}

	static getConfiguredCommandHistoryLength(configurationService: IConfigurationService): number {
		const config = <ICommandsQuickAccessConfiguration>configurationService.getValue();

		const configuredCommandHistoryLength = config.workbench?.commandPalette?.history;
		if (typeof configuredCommandHistoryLength === 'number') {
			return configuredCommandHistoryLength;
		}

		return CommandsHistory.DEFAULT_COMMANDS_HISTORY_LENGTH;
	}

	static clearHistory(configurationService: IConfigurationService, storageService: IStorageService): void {
		const commandHistoryLength = CommandsHistory.getConfiguredCommandHistoryLength(configurationService);
		CommandsHistory.cache = new LRUCache<string, number>(commandHistoryLength);
		CommandsHistory.counter = 1;

		CommandsHistory.saveState(storageService);
	}
}

