import _ from 'lodash';
import archiver from 'archiver';
import {existsSync, readdir} from "fs";
import {resolve} from 'path';
import {mkdirp} from 'mkdirp';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import zlib from 'zlib';
import FileType from 'file-type'; // using v16, see https://github.com/sindresorhus/file-type/issues/535
import {DateTime, Duration} from "ts-luxon";
import {rootLogger} from "./logger";
import * as path from "path";
import AdmZip from 'adm-zip';

const logger = rootLogger.child({ src: 'file-utils.ts' });

const TS_FORMAT = `yyyyMMdd'T'HHmm`;

async function getFileType(path: string): Promise<string | undefined> {
    const absolutePath = getAbsolutePath(path);
    const info = await FileType.fromFile(absolutePath);
    return _.get(info, 'mime');
}

async function isFileType(expected: string, path: string): Promise<boolean> {
    const actual = fileExistsNotEmpty(path) ? await getFileType(path) : undefined;
    return actual === expected;
}

async function isZipFile(path: string): Promise<boolean> {
    return isFileType('application/zip', path);
}

async function isGzipFile(path: string): Promise<boolean> {
    return isFileType('application/gzip', path);
}

function fileExistsNotEmpty(path: string | undefined): boolean {
    let existsNotEmpty = false;
    if (_.isString(path)) {
        const absolutePath = getAbsolutePath(path);
        if (existsSync(absolutePath)) {
            const fileSize = getFileSize(absolutePath);
            existsNotEmpty = fileSize > 2;
        }
    } else {
        logger.warning('fileExistsNotEmpty(path) invoked with undefined path');
    }
    return existsNotEmpty;
}

async function isValidFile(path: string | undefined): Promise<boolean> {
    let isValid = false;
    if (_.isString(path)) {
        if (path.endsWith('.json')) {
            try {
                const stringContents = await readFileAsString(path);
                const parsed = JSON.parse(stringContents);
                isValid = !_.isNil(parsed);
            } catch (e) {
                // isValid == false
            }
        } else if (path.endsWith('.zip')) {
            isValid = await isZipFile(path) || await isGzipFile(path);
        } else {
            isValid = fileExistsNotEmpty(path);
        }
    }
    return isValid;
}

function getFileSize(path: string): number {
    const absolutePath = getAbsolutePath(path);
    if (existsSync(absolutePath)) {
        const stat = fs.statSync(absolutePath);
        return stat.size;
    }
    return -1;
}

function fileIsNew(path: string, hours: number = 12): boolean {
    const absolutePath = getAbsolutePath(path);
    if (existsSync(absolutePath)) {
        const stat = fs.statSync(absolutePath);
        const lastModifiedMillis = stat.mtimeMs;
        const nowMillis = Date.now();
        const diffMillis = nowMillis - lastModifiedMillis;
        const maxDiffMillis = hours * 60 * 60 * 1000;
        const lastModifiedTs = DateTime.fromMillis(lastModifiedMillis).setZone('Europe/Helsinki').toFormat(`yyyy-MM-dd'T'HH:mm:ssZZ`);
        const durationText = Duration.fromMillis(diffMillis).toFormat(`d 'days', h 'hours', m 'minutes'`);
        const isNew = diffMillis < maxDiffMillis;
        const moreOrLess = isNew ? 'less' : 'more';
        logger.debug(`${absolutePath} was last modified ${lastModifiedTs}, which is ${durationText} ago. The file is ${moreOrLess} than ${hours} hours old.`);
        return isNew;
    }
    return false;
}

async function listFiles(dir: string): Promise<string[]> {
    const dirAbsolute = getAbsolutePath(dir);
    return new Promise<string[]>((resolve, reject) =>
        readdir(dirAbsolute, (err, fileNames) => {
            if ( _.isNil(err) ) {
                const absolutePaths = fileNames.map(fileName => getAbsolutePath(`${dirAbsolute}${path.sep}${fileName}`));
                const existingFiles = absolutePaths.filter(absolutePath => existsSync(absolutePath));
                resolve(existingFiles);
            } else {
                reject(err);
            }
        })
    );
}

async function removeOldFiles(dirs: string[], hours: number = 24 * 14): Promise<string[]> {
    const removedFiles = [] as string[];
    for (let dir of dirs) {
        const files = await listFiles(dir);
        for (let file of files) {
            if (!fileIsNew(file, hours)) {
                try {
                    await removeFile(file);
                    removedFiles.push(file);
                } catch (e) {
                    logger.error(`Failed to remove file: ${file}`);
                }
            }
        }
    }
    if (_.isEmpty(removedFiles)) {
        logger.debug(`No files were removed under ${dirs}`);
    } else {
        logger.debug(`Removed ${removedFiles.length} files since they were more than ${hours} hours old: ${removedFiles}`);
    }
    return removedFiles;
}

function getAbsolutePath(path: string): string {
    return resolve(path);
}

function getParentDir(path: string): string {
    const absolutePath = getAbsolutePath(path);
    const lastSlash = absolutePath.lastIndexOf('/');
    return absolutePath.substring(0, lastSlash);
}

async function createDirIfNotExists(dir: string): Promise<string> {
    const absolutePath = getAbsolutePath(dir);
    if (!existsSync(absolutePath)) {
        await mkdirp(absolutePath);
    }
    return absolutePath;
}

async function gunzipFile(gzFile: string, destFile: string): Promise<string> {
    const gzFileAbsolutePath = getAbsolutePath(gzFile);
    const destFileAbsolutePath = getAbsolutePath(destFile);
    const gunzip = zlib.createGunzip();
    return new Promise((resolve, reject) => {
        const destinationFileStream = fs.createWriteStream(destFileAbsolutePath);
        fs.createReadStream(gzFileAbsolutePath)
            .pipe(gunzip)
            .pipe(destinationFileStream)
            .on('close', () => resolve(destFileAbsolutePath))
            .on('error', error => reject(error));
    });
}

async function unzip(zipfile: string, destDir: string, entryFile?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip(zipfile);
      if (entryFile) {
        zip.extractEntryTo(entryFile, destDir);
      } else {
        zip.extractAllTo(destDir);
      }
      resolve(destDir);
    } catch (e) {
      console.error(`Exception while unzip(zipfile=${zipfile}, dstdir=${destDir}, entryFile=${entryFile}) : `, e);
      reject(e);
    }
  });
}

async function readFileAsString(path: string): Promise<string> {
    const absolutePath = getAbsolutePath(path);
    return new Promise((resolve, reject) => {
        fs.readFile(absolutePath, 'utf8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

async function removeFile(path: string): Promise<string> {
    const absolutePath = getAbsolutePath(path);
    try {
        await fsPromises.rm(absolutePath, { recursive: true, force: true });
        return absolutePath;
    } catch (error) {
        throw error;
    }
}

async function cleanDir(path: string): Promise<string> {
    const absolutePath = getAbsolutePath(path);
    return removeFile(absolutePath).then(createDirIfNotExists);
}

async function cleanDirs(...paths: string[]) {
    const initialValue = Promise.resolve([]);
    const callback = (previousPromise: Promise<any>, path: string) =>
        previousPromise.then((results: any) =>
            cleanDir(path).then(result => [...results, result])
        );
    const result = await paths.reduce(callback, initialValue);
    console.log(`common.cleanDirs(${paths})`);
    return result;
}

async function createZip(zipFilePath: string, srcDirPath: string, level: number = 1): Promise<string> {
    return new Promise<string>((resolve) => {
        const output = fs.createWriteStream(zipFilePath);
        output.on('end', () => {
            return true;
        });
        output.on('close', () => {
            resolve(zipFilePath)
        });
        const archive = archiver('zip', { zlib: { level: level } });
        archive.pipe(output);
        archive.directory(srcDirPath, false);
        archive.finalize();
    });
}

async function writeFile(filePath: string, content: string): Promise<string> {
    const filePathAbsolute = getAbsolutePath(filePath);
    return new Promise((resolve, reject) =>
        fs.writeFile(filePathAbsolute, content, 'utf8', error => {
            if (_.isNil(error)) {
                resolve(filePathAbsolute);
            } else {
                reject(error);
            }
        }));
}

async function writeJsonFile(filePath: string, jsonString: string): Promise<string> {
    const parsed = JSON.parse(jsonString);
    const formatted = JSON.stringify(parsed, null, '    ');
    return writeFile(filePath, formatted);
}

async function formatJsonFile(filePath: string): Promise<string> {
    const filePathAbsolute = getAbsolutePath(filePath);
    const content = await readFileAsString(filePathAbsolute);
    return writeJsonFile(filePath, content);
}

async function backup(filePath: string): Promise<boolean> {
    const fileAbsolutePath = getAbsolutePath(filePath);
    const backupFile = `${fileAbsolutePath}-backup`;
    return new Promise<boolean>((resolve, reject) => {
        if (fileExistsNotEmpty(fileAbsolutePath)) {
            fs.copyFile(fileAbsolutePath, backupFile, err => {
                if (_.isNil(err)) {
                    logger.debug(`File ${fileAbsolutePath} backup done: ${backupFile}`);
                    resolve(true);
                } else {
                    logger.warn(`Error when backing up file ${fileAbsolutePath} to: ${backupFile}`);
                    logger.warn(err);
                    reject(err);
                }
            });
        } else {
            logger.info(`Cannot backup file ${fileAbsolutePath} because the file does not exist or the file is empty.`);
            resolve(false);
        }
    });
}

async function restore(filePath: string): Promise<boolean> {
    const fileAbsolutePath = getAbsolutePath(filePath);
    const backupFile = `${fileAbsolutePath}-backup`;
    return new Promise<boolean>((resolve, reject) => {
        if (fileExistsNotEmpty(backupFile)) {
            fs.rename(backupFile, fileAbsolutePath, err => {
                if (_.isNil(err)) {
                    logger.info(`File ${fileAbsolutePath} restored from backup: ${backupFile}`);
                    resolve(true);
                } else {
                    logger.warn(`Error when backing up file ${fileAbsolutePath} to: ${backupFile}`);
                    logger.warn(err);
                    reject(err);
                }
            });
        } else {
            logger.warn(`Cannot restore file ${fileAbsolutePath} because the backup file ${backupFile} does not exist.`);
            resolve(false);
        }
    });
}

function getTimestamp(): string {
    return DateTime.local().setZone('Europe/Helsinki').toFormat(TS_FORMAT);
}

function moveFile(oldPath: string, newPath: string) {
    return new Promise((resolve, reject) =>
        fs.rename(oldPath, newPath, err => {
            if (_.isNil(err)) {
                resolve(newPath);
            } else {
                reject(err);
            }
        })
    );
}

function copyFile(srcDir: string, dstDir: string, fileName: string) {
    return new Promise((resolve, reject) => {
        const srcPath = `${srcDir}/${fileName}`;
        const dstPath = `${dstDir}/${fileName}`;
        if (notExists(dstDir)) {
            reject(`ERROR: copyFile : dstDir=${dstDir} does not exist`);
        } else {
            fs.createReadStream(srcPath)
                .on('end', () => { /*console.log(`copyFile: ${srcPath} => ${dstPath} done` );*/ resolve('done'); })
                .on('error', e => { console.log(`copyFile: ${srcPath} => ${dstPath}, something bad happened, rejecting`); reject(e); })
                .pipe(fs.createWriteStream(dstPath));
        }
    });
}

async function copyFiles(srcDir: string, dstDir: string, fileNamesArray: string[] | string) {
    fileNamesArray = _.isString(fileNamesArray) ? [fileNamesArray] : fileNamesArray
    const result = await Promise.all(fileNamesArray.map(fileName => copyFile(srcDir, dstDir, fileName)));
    return result;
}

function notExists(path: string): boolean {
    const result = !fs.existsSync(path);
    return result;
}

export {
    backup,
    cleanDir,
    createDirIfNotExists,
    createZip,
    fileExistsNotEmpty,
    fileIsNew,
    formatJsonFile,
    getAbsolutePath,
    getFileSize,
    getParentDir,
    getTimestamp,
    gunzipFile,
    isGzipFile,
    isValidFile,
    isZipFile,
    readFileAsString,
    restore,
    removeFile,
    removeOldFiles,
    writeJsonFile,
    unzip,
    moveFile,
    copyFiles,
    cleanDirs
}
