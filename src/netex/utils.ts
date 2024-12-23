import _ from "lodash";
import {Agency, Calendar, CalendarDate, Gtfs, Route, Stop, StopTime, Trip, FeedInfo, Translation} from "../utils/gtfs-types";
import {Document, Element} from "libxmljs2";
import * as fs from 'fs';
import { rootLogger } from "../utils/logger";

const log = rootLogger.child({src: 'utils.ts'});

interface Stats {
    Lines: number,
    StopPlaces: number,
    Quays: number,
    JourneyPatterns: number,
    ServiceJourneys: number,
}

function findAgencyForId(gtfs: Gtfs, agencyId: string): Agency {
    if (gtfs.agency.length === 1) {
        return gtfs.agency[0]; // trivial case, only one agency, and in that case agencyId is optional
    }
    return gtfs.agency.find((a) => a.agency_id === agencyId) as Agency;
}

function findRouteForId(gtfs: Gtfs, routeId: string): Route {
    return gtfs.routes.find((r) => r.route_id === routeId) as Route;
}

function findTripsForRouteId(gtfs: Gtfs, routeId: string): Trip[] {
    return gtfs.trips.filter((t) => t.route_id === routeId) as Trip[];
}

// Prepare the index outside the function (only once for the entire GTFS dataset)
function indexStopsById(gtfs: Gtfs): { [stop_id: string]: Stop } {
    const stopsById: { [stop_id: string]: Stop } = {};

    for (const stop of gtfs.stops) {
        stopsById[stop.stop_id] = stop;
    }

    return stopsById;
}

function findStopsForTrips(gtfs: Gtfs, stopsById: { [stop_id: string]: Stop }, trips: Trip[], stoptimesIndex: { [trip_id: string]: StopTime[] }): Stop[] {
    // Create a Set to store unique stop IDs encountered
    const stopIdSet = new Set<string>();
    for (const trip of trips) {
        const stopTimesForTrip = stoptimesIndex[trip.trip_id];
        if (stopTimesForTrip) {
            for (const stopTime of stopTimesForTrip) {
                stopIdSet.add(stopTime.stop_id);
            }
        }
    }
    // Map the unique stop IDs to their corresponding Stop objects
    return Array.from(stopIdSet).map((stopId) => stopsById[stopId]).filter((s) => s) as Stop[];
}

function findCalendarsForTrips(gtfs: Gtfs, trips: Trip[]): Calendar[] {
    let serviceIds = trips.map((t) => t.service_id);
    serviceIds = Array.from(new Set(serviceIds));
    return gtfs.calendar.filter((c) => serviceIds.includes(c.service_id)) as Calendar[];
}

function findCalendarDatesForTrips(gtfs: Gtfs, trips: Trip[]): CalendarDate[] {
    let serviceIds = trips.map((t) => t.service_id);
    serviceIds = Array.from(new Set(serviceIds));
    return gtfs.calendar_dates.filter((cd) => serviceIds.includes(cd.service_id)) as CalendarDate[];
}

// Prepare the index outside the function (only once for the entire GTFS dataset)
function indexStopTimesByTripId(gtfs: Gtfs): { [trip_id: string]: StopTime[] } {
    const stopTimesByTripId: { [trip_id: string]: StopTime[] } = {};

    for (const stopTime of gtfs.stop_times) {
        const tripId = stopTime.trip_id;
        if (!stopTimesByTripId.hasOwnProperty(tripId)) {
            stopTimesByTripId[tripId] = [];
        }
        stopTimesByTripId[tripId].push(stopTime);
    }

    return stopTimesByTripId;
}

// Use the index to find stop times for a specific trip id
function findStopTimesForTripId(stopTimesByTripId: { [trip_id: string]: StopTime[] }, tripId: string): StopTime[] {
    const unsorted = stopTimesByTripId[tripId] || [];
    return unsorted.sort((a, b) => a.stop_sequence - b.stop_sequence);
}

function findParentStop(gtfs: Gtfs, stop: Stop, stopsIndex: { [stop_id: string]: Stop }): Stop | undefined {
    const parentStopId = stop.parent_station;
    if (parentStopId && stopsIndex.hasOwnProperty(parentStopId)) {
        return stopsIndex[parentStopId];
    }
    return undefined;
}

function getNetexLineId(gtfsRoute: Route, agency: Agency, feedInfo: FeedInfo): string {
    const codeSpace = getCodeSpaceForAgency(agency, feedInfo);
    return codeSpace + 'Line' + ':' + gtfsRoute.route_id;
}

function getNetexRouteId(gtfsRoute: Route, agency: Agency, feedInfo: FeedInfo): string {
    const codeSpace = getCodeSpaceForAgency(agency, feedInfo);
    return codeSpace + 'Route' + ':' + gtfsRoute.route_id;
}

function getNetexOperatorId(gtfsAgency: Agency): string {
    return 'FSR:' + 'Operator' + ':' + _.camelCase(gtfsAgency.agency_name);
}

function getTransportMode(gtfsRouteType: number): string {
    // Map GTFS route types to NeTEx transport modes
    const gtfsToNetexTransportMode: Record<number, string> = {
        0: 'tram',
        1: 'metro',
        2: 'rail',
        102: 'rail',
        103: 'rail',
        109: 'rail',
        3: 'bus',
        700: 'bus',
        701: 'bus',
        702: 'bus',
        703: 'bus',
        704: 'bus',
        710: 'bus',
        711: 'bus',
        712: 'bus',
        713: 'bus',
        714: 'bus',
        715: 'bus',
        900: 'tram',
        4: 'water',
        5: 'cablecar',
        6: 'gondola',
        7: 'funicular',
        1100: 'air'
    };
    const mode = gtfsToNetexTransportMode[gtfsRouteType];
    if (mode) {
        return mode;
    }
    log.warn('Unknown GTFS route type: ' + gtfsRouteType);
    return 'other';
}

function getStopPlaceType(gtfsRouteType: number): string {
    const mode = getTransportMode(gtfsRouteType);
    if (mode === 'tram') {
        return 'onstreetTram';
    }
    if (mode === 'metro') {
        return 'metroStation';
    }
    if (mode === 'rail') {
        return 'railStation';
    }
    if (mode === 'bus') {
        return 'onstreetBus';
    }
    if (mode === 'water') {
        return 'harbourPort';
    }
    if (mode === 'cablecar' || mode === 'gondola' || mode === 'funicular') {
        return 'liftStation';
    }
    if (mode === 'air') {
        return 'airport';
    }
    log.warn('Unknown GTFS route type: ' + gtfsRouteType);
    return '';
}

const CODESPACE_FROM_FEEDINFO = true; //process.env.CODESPACE_FROM_FEEDINFO === 'true';

function getCodeSpaceForAgency(gtfsAgency: Agency, feedInfo: FeedInfo): string {
    if (CODESPACE_FROM_FEEDINFO) {
        // Use the first 3 letters of feed_publisher_name as codespace
        const publisherName = feedInfo?.feed_publisher_name || 'OTH';
        return _.camelCase(publisherName).slice(0, 3).toUpperCase() + ':';
    }
    let cs = getCodeSpaceForAgencyByUrl(gtfsAgency.agency_fare_url);
    if (_.isEmpty(cs)) {
        cs = 'OTH:'
    }
    return cs;
}

function getCodeSpaceForAgencyByUrl(url: string): string {
    if (!url || _.isEmpty(url)) {
        return '';
    }
    if (url.includes('matkahuolto.fi')) {
        return 'MAT:';
    }
    if (url.includes('vr.fi')) {
        return 'VRG:';
    }
    if (url.includes('waltti')) {
        return 'WAL:';
    }
    if (url.includes('hsl.fi')) {
        return 'HSL:';
    }
    if (url.includes('tampere.fi')) {
        return 'NYS:';
    }
    if (url.includes('foli.fi')) {
        return 'FOL:';
    }
    if (url.includes('oulunjoukkoliikenne')) {
        return 'OSL:';
    }
    if (url.includes('jyvaskyla')) {
        return 'LIN:';
    }
    return '';
}

function replaceAttributeContainingString(xmlDoc: Document, attributeName: string, searchString: string, replacement: string): void {
    const rootElement: Element = xmlDoc.root()!;
    const elements: Element[] = rootElement.find(`//*[contains(@${attributeName}, '${searchString}')]`); // Find all elements with the specified attribute containing the search string

    for (const element of elements) {
        const attribute = element.attr(attributeName);

        if (attribute) {
            const oldValue = attribute.value();
            const newValue = oldValue.replace(new RegExp(searchString, 'g'), replacement);
            attribute.value(newValue);
        }
    }
}

function addAccessibilityAssessment(parent: Element, wcb: string, cs: string, parentId: string) {
    let value = 'unknown';
    if (wcb === "1") {
        value = 'partial';
    } else if (wcb === "2") {
        value = 'false';
    }
    const aa = parent.node('AccessibilityAssessment')
        .attr('version', '1')
        .attr('id', cs + 'AccessibilityAssessment:' + parentId);
    aa.node('MobilityImpairedAccess', value);
    const limitations = aa.node('limitations');
    const al = limitations.node('AccessibilityLimitation');
    al.node('WheelchairAccess', value);
    al.node('StepFreeAccess', value);
}

// Function to generate a translations map
function getTranslationsMap(
    translations: Translation[],
    table_name: string,
    field_name: string
): Record<string, Record<string, string>> {
    const translationsMap: Record<string, Record<string, string>> = {};

    // Populate the translations map with Translation objects
    translations.forEach(translation => {
        const {
            table_name: translationTableName,
            field_name: translationFieldName,
            language,
            translation: translatedName,
            record_id
        } = translation;

        // Check if it's a translation for the specified table and field, and has a record_id
        if (translationTableName === table_name && translationFieldName === field_name && record_id) {
            if (!translationsMap[record_id]) {
                translationsMap[record_id] = {};
            }
            translationsMap[record_id][language] = translatedName;
        }
    });

    return translationsMap;
}

function writeXmlDocToFile(xmlDoc: Document, outputPath: string, filename: string): void {
    const xmlString = xmlDoc.toString();
    const filePath = `${outputPath}/${filename}`;

    // Ensure the output directory exists
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, {recursive: true});
    }

    // Write the xmlDoc to the file
    writeFile(filePath, xmlString);
}

function writeStatsToFile(stats: Stats, outputPath: string, filename: string): void {
    const statsString = JSON.stringify(stats, null, 2);
    const filePath = `${outputPath}/${filename}`;

    // Ensure the output directory exists
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, {recursive: true});
    }

    // Write the stats to the file
    writeFile(filePath, statsString);
}

function writeFile(filePath: string, data: string, encoding: BufferEncoding = 'utf8'): void {
    let fd = 0;
    try {
        fd = fs.openSync(filePath, 'w');
        fs.writeSync(fd, data, 0, encoding);
    } catch (error) {
        log.error('Error writing file: ' + error);
    } finally {
        if (fd !== 0) {
            fs.closeSync(fd);
        }
    }
}

function createDestinationDisplayForTrip(destinationDisplays: Element, cs: string, trip: Trip, translationsMap: Record<string, Record<string, string>>) {
    const destinationDisplay = destinationDisplays
        .node('DestinationDisplay')
        .attr({version: '1', id: cs + 'DestinationDisplay:' + normalizeGtfsId(trip.trip_headsign)});

    // Include translated headsign if available
    const translations = translationsMap[trip.trip_id];
    if (translations) {
        const alternativeTexts = destinationDisplay.node('alternativeTexts');
        for (const language in translationsMap[trip.trip_id]) {
            const translatedName = translationsMap[trip.trip_id][language];
            const alternativeText = alternativeTexts.node('AlternativeText');
            alternativeText.attr({attributeName: 'FrontText'});
            alternativeText.attr({id: cs + 'AlternativeText:Trip_' + normalizeGtfsId(trip.trip_headsign) + "_" + language});
            const text = alternativeText.node('Text');
            text.attr({lang: language});
            text.text(translatedName);
        }
    }

    destinationDisplay.node('FrontText').text(trip.trip_headsign);
    return destinationDisplay;
}

function createDestinationDisplayForStopTime(destinationDisplays: Element, cs: string, stopTime: StopTime, translationsMap: Record<string, Record<string, string>>) {
    const destinationDisplay = destinationDisplays
        .node('DestinationDisplay')
        .attr({version: '1', id: cs + 'DestinationDisplay:' + normalizeGtfsId(stopTime.stop_headsign)});

    // Include translated headsign if available
    const translations = translationsMap[stopTime.trip_id];
    if (translations) {
        const alternativeTexts = destinationDisplay.node('alternativeTexts');
        for (const language in translationsMap[stopTime.trip_id]) {
            const translatedName = translationsMap[stopTime.trip_id][language];
            const alternativeText = alternativeTexts.node('AlternativeText');
            alternativeText.attr({attributeName: 'FrontText'});
            alternativeText.attr({id: cs + 'AlternativeText:StopTime_' + normalizeGtfsId(stopTime.stop_headsign) + "_" + language});
            const text = alternativeText.node('Text');
            text.attr({lang: language});
            text.text(translatedName);
        }
    }

    destinationDisplay.node('FrontText').text(stopTime.stop_headsign);
    return destinationDisplay;
}

const transportModePriority = ['air', 'water', 'rail', 'metro', 'bus', 'tram', 'cablecar', 'gondola', 'funicular', 'other']; // Higher priority first

function getTransportModePriority(mode: string): number {
    const priority = transportModePriority.indexOf(mode);
    return priority === -1 ? transportModePriority.length : priority; // Return a lower priority if not found
}

function setTransportModeWithPriority(
    stopPlace: Element,
    gtfsRouteType: number,
    cs: string
): void {
    // Convert GTFS route type to NeTEx transport mode
    const netexTransportMode = getTransportMode(gtfsRouteType);

    // Check if the StopPlace already has a primary mode set
    const existingTransportModeElement = stopPlace.get('TransportMode') as Element;
    const existingTransportMode = existingTransportModeElement?.text();

    if (!existingTransportMode) {
        // No primary mode set yet, use the current mode as the primary mode
        stopPlace.node('TransportMode').text(netexTransportMode);
        stopPlace.node('StopPlaceType').text(getStopPlaceType(gtfsRouteType)); // Set StopPlaceType based on primary mode
    } else {
        const existingPriority = getTransportModePriority(existingTransportMode);
        const currentPriority = getTransportModePriority(netexTransportMode);

        if (currentPriority < existingPriority) {
            // Current mode has a higher priority, so make it the primary mode
            existingTransportModeElement.text(netexTransportMode); // Update primary mode to current
            (stopPlace.get('StopPlaceType') as Element)?.text(getStopPlaceType(gtfsRouteType)); // Update StopPlaceType to match new primary mode

            // Move existing primary mode to OtherTransportModes
            updateOtherTransportModes(stopPlace, existingTransportMode);
        } else if (netexTransportMode !== existingTransportMode) {
            // If the current mode is different from the existing primary mode
            // and doesn't have a higher priority, add it to OtherTransportModes
            updateOtherTransportModes(stopPlace, netexTransportMode);
        }
    }
}


// Helper function to update OtherTransportModes and place it after TransportMode
function updateOtherTransportModes(stopPlace: Element, modeToAdd: string): void {
    // Remove any existing OtherTransportModes element to ensure it’s fresh
    const existingOtherTransportModesElement = stopPlace.get('OtherTransportModes') as Element;
    if (existingOtherTransportModesElement) {
        existingOtherTransportModesElement.remove();
    }

    // Collect the modes to be placed in OtherTransportModes
    let otherModes = new Set<string>();
    if (existingOtherTransportModesElement) {
        otherModes = new Set(existingOtherTransportModesElement.text().split(' ').filter(Boolean));
    }
    otherModes.add(modeToAdd);

    // Create a new OtherTransportModes element directly after TransportMode
    const transportModeElement = stopPlace.get('TransportMode') as Element;
    const otherTransportModesElement = stopPlace.node('OtherTransportModes');
    otherTransportModesElement.text(Array.from(otherModes).join(' '));

    // Reorder the node so that OtherTransportModes is right after TransportMode
    transportModeElement.addNextSibling(otherTransportModesElement);
}

function normalizeGtfsId(id: string): string {
    return _.snakeCase(id);
}

export {
    Stats,
    findAgencyForId,
    findRouteForId,
    findTripsForRouteId,
    findStopsForTrips,
    findStopTimesForTripId,
    indexStopTimesByTripId,
    indexStopsById,
    getNetexLineId,
    getNetexRouteId,
    getNetexOperatorId,
    getTransportMode,
    getStopPlaceType,
    findCalendarsForTrips,
    findCalendarDatesForTrips,
    getCodeSpaceForAgency,
    replaceAttributeContainingString,
    writeXmlDocToFile,
    writeStatsToFile,
    addAccessibilityAssessment,
    getTranslationsMap,
    findParentStop,
    createDestinationDisplayForTrip,
    createDestinationDisplayForStopTime,
    setTransportModeWithPriority,
    normalizeGtfsId
};
