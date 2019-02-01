/*
 * Wire
 * Copyright (C) 2019 Wire Swiss GmbH
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

import {exec} from 'child_process';
import * as path from 'path';
import {promisify} from 'util';

import copy = require('copy');
import * as fs from 'fs-extra';
import * as logdown from 'logdown';
import * as rimraf from 'rimraf';

import {CopyConfigOptions} from './CopyConfigOptions';

const rimrafAsync = promisify(rimraf);
const execAsync = promisify(exec);
const copyAsync = (source: string, destination: string): Promise<string[]> =>
  new Promise((resolve, reject) =>
    copy(source, destination, (error, files = []) => (error ? reject(error) : resolve(files.map(file => file.path))))
  );

const defaultOptions: Required<CopyConfigOptions> = {
  externalDir: '',
  files: {},
  repositoryUrl: 'https://github.com/wireapp/wire-web-config-default#v0.7.1',
};

export class CopyConfig {
  private readonly options: Required<CopyConfigOptions>;
  private readonly logger: logdown.Logger;
  private readonly baseDir: string = 'config';
  private readonly noClone: boolean = false;
  private readonly noCleanup: boolean = false;
  private readonly filterFiles: string[] = ['.DS_Store'];

  constructor(filesOrOptions: CopyConfigOptions) {
    this.options = {...defaultOptions, ...filesOrOptions};
    this.readEnvVars();

    if (this.options.externalDir) {
      this.noClone = true;
      this.noCleanup = true;
      this.baseDir = this.options.externalDir;
    }
    this.baseDir = path.resolve(this.baseDir);

    this.logger = logdown('@wireapp/copy-config/CopyConfig', {
      markdown: false,
    });
  }

  private readEnvVars(): void {
    const setString = (variable: string | undefined, optionKey: keyof CopyConfigOptions) =>
      typeof variable !== 'undefined' && (this.options[optionKey] = String(variable));

    const setFiles = (files: string | undefined) => {
      const fileArrayRegex = /^\[(.*)\]$/;

      if (typeof files !== 'undefined') {
        files
          .split(';')
          .map(fileTuple => fileTuple.split(':'))
          .forEach(([source, dest]) => {
            let destination: string | string[] = dest;
            if (fileArrayRegex.test(destination)) {
              destination = dest.replace(fileArrayRegex, '$1').split(',');
            }
            this.options.files[source] = destination;
          });
      }
    };

    setString(process.env.WIRE_CONFIGURATION_EXTERNAL_DIR, 'externalDir');
    setString(process.env.WIRE_CONFIGURATION_REPOSITORY, 'repositoryUrl');
    setFiles(process.env.WIRE_CONFIGURATION_FILES);
  }

  private resolveFiles(): void {
    const filesArray = Object.keys(this.options.files);
    if (!filesArray.length) {
      throw new Error('No source files or directories specified.');
    }

    filesArray.forEach(source => {
      const destination = this.options.files[source];

      const joinedSource = path.join(this.baseDir, source);
      const resolvedDestination =
        destination instanceof Array ? destination.map(dest => path.resolve(dest)) : path.resolve(destination);

      delete this.options.files[source];

      this.options.files[joinedSource] = resolvedDestination;
    });
  }

  public async copyDirOrFile(source: string, destination: string): Promise<string[]> {
    const filter = (src: string): boolean => {
      for (const fileName in this.filterFiles) {
        if (src.endsWith(fileName)) {
          return false;
        }
      }
      return true;
    };
    const isFile = (path: string) => /[^.\/\\]+\..+$/.test(path);
    const isGlob = (path: string) => /\*$/.test(path);

    this.logger.info(`Copying "${source}" -> "${destination}"`);

    if (isFile(destination)) {
      if (!isFile(source)) {
        throw new Error('Cannot copy a directory into a file.');
      }
      await fs.ensureDir(path.dirname(destination));
    } else {
      await fs.ensureDir(destination);
    }

    if (isGlob(source)) {
      return copyAsync(source, destination);
    }

    if (isFile(source) && !isFile(destination)) {
      destination = path.join(destination, path.basename(source));
    }

    await fs.copy(source, destination, {filter, overwrite: true, recursive: true});
    return [destination];
  }

  private async clone(): Promise<void> {
    const [bareUrl, branch = 'master'] = this.options.repositoryUrl.split('#');

    const {stderr: stderrVersion} = await execAsync('git --version');

    if (stderrVersion) {
      throw new Error(`No git installation found: ${stderrVersion}`);
    }

    if (!this.noCleanup) {
      this.logger.info(`Removing clone directory before cloning ...`);
      await rimrafAsync(this.baseDir);
    }

    this.logger.info(`Cloning "${bareUrl}" (branch "${branch}") ...`);
    const command = `git clone --depth 1 -b ${branch} ${bareUrl} ${this.baseDir}`;

    const {stderr: stderrClone} = await execAsync(command);

    if (stderrClone.includes('fatal')) {
      throw new Error(stderrClone);
    }
  }

  public async copy(): Promise<string[]> {
    let copiedFiles: string[] = [];

    if (!this.noClone) {
      await this.clone();
    }

    this.resolveFiles();

    for (const file in this.options.files) {
      const destination = this.options.files[file];
      if (destination instanceof Array) {
        const results = await Promise.all(destination.map(dest => this.copyDirOrFile(file, dest)));
        results.forEach(result => (copiedFiles = copiedFiles.concat(result)));
      } else {
        const result = await this.copyDirOrFile(file, destination);
        copiedFiles = copiedFiles.concat(result);
      }
    }

    return copiedFiles.sort();
  }
}