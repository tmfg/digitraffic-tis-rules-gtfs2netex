import * as dotenv from 'dotenv';
dotenv.config();
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { writeNeTEx } from "./netex";
import { readGtfs } from "../utils/read-gtfs";


async function convertGtfs(gtfsFilePath: string, netexFilePath: string): Promise<void> {
    const gtfs = await readGtfs(gtfsFilePath);
    const res = await writeNeTEx(gtfs, netexFilePath);
}

const program = new Command();

program
    .option('-g, --gtfs <gtfsFileName>', 'GTFS file name')
    .option('-n, --netex <netexDirectory>', 'NeTEx directory')
    .parse(process.argv);

const { gtfs, netex } = program.opts();

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

    convertGtfs(gtfsFilePath, netexDirPath)
        .then(() => {
            console.log('Conversion completed successfully.');
        })
        .catch((error) => {
            console.error('Error during conversion:', error);
        });
}

export { convertGtfs };
