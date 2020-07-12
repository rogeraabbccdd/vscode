/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/processExplorer';
import { clipboard } from 'electron';
import { totalmem } from 'os';
import { ipcRenderer } from 'vs/base/parts/sandbox/electron-sandbox/globals';
import product from 'vs/platform/product/common/product';
import { localize } from 'vs/nls';
import { ProcessExplorerStyles, ProcessExplorerData } from 'vs/platform/issue/common/issue';
import { applyZoom, zoomIn, zoomOut } from 'vs/platform/windows/electron-sandbox/window';
import * as platform from 'vs/base/common/platform';
import { IContextMenuItem } from 'vs/base/parts/contextmenu/common/contextmenu';
import { popup } from 'vs/base/parts/contextmenu/electron-sandbox/contextmenu';
import { ProcessItem } from 'vs/base/common/processes';
import { addDisposableListener, addClass } from 'vs/base/browser/dom';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { isRemoteDiagnosticError, IRemoteDiagnosticError } from 'vs/platform/diagnostics/common/diagnostics';

const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk|port)?=(\d+)?/;
const DEBUG_PORT_PATTERN = /\s--(inspect|debug)-port=(\d+)/;

interface FormattedProcessItem {
	cpu: number;
	memory: number;
	pid: string;
	name: string;
	formattedName: string;
	cmd: string;
}

class ProcessExplorer {
	private lastRequestTime: number;

	private collapsedStateCache: Map<string, boolean> = new Map<string, boolean>();

	private mapPidToWindowTitle = new Map<number, string>();

	private listeners = new DisposableStore();

	constructor(data: ProcessExplorerData) {
		this.applyStyles(data.styles);

		// Map window process pids to titles, annotate process names with this when rendering to distinguish between them
		ipcRenderer.on('vscode:windowsInfoResponse', (event: unknown, windows: any[]) => {
			this.mapPidToWindowTitle = new Map<number, string>();
			windows.forEach(window => this.mapPidToWindowTitle.set(window.pid, window.title));
		});

		ipcRenderer.on('vscode:listProcessesResponse', (event: unknown, processRoots: [{ name: string, rootProcess: ProcessItem | IRemoteDiagnosticError }]) => {
			this.updateProcessInfo(processRoots);
			this.requestProcessList(0);
		});

		this.lastRequestTime = Date.now();
		ipcRenderer.send('vscode:windowsInfoRequest');
		ipcRenderer.send('vscode:listProcesses');
	}

	private getProcessList(rootProcess: ProcessItem, isLocal: boolean): FormattedProcessItem[] {
		const processes: FormattedProcessItem[] = [];

		if (rootProcess) {
			this.getProcessItem(processes, rootProcess, 0, isLocal);
		}

		return processes;
	}

	private getProcessItem(processes: FormattedProcessItem[], item: ProcessItem, indent: number, isLocal: boolean): void {
		const isRoot = (indent === 0);

		const MB = 1024 * 1024;

		let name = item.name;
		if (isRoot) {
			name = isLocal ? `${product.applicationName} main` : 'remote agent';
		}

		if (name === 'window') {
			const windowTitle = this.mapPidToWindowTitle.get(item.pid);
			name = windowTitle !== undefined ? `${name} (${this.mapPidToWindowTitle.get(item.pid)})` : name;
		}

		// Format name with indent
		const formattedName = isRoot ? name : `${'    '.repeat(indent)} ${name}`;
		const memory = process.platform === 'win32' ? item.mem : (totalmem() * (item.mem / 100));
		processes.push({
			cpu: item.load,
			memory: (memory / MB),
			pid: item.pid.toFixed(0),
			name,
			formattedName,
			cmd: item.cmd
		});

		// Recurse into children if any
		if (Array.isArray(item.children)) {
			item.children.forEach(child => {
				if (child) {
					this.getProcessItem(processes, child, indent + 1, isLocal);
				}
			});
		}
	}

	private isDebuggable(cmd: string): boolean {
		const matches = DEBUG_FLAGS_PATTERN.exec(cmd);
		return (matches && matches.length >= 2) || cmd.indexOf('node ') >= 0 || cmd.indexOf('node.exe') >= 0;
	}

	private attachTo(item: FormattedProcessItem) {
		const config: any = {
			type: 'node',
			request: 'attach',
			name: `process ${item.pid}`
		};

		let matches = DEBUG_FLAGS_PATTERN.exec(item.cmd);
		if (matches && matches.length >= 2) {
			// attach via port
			if (matches.length === 4 && matches[3]) {
				config.port = parseInt(matches[3]);
			}
			config.protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
		} else {
			// no port -> try to attach via pid (send SIGUSR1)
			config.processId = String(item.pid);
		}

		// a debug-port=n or inspect-port=n overrides the port
		matches = DEBUG_PORT_PATTERN.exec(item.cmd);
		if (matches && matches.length === 3) {
			// override port
			config.port = parseInt(matches[2]);
		}

		ipcRenderer.send('vscode:workbenchCommand', { id: 'debug.startFromConfig', from: 'processExplorer', args: [config] });
	}

	private getProcessIdWithHighestProperty(processList: any[], propertyName: string) {
		let max = 0;
		let maxProcessId;
		processList.forEach(process => {
			if (process[propertyName] > max) {
				max = process[propertyName];
				maxProcessId = process.pid;
			}
		});

		return maxProcessId;
	}

	private updateSectionCollapsedState(shouldExpand: boolean, body: HTMLElement, twistie: HTMLImageElement, sectionName: string) {
		if (shouldExpand) {
			body.classList.remove('hidden');
			this.collapsedStateCache.set(sectionName, false);
			twistie.src = './media/expanded.svg';
		} else {
			body.classList.add('hidden');
			this.collapsedStateCache.set(sectionName, true);
			twistie.src = './media/collapsed.svg';
		}
	}

	private renderProcessFetchError(sectionName: string, errorMessage: string) {
		const container = document.getElementById('process-list');
		if (!container) {
			return;
		}

		const body = document.createElement('tbody');

		this.renderProcessGroupHeader(sectionName, body, container);

		const errorRow = document.createElement('tr');
		const data = document.createElement('td');
		data.textContent = errorMessage;
		data.className = 'error';
		data.colSpan = 4;
		errorRow.appendChild(data);

		body.appendChild(errorRow);
		container.appendChild(body);
	}

	private renderProcessGroupHeader(sectionName: string, body: HTMLElement, container: HTMLElement) {
		const headerRow = document.createElement('tr');
		const data = document.createElement('td');
		data.textContent = sectionName;
		data.colSpan = 4;
		headerRow.appendChild(data);

		const twistie = document.createElement('img');
		this.updateSectionCollapsedState(!this.collapsedStateCache.get(sectionName), body, twistie, sectionName);
		data.prepend(twistie);

		this.listeners.add(addDisposableListener(data, 'click', (e) => {
			const isHidden = body.classList.contains('hidden');
			this.updateSectionCollapsedState(isHidden, body, twistie, sectionName);
		}));

		container.appendChild(headerRow);
	}

	private renderTableSection(sectionName: string, processList: FormattedProcessItem[], renderManySections: boolean, sectionIsLocal: boolean): void {
		const container = document.getElementById('process-list');
		if (!container) {
			return;
		}

		const highestCPUProcess = this.getProcessIdWithHighestProperty(processList, 'cpu');
		const highestMemoryProcess = this.getProcessIdWithHighestProperty(processList, 'memory');

		const body = document.createElement('tbody');

		if (renderManySections) {
			this.renderProcessGroupHeader(sectionName, body, container);
		}

		processList.forEach(p => {
			const row = document.createElement('tr');
			row.id = p.pid.toString();

			const cpu = document.createElement('td');
			p.pid === highestCPUProcess
				? cpu.classList.add('centered', 'highest')
				: cpu.classList.add('centered');
			cpu.textContent = p.cpu.toFixed(0);

			const memory = document.createElement('td');
			p.pid === highestMemoryProcess
				? memory.classList.add('centered', 'highest')
				: memory.classList.add('centered');
			memory.textContent = p.memory.toFixed(0);

			const pid = document.createElement('td');
			pid.classList.add('centered');
			pid.textContent = p.pid;

			const name = document.createElement('th');
			name.scope = 'row';
			name.classList.add('data');
			name.title = p.cmd;
			name.textContent = p.formattedName;

			row.append(cpu, memory, pid, name);

			this.listeners.add(addDisposableListener(row, 'contextmenu', (e) => {
				this.showContextMenu(e, p, sectionIsLocal);
			}));

			body.appendChild(row);
		});

		container.appendChild(body);
	}

	private updateProcessInfo(processLists: [{ name: string, rootProcess: ProcessItem | IRemoteDiagnosticError }]): void {
		const container = document.getElementById('process-list');
		if (!container) {
			return;
		}

		container.innerHTML = '';
		this.listeners.clear();

		const tableHead = document.createElement('thead');
		tableHead.innerHTML = `<tr>
			<th scope="col" class="cpu">${localize('cpu', "CPU %")}</th>
			<th scope="col" class="memory">${localize('memory', "Memory (MB)")}</th>
			<th scope="col" class="pid">${localize('pid', "pid")}</th>
			<th scope="col" class="nameLabel">${localize('name', "Name")}</th>
		</tr>`;

		container.append(tableHead);

		const hasMultipleMachines = Object.keys(processLists).length > 1;
		processLists.forEach((remote, i) => {
			const isLocal = i === 0;
			if (isRemoteDiagnosticError(remote.rootProcess)) {
				this.renderProcessFetchError(remote.name, remote.rootProcess.errorMessage);
			} else {
				this.renderTableSection(remote.name, this.getProcessList(remote.rootProcess, isLocal), hasMultipleMachines, isLocal);
			}
		});
	}

	private applyStyles(styles: ProcessExplorerStyles): void {
		const styleTag = document.createElement('style');
		const content: string[] = [];

		if (styles.hoverBackground) {
			content.push(`tbody > tr:hover, table > tr:hover  { background-color: ${styles.hoverBackground}; }`);
		}

		if (styles.hoverForeground) {
			content.push(`tbody > tr:hover, table > tr:hover { color: ${styles.hoverForeground}; }`);
		}

		if (styles.highlightForeground) {
			content.push(`.highest { color: ${styles.highlightForeground}; }`);
		}

		styleTag.innerHTML = content.join('\n');
		if (document.head) {
			document.head.appendChild(styleTag);
		}
		if (styles.color) {
			document.body.style.color = styles.color;
		}
	}

	private showContextMenu(e: MouseEvent, item: FormattedProcessItem, isLocal: boolean) {
		e.preventDefault();

		const items: IContextMenuItem[] = [];
		const pid = Number(item.pid);

		if (isLocal) {
			items.push({
				label: localize('killProcess', "Kill Process"),
				click() {
					process.kill(pid, 'SIGTERM');
				}
			});

			items.push({
				label: localize('forceKillProcess', "Force Kill Process"),
				click() {
					process.kill(pid, 'SIGKILL');
				}
			});

			items.push({
				type: 'separator'
			});
		}

		items.push({
			label: localize('copy', "Copy"),
			click() {
				const row = document.getElementById(pid.toString());
				if (row) {
					clipboard.writeText(row.innerText);
				}
			}
		});

		items.push({
			label: localize('copyAll', "Copy All"),
			click() {
				const processList = document.getElementById('process-list');
				if (processList) {
					clipboard.writeText(processList.innerText);
				}
			}
		});

		if (item && isLocal && this.isDebuggable(item.cmd)) {
			items.push({
				type: 'separator'
			});

			items.push({
				label: localize('debug', "Debug"),
				click: () => {
					this.attachTo(item);
				}
			});
		}

		popup(items);
	}

	private requestProcessList(totalWaitTime: number): void {
		setTimeout(() => {
			const nextRequestTime = Date.now();
			const waited = totalWaitTime + nextRequestTime - this.lastRequestTime;
			this.lastRequestTime = nextRequestTime;

			// Wait at least a second between requests.
			if (waited > 1000) {
				ipcRenderer.send('vscode:windowsInfoRequest');
				ipcRenderer.send('vscode:listProcesses');
			} else {
				this.requestProcessList(waited);
			}
		}, 200);
	}

	public dispose() {
		this.listeners.dispose();
	}
}



export function startup(data: ProcessExplorerData): void {
	const platformClass = platform.isWindows ? 'windows' : platform.isLinux ? 'linux' : 'mac';
	addClass(document.body, platformClass); // used by our fonts
	applyZoom(data.zoomLevel);

	const processExplorer = new ProcessExplorer(data);

	document.onkeydown = (e: KeyboardEvent) => {
		const cmdOrCtrlKey = platform.isMacintosh ? e.metaKey : e.ctrlKey;

		// Cmd/Ctrl + zooms in
		if (cmdOrCtrlKey && e.keyCode === 187) {
			zoomIn();
		}

		// Cmd/Ctrl - zooms out
		if (cmdOrCtrlKey && e.keyCode === 189) {
			zoomOut();
		}
	};

	// Cmd/Ctrl + w closes process explorer
	window.addEventListener('keydown', e => {
		const cmdOrCtrlKey = platform.isMacintosh ? e.metaKey : e.ctrlKey;
		if (cmdOrCtrlKey && e.keyCode === 87) {
			processExplorer.dispose();
			ipcRenderer.send('vscode:closeProcessExplorer');
		}
	});
}
