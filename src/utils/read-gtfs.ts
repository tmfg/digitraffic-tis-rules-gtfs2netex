import _ from 'lodash';
import { parse } from 'csv-parse';
import StreamZip from 'node-stream-zip';
import {Agency, Calendar, CalendarDate, Gtfs, Route, Stop, StopTime, Trip, Shape, Translation, FeedInfo} from "./gtfs-types";
import {getAbsolutePath, gunzipFile, isGzipFile, isZipFile } from "./file-utils";
import {rootLogger} from "./logger";

const logger = rootLogger.child({src: 'read-gtfs.ts'});

function closeZip(zip: StreamZip) {
    try {
        zip.close();
    } catch (ignore) {
    }
}

async function readObjects(stream: NodeJS.ReadableStream, filePath: string, entry: string): Promise<Array<object>> {
    return new Promise<Array<object>>((resolve, reject) => {
        const columnIndex = new Map<string, number>();
        const array = new Array<object>();
        const parseStream = parse({delimiter: ','});
        stream
            .pipe(parseStream)
            .on('data', row => {
                if (columnIndex.size === 0) {
                    for (let i = 0; i < row.length; i++) {
                        const key = row[i].trim();
                        columnIndex.set(key, i);
                    }
                } else {
                    const entry = {};
                    for (let key of Array.from(columnIndex.keys())) {
                        const index = columnIndex.get(key);
                        if (_.isNumber(index)) {
                            const value = row[index];
                            if ( _.isString(value) && value.trim().length > 0 ) {
                                const keyToSet = key === 'digistop_id' ? 'stop_digiroad_id' : key;
                                _.set(entry, keyToSet, row[index]);
                            }
                        }
                    }
                    array.push(entry);
                }
            })
            .on('end', () => {
                resolve(array);
            })
            .on('error', (a) => {
                const message = `Error when reading zip entry stream (${filePath}, entry=${entry}) : ` + a;
                logger.error(message);
                resolve(array);
            });
    });
}

async function readEntry(filePath: string, entry: string): Promise<object[]> {
    const isZip = await isZipFile(filePath);
    return new Promise<object[]>((resolve, reject) => {
        if ( isZip ) {
            const zip = new StreamZip({
                file: filePath,
                storeEntries: true
            });
            zip.on('ready', () => {
                zip.stream(entry, (err, stm) => {
                    if (stm) {
                        readObjects(stm, filePath, entry).then(objects => {
                            closeZip(zip);
                            resolve(objects);
                        });
                    } else {
                        closeZip(zip);
                        resolve([]);
                    }
                });
            });
            zip.on('error', error => {
                const message = `Cannot read zip entry ${entry} from zip file: ${filePath}, an error occurred: ${error}`;
                logger.info(message);
                closeZip(zip);
                reject(message);
            });
        } else {
            const message = `Cannot read zip entry ${entry}, not a zip file: ${filePath}`;
            logger.info(message);
            reject(message);
        }
    });
}

function objectToStop(o : object) : Stop {
    const stop = o as Stop;
    stop.stop_lat = parseFloat(_.get(o, 'stop_lat') || '');
    stop.stop_lon = parseFloat(_.get(o, 'stop_lon') || '');
    return stop;
}

// TODO: do we need to always read shapes? could save some time and memory if not
// e.g. after last tidy in `cmd.ts` we do not really need shapes to pass for hashIds if not hashing the shape_id
async function readGtfsZip(filePath: string): Promise<Gtfs> {
    const agencyObjects = await readEntry(filePath, 'agency.txt');
    const calendarDatesObjects = await readEntry(filePath, 'calendar_dates.txt');
    const calendarObjects = await readEntry(filePath, 'calendar.txt');
    const routesObjects = await readEntry(filePath, 'routes.txt');
    const stopsObjects = await readEntry(filePath, 'stops.txt');
    const stopTimesObjects = await readEntry(filePath, 'stop_times.txt');
    const tripsObjects = await readEntry(filePath, 'trips.txt');
    const shapesObjects = await readEntry(filePath, 'shapes.txt');
    const transObjects = await readEntry(filePath, 'translations.txt');
    const feedInfoObjects = await readEntry(filePath, 'feed_info.txt');
    const gtfs = {
        name: filePath,
        agency: _.uniqBy(agencyObjects.map(o => o as Agency), 'agency_id'),
        calendar_dates: calendarDatesObjects.map(o => o as CalendarDate),
        calendar: calendarObjects.map(o => o as Calendar),
        routes: routesObjects.map(o => o as Route),
        stops: stopsObjects.map(objectToStop),
        stop_times: stopTimesObjects.map(o => o as StopTime),
        trips: tripsObjects.map(o => o as Trip),
        shapes: shapesObjects.map(o => o as Shape),
        translations: transObjects.map(o => o as Translation),
        feed_info: feedInfoObjects.map(o => o as FeedInfo)
    } as Gtfs;
    return Promise.resolve(gtfs);
}

async function gunzipFileIfNeeded(filePath: string, resultSuffix: string = 'gunzipped.zip'): Promise<string> {
    const absolutePath = getAbsolutePath(filePath);
    const isGzip = await isGzipFile(absolutePath);
    const gunzippedFile = `${absolutePath}.${resultSuffix}`;
    return isGzip ? gunzipFile(absolutePath, gunzippedFile) : absolutePath;
}

async function readGtfs(filePath: string): Promise<Gtfs> {
    logger.debug(`Starting to read ${filePath}`);
    const startTime = Date.now();
    const zipFilePath = await gunzipFileIfNeeded(filePath);
    const gtfs = await readGtfsZip(zipFilePath);
    const s = Math.round((Date.now()-startTime)/1000);
    logger.info(`Reading '${filePath}' complete, took ${s} seconds.`);
    return gtfs;
}

export {
    readGtfs,
    gunzipFileIfNeeded
}
