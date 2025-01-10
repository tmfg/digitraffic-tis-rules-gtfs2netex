import _ from "lodash";
import {Agency, Calendar, CalendarDate, Gtfs, Route, Stop, StopTime, Trip, FeedInfo, Translation} from "../utils/gtfs-types";
import * as fs from 'fs';
import { rootLogger } from "../utils/logger";
import * as xpath from 'xpath';
import { Document, Element, XMLSerializer, Node as XmlNode } from '@xmldom/xmldom';
import xmlFormat from 'xml-formatter';

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

function replaceAttributeContainingString(
    xmlDoc: Document,
    attributeName: string,
    searchString: string,
    replacement: string
): void {
    // XPath query to find all elements with an attribute containing the search string
    const xpathQuery = `//*[contains(@${attributeName}, '${searchString}')]`;

    // Select matching nodes using xpath and safely cast
    const nodes= getElementsFromNode(xpathQuery, xmlDoc);

    // Ensure it's an array of Nodes
    const nodeArray = Array.isArray(nodes) ? nodes.filter(n => n instanceof XmlNode) as XmlNode[] : [];

    // Replace the attribute value for each matching element
    for (const node of nodeArray) {
        if (node.nodeType === 1) { // Node.ELEMENT_NODE (ensures it's an Element)
            const element = node as Element;
            const attrValue = element.getAttribute(attributeName);

            if (attrValue && attrValue.includes(searchString)) {
                const newValue = attrValue.replace(new RegExp(searchString, 'g'), replacement);
                element.setAttribute(attributeName, newValue);
            }
        }
    }
}

function addAccessibilityAssessment(
    parent: Element,
    wcb: string,
    cs: string,
    parentId: string
): void {
    let value = 'unknown';

    // Map wheelchair boarding values to accessibility values
    if (wcb === '1') {
        value = 'partial';
    } else if (wcb === '2') {
        value = 'false';
    }

    const doc = parent.ownerDocument!;

    // Create the AccessibilityAssessment element
    const accessibilityAssessment = doc.createElement('AccessibilityAssessment');
    accessibilityAssessment.setAttribute('version', '1');
    accessibilityAssessment.setAttribute('id', `${cs}AccessibilityAssessment:${parentId}`);

    // Create and append MobilityImpairedAccess element
    const mobilityImpairedAccess = doc.createElement('MobilityImpairedAccess');
    mobilityImpairedAccess.textContent = value;
    accessibilityAssessment.appendChild(mobilityImpairedAccess);

    // Create limitations -> AccessibilityLimitation elements
    const limitations = doc.createElement('limitations');
    const accessibilityLimitation = doc.createElement('AccessibilityLimitation');

    const wheelchairAccess = doc.createElement('WheelchairAccess');
    wheelchairAccess.textContent = value;
    accessibilityLimitation.appendChild(wheelchairAccess);

    const stepFreeAccess = doc.createElement('StepFreeAccess');
    stepFreeAccess.textContent = value;
    accessibilityLimitation.appendChild(stepFreeAccess);

    limitations.appendChild(accessibilityLimitation);
    accessibilityAssessment.appendChild(limitations);

    // Append AccessibilityAssessment to the parent element
    parent.appendChild(accessibilityAssessment);
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
    const xmlSerializer = new XMLSerializer();
    let xmlString = xmlSerializer.serializeToString(xmlDoc);

    xmlString = `<?xml version="1.0" encoding="UTF-8"?>\n` + xmlString;
    xmlString = xmlFormat(xmlString, { collapseContent: true, indentation: '  ' });

    const filePath = `${outputPath}/${filename}`;

    // Ensure the output directory exists
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }

    // Write the prettified XML string to the file
    fs.writeFileSync(filePath, xmlString, 'utf8');
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

function createDestinationDisplayForTrip(
    destinationDisplays: Element,
    cs: string,
    trip: Trip,
    translationsMap: Record<string, Record<string, string>>
): Element {
    // Normalize the headsign ID
    const normalizedId = normalizeGtfsId(trip.trip_headsign);
    const destinationDisplayId = `${cs}DestinationDisplay:${normalizedId}`;

    const doc = destinationDisplays.ownerDocument!;

    // Create the DestinationDisplay element
    const destinationDisplay = doc.createElement('DestinationDisplay');
    destinationDisplay.setAttribute('version', '1');
    destinationDisplay.setAttribute('id', destinationDisplayId);

    // Include translated headsigns if available
    const translations = translationsMap[trip.trip_id];
    if (translations) {
        const alternativeTexts = doc.createElement('alternativeTexts');
        for (const language in translations) {
            const translatedName = translations[language];
            const alternativeText = doc.createElement('AlternativeText');
            alternativeText.setAttribute('attributeName', 'FrontText');
            alternativeText.setAttribute(
                'id',
                `${cs}AlternativeText:Trip_${normalizedId}_${language}`
            );

            const text = doc.createElement('Text');
            text.setAttribute('lang', language);
            text.appendChild(doc.createTextNode(translatedName));

            alternativeText.appendChild(text);
            alternativeTexts.appendChild(alternativeText);
        }
        destinationDisplay.appendChild(alternativeTexts);
    }

    // Add the FrontText node
    const frontText = doc.createElement('FrontText');
    frontText.appendChild(doc.createTextNode(trip.trip_headsign));
    destinationDisplay.appendChild(frontText);

    // Append the DestinationDisplay to the parent element
    destinationDisplays.appendChild(destinationDisplay);

    return destinationDisplay;
}

function createDestinationDisplayForStopTime(
    destinationDisplays: Element,
    cs: string,
    stopTime: StopTime,
    translationsMap: Record<string, Record<string, string>>
): Element {
    // Normalize the headsign ID
    const normalizedId = normalizeGtfsId(stopTime.stop_headsign);
    const destinationDisplayId = `${cs}DestinationDisplay:${normalizedId}`;

    const doc = destinationDisplays.ownerDocument!;

    // Create the DestinationDisplay element
    const destinationDisplay = doc.createElement('DestinationDisplay');
    destinationDisplay.setAttribute('version', '1');
    destinationDisplay.setAttribute('id', destinationDisplayId);

    // Include translated headsigns if available
    const translations = translationsMap[stopTime.trip_id];
    if (translations) {
        const alternativeTexts = doc.createElement('alternativeTexts');
        for (const language in translations) {
            const translatedName = translations[language];
            const alternativeText = doc.createElement('AlternativeText');
            alternativeText.setAttribute('attributeName', 'FrontText');
            alternativeText.setAttribute(
                'id',
                `${cs}AlternativeText:StopTime_${normalizedId}_${language}`
            );

            const text = doc.createElement('Text');
            text.setAttribute('lang', language);
            text.appendChild(doc.createTextNode(translatedName));

            alternativeText.appendChild(text);
            alternativeTexts.appendChild(alternativeText);
        }
        destinationDisplay.appendChild(alternativeTexts);
    }

    // Add the FrontText node
    const frontText = doc.createElement('FrontText');
    frontText.appendChild(doc.createTextNode(stopTime.stop_headsign));
    destinationDisplay.appendChild(frontText);

    // Append the DestinationDisplay to the parent element
    destinationDisplays.appendChild(destinationDisplay);

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
    const doc = stopPlace.ownerDocument!;

    // Convert GTFS route type to NeTEx transport mode
    const netexTransportMode = getTransportMode(gtfsRouteType);

    // Find or create the TransportMode element
    let transportModeElement = getElementFromElement('TransportMode', stopPlace);
    if (!transportModeElement) {
        transportModeElement = doc.createElement('TransportMode');
        transportModeElement.appendChild(doc.createTextNode(netexTransportMode));
        stopPlace.appendChild(transportModeElement);

        // Add StopPlaceType since this is the primary mode
        const stopPlaceTypeElement = doc.createElement('StopPlaceType');
        stopPlaceTypeElement.appendChild(doc.createTextNode(getStopPlaceType(gtfsRouteType)));
        stopPlace.appendChild(stopPlaceTypeElement);

        return; // Exit since the primary mode has been set
    }

    // Get the existing primary mode and its priority
    const existingTransportMode = transportModeElement.textContent || '';
    const existingPriority = getTransportModePriority(existingTransportMode);
    const currentPriority = getTransportModePriority(netexTransportMode);

    if (currentPriority < existingPriority) {
        // Update primary TransportMode
        transportModeElement.textContent = netexTransportMode;

        // Update StopPlaceType based on the new primary mode
        let stopPlaceTypeElement = getElementFromElement('StopPlaceType', stopPlace);
        if (!stopPlaceTypeElement) {
            stopPlaceTypeElement = doc.createElement('StopPlaceType');
            stopPlace.appendChild(stopPlaceTypeElement);
        }
        stopPlaceTypeElement.textContent = getStopPlaceType(gtfsRouteType);

        // Move the old primary mode to OtherTransportModes
        updateOtherTransportModes(stopPlace, existingTransportMode);
    } else if (netexTransportMode !== existingTransportMode) {
        // Add the current mode to OtherTransportModes if it's not the primary
        updateOtherTransportModes(stopPlace, netexTransportMode);
    }
}

function updateOtherTransportModes(stopPlace: Element, modeToAdd: string): void {
    const doc = stopPlace.ownerDocument!;

    // Find the existing OtherTransportModes element
    let existingOtherTransportModesElement = getElementFromElement('OtherTransportModes', stopPlace);

    // Collect modes from the existing OtherTransportModes element
    const otherModes = new Set<string>();
    if (existingOtherTransportModesElement) {
        const existingModes = existingOtherTransportModesElement.textContent || '';
        existingModes.split(' ').filter(Boolean).forEach(mode => otherModes.add(mode));

        // Remove the existing OtherTransportModes element
        stopPlace.removeChild(existingOtherTransportModesElement);
    }

    // Add the new mode to the set
    otherModes.add(modeToAdd);

    // Re-create OtherTransportModes element with updated content
    const newOtherTransportModesElement = doc.createElement('OtherTransportModes');
    newOtherTransportModesElement.textContent = Array.from(otherModes).join(' ');

    // Find the TransportMode element
    const transportModeElement = getElementFromElement('TransportMode', stopPlace);

    // Insert OtherTransportModes right after TransportMode
    if (transportModeElement?.nextSibling) {
        stopPlace.insertBefore(newOtherTransportModesElement, transportModeElement.nextSibling);
    } else {
        stopPlace.appendChild(newOtherTransportModesElement);
    }
}

// Safely get a single Element from a Document
function getElementFromDocument(expression: string, doc: Document): Element | null {
    // @ts-ignore
    const result = xpath.select1(expression, doc as unknown as Node); // Cast to Node
    return result instanceof Element ? result : null;
}

// Safely get a single Element from an Element
function getElementFromElement(expression: string, element: Element): Element | null {
    // @ts-ignore
    const result = xpath.select1(expression, element as unknown as Node); // Cast to Node
    return result instanceof Element ? result : null;
}

// Safely get a single Element from a Node
function getElementFromNode(expression: string, node: XmlNode): Element | null {
    // @ts-ignore
    const result = xpath.select1(expression, node as unknown as Node); // Explicitly cast as Node
    return result instanceof Element ? result : null;
}

// Safely get multiple Elements from a Node
function getElementsFromNode(expression: string, node: XmlNode): Element[] {
    // @ts-ignore
    const results = xpath.select(expression, node as unknown as Node);

    if (!results) return [];

    // Ensure the result is an array and filter Elements, then assert type as Element[]
    return (Array.isArray(results)
        ? results.filter((item) => item instanceof Element)
        : []) as Element[];
}

function getCountFromXPath(expression: string, doc: Document): number {
    const result = xpath.select(expression, doc as unknown as Node); // Cast Document to Node

    if (typeof result === 'number') {
        return result;
    } else if (typeof result === 'string') {
        return parseFloat(result); // Convert string result to number
    } else if (Array.isArray(result) && result.length === 1 && typeof result[0] === 'number') {
        return result[0];
    }

    throw new Error(`Unexpected result type for XPath count expression: ${expression}`);
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
    normalizeGtfsId,
    getElementFromDocument,
    getElementFromElement,
    getElementFromNode,
    getElementsFromNode,
    getCountFromXPath
};
