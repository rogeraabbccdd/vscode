/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EnvironmentService, parseSearchPort } from 'vs/platform/environment/node/environmentService';
import { IWindowConfiguration } from 'vs/platform/windows/common/windows';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { memoize } from 'vs/base/common/decorators';
import { URI } from 'vs/base/common/uri';
import { Schemas } from 'vs/base/common/network';
import { toBackupWorkspaceResource } from 'vs/workbench/services/backup/common/backup';
import { join } from 'vs/base/common/path';
import { IDebugParams } from 'vs/platform/environment/common/environment';
import product from 'vs/platform/product/common/product';

export class NativeWorkbenchEnvironmentService extends EnvironmentService implements IWorkbenchEnvironmentService {

	_serviceBrand: undefined;

	@memoize
	get webviewExternalEndpoint(): string {
		const baseEndpoint = 'https://{{uuid}}.vscode-webview-test.com/{{commit}}';

		return baseEndpoint.replace('{{commit}}', product.commit || 'c58aaab8a1cc22a7139b761166a0d4f37d41e998');
	}

	@memoize
	get webviewResourceRoot(): string { return 'vscode-resource://{{resource}}'; }

	@memoize
	get webviewCspSource(): string { return 'vscode-resource:'; }

	@memoize
	get skipReleaseNotes(): boolean { return !!this.args['skip-release-notes']; }

	@memoize
	get userRoamingDataHome(): URI { return this.appSettingsHome.with({ scheme: Schemas.userData }); }

	@memoize
	get logFile(): URI { return URI.file(join(this.logsPath, `renderer${this.windowId}.log`)); }

	@memoize
	get logExtensionHostCommunication(): boolean { return !!this.args.logExtensionHostCommunication; }

	@memoize
	get debugSearch(): IDebugParams { return parseSearchPort(this.args, this.isBuilt); }

	constructor(
		readonly configuration: IWindowConfiguration,
		execPath: string,
		private readonly windowId: number
	) {
		super(configuration, execPath);

		this.configuration.backupWorkspaceResource = this.configuration.backupPath ? toBackupWorkspaceResource(this.configuration.backupPath, this) : undefined;
	}
}
