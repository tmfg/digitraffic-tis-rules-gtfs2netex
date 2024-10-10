import * as dotenv from 'dotenv';
dotenv.config();
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { writeNeTEx } from "./netex";
import { readGtfs } from "../utils/read-gtfs";
import {rootLogger} from "../utils/logger";

const log = rootLogger.child({src: 'converter.ts'});

async function convertGtfs(gtfsFilePath: string, netexFilePath: string, stopsOnly: boolean): Promise<void> {
    const gtfs = await readGtfs(gtfsFilePath);
    const res = await writeNeTEx(gtfs, netexFilePath, stopsOnly);
}

const program = new Command();

program
    .option('-g, --gtfs <gtfsFileName>', 'GTFS file name')
    .option('-n, --netex <netexDirectory>', 'NeTEx directory')
    .option('-s, --stops-only', 'Generate NeTEx only for stops')
    .parse(process.argv);

const { gtfs, netex, stopsOnly } = program.opts();

if (!gtfs || !netex) {
    console.error('Both GTFS file name and NeTEx directory are required.');
    program.help();
} else {
    // Check if the NeTEx directory exists, create it if not
    if (!fs.existsSync(netex)) {
        fs.mkdirSync(netex, { recursive: true });
    }

    const gtfsFilePath = path.resolve(gtfs);
    const netexDirPath = path.resolve(netex);
    const errorFile: object[] =  [];

    convertGtfs(gtfsFilePath, netexDirPath, stopsOnly)
        .then(() => {
            log.info('Conversion completed successfully.');
        })
        .catch((error) => {
            log.error('Error during conversion: ' + error);
            const data = { errorMsg: error.message };
            errorFile.push(data)
            const errorFilePath = netexDirPath + '/errors.json';
            const errorData = JSON.stringify(errorFile, null, 2);
            fs.writeFile(errorFilePath, errorData, (error) => {
                log.info('error file written to ' + errorFilePath);
            })
        });
}

export { convertGtfs };
