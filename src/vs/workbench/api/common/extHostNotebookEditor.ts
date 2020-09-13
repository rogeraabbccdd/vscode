/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readonly } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { CellKind, MainThreadNotebookShape } from 'vs/workbench/api/common/extHost.protocol';
import * as extHostTypes from 'vs/workbench/api/common/extHostTypes';
import { addIdToOutput, CellEditType, ICellEditOperation, ICellReplaceEdit, INotebookEditData, notebookDocumentMetadataDefaults } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import * as vscode from 'vscode';
import { ExtHostNotebookDocument } from './extHostNotebookDocument';

class NotebookEditorCellEditBuilder implements vscode.NotebookEditorEdit {

	private readonly _documentVersionId: number;

	private _finalized: boolean = false;
	private _collectedEdits: ICellEditOperation[] = [];

	constructor(documentVersionId: number) {
		this._documentVersionId = documentVersionId;
	}

	finalize(): INotebookEditData {
		this._finalized = true;
		return {
			documentVersionId: this._documentVersionId,
			cellEdits: this._collectedEdits
		};
	}

	private _throwIfFinalized() {
		if (this._finalized) {
			throw new Error('Edit is only valid while callback runs');
		}
	}

	replaceNotebookMetadata(value: vscode.NotebookDocumentMetadata): void {
		this._throwIfFinalized();
		this._collectedEdits.push({
			editType: CellEditType.DocumentMetadata,
			metadata: { ...notebookDocumentMetadataDefaults, ...value }
		});
	}

	replaceCellMetadata(index: number, metadata: vscode.NotebookCellMetadata): void {
		this._throwIfFinalized();
		this._collectedEdits.push({
			editType: CellEditType.Metadata,
			index,
			metadata
		});
	}

	replaceMetadata(index: number, metadata: vscode.NotebookCellMetadata): void {
		console.warn('DEPRECATED use "replaceCellMetadata" instead');
		this.replaceCellMetadata(index, metadata);
	}


	replaceCellOutput(index: number, outputs: vscode.CellOutput[]): void {
		this._throwIfFinalized();
		this._collectedEdits.push({
			editType: CellEditType.Output,
			index,
			outputs: outputs.map(output => addIdToOutput(output))
		});
	}

	replaceOutput(index: number, outputs: vscode.CellOutput[]): void {
		console.warn('DEPRECATED use "replaceCellOutput" instead');
		this.replaceCellOutput(index, outputs);
	}

	replaceCells(from: number, to: number, cells: vscode.NotebookCellData[]): void {
		this._throwIfFinalized();

		this._collectedEdits.push({
			editType: CellEditType.Replace,
			index: from,
			count: to - from,
			cells: cells.map(data => {
				return {
					...data,
					outputs: data.outputs.map(output => addIdToOutput(output)),
				};
			})
		});
	}

	insert(index: number, content: string | string[], language: string, type: CellKind, outputs: vscode.CellOutput[], metadata: vscode.NotebookCellMetadata | undefined): void {
		this._throwIfFinalized();
		this.replaceCells(index, index, [{
			language,
			outputs,
			metadata,
			cellKind: type,
			source: Array.isArray(content) ? content.join('\n') : content,
		}]);
	}

	delete(index: number): void {
		this._throwIfFinalized();
		this.replaceCells(index, 1, []);
	}
}

export class ExtHostNotebookEditor extends Disposable implements vscode.NotebookEditor {

	//TODO@rebornix noop setter?
	selection?: vscode.NotebookCell;

	private _visibleRanges: vscode.NotebookCellRange[] = [];
	private _viewColumn?: vscode.ViewColumn;
	private _active: boolean = false;
	private _visible: boolean = false;
	private _kernel?: vscode.NotebookKernel;

	private _onDidDispose = new Emitter<void>();
	private _onDidReceiveMessage = new Emitter<any>();

	readonly onDidDispose: Event<void> = this._onDidDispose.event;
	readonly onDidReceiveMessage: vscode.Event<any> = this._onDidReceiveMessage.event;

	constructor(
		readonly id: string,
		private readonly _viewType: string,
		private readonly _proxy: MainThreadNotebookShape,
		private readonly _webComm: vscode.NotebookCommunication,
		readonly notebookData: ExtHostNotebookDocument,
	) {
		super();
		this._register(this._webComm.onDidReceiveMessage(e => {
			this._onDidReceiveMessage.fire(e);
		}));
	}

	get viewColumn(): vscode.ViewColumn | undefined {
		return this._viewColumn;
	}

	set viewColumn(_value) {
		throw readonly('viewColumn');
	}

	get kernel() {
		return this._kernel;
	}

	set kernel(_kernel: vscode.NotebookKernel | undefined) {
		throw readonly('kernel');
	}

	_acceptKernel(kernel?: vscode.NotebookKernel) {
		this._kernel = kernel;
	}

	get visible(): boolean {
		return this._visible;
	}

	set visible(_state: boolean) {
		throw readonly('visible');
	}

	_acceptVisibility(value: boolean) {
		this._visible = value;
	}

	get visibleRanges() {
		return this._visibleRanges;
	}

	set visibleRanges(_range: vscode.NotebookCellRange[]) {
		throw readonly('visibleRanges');
	}

	_acceptVisibleRanges(value: vscode.NotebookCellRange[]): void {
		this._visibleRanges = value;
	}

	get active(): boolean {
		return this._active;
	}

	set active(_state: boolean) {
		throw readonly('active');
	}

	_acceptActive(value: boolean) {
		this._active = value;
	}

	get document(): vscode.NotebookDocument {
		return this.notebookData.notebookDocument;
	}

	edit(callback: (editBuilder: NotebookEditorCellEditBuilder) => void): Thenable<boolean> {
		const edit = new NotebookEditorCellEditBuilder(this.document.version);
		callback(edit);
		return this._applyEdit(edit.finalize());
	}

	private _applyEdit(editData: INotebookEditData): Promise<boolean> {

		// return when there is nothing to do
		if (editData.cellEdits.length === 0) {
			return Promise.resolve(true);
		}

		const compressedEdits: ICellEditOperation[] = [];
		let compressedEditsIndex = -1;

		for (let i = 0; i < editData.cellEdits.length; i++) {
			if (compressedEditsIndex < 0) {
				compressedEdits.push(editData.cellEdits[i]);
				compressedEditsIndex++;
				continue;
			}

			const prevIndex = compressedEditsIndex;
			const prev = compressedEdits[prevIndex];

			if (prev.editType === CellEditType.Replace && editData.cellEdits[i].editType === CellEditType.Replace) {
				const edit = editData.cellEdits[i];
				if ((edit.editType !== CellEditType.DocumentMetadata && edit.editType !== CellEditType.Unknown) && prev.index === edit.index) {
					prev.cells.push(...(editData.cellEdits[i] as ICellReplaceEdit).cells);
					prev.count += (editData.cellEdits[i] as ICellReplaceEdit).count;
					continue;
				}
			}

			compressedEdits.push(editData.cellEdits[i]);
			compressedEditsIndex++;
		}

		return this._proxy.$tryApplyEdits(this._viewType, this.document.uri, editData.documentVersionId, compressedEdits);
	}

	revealRange(range: vscode.NotebookCellRange, revealType?: extHostTypes.NotebookEditorRevealType) {
		this._proxy.$tryRevealRange(this.id, range, revealType || extHostTypes.NotebookEditorRevealType.Default);
	}

	async postMessage(message: any): Promise<boolean> {
		return this._webComm.postMessage(message);
	}

	asWebviewUri(localResource: vscode.Uri): vscode.Uri {
		return this._webComm.asWebviewUri(localResource);
	}

	dispose() {
		this._onDidDispose.fire();
		super.dispose();
	}
}
