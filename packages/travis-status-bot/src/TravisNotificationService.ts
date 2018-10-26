/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import {CronJob} from 'cron';
import * as logdown from 'logdown';
import {Result as TravisResult, StatusPage} from 'statuspage.io';

import {TravisData, TravisDataResult} from './Interfaces';
import {StoreService} from './StoreService';

class TravisNotificationService {
  private readonly logger: logdown.Logger;
  private readonly DATA_URL: string;
  private readonly storeService: StoreService;
  private readonly notifySubscribers: ((incidents: TravisResult.Incident[], reason?: string) => Promise<void>);
  private readonly statusPageAPI: StatusPage;

  constructor(
    storeService: StoreService,
    notifySubscribers: ((incidents: TravisResult.Incident[]) => Promise<void>),
    dataUrl?: string
  ) {
    this.DATA_URL = dataUrl || 'https://www.traviscistatus.com';
    this.storeService = storeService;
    this.notifySubscribers = notifySubscribers;
    this.statusPageAPI = new StatusPage(this.DATA_URL);

    this.logger = logdown('@wireapp/travis-status-bot/TravisNotificationService', {
      logger: console,
      markdown: false,
    });
    this.logger.state.isEnabled = true;
  }

  public async init(): Promise<void> {
    await this.updateData('Initialization');

    const cronJobTime = '*/10';
    new CronJob(cronJobTime, () => this.updateData('cron job')).start();
    this.logger.info(`Initialized cron updater job with time: "${cronJobTime}".`);
  }

  public async getStatus(): Promise<TravisData | null> {
    const {cachedData, newData} = await this.updateData('Status request');

    if (!newData) {
      this.logger.info('No new Travis JSON data loaded.');
      return cachedData;
    }

    return newData;
  }

  private getNewIncidents(cachedData: TravisData, receivedData: TravisData): TravisResult.Incident[] | null {
    const cachedIncidents = cachedData.incidents;
    const receivedIncidents = receivedData.incidents;

    if (!receivedIncidents || !receivedIncidents.length) {
      return null;
    }

    if (!cachedIncidents || !cachedIncidents.length) {
      return receivedIncidents;
    }

    const cachedIncidentIds = cachedData.incidents.map(incident => incident.id);
    const newIncidents = receivedIncidents.filter(receivedIncident => !cachedIncidentIds.includes(receivedIncident.id));
    return newIncidents.length ? newIncidents : null;
  }

  public async updateData(reason?: string): Promise<TravisDataResult> {
    this.logger.info(`Updating Travis JSON data ${reason ? `(reason: ${reason}) ` : ''}...`);
    const jsonData = await this.requestJSONData();
    const cachedData = await this.storeService.loadDataFromCache();

    if (!jsonData) {
      this.logger.info(`Did not save any Travis JSON data to cache.`);
      return {newData: null, cachedData: cachedData || null};
    }

    await this.storeService.saveDataToCache(jsonData);

    let newIncidents: TravisResult.Incident[] | null = null;

    if (cachedData) {
      newIncidents = this.getNewIncidents(cachedData, jsonData);
    }

    this.logger.info(
      `Saved Travis JSON data to cache. ${newIncidents ? newIncidents.length : 'No'} new incident${
        newIncidents && newIncidents.length === 1 ? '' : 's'
      }.`
    );

    if (newIncidents) {
      await this.notifySubscribers(newIncidents, 'New incidents found');
    }

    return {newData: jsonData, cachedData};
  }

  private async requestJSONData(): Promise<TravisData | null> {
    try {
      const {incidents} = await this.statusPageAPI.api.incidents.getAll();
      const {components} = await this.statusPageAPI.api.getComponents();
      this.logger.info(
        `Received ${incidents.length} incidents and ${components.length} components from "${this.DATA_URL}".`
      );
      return {incidents, components};
    } catch (error) {
      this.logger.error(`Request to "${error.config.url}" failed with status code "${error.response.status}".`);
      return null;
    }
  }
}

export {TravisNotificationService};
