/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable } from 'vs/base/common/lifecycle';

export const IOpenerService = createDecorator<IOpenerService>('openerService');

export interface IOpener {
	open(resource: URI, options?: { openToSide?: boolean }): Promise<boolean>;
	open(resource: URI, options?: { openExternal?: boolean }): Promise<boolean>;
}

export interface IValidator {
	shouldOpen(resource: URI): Promise<boolean>;
}

export interface IOpenerService {

	_serviceBrand: undefined;

	/**
	 * Register a participant that can handle the open() call.
	 */
	registerOpener(opener: IOpener): IDisposable;

	/**
	 * Register a participant that can validate if the URI resource be opened.
	 * validators are run before openers.
	 */
	registerValidator(validator: IValidator): IDisposable;

	/**
	 * Opens a resource, like a webaddress, a document uri, or executes command.
	 *
	 * @param resource A resource
	 * @return A promise that resolves when the opening is done.
	 */
	open(resource: URI, options?: { openToSide?: boolean }): Promise<boolean>;
	open(resource: URI, options?: { openExternal?: boolean }): Promise<boolean>;
}

export const NullOpenerService: IOpenerService = Object.freeze({
	_serviceBrand: undefined,
	registerOpener() { return { dispose() { } }; },
	registerValidator() { return { dispose() { } }; },
	open() { return Promise.resolve(false); },
});
