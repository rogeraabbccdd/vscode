/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { CancellationToken } from 'vs/base/common/cancellation';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { assertIsDefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import 'vs/css!./media/searchEditor';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from 'vs/editor/browser/widget/codeEditorWidget';
import type { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { Range } from 'vs/editor/common/core/range';
import { TrackedRangeStickiness } from 'vs/editor/common/model';
import { IModelService } from 'vs/editor/common/services/modelService';
import { localize } from 'vs/nls';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILabelService } from 'vs/platform/label/common/label';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { EditorInput, EditorOptions } from 'vs/workbench/common/editor';
import { ExcludePatternInputWidget, PatternInputWidget } from 'vs/workbench/contrib/search/browser/patternInputWidget';
import { SearchWidget } from 'vs/workbench/contrib/search/browser/searchWidget';
import { ITextQueryBuilderOptions, QueryBuilder } from 'vs/workbench/contrib/search/common/queryBuilder';
import { getOutOfWorkspaceEditorResources } from 'vs/workbench/contrib/search/common/search';
import { SearchModel } from 'vs/workbench/contrib/search/common/searchModel';
import { IPatternInfo, ISearchConfigurationProperties, ITextQuery } from 'vs/workbench/services/search/common/search';
import { Delayer } from 'vs/base/common/async';
import { serializeSearchResultForEditor, SearchConfiguration, SearchEditorInput } from 'vs/workbench/contrib/search/browser/searchEditorCommands';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { InSearchEditor, InputBoxFocusedKey } from 'vs/workbench/contrib/search/common/constants';
import { IEditorProgressService, LongRunningOperation } from 'vs/platform/progress/common/progress';

const RESULT_LINE_REGEX = /^(\s+)(\d+)(:| )(\s+)(.*)$/;

// Using \r\n on Windows inserts an extra newline between results.
const lineDelimiter = '\n';



export class SearchEditor extends BaseEditor {
	static readonly ID: string = 'workbench.editor.searchEditor';

	private queryEditorWidget!: SearchWidget;
	private searchResultEditor!: CodeEditorWidget;
	private queryEditorContainer!: HTMLElement;
	private dimension?: DOM.Dimension;
	private inputPatternIncludes!: PatternInputWidget;
	private inputPatternExcludes!: ExcludePatternInputWidget;
	private includesExcludesContainer!: HTMLElement;
	private toggleQueryDetailsButton!: HTMLElement;

	private runSearchDelayer = new Delayer(300);
	private pauseSearching: boolean = false;
	private showingIncludesExcludes: boolean = false;
	private inSearchEditorContextKey: IContextKey<boolean>;
	private inputFocusContextKey: IContextKey<boolean>;
	private searchOperation: LongRunningOperation;
	private searchHistoryDelayer: Delayer<void>;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IContextKeyService readonly contextKeyService: IContextKeyService,
		@IEditorProgressService readonly progressService: IEditorProgressService,
	) {
		super(SearchEditor.ID, telemetryService, themeService, storageService);
		this.inSearchEditorContextKey = InSearchEditor.bindTo(contextKeyService);
		this.inputFocusContextKey = InputBoxFocusedKey.bindTo(contextKeyService);
		this.searchOperation = this._register(new LongRunningOperation(progressService));
		this.searchHistoryDelayer = new Delayer<void>(2000);
	}

	createEditor(parent: HTMLElement) {
		DOM.addClass(parent, 'search-editor');

		// Query
		this.queryEditorContainer = DOM.append(parent, DOM.$('.query-container'));

		this.queryEditorWidget = this._register(this.instantiationService.createInstance(SearchWidget, this.queryEditorContainer, { _hideReplaceToggle: true, showContextToggle: true }));
		this._register(this.queryEditorWidget.onReplaceToggled(() => this.reLayout()));
		this._register(this.queryEditorWidget.onDidHeightChange(() => this.reLayout()));
		this.queryEditorWidget.onSearchSubmit(() => this.runSearch(true)); // onSearchSubmit has an internal delayer, so skip over ours.
		this.queryEditorWidget.searchInput.onDidOptionChange(() => this.runSearch());
		this.queryEditorWidget.onDidToggleContext(() => this.runSearch());

		// Includes/Excludes Dropdown
		this.includesExcludesContainer = DOM.append(this.queryEditorContainer, DOM.$('.includes-excludes'));
		// // Toggle query details button
		this.toggleQueryDetailsButton = DOM.append(this.includesExcludesContainer, DOM.$('.expand.codicon.codicon-ellipsis', { tabindex: 0, role: 'button', title: localize('moreSearch', "Toggle Search Details") }));
		this._register(DOM.addDisposableListener(this.toggleQueryDetailsButton, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e);
			this.toggleIncludesExcludes();
		}));
		this._register(DOM.addDisposableListener(this.toggleQueryDetailsButton, DOM.EventType.KEY_UP, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);

			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				DOM.EventHelper.stop(e);
				this.toggleIncludesExcludes();
			}
		}));
		this._register(DOM.addDisposableListener(this.toggleQueryDetailsButton, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);

			if (event.equals(KeyMod.Shift | KeyCode.Tab)) {
				if (this.queryEditorWidget.isReplaceActive()) {
					this.queryEditorWidget.focusReplaceAllAction();
				} else {
					this.queryEditorWidget.isReplaceShown() ? this.queryEditorWidget.replaceInput.focusOnPreserve() : this.queryEditorWidget.focusRegexAction();
				}
				DOM.EventHelper.stop(e);
			}
		}));

		// // Includes

		const folderIncludesList = DOM.append(this.includesExcludesContainer, DOM.$('.file-types.includes'));
		const filesToIncludeTitle = localize('searchScope.includes', "files to include");
		DOM.append(folderIncludesList, DOM.$('h4', undefined, filesToIncludeTitle));

		this.inputPatternIncludes = this._register(this.instantiationService.createInstance(PatternInputWidget, folderIncludesList, this.contextViewService, {
			ariaLabel: localize('label.includes', 'Search Include Patterns'),
		}));
		this.inputPatternIncludes.onSubmit(_triggeredOnType => this.runSearch());

		// // Excludes
		const excludesList = DOM.append(this.includesExcludesContainer, DOM.$('.file-types.excludes'));
		const excludesTitle = localize('searchScope.excludes', "files to exclude");
		DOM.append(excludesList, DOM.$('h4', undefined, excludesTitle));

		this.inputPatternExcludes = this._register(this.instantiationService.createInstance(ExcludePatternInputWidget, excludesList, this.contextViewService, {
			ariaLabel: localize('label.excludes', 'Search Exclude Patterns'),
		}));

		this.inputPatternExcludes.onSubmit(_triggeredOnType => this.runSearch());
		this.inputPatternExcludes.onChangeIgnoreBox(() => this.runSearch());

		// Editor
		const searchResultContainer = DOM.append(parent, DOM.$('.search-results'));
		const configuration: IEditorOptions = this.configurationService.getValue('editor', { overrideIdentifier: 'search-result' });
		const options: ICodeEditorWidgetOptions = {};
		this.searchResultEditor = this._register(this.instantiationService.createInstance(CodeEditorWidget, searchResultContainer, configuration, options));
		this.searchResultEditor.onMouseUp(e => {

			if (e.event.detail === 2) {
				const behaviour = this.configurationService.getValue<ISearchConfigurationProperties>('search').searchEditorPreview.doubleClickBehaviour;
				const position = e.target.position;
				if (position && behaviour !== 'selectWord') {
					const line = this.searchResultEditor.getModel()?.getLineContent(position.lineNumber) ?? '';
					if (line.match(RESULT_LINE_REGEX)) {
						this.searchResultEditor.setSelection(Range.fromPositions(position));
						this.commandService.executeCommand(behaviour === 'goToLocation' ? 'editor.action.goToDeclaration' : 'editor.action.openDeclarationToTheSide');
					}
				}
			}
		});

		this._register(this.searchResultEditor.onKeyDown(e => e.keyCode === KeyCode.Escape && this.queryEditorWidget.searchInput.focus()));

		this._register(this.searchResultEditor.onDidChangeModel(() => this.hideHeader()));
		this._register(this.searchResultEditor.onDidChangeModelContent(() => (this._input as SearchEditorInput)?.setDirty(true)));

		[this.queryEditorWidget.searchInputFocusTracker, this.queryEditorWidget.replaceInputFocusTracker, this.inputPatternExcludes.inputFocusTracker, this.inputPatternIncludes.inputFocusTracker]
			.map(tracker => {
				this._register(tracker.onDidFocus(() => setTimeout(() => this.inputFocusContextKey.set(true), 0)));
				this._register(tracker.onDidBlur(() => this.inputFocusContextKey.set(false)));
			});
	}

	focusNextInput() {
		if (this.queryEditorWidget.searchInputHasFocus()) {
			if (this.showingIncludesExcludes) {
				this.inputPatternIncludes.focus();
			} else {
				this.searchResultEditor.focus();
			}
		} else if (this.inputPatternIncludes.inputHasFocus()) {
			this.inputPatternExcludes.focus();
		} else if (this.inputPatternExcludes.inputHasFocus()) {
			this.searchResultEditor.focus();
		} else if (this.searchResultEditor.hasWidgetFocus()) {
			// pass
		}
	}

	focusPrevInput() {
		if (this.queryEditorWidget.searchInputHasFocus()) {
			this.searchResultEditor.focus(); // wrap
		} else if (this.inputPatternIncludes.inputHasFocus()) {
			this.queryEditorWidget.searchInput.focus();
		} else if (this.inputPatternExcludes.inputHasFocus()) {
			this.inputPatternIncludes.focus();
		} else if (this.searchResultEditor.hasWidgetFocus()) {
			// ureachable.
		}
	}

	toggleWholeWords() {
		this.queryEditorWidget.searchInput.setWholeWords(!this.queryEditorWidget.searchInput.getWholeWords());
		this.runSearch();
	}

	toggleRegex() {
		this.queryEditorWidget.searchInput.setRegex(!this.queryEditorWidget.searchInput.getRegex());
		this.runSearch();
	}

	toggleCaseSensitive() {
		this.queryEditorWidget.searchInput.setCaseSensitive(!this.queryEditorWidget.searchInput.getCaseSensitive());
		this.runSearch();
	}

	toggleContextLines() {
		this.queryEditorWidget.toggleContextLines();
	}

	private async runSearch(instant = false) {
		if (!this.pauseSearching) {
			this.runSearchDelayer.trigger(() => this.doRunSearch(), instant ? 0 : undefined);
		}
	}

	private async doRunSearch() {
		const startInput = this.input;

		this.searchHistoryDelayer.trigger(() => {
			this.queryEditorWidget.searchInput.onSearchSubmit();
			this.inputPatternExcludes.onSearchSubmit();
			this.inputPatternIncludes.onSearchSubmit();
		});

		const config: SearchConfiguration = {
			caseSensitive: this.queryEditorWidget.searchInput.getCaseSensitive(),
			contextLines: this.queryEditorWidget.contextLines(),
			excludes: this.inputPatternExcludes.getValue(),
			includes: this.inputPatternIncludes.getValue(),
			query: this.queryEditorWidget.searchInput.getValue(),
			regexp: this.queryEditorWidget.searchInput.getRegex(),
			wholeWord: this.queryEditorWidget.searchInput.getWholeWords(),
			useIgnores: this.inputPatternExcludes.useExcludesAndIgnoreFiles(),
			showIncludesExcludes: this.showingIncludesExcludes
		};

		if (!config.query) { return; }

		const content: IPatternInfo = {
			pattern: config.query,
			isRegExp: config.regexp,
			isCaseSensitive: config.caseSensitive,
			isWordMatch: config.wholeWord,
		};

		const options: ITextQueryBuilderOptions = {
			_reason: 'searchEditor',
			extraFileResources: this.instantiationService.invokeFunction(getOutOfWorkspaceEditorResources),
			maxResults: 10000,
			disregardIgnoreFiles: !config.useIgnores,
			disregardExcludeSettings: !config.useIgnores,
			excludePattern: config.excludes,
			includePattern: config.includes,
			previewOptions: {
				matchLines: 1,
				charsPerLine: 1000
			},
			afterContext: config.contextLines,
			beforeContext: config.contextLines,
			isSmartCase: this.configurationService.getValue<ISearchConfigurationProperties>('search').smartCase,
			expandPatterns: true
		};

		const folderResources = this.contextService.getWorkspace().folders;
		let query: ITextQuery;
		try {
			const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
			query = queryBuilder.text(content, folderResources.map(folder => folder.uri), options);
		}
		catch (err) {
			return;
		}
		const searchModel = this.instantiationService.createInstance(SearchModel);
		this.searchOperation.start(500);
		await searchModel.search(query).finally(() => this.searchOperation.stop());
		if (this.input !== startInput) {
			searchModel.dispose();
			return;
		}

		(assertIsDefined(this._input) as SearchEditorInput).setConfig(config);

		const labelFormatter = (uri: URI): string => this.labelService.getUriLabel(uri, { relative: true });
		const results = serializeSearchResultForEditor(searchModel.searchResult, config.includes, config.excludes, config.contextLines, labelFormatter, true);
		const textModel = assertIsDefined(this.searchResultEditor.getModel());
		this.modelService.updateModel(textModel, results.text.join(lineDelimiter));
		this.getInput()?.setDirty(this.getInput()?.resource.scheme !== 'search-editor');
		this.hideHeader();
		textModel.deltaDecorations([], results.matchRanges.map(range => ({ range, options: { className: 'searchEditorFindMatch', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } })));

		searchModel.dispose();
	}

	private hideHeader() {
		const headerLines =
			this.searchResultEditor
				.getModel()
				?.getValueInRange(new Range(1, 1, 6, 1))
				.split('\n')
				.filter(line => line.startsWith('#'))
				.length
			?? 0;

		this.searchResultEditor.setHiddenAreas([new Range(1, 1, headerLines + 1, 1)]);
	}

	layout(dimension: DOM.Dimension) {
		this.dimension = dimension;
		this.reLayout();
	}

	focusInput() {
		this.queryEditorWidget.focus();
	}

	private reLayout() {
		if (this.dimension) {
			this.queryEditorWidget.setWidth(this.dimension.width - 28 /* container margin */);
			this.searchResultEditor.layout({ height: this.dimension.height - DOM.getTotalHeight(this.queryEditorContainer), width: this.dimension.width });
			this.inputPatternExcludes.setWidth(this.dimension.width - 28 /* container margin */);
			this.inputPatternIncludes.setWidth(this.dimension.width - 28 /* container margin */);
		}
	}

	private getInput(): SearchEditorInput | undefined {
		return this._input as SearchEditorInput;
	}

	async setInput(newInput: EditorInput, options: EditorOptions | undefined, token: CancellationToken): Promise<void> {
		await super.setInput(newInput, options, token);
		this.inSearchEditorContextKey.set(true);

		if (!(newInput instanceof SearchEditorInput)) { return; }
		this.pauseSearching = true;
		const model = this.modelService.getModel(newInput.resource);
		if (newInput.resource.scheme !== 'search-editor') {
			if (model?.getValue() === '') {
				model.setValue((await this.textFileService.read(newInput.resource)).value);
			}
		}
		this.searchResultEditor.setModel(model);
		this.queryEditorWidget.setValue(newInput.config.query, true);
		this.queryEditorWidget.searchInput.setCaseSensitive(newInput.config.caseSensitive);
		this.queryEditorWidget.searchInput.setRegex(newInput.config.regexp);
		this.queryEditorWidget.searchInput.setWholeWords(newInput.config.wholeWord);
		this.queryEditorWidget.setContextLines(newInput.config.contextLines);
		this.inputPatternExcludes.setValue(newInput.config.excludes);
		this.inputPatternIncludes.setValue(newInput.config.includes);
		this.inputPatternExcludes.setUseExcludesAndIgnoreFiles(newInput.config.useIgnores);
		this.toggleIncludesExcludes(newInput.config.showIncludesExcludes);

		this.focusInput();
		this.pauseSearching = false;
	}

	private toggleIncludesExcludes(_shouldShow?: boolean): void {
		const cls = 'expanded';
		const shouldShow = _shouldShow ?? !DOM.hasClass(this.includesExcludesContainer, cls);

		if (shouldShow) {
			this.toggleQueryDetailsButton.setAttribute('aria-expanded', 'true');
			DOM.addClass(this.includesExcludesContainer, cls);
		} else {
			this.toggleQueryDetailsButton.setAttribute('aria-expanded', 'false');
			DOM.removeClass(this.includesExcludesContainer, cls);
		}

		this.showingIncludesExcludes = DOM.hasClass(this.includesExcludesContainer, cls);

		this.reLayout();
	}

	getModel() {
		return this.searchResultEditor.getModel();
	}

	clearInput() {
		super.clearInput();
		this.inSearchEditorContextKey.set(false);
	}
}
