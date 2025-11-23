import { XMLSerializer, Element, Node } from '@xmldom/xmldom';
import fs from 'fs';
import path from 'path';
import { rootLogger } from "../utils/logger";

const log = rootLogger.child({src: 'writestops.ts'});

export function writeAllStopsStreaming(
    stopPlacesMap: Record<string, Element>,
    filePath: string,
    publisherPrefix: string
): { stopPlaceCount: number; quayCount: number } {

    const stopsFileName = `${publisherPrefix}_all_stops.xml`;
    const fullPath = path.join(filePath, stopsFileName);

    const stream = fs.createWriteStream(fullPath, { encoding: "utf8" });

    const serializer = new XMLSerializer();

    // Header
    stream.write(`<?xml version="1.0" encoding="UTF-8"?>\n`);
    stream.write(`<PublicationDelivery xmlns="http://www.netex.org.uk/netex" xmlns:gml="http://www.opengis.net/gml/3.2">\n`);
    stream.write(`  <PublicationTimestamp>${new Date().toISOString()}</PublicationTimestamp>\n`);
    stream.write(`  <ParticipantRef>FSR</ParticipantRef>\n`);
    stream.write(`  <dataObjects>\n`);
    stream.write(`    <SiteFrame id="SiteFrame_1" version="1">\n`);
    stream.write(`      <FrameDefaults>\n`);
    stream.write(`        <DefaultLocale>\n`);
    stream.write(`          <TimeZone>Europe/Helsinki</TimeZone>\n`);
    stream.write(`          <DefaultLanguage>fi</DefaultLanguage>\n`);
    stream.write(`        </DefaultLocale>\n`);
    stream.write(`        <DefaultLocationSystem>WGS84</DefaultLocationSystem>\n`);
    stream.write(`      </FrameDefaults>\n`);
    stream.write(`      <stopPlaces>\n`);

    let stopPlaceCount = 0;
    let quayCount = 0;

    for (const key in stopPlacesMap) {
        const sp = stopPlacesMap[key];
        if (!sp) continue;

        stopPlaceCount++;

        // Count Quays
        const quays = sp.getElementsByTagName("Quay");
        quayCount += quays.length;

        stream.write("        " + serializer.serializeToString(sp) + "\n");

        // Free memory
        stopPlacesMap[key] = null as any;
    }

    // Footer
    stream.write(`      </stopPlaces>\n`);
    stream.write(`    </SiteFrame>\n`);
    stream.write(`  </dataObjects>\n`);
    stream.write(`</PublicationDelivery>\n`);
    stream.end();

    return { stopPlaceCount, quayCount };
}
