/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createApiFactoryAndRegisterActors } from 'vs/workbench/api/common/extHost.api.impl';
import { NodeModuleRequireInterceptor, VSCodeNodeModuleFactory, KeytarNodeModuleFactory, OpenNodeModuleFactory } from 'vs/workbench/api/node/extHostRequireInterceptor';
import { MainContext } from 'vs/workbench/api/common/extHost.protocol';
import { ExtensionActivationTimesBuilder } from 'vs/workbench/api/common/extHostExtensionActivator';
import { connectProxyResolver } from 'vs/workbench/services/extensions/node/proxyResolver';
import { AbstractExtHostExtensionService } from 'vs/workbench/api/common/extHostExtensionService';
import { ExtHostDownloadService } from 'vs/workbench/api/node/extHostDownloadService';
import { CLIServer } from 'vs/workbench/api/node/extHostCLIServer';
import { URI } from 'vs/base/common/uri';
import { Schemas } from 'vs/base/common/network';

export class ExtHostExtensionService extends AbstractExtHostExtensionService {

	protected async _beforeAlmostReadyToRunExtensions(): Promise<void> {
		// initialize API and register actors
		const extensionApiFactory = this._instaService.invokeFunction(createApiFactoryAndRegisterActors);

		// Register Download command
		this._instaService.createInstance(ExtHostDownloadService);

		// Register CLI Server for ipc
		if (this._initData.remote.isRemote && this._initData.remote.authority) {
			const cliServer = this._instaService.createInstance(CLIServer);
			process.env['VSCODE_IPC_HOOK_CLI'] = cliServer.ipcHandlePath;
		}

		// Module loading tricks
		const configProvider = await this._extHostConfiguration.getConfigProvider();
		const extensionPaths = await this.getExtensionPathIndex();
		NodeModuleRequireInterceptor.INSTANCE.register(new VSCodeNodeModuleFactory(extensionApiFactory, extensionPaths, this._registry, configProvider));
		NodeModuleRequireInterceptor.INSTANCE.register(new KeytarNodeModuleFactory(this._extHostContext.getProxy(MainContext.MainThreadKeytar), this._initData.environment));
		if (this._initData.remote.isRemote) {
			NodeModuleRequireInterceptor.INSTANCE.register(new OpenNodeModuleFactory(
				this._extHostContext.getProxy(MainContext.MainThreadWindow),
				this._extHostContext.getProxy(MainContext.MainThreadTelemetry),
				extensionPaths
			));
		}

		// Do this when extension service exists, but extensions are not being activated yet.
		await connectProxyResolver(this._extHostWorkspace, configProvider, this, this._logService, this._mainThreadTelemetryProxy);

		// Use IPC messages to forward console-calls, note that the console is
		// already patched to use`process.send()`
		const nativeProcessSend = process.send!;
		const mainThreadConsole = this._extHostContext.getProxy(MainContext.MainThreadConsole);
		process.send = (...args: any[]) => {
			if (args.length === 0 || !args[0] || args[0].type !== '__$console') {
				return nativeProcessSend.apply(process, args);
			}
			mainThreadConsole.$logExtensionHostMessage(args[0]);
		};
	}

	protected _loadCommonJSModule<T>(module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		if (module.scheme !== Schemas.file) {
			throw new Error(`Cannot load URI: '${module}', must be of file-scheme`);
		}
		let r: T | null = null;
		activationTimesBuilder.codeLoadingStart();
		this._logService.info(`ExtensionService#loadCommonJSModule ${module.toString(true)}`);
		try {
			r = require.__$__nodeRequire<T>(module.fsPath);
		} catch (e) {
			return Promise.reject(e);
		} finally {
			activationTimesBuilder.codeLoadingStop();
		}
		return Promise.resolve(r);
	}

	public async $setRemoteEnvironment(env: { [key: string]: string | null }): Promise<void> {
		if (!this._initData.remote.isRemote) {
			return;
		}

		for (const key in env) {
			const value = env[key];
			if (value === null) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}
