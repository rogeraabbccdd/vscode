/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { IPickerQuickAccessItem, PickerQuickAccessProvider, TriggerAction } from 'vs/platform/quickinput/browser/pickerQuickAccess';
import { fuzzyScore, createMatches, FuzzyScore } from 'vs/base/common/filters';
import { CancellationToken } from 'vs/base/common/cancellation';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { ThrottledDelayer } from 'vs/base/common/async';
import { getWorkspaceSymbols, IWorkspaceSymbol, IWorkspaceSymbolProvider } from 'vs/workbench/contrib/search/common/search';
import { SymbolKinds, SymbolTag, SymbolKind } from 'vs/editor/common/modes';
import { ILabelService } from 'vs/platform/label/common/label';
import { Schemas } from 'vs/base/common/network';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IEditorService, SIDE_GROUP, ACTIVE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { Range } from 'vs/editor/common/core/range';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkbenchEditorConfiguration } from 'vs/workbench/common/editor';
import { IKeyMods } from 'vs/platform/quickinput/common/quickInput';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { createResourceExcludeMatcher } from 'vs/workbench/services/search/common/search';
import { ResourceMap } from 'vs/base/common/map';
import { URI } from 'vs/base/common/uri';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { getSelectionSearchString } from 'vs/editor/contrib/find/findController';
import { withNullAsUndefined } from 'vs/base/common/types';
import { prepareQuery, IPreparedQuery } from 'vs/base/common/fuzzyScorer';

interface ISymbolQuickPickItem extends IPickerQuickAccessItem {
	resource: URI | undefined;
	score: FuzzyScore | undefined;
	symbol: IWorkspaceSymbol;
}

export class SymbolsQuickAccessProvider extends PickerQuickAccessProvider<ISymbolQuickPickItem> {

	static PREFIX = '#';

	private static readonly TYPING_SEARCH_DELAY = 200; // this delay accommodates for the user typing a word and then stops typing to start searching

	private static TREAT_AS_GLOBAL_SYMBOL_TYPES = new Set<SymbolKind>([
		SymbolKind.Class,
		SymbolKind.Enum,
		SymbolKind.File,
		SymbolKind.Interface,
		SymbolKind.Namespace,
		SymbolKind.Package,
		SymbolKind.Module
	]);

	private delayer = this._register(new ThrottledDelayer<ISymbolQuickPickItem[]>(SymbolsQuickAccessProvider.TYPING_SEARCH_DELAY));

	private readonly resourceExcludeMatcher = this._register(createResourceExcludeMatcher(this.instantiationService, this.configurationService));

	get defaultFilterValue(): string | undefined {

		// Prefer the word under the cursor in the active editor as default filter
		const editor = this.codeEditorService.getFocusedCodeEditor();
		if (editor) {
			return withNullAsUndefined(getSelectionSearchString(editor));
		}

		return undefined;
	}

	constructor(
		@ILabelService private readonly labelService: ILabelService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		super(SymbolsQuickAccessProvider.PREFIX, { canAcceptInBackground: true });
	}

	private get configuration() {
		const editorConfig = this.configurationService.getValue<IWorkbenchEditorConfiguration>().workbench.editor;

		return {
			openEditorPinned: !editorConfig.enablePreviewFromQuickOpen,
			openSideBySideDirection: editorConfig.openSideBySideDirection
		};
	}

	protected getPicks(filter: string, disposables: DisposableStore, token: CancellationToken): Promise<Array<ISymbolQuickPickItem>> {
		return this.getSymbolPicks(filter, undefined, token);
	}

	async getSymbolPicks(filter: string, options: { skipLocal?: boolean, skipSorting?: boolean, delay?: number } | undefined, token: CancellationToken): Promise<Array<ISymbolQuickPickItem>> {
		return this.delayer.trigger(async () => {
			if (token.isCancellationRequested) {
				return [];
			}

			return this.doGetSymbolPicks(prepareQuery(filter), options, token);
		}, options?.delay);
	}

	private async doGetSymbolPicks(query: IPreparedQuery, options: { skipLocal?: boolean, skipSorting?: boolean } | undefined, token: CancellationToken): Promise<Array<ISymbolQuickPickItem>> {
		const workspaceSymbols = await getWorkspaceSymbols(query.original, token);
		if (token.isCancellationRequested) {
			return [];
		}

		const symbolPicks: Array<ISymbolQuickPickItem> = [];

		// Split between symbol and container query
		let symbolQuery: IPreparedQuery;
		let containerQuery: IPreparedQuery | undefined;
		if (query.values && query.values.length > 1) {
			symbolQuery = prepareQuery(query.values[0].original);
			containerQuery = prepareQuery(query.values[1].original);
		} else {
			symbolQuery = query;
		}

		// Convert to symbol picks and apply filtering
		const openSideBySideDirection = this.configuration.openSideBySideDirection;
		const symbolsExcludedByResource = new ResourceMap<boolean>();
		for (const [provider, symbols] of workspaceSymbols) {
			for (const symbol of symbols) {

				// Depending on the workspace symbols filter setting, skip over symbols that:
				// - do not have a container
				// - and are not treated explicitly as global symbols (e.g. classes)
				if (options?.skipLocal && !SymbolsQuickAccessProvider.TREAT_AS_GLOBAL_SYMBOL_TYPES.has(symbol.kind) && !!symbol.containerName) {
					continue;
				}

				// Score by symbol label
				const symbolLabel = symbol.name;
				const symbolScore = fuzzyScore(symbolQuery.original, symbolQuery.originalLowercase, 0, symbolLabel, symbolLabel.toLowerCase(), 0, true);
				if (!symbolScore) {
					continue;
				}

				const symbolUri = symbol.location.uri;
				let containerLabel: string | undefined = undefined;
				if (symbolUri) {
					const containerPath = this.labelService.getUriLabel(symbolUri, { relative: true });
					if (symbol.containerName) {
						containerLabel = `${symbol.containerName} • ${containerPath}`;
					} else {
						containerLabel = containerPath;
					}
				}

				// Score by container if specified
				let containerScore: FuzzyScore | undefined = undefined;
				if (containerQuery) {
					if (containerLabel) {
						containerScore = fuzzyScore(containerQuery.original, containerQuery.originalLowercase, 0, containerLabel, containerLabel.toLowerCase(), 0, true);
					}

					if (!containerScore) {
						continue;
					}
				}

				// Filter out symbols that match the global resource filter
				if (symbolUri) {
					let excludeSymbolByResource = symbolsExcludedByResource.get(symbolUri);
					if (typeof excludeSymbolByResource === 'undefined') {
						excludeSymbolByResource = this.resourceExcludeMatcher.matches(symbolUri);
						symbolsExcludedByResource.set(symbolUri, excludeSymbolByResource);
					}

					if (excludeSymbolByResource) {
						continue;
					}
				}

				const symbolLabelWithIcon = `$(symbol-${SymbolKinds.toString(symbol.kind) || 'property'}) ${symbolLabel}`;
				const deprecated = symbol.tags ? symbol.tags.indexOf(SymbolTag.Deprecated) >= 0 : false;

				symbolPicks.push({
					symbol,
					resource: symbolUri,
					score: symbolScore,
					label: symbolLabelWithIcon,
					ariaLabel: localize('symbolAriaLabel', "{0}, symbols picker", symbolLabel),
					highlights: deprecated ? undefined : {
						label: createMatches(symbolScore, symbolLabelWithIcon.length - symbolLabel.length /* Readjust matches to account for codicons in label */),
						description: createMatches(containerScore)
					},
					description: containerLabel,
					strikethrough: deprecated,
					buttons: [
						{
							iconClass: openSideBySideDirection === 'right' ? 'codicon-split-horizontal' : 'codicon-split-vertical',
							tooltip: openSideBySideDirection === 'right' ? localize('openToSide', "Open to the Side") : localize('openToBottom', "Open to the Bottom")
						}
					],
					trigger: (buttonIndex, keyMods) => {
						this.openSymbol(provider, symbol, token, { keyMods, forceOpenSideBySide: true });

						return TriggerAction.CLOSE_PICKER;
					},
					accept: async (keyMods, event) => this.openSymbol(provider, symbol, token, { keyMods, preserveFocus: event.inBackground }),
				});
			}
		}

		// Sort picks (unless disabled)
		if (!options?.skipSorting) {
			symbolPicks.sort((symbolA, symbolB) => this.compareSymbols(symbolA, symbolB));
		}

		return symbolPicks;
	}

	private async openSymbol(provider: IWorkspaceSymbolProvider, symbol: IWorkspaceSymbol, token: CancellationToken, options: { keyMods: IKeyMods, forceOpenSideBySide?: boolean, preserveFocus?: boolean }): Promise<void> {

		// Resolve actual symbol to open for providers that can resolve
		let symbolToOpen = symbol;
		if (typeof provider.resolveWorkspaceSymbol === 'function' && !symbol.location.range) {
			symbolToOpen = await provider.resolveWorkspaceSymbol(symbol, token) || symbol;

			if (token.isCancellationRequested) {
				return;
			}
		}

		// Open HTTP(s) links with opener service
		if (symbolToOpen.location.uri.scheme === Schemas.http || symbolToOpen.location.uri.scheme === Schemas.https) {
			await this.openerService.open(symbolToOpen.location.uri, { fromUserGesture: true });
		}

		// Otherwise open as editor
		else {
			await this.editorService.openEditor({
				resource: symbolToOpen.location.uri,
				options: {
					preserveFocus: options?.preserveFocus,
					pinned: options.keyMods.alt || this.configuration.openEditorPinned,
					selection: symbolToOpen.location.range ? Range.collapseToStart(symbolToOpen.location.range) : undefined
				}
			}, options.keyMods.ctrlCmd || options?.forceOpenSideBySide ? SIDE_GROUP : ACTIVE_GROUP);
		}
	}

	private compareSymbols(symbolA: ISymbolQuickPickItem, symbolB: ISymbolQuickPickItem): number {

		// By score
		if (symbolA.score && symbolB.score) {
			if (symbolA.score[0] > symbolB.score[0]) {
				return -1;
			} else if (symbolA.score[0] < symbolB.score[0]) {
				return 1;
			}
		}

		// By name
		const symbolAName = symbolA.symbol.name.toLowerCase();
		const symbolBName = symbolB.symbol.name.toLowerCase();
		const res = symbolAName.localeCompare(symbolBName);
		if (res !== 0) {
			return res;
		}

		// By kind
		const symbolAKind = SymbolKinds.toCssClassName(symbolA.symbol.kind);
		const symbolBKind = SymbolKinds.toCssClassName(symbolB.symbol.kind);
		return symbolAKind.localeCompare(symbolBKind);
	}
}
