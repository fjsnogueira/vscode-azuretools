/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActionContext } from 'vscode-azureextensionui';

export interface IDeployContext extends IActionContext {
    stopAppBeforeDeploy?: boolean;
    syncTriggersPostDeploy?: boolean;
}
