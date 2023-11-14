import _ from "lodash";
import {Agency, Calendar, CalendarDate, Gtfs, Route, Stop, StopTime, Trip, FeedInfo, Translation} from "../utils/gtfs-types";
import {Agent} from "http";
import {Document, Element} from "libxmljs2";
import * as fs from 'fs';

function findAgencyForId(gtfs: Gtfs, agencyId: string): Agency {
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

function findStopsForTrips_old(gtfs: Gtfs, trips: Trip[]): Stop[] {
    let stopIds = gtfs.stop_times.filter((st) => trips.map((t) => t.trip_id).includes(st.trip_id)).map((st) => st.stop_id);
    stopIds = Array.from(new Set(stopIds));
    return gtfs.stops.filter((s) => stopIds.includes(s.stop_id)) as Stop[];
}

function findStopsForTrips(gtfs: Gtfs, stopsById: { [stop_id: string]: Stop }, trips: Trip[]): Stop[] {
    const tripIds = trips.map((t) => t.trip_id);
    const stopIds = gtfs.stop_times
        .filter((st) => tripIds.includes(st.trip_id))
        .map((st) => st.stop_id);
    const uniqueStopIds = Array.from(new Set(stopIds));
    return uniqueStopIds.map((stopId) => stopsById[stopId]).filter((s) => s) as Stop[];
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
        715: 'bus',
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
    console.warn('Unknown GTFS route type: ' + gtfsRouteType);
    return 'other';
}

const CODESPACE_FROM_FEEDINFO = true; //process.env.CODESPACE_FROM_FEEDINFO === 'true';

function getCodeSpaceForAgency(gtfsAgency: Agency, feedInfo: FeedInfo): string {
    if (CODESPACE_FROM_FEEDINFO) {
        // Use the first 3 letters of feed_publisher_name as codespace
        const publisherName = feedInfo?.feed_publisher_name || 'OTH';
        return publisherName.slice(0, 3).toUpperCase() + ':';
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

function addAccessibilityAssessment(stopPlace: Element, stop: Stop, cs: string) {
    const wcb = stop.wheelchair_boarding.toString();
    let value = 'unknown';
    if (wcb === "1") {
        value = 'partial';
    } else if (wcb === "2") {
        value = 'false';
    }
    const aa = stopPlace.node('AccessibilityAssessment')
        .attr('version', '1')
        .attr('id', cs + 'AccessibilityAssessment:' + stop.stop_id);
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
    fs.writeFileSync(filePath, xmlString, {encoding: 'utf8'});
}

export {
    findAgencyForId,
    findRouteForId,
    findTripsForRouteId,
    findStopsForTrips,
    findStopTimesForTripId,
    indexStopTimesByTripId,
    indexStopsById,
    getNetexLineId,
    getNetexOperatorId,
    getTransportMode,
    findCalendarsForTrips,
    findCalendarDatesForTrips,
    getCodeSpaceForAgency,
    replaceAttributeContainingString,
    writeXmlDocToFile,
    addAccessibilityAssessment,
    getTranslationsMap,
    findParentStop
};
