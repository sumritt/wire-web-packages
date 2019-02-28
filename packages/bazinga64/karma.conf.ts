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

import {Config, ConfigOptions} from 'karma';

module.exports = (config: Config) => {
  const standardOptions: ConfigOptions = {
    autoWatch: false,
    basePath: '',
    browserNoActivityTimeout: 90000,
    browsers: ['ChromeNoSandbox'],
    client: {
      useIframe: false,
    },
    colors: true,
    concurrency: Infinity,
    customLaunchers: {
      ChromeNoSandbox: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox'],
      },
    },
    exclude: [],
    files: ['src/**/*.test.ts'],
    frameworks: ['jasmine'],
    logLevel: config.LOG_INFO,
    mime: {
      'text/x-typescript': ['ts', 'tsx'],
    },
    port: 9876,
    preprocessors: {
      '**/*.ts': ['typescript'],
    },
    reporters: ['jasmine-diff', 'spec'],
    singleRun: true,
  };

  const extendedOptions = {
    specReporter: {
      showSpecTiming: true,
    },
  };

  const options = {...standardOptions, ...extendedOptions};

  config.set(options);
};
