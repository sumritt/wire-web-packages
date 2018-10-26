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

import {error as StoreEngineError} from '@wireapp/store-engine';
import {FileEngine} from '@wireapp/store-engine/dist/commonjs/engine';
import * as logdown from 'logdown';
import * as path from 'path';

import {SubscriberOptions, TravisData} from './Interfaces';

const defaultStorePath = path.join(__dirname, '.temp');

class StoreService {
  private readonly STORE_PATH: string;
  private readonly TABLE_NAME_SUBSCRIBERS = 'subscribers';
  private readonly TABLE_NAME_Data = 'travis-data';
  private readonly logger: logdown.Logger;
  private readonly storeEngine: FileEngine;

  constructor(storePath?: string) {
    this.STORE_PATH = storePath ? path.resolve(storePath) : defaultStorePath;
    this.storeEngine = new FileEngine(this.STORE_PATH);

    this.logger = logdown('@wireapp/travis-status-bot/StoreService', {
      logger: console,
      markdown: false,
    });
    this.logger.state.isEnabled = true;
  }

  public async saveDataToCache(data: TravisData): Promise<void> {
    try {
      await this.storeEngine.updateOrCreate(this.TABLE_NAME_Data, 'full', data);
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async loadDataFromCache(): Promise<TravisData | null> {
    try {
      const data = await this.storeEngine.read<TravisData>(this.TABLE_NAME_Data, 'full');
      return data;
    } catch (error) {
      const recordNotFound =
        error instanceof StoreEngineError.RecordNotFoundError ||
        error.constructor.name !== StoreEngineError.RecordNotFoundError.name;
      if (!recordNotFound) {
        this.logger.error(error);
      }
      return null;
    }
  }

  public async addSubscriber(subscriberId: string): Promise<void> {
    try {
      await this.storeEngine.updateOrCreate(this.TABLE_NAME_SUBSCRIBERS, subscriberId, {isSubscribed: true});
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async init(): Promise<void> {
    try {
      await this.storeEngine.init('travis-status-bot');
    } catch (error) {
      this.logger.error(error);
    }

    const subscriberIds = await this.getSubscribers();
    if (subscriberIds.length) {
      this.logger.info(`Loaded ${subscriberIds.length} subscriber${subscriberIds.length === 1 ? '' : 's'} from cache.`);
    } else {
      this.logger.info(`No subscribers found in cache.`);
    }

    const jsonData = await this.loadDataFromCache();
    if (jsonData && jsonData.incidents && jsonData.incidents.length) {
      this.logger.info(
        `Loaded Travis JSON data with ${jsonData.incidents.length} incident${
          jsonData.incidents.length === 1 ? '' : 's'
        } from cache.`
      );
    } else {
      this.logger.info(`No Travis JSON data found in cache.`);
    }
  }

  public async checkSubscription(conversationId: string): Promise<boolean> {
    try {
      const {isSubscribed} = await this.storeEngine.read<SubscriberOptions>(
        this.TABLE_NAME_SUBSCRIBERS,
        conversationId
      );
      return isSubscribed;
    } catch (error) {
      const recordNotFound =
        error instanceof StoreEngineError.RecordNotFoundError ||
        error.constructor.name !== StoreEngineError.RecordNotFoundError.name;
      if (!recordNotFound) {
        this.logger.error(error);
      }
      return false;
    }
  }

  public async getSubscribers(): Promise<string[]> {
    let conversationIds: string[] = [];

    try {
      conversationIds = await this.storeEngine.readAllPrimaryKeys(this.TABLE_NAME_SUBSCRIBERS);
    } catch (error) {
      const recordNotFound =
        error instanceof StoreEngineError.RecordNotFoundError ||
        error.constructor.name !== StoreEngineError.RecordNotFoundError.name;
      if (!recordNotFound) {
        this.logger.error(error);
      }
      return conversationIds;
    }

    const subscriberIds = [];

    for (const conversationId of conversationIds) {
      const isSubscribed = await this.checkSubscription(conversationId);
      if (isSubscribed) {
        subscriberIds.push(conversationId);
      }
    }

    return subscriberIds;
  }

  public async removeSubscriber(conversationId: string): Promise<void> {
    try {
      await this.storeEngine.updateOrCreate(this.TABLE_NAME_SUBSCRIBERS, conversationId, {isSubscribed: false});
    } catch (error) {
      this.logger.error(error);
    }
  }
}

export {StoreService};
