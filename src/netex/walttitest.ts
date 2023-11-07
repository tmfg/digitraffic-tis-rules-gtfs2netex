import * as dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {readGtfs} from "../utils/read-gtfs";
import {writeNeTEx} from "./netex";

const authorities = [
    { id: '203', name: 'Hämeenlinna' },
    { id: '207', name: 'Joensuu' },
    { id: '209', name: 'Jyväskylä' },
    { id: '211', name: 'Kajaani' },
    { id: '217', name: 'Kotka' },
    { id: '219', name: 'Kouvola' },
    { id: '221', name: 'Kuopio' },
    { id: '223', name: 'Lahti' },
    { id: '225', name: 'Lappeenranta' },
    { id: '227', name: 'Mikkeli' },
    { id: '229', name: 'Oulu' },
    { id: '231', name: 'Pori' },
    { id: '232', name: 'Raasepori' },
    { id: '237', name: 'Rovaniemi' },
    { id: '239', name: 'Salo' },
    { id: '249', name: 'Vaasa' },
];

const downloadAndConvert = async (authority: { id: string; name: string }) => {
    const authorityId = authority.id;
    const authorityName = authority.name;

    // Define URLs
    const gtfsUrl = `https://tvv.fra1.digitaloceanspaces.com/${authorityId}.zip`;
    const netexFilePath = path.join('/tmp', authorityName);

    try {
        // Download GTFS ZIP file
        const response = await axios.get(gtfsUrl, { responseType: 'stream' });
        const gtfsFilePath = path.join('/tmp', `${authorityId}.zip`);
        const writer = fs.createWriteStream(gtfsFilePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const gtfs = await readGtfs(gtfsFilePath);
        const res = await writeNeTEx(gtfs, netexFilePath);

        console.log(`Conversion completed for ${authorityName}`);
    } catch (error: any) {
        console.error(`Error processing ${authorityName}: ${error.message}`);
    }
};

// Iterate through authorities and process each one
(async () => {
    for (const authority of authorities) {
        await downloadAndConvert(authority);
    }
})();
