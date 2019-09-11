/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebSiteManagementClient } from 'azure-arm-website';
import { AppServicePlan, FunctionEnvelopeCollection, FunctionSecrets, HostNameSslState, Site, SiteConfigResource, SiteLogsConfig, SiteSourceControl, SlotConfigNamesResource, SourceControlCollection, StringDictionary, User, WebAppInstanceCollection, WebJobCollection } from 'azure-arm-website/lib/models';
import { ServiceClientOptions, WebResource } from 'ms-rest';
import { addExtensionUserAgent, createAzureClient, ISubscriptionContext, parseError } from 'vscode-azureextensionui';
import { KuduClient } from 'vscode-azurekudu';
import { FunctionEnvelope } from 'vscode-azurekudu/lib/models';
import { localize } from './localize';
import { nonNullProp, nonNullValue } from './utils/nonNull';
import { requestUtils } from './utils/requestUtils';

/**
 * Wrapper of a WebSiteManagementClient for use with a specific Site
 * Reduces the number of arguments needed for every call and automatically ensures the 'slot' method is called when appropriate
 */
export class SiteClient {
    public readonly id: string;
    public readonly isSlot: boolean;
    /**
     * The main site name (does not include the slot name)
     */
    public readonly siteName: string;
    public readonly slotName?: string;
    /**
     * Combination of the site name and slot name (if applicable), separated by a hyphen
     */
    public readonly fullName: string;

    public readonly resourceGroup: string;
    public readonly location: string;
    public readonly serverFarmId: string;
    public readonly kind: string;
    public readonly initialState?: string;
    public readonly isFunctionApp: boolean;
    public readonly isLinux: boolean;

    public readonly planResourceGroup: string;
    public readonly planName: string;

    public readonly defaultHostName: string;
    public readonly defaultHostUrl: string;
    public readonly kuduHostName: string | undefined;
    public readonly kuduUrl: string | undefined;
    public readonly gitUrl: string | undefined;

    private readonly _subscription: ISubscriptionContext;
    private _funcPreviewSlotError: Error = new Error(localize('functionsSlotPreview', 'This operation is not supported for slots, which are still in preview.'));

    private _cachedPlan: AppServicePlan | undefined;
    private _cachedSiteRestrictedToken: string | undefined;
    private _siteRestrictedTokenExpireTime: number = Date.now();

    constructor(site: Site, subscription: ISubscriptionContext) {
        let matches: RegExpMatchArray | null = nonNullProp(site, 'serverFarmId').match(/\/subscriptions\/(.*)\/resourceGroups\/(.*)\/providers\/Microsoft.Web\/serverfarms\/(.*)/);
        matches = nonNullValue(matches, 'Invalid serverFarmId.');

        this.id = nonNullProp(site, 'id');
        [this.siteName, this.slotName] = nonNullProp(site, 'name').split('/');
        this.isSlot = !!this.slotName;
        this.fullName = this.siteName + (this.slotName ? `-${this.slotName}` : '');

        this.resourceGroup = nonNullProp(site, 'resourceGroup');
        this.location = site.location;
        this.serverFarmId = nonNullProp(site, 'serverFarmId');
        this.kind = nonNullProp(site, 'kind');
        this.initialState = site.state;
        this.isFunctionApp = !!site.kind && site.kind.includes('functionapp');
        this.isLinux = !!site.kind && site.kind.toLowerCase().includes('linux');

        this.planResourceGroup = matches[2];
        this.planName = matches[3];

        this.defaultHostName = nonNullProp(site, 'defaultHostName');
        this.defaultHostUrl = `https://${this.defaultHostName}`;
        const kuduRepositoryUrl: HostNameSslState | undefined = nonNullProp(site, 'hostNameSslStates').find((h: HostNameSslState) => !!h.hostType && h.hostType.toLowerCase() === 'repository');
        if (kuduRepositoryUrl) {
            this.kuduHostName = kuduRepositoryUrl.name;
            this.kuduUrl = `https://${this.kuduHostName}`;
            this.gitUrl = `${this.kuduHostName}:443/${site.repositorySiteName}.git`;
        }

        this._subscription = subscription;
    }

    private get _client(): WebSiteManagementClient {
        return createAzureClient(this._subscription, WebSiteManagementClient);
    }

    public async getIsConsumption(): Promise<boolean> {
        if (this.isFunctionApp) {
            const asp: AppServicePlan | undefined = await this.getCachedAppServicePlan();
            // Assume it's consumption if we can't get the plan (sometimes happens with brand new plans). Consumption is recommended and more popular
            return !asp || !asp.sku || !asp.sku.tier || asp.sku.tier.toLowerCase() === 'dynamic';
        } else {
            return false;
        }
    }

    public async getKuduClient(): Promise<KuduClient> {
        if (!this.kuduHostName) {
            throw new Error(localize('notSupportedLinux', 'This operation is not supported by this app service plan.'));
        }

        const clientOptions: ServiceClientOptions | undefined = await this.getKuduClientOptions();
        const kuduClient: KuduClient = new KuduClient(this._subscription.credentials, this.kuduUrl, clientOptions);
        addExtensionUserAgent(kuduClient);
        return kuduClient;
    }

    public async stop(): Promise<void> {
        this.slotName ?
            await this._client.webApps.stopSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.stop(this.resourceGroup, this.siteName);
    }

    public async start(): Promise<void> {
        this.slotName ?
            await this._client.webApps.startSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.start(this.resourceGroup, this.siteName);
    }

    public async getState(): Promise<string | undefined> {
        return (this.slotName ?
            await this._client.webApps.getSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.get(this.resourceGroup, this.siteName)).state;
    }

    public async getWebAppPublishCredential(): Promise<User> {
        return this.slotName ?
            await this._client.webApps.listPublishingCredentialsSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.listPublishingCredentials(this.resourceGroup, this.siteName);
    }

    public async getSiteConfig(): Promise<SiteConfigResource> {
        return this.slotName ?
            await this._client.webApps.getConfigurationSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.getConfiguration(this.resourceGroup, this.siteName);
    }

    public async updateConfiguration(config: SiteConfigResource): Promise<SiteConfigResource> {
        return this.slotName ?
            await this._client.webApps.updateConfigurationSlot(this.resourceGroup, this.siteName, config, this.slotName) :
            await this._client.webApps.updateConfiguration(this.resourceGroup, this.siteName, config);
    }

    public async getLogsConfig(): Promise<SiteLogsConfig> {
        return this.slotName ?
            await this._client.webApps.getDiagnosticLogsConfigurationSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.getDiagnosticLogsConfiguration(this.resourceGroup, this.siteName);
    }

    public async updateLogsConfig(config: SiteLogsConfig): Promise<SiteLogsConfig> {
        return this.slotName ?
            await this._client.webApps.updateDiagnosticLogsConfigSlot(this.resourceGroup, this.siteName, config, this.slotName) :
            await this._client.webApps.updateDiagnosticLogsConfig(this.resourceGroup, this.siteName, config);
    }

    public async getAppServicePlan(): Promise<AppServicePlan | undefined> {
        return await this._client.appServicePlans.get(this.planResourceGroup, this.planName);
    }

    public async getSourceControl(): Promise<SiteSourceControl> {
        return this.slotName ?
            await this._client.webApps.getSourceControlSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.getSourceControl(this.resourceGroup, this.siteName);
    }

    public async updateSourceControl(siteSourceControl: SiteSourceControl): Promise<SiteSourceControl> {
        return this.slotName ?
            await this._client.webApps.createOrUpdateSourceControlSlot(this.resourceGroup, this.siteName, siteSourceControl, this.slotName) :
            await this._client.webApps.createOrUpdateSourceControl(this.resourceGroup, this.siteName, siteSourceControl);
    }

    public async syncRepository(): Promise<void> {
        return this.slotName ?
            await this._client.webApps.syncRepositorySlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.syncRepository(this.resourceGroup, this.siteName);
    }

    public async listApplicationSettings(): Promise<StringDictionary> {
        return this.slotName ?
            await this._client.webApps.listApplicationSettingsSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.listApplicationSettings(this.resourceGroup, this.siteName);
    }

    public async updateApplicationSettings(appSettings: StringDictionary): Promise<StringDictionary> {
        return this.slotName ?
            await this._client.webApps.updateApplicationSettingsSlot(this.resourceGroup, this.siteName, appSettings, this.slotName) :
            await this._client.webApps.updateApplicationSettings(this.resourceGroup, this.siteName, appSettings);
    }

    public async listSlotConfigurationNames(): Promise<SlotConfigNamesResource> {
        return await this._client.webApps.listSlotConfigurationNames(this.resourceGroup, this.siteName);
    }

    public async updateSlotConfigurationNames(appSettings: SlotConfigNamesResource): Promise<SlotConfigNamesResource> {
        return await this._client.webApps.updateSlotConfigurationNames(this.resourceGroup, this.siteName, appSettings);
    }

    public async deleteMethod(options?: { deleteMetrics?: boolean, deleteEmptyServerFarm?: boolean, skipDnsRegistration?: boolean, customHeaders?: { [headerName: string]: string; } }): Promise<void> {
        return this.slotName ?
            await this._client.webApps.deleteSlot(this.resourceGroup, this.siteName, this.slotName, options) :
            await this._client.webApps.deleteMethod(this.resourceGroup, this.siteName, options);
    }

    public async listInstanceIdentifiers(): Promise<WebAppInstanceCollection> {
        return this.slotName ?
            await this._client.webApps.listInstanceIdentifiersSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.listInstanceIdentifiers(this.resourceGroup, this.siteName);
    }

    public async listSourceControls(): Promise<SourceControlCollection> {
        return await this._client.listSourceControls();
    }

    public async listFunctions(): Promise<FunctionEnvelopeCollection> {
        if (this.slotName) {
            throw this._funcPreviewSlotError;
        } else {
            return await this._client.webApps.listFunctions(this.resourceGroup, this.siteName);
        }
    }

    public async listFunctionsNext(nextPageLink: string): Promise<FunctionEnvelopeCollection> {
        if (this.slotName) {
            throw this._funcPreviewSlotError;
        } else {
            return await this._client.webApps.listFunctionsNext(nextPageLink);
        }
    }

    public async getFunction(functionName: string): Promise<FunctionEnvelope> {
        if (this.slotName) {
            throw this._funcPreviewSlotError;
        } else {
            return await this._client.webApps.getFunction(this.resourceGroup, this.siteName, functionName);
        }
    }

    public async deleteFunction(functionName: string): Promise<void> {
        if (this.slotName) {
            throw this._funcPreviewSlotError;
        } else {
            return await this._client.webApps.deleteFunction(this.resourceGroup, this.siteName, functionName);
        }
    }

    public async listFunctionSecrets(functionName: string): Promise<FunctionSecrets> {
        return this.slotName ?
            await this._client.webApps.listFunctionSecretsSlot(this.resourceGroup, this.siteName, functionName, this.slotName) :
            await this._client.webApps.listFunctionSecrets(this.resourceGroup, this.siteName, functionName);
    }

    public async getFunctionsAdminToken(): Promise<string> {
        return this.slotName ?
            await this._client.webApps.getFunctionsAdminTokenSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.getFunctionsAdminToken(this.resourceGroup, this.siteName);
    }

    public async syncFunctionTriggers(): Promise<void> {
        try {
            this.slotName ?
                await this._client.webApps.syncFunctionTriggersSlot(this.resourceGroup, this.siteName, this.slotName) :
                await this._client.webApps.syncFunctionTriggers(this.resourceGroup, this.siteName);
        } catch (error) {
            // For some reason this call incorrectly throws an error when the status code is 200
            if (parseError(error).errorType !== '200') {
                throw error;
            }
        }
    }

    public async getPublishingUser(): Promise<User> {
        return await this._client.getPublishingUser({});
    }

    public async listWebJobs(): Promise<WebJobCollection> {
        return this.slotName ?
            await this._client.webApps.listWebJobsSlot(this.resourceGroup, this.siteName, this.slotName) :
            await this._client.webApps.listWebJobs(this.resourceGroup, this.siteName);
    }

    /**
     * Temporary workaround because this isn't in azure sdk yet
     * Spec: https://github.com/Azure/azure-functions-host/issues/3994
     */
    public async listHostKeys(): Promise<IHostKeys> {
        const urlPath: string = `${this.id}/host/default/listkeys?api-version=2016-08-01`;
        const requestOptions: requestUtils.Request = await requestUtils.getDefaultAzureRequest(urlPath, this._subscription, 'POST');
        const result: string = await requestUtils.sendRequest(requestOptions);
        return <IHostKeys>JSON.parse(result);
    }

    /**
     * Temporary workaround because this isn't in azure sdk yet
     * Spec: https://github.com/Azure/azure-functions-host/issues/3994
     */
    public async listFunctionKeys(functionName: string): Promise<IFunctionKeys> {
        const urlPath: string = `${this.id}/functions/${functionName}/listKeys?api-version=2016-08-01`;
        const requestOptions: requestUtils.Request = await requestUtils.getDefaultAzureRequest(urlPath, this._subscription, 'POST');
        const result: string = await requestUtils.sendRequest(requestOptions);
        return <IFunctionKeys>JSON.parse(result);
    }

    /**
     * To be used for better performance when checking something on the plan that doesn't change
     */
    private async getCachedAppServicePlan(): Promise<AppServicePlan | undefined> {
        let result: AppServicePlan | undefined = this._cachedPlan;
        if (!result) {
            result = await this.getAppServicePlan();
        }
        return result;
    }

    /**
     * Linux consumption currently requires a site-restricted token for all kudu calls (in addition to existing credentials)
     * This is only a temporary requirement and should be going away eventually
     */
    private async getKuduClientOptions(): Promise<ServiceClientOptions | undefined> {
        if (this.isLinux) {
            const isConsumption: boolean = await this.getIsConsumption();
            if (isConsumption) {
                // Doing the best we can for types here - 'ms-rest' is severely lacking when it comes to filters
                type callbackType = (err: unknown) => void;
                type nextType = (r: WebResource, c: callbackType) => Promise<void>;
                return {
                    filters: [
                        async (resource: WebResource, next: nextType, callback: callbackType): Promise<void> => {
                            try {
                                resource.headers['x-ms-site-restricted-token'] = await this.getSiteRestrictedToken();
                                return next(resource, callback);
                            } catch (error) {
                                callback(error);
                            }
                        }
                    ]
                };
            }
        }

        return undefined;
    }

    private async getSiteRestrictedToken(): Promise<string> {
        if (!this._cachedSiteRestrictedToken || Date.now() > this._siteRestrictedTokenExpireTime) {
            const urlPath: string = `${this.id}/hostruntime/admin/host/token?api-version=2015-08-01`;
            const request: requestUtils.Request = await requestUtils.getDefaultAzureRequest(urlPath, this._subscription);
            // token only lasts 5 minutes. Use 4 just to be safe
            this._siteRestrictedTokenExpireTime = Date.now() + 4 * 60 * 1000;
            this._cachedSiteRestrictedToken = await requestUtils.sendRequest<string>(request);
        }

        return this._cachedSiteRestrictedToken;
    }
}

export interface IFunctionKeys {
    // tslint:disable-next-line: no-reserved-keywords
    default?: string;
    [key: string]: string | undefined;
}

export interface IHostKeys {
    masterKey?: string;
    functionKeys?: { [key: string]: string | undefined };
    systemKeys?: { [key: string]: string | undefined };
}
