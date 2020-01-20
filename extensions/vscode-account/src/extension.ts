/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzureActiveDirectoryService, onDidChangeSessions } from './AADHelper';

export async function activate(context: vscode.ExtensionContext) {

	const loginService = new AzureActiveDirectoryService();

	await loginService.initialize();

	vscode.authentication.registerAuthenticationProvider({
		id: 'MSA',
		displayName: 'Microsoft Account', // TODO localize
		onDidChangeSessions: onDidChangeSessions.event,
		getSessions: () => Promise.resolve(loginService.sessions),
		login: async () => {
			try {
				await loginService.login();
				return loginService.sessions[0]!;
			} catch (e) {
				vscode.window.showErrorMessage(`Logging in failed: ${e}`);
				throw e;
			}
		},
		logout: async (id: string) => {
			return loginService.logout();
		}
	});

	return;
}

// this method is called when your extension is deactivated
export function deactivate() { }
